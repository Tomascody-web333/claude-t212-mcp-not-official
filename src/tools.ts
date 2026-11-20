import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { Env, Props, T212Env } from "./env";
import { T212Error, t212 } from "./t212";

// ---------- helpers ----------

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

/** Credenciais já resolvidas para UMA conta (demo ou live). */
interface Ctx {
  apiKey: string;
  apiSecret: string;
  env: T212Env;
  readOnly: boolean;
  userId: string;
}

function resolve(account?: T212Env): Ctx {
  const p = getMcpAuthContext()?.props as Props | undefined;
  if (!p || (!p.demo && !p.live)) throw new Error("Sem sessão: volta a ligar o conector no Claude.");
  const configured = (["demo", "live"] as const).filter((k) => p[k]);
  const chosen = account ?? (configured.length === 1 ? configured[0] : undefined);
  if (!chosen) throw new Error("Indica 'account': \"demo\" (dinheiro simulado) ou \"live\" (dinheiro real). Não assumo por ti.");
  const creds = p[chosen];
  if (!creds) throw new Error(`A conta ${chosen.toUpperCase()} não está ligada. Volta a ligar o conector e preenche essas chaves.`);
  return { ...creds, env: chosen, readOnly: chosen === "live" && p.liveReadOnly, userId: p.userId };
}

/** Executa uma tool, convertendo erros em respostas legíveis para o Claude. */
async function run(account: T212Env | undefined, fn: (c: Ctx) => Promise<unknown>) {
  try {
    const result = await fn(resolve(account));
    return json(result);
  } catch (e) {
    if (e instanceof T212Error) return fail(`Erro Trading 212 ${e.message}`);
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Bloqueia ações de escrita quando a conta está em modo só-leitura. */
function assertCanWrite(c: Ctx) {
  if (c.readOnly) {
    throw new Error("A conta LIVE está em modo SÓ-LEITURA. Volta a ligar o conector sem essa opção para poderes criar/alterar ordens ou pies na conta real.");
  }
}

function maxOrderValue(): number {
  const n = Number((env as Env).MAX_ORDER_VALUE ?? "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** quantity OU value (montante) -> quantidade; aplica o limite de segurança nas compras. */
function resolveQuantity(args: {
  side: "buy" | "sell";
  quantity?: number;
  value?: number;
  price?: number; // preço de referência (limit/stop/estimado)
}): number {
  const { side, quantity, value, price } = args;
  if ((quantity === undefined) === (value === undefined)) {
    throw new Error("Indica exatamente um de: quantity (nº de ações) ou value (montante na moeda da conta).");
  }
  let qty = quantity;
  if (qty === undefined) {
    if (!price) throw new Error("Para usar 'value' é preciso um preço de referência.");
    qty = Math.floor(((value as number) / price) * 1e4) / 1e4;
  }
  if (!(qty > 0)) throw new Error("A quantidade resultante é 0 — aumenta o montante ou indica a quantidade.");
  if (side === "buy") {
    if (!price) throw new Error("Em compras é obrigatório um preço (limit/stop/estimado) para validar o limite de segurança.");
    const notional = qty * price;
    const cap = maxOrderValue();
    if (notional > cap) {
      throw new Error(`Recusado: ordem de ~${notional.toFixed(2)} excede o limite de segurança MAX_ORDER_VALUE=${cap}.`);
    }
  }
  return side === "buy" ? qty : -qty;
}

const account = z
  .enum(["demo", "live"])
  .optional()
  .describe("demo = dinheiro SIMULADO, live = dinheiro REAL. Obrigatório se as duas contas estiverem ligadas; confirma com o utilizador em caso de dúvida.");
const ticker = z.string().describe("Ticker da Trading 212, ex.: AAPL_US_EQ (usa search_instruments para o encontrar).");
const side = z.enum(["buy", "sell"]).describe("buy = comprar, sell = vender");
const quantity = z.number().positive().optional().describe("Nº de ações (aceita frações). Usa quantity OU value.");
const value = z.number().positive().optional().describe("Montante a investir na moeda da conta (ex.: 10). Usa quantity OU value.");
const timeValidity = z
  .enum(["DAY", "GOOD_TILL_CANCEL"])
  .default("GOOD_TILL_CANCEL")
  .describe("DAY = expira no fim do dia; GOOD_TILL_CANCEL = fica ativa até ser cancelada.");

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const SOFT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const NO_RETRY = " A API da T212 não é idempotente: se houver erro/timeout, confirma com get_pending_orders antes de repetir.";

// ---------- servidor ----------

export function createServer(): McpServer {
  const base = new McpServer({ name: "trading212", version: "1.0.0" });
  // Todas as tools recebem 'account' (demo/live) e uma ligação resolvida.
  const server = {
    registerTool(name: string, config: any, handler: (c: Ctx, args: any) => Promise<unknown>) {
      base.registerTool(
        name,
        { ...config, inputSchema: { account, ...(config.inputSchema ?? {}) } },
        (args: any) => run(args?.account, (c) => handler(c, args ?? {})),
      );
    },
  };

  // ===== LEITURA =====

  server.registerTool(
    "get_account_summary",
    {
      title: "Ver resumo da conta",
      description: "Saldo disponível, valor investido, valor total e lucro/prejuízo da conta Trading 212.",
      annotations: READ,
    },
    (p) => (t212(p, "GET", "/equity/account/summary")),
  );

  server.registerTool(
    "get_positions",
    {
      title: "Ver as minhas ações (posições)",
      description: "Lista as posições abertas (quantidade, preço médio, preço atual, lucro/prejuízo). Filtra opcionalmente por ticker.",
      inputSchema: { ticker: ticker.optional() },
      annotations: READ,
    },
    (p, { ticker }) => (t212(p, "GET", "/equity/positions", { query: { ticker } })),
  );

  server.registerTool(
    "search_instruments",
    {
      title: "Procurar ações/ETFs",
      description:
        "Procura instrumentos por nome, ticker ou ISIN e devolve o ticker da T212 (necessário para ordens). Resultados em cache durante 1 hora.",
      inputSchema: { query: z.string().min(2), limit: z.number().int().min(1).max(50).default(15) },
      annotations: READ,
    },
    async (p, { query, limit }) => {
        const cacheKey = `t212:instruments:${p.env}:${p.userId}`;
        const e = env as Env;
        let list: Array<Record<string, unknown>> | null = await e.OAUTH_KV.get(cacheKey, "json");
        if (!list) {
          list = await t212<Array<Record<string, unknown>>>(p, "GET", "/equity/metadata/instruments");
          await e.OAUTH_KV.put(cacheKey, JSON.stringify(list), { expirationTtl: 3600 });
        }
        const q = query.toLowerCase();
        return list
          .filter((i) => ["ticker", "name", "shortName", "isin"].some((k) => String(i[k] ?? "").toLowerCase().includes(q)))
          .slice(0, limit);
    },
  );

  server.registerTool(
    "get_pending_orders",
    {
      title: "Ver ordens pendentes",
      description: "Lista as ordens ativas (ainda não executadas, canceladas ou expiradas).",
      annotations: READ,
    },
    (p) => (t212(p, "GET", "/equity/orders")),
  );

  server.registerTool(
    "get_pending_order",
    {
      title: "Ver uma ordem pendente",
      description: "Detalhes de uma ordem pendente pelo seu id.",
      inputSchema: { id: z.number().int() },
      annotations: READ,
    },
    (p, { id }) => (t212(p, "GET", `/equity/orders/${id}`)),
  );

  server.registerTool(
    "get_order_history",
    {
      title: "Ver histórico de ordens",
      description: "Histórico de ordens (paginado). Usa nextPagePath/cursor da resposta para a página seguinte.",
      inputSchema: {
        ticker: ticker.optional(),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.number().int().optional(),
      },
      annotations: READ,
    },
    (p, { ticker, limit, cursor }) => (t212(p, "GET", "/equity/history/orders", { query: { ticker, limit, cursor } })),
  );

  server.registerTool(
    "get_dividend_history",
    {
      title: "Ver dividendos recebidos",
      description: "Histórico de dividendos pagos (paginado).",
      inputSchema: {
        ticker: ticker.optional(),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.number().int().optional(),
      },
      annotations: READ,
    },
    (p, { ticker, limit, cursor }) => (t212(p, "GET", "/equity/history/dividends", { query: { ticker, limit, cursor } })),
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Ver depósitos e levantamentos",
      description: "Histórico de depósitos e levantamentos da conta (paginado).",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20), cursor: z.string().optional() },
      annotations: READ,
    },
    (p, { limit, cursor }) => (t212(p, "GET", "/equity/history/transactions", { query: { limit, cursor } })),
  );

  server.registerTool(
    "list_pies",
    {
      title: "Ver os meus pies",
      description: "Lista todos os pies. Nota: os endpoints de pies estão marcados como deprecated pela T212.",
      annotations: READ,
    },
    (p) => (t212(p, "GET", "/equity/pies")),
  );

  server.registerTool(
    "get_pie",
    {
      title: "Ver detalhes de um pie",
      description: "Composição e estado de um pie.",
      inputSchema: { id: z.number().int() },
      annotations: READ,
    },
    (p, { id }) => (t212(p, "GET", `/equity/pies/${id}`)),
  );

  // ===== ORDENS (escrita) =====

  server.registerTool(
    "place_market_order",
    {
      title: "Criar ordem de mercado",
      description:
        "Compra/vende já ao preço de mercado. Para compras, 'estimatedPrice' (preço atual aproximado) é obrigatório para validar o limite de segurança e converter 'value' em quantidade." +
        NO_RETRY,
      inputSchema: {
        ticker,
        side,
        quantity,
        value,
        estimatedPrice: z.number().positive().optional().describe("Preço atual aproximado (obrigatório em compras)."),
        extendedHours: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    async (p, a) => {
        assertCanWrite(p);
        const q = resolveQuantity({ side: a.side, quantity: a.quantity, value: a.value, price: a.estimatedPrice });
        return t212(p, "POST", "/equity/orders/market", { body: { ticker: a.ticker, quantity: q, extendedHours: a.extendedHours } });
    },
  );

  server.registerTool(
    "place_limit_order",
    {
      title: "Criar ordem limite",
      description:
        "Compra a limitPrice OU MENOS / vende a limitPrice OU MAIS. Serve para 'comprar quando o preço CAIR até X'. " +
        "Se o preço atual já estiver melhor que o limite, executa logo. Para 'comprar quando o preço SUBIR até X' usa place_stop_order." +
        NO_RETRY,
      inputSchema: { ticker, side, quantity, value, limitPrice: z.number().positive(), timeValidity },
      annotations: WRITE,
    },
    async (p, a) => {
        assertCanWrite(p);
        const q = resolveQuantity({ side: a.side, quantity: a.quantity, value: a.value, price: a.limitPrice });
        return t212(p, "POST", "/equity/orders/limit", {
          body: { ticker: a.ticker, quantity: q, limitPrice: a.limitPrice, timeValidity: a.timeValidity },
        });
    },
  );

  server.registerTool(
    "place_stop_order",
    {
      title: "Criar ordem stop",
      description:
        "Fica parada até o preço ATINGIR stopPrice e então executa a mercado. Compra: dispara quando o preço SOBE até X (ex.: 'se chegar a 100€ compra'). " +
        "Venda: dispara quando CAI até X (stop-loss)." +
        NO_RETRY,
      inputSchema: { ticker, side, quantity, value, stopPrice: z.number().positive(), timeValidity },
      annotations: WRITE,
    },
    async (p, a) => {
        assertCanWrite(p);
        const q = resolveQuantity({ side: a.side, quantity: a.quantity, value: a.value, price: a.stopPrice });
        return t212(p, "POST", "/equity/orders/stop", {
          body: { ticker: a.ticker, quantity: q, stopPrice: a.stopPrice, timeValidity: a.timeValidity },
        });
    },
  );

  server.registerTool(
    "place_stop_limit_order",
    {
      title: "Criar ordem stop-limit",
      description:
        "Quando o preço atinge stopPrice, cria uma ordem limite a limitPrice (controla o preço máximo/mínimo de execução)." + NO_RETRY,
      inputSchema: {
        ticker,
        side,
        quantity,
        value,
        stopPrice: z.number().positive(),
        limitPrice: z.number().positive(),
        timeValidity,
      },
      annotations: WRITE,
    },
    async (p, a) => {
        assertCanWrite(p);
        const q = resolveQuantity({ side: a.side, quantity: a.quantity, value: a.value, price: a.limitPrice });
        return t212(p, "POST", "/equity/orders/stop_limit", {
          body: { ticker: a.ticker, quantity: q, stopPrice: a.stopPrice, limitPrice: a.limitPrice, timeValidity: a.timeValidity },
        });
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancelar ordem pendente",
      description: "Cancela uma ordem ativa que ainda não foi executada.",
      inputSchema: { id: z.number().int() },
      annotations: WRITE,
    },
    async (p, { id }) => {
        assertCanWrite(p);
        await t212(p, "DELETE", `/equity/orders/${id}`);
        return { cancelled: id };
    },
  );

  // ===== PIES (escrita) =====

  const pieBody = {
    name: z.string().min(1),
    instrumentShares: z
      .record(z.string(), z.number().min(0).max(1))
      .describe("Pesos por ticker, somam 1. Ex.: {\"AAPL_US_EQ\":0.5,\"MSFT_US_EQ\":0.5}"),
    dividendCashAction: z.enum(["REINVEST", "TO_ACCOUNT_CASH"]).default("REINVEST"),
    icon: z.string().optional(),
    goal: z.number().positive().optional().describe("Valor-alvo do pie na moeda da conta."),
    endDate: z.string().optional().describe("Data-alvo ISO 8601, ex.: 2030-01-01T00:00:00Z"),
  };
  const checkWeights = (w: Record<string, number>) => {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.001) throw new Error(`Os pesos somam ${sum.toFixed(3)}; têm de somar 1.`);
  };

  server.registerTool(
    "create_pie",
    {
      title: "Criar pie",
      description: "Cria um pie com os pesos indicados (deprecated na API da T212, mas ainda disponível).",
      inputSchema: pieBody,
      annotations: SOFT_WRITE,
    },
    async (p, a) => {
        assertCanWrite(p);
        checkWeights(a.instrumentShares);
        return t212(p, "POST", "/equity/pies", { body: a });
    },
  );

  server.registerTool(
    "update_pie",
    {
      title: "Alterar pie",
      description: "Substitui a configuração de um pie existente (nome, pesos, objetivo...). Envia a configuração completa.",
      inputSchema: { id: z.number().int(), ...pieBody },
      annotations: WRITE,
    },
    async (p, { id, ...body }) => {
        assertCanWrite(p);
        checkWeights(body.instrumentShares);
        return t212(p, "POST", `/equity/pies/${id}`, { body });
    },
  );

  server.registerTool(
    "duplicate_pie",
    {
      title: "Duplicar pie",
      description: "Cria uma cópia de um pie existente.",
      inputSchema: { id: z.number().int(), name: z.string().optional(), icon: z.string().optional() },
      annotations: SOFT_WRITE,
    },
    async (p, { id, name, icon }) => {
        assertCanWrite(p);
        return t212(p, "POST", `/equity/pies/${id}/duplicate`, { body: { name, icon } });
    },
  );

  server.registerTool(
    "delete_pie",
    {
      title: "Apagar pie",
      description: "Apaga um pie. Ação irreversível — confirma com o utilizador antes.",
      inputSchema: { id: z.number().int() },
      annotations: WRITE,
    },
    async (p, { id }) => {
        assertCanWrite(p);
        await t212(p, "DELETE", `/equity/pies/${id}`);
        return { deleted: id };
    },
  );

  return base;
}
