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

/** Credentials already resolved for ONE account (demo or live). */
interface Ctx {
  apiKey: string;
  apiSecret: string;
  env: T212Env;
  readOnly: boolean;
  /** Risky mode: no per-order value cap. */
  noCap: boolean;
  userId: string;
}

function resolve(account?: T212Env): Ctx {
  const p = getMcpAuthContext()?.props as Props | undefined;
  if (!p || (!p.demo && !p.live)) throw new Error("No session: reconnect the connector in Claude.");
  const configured = (["demo", "live"] as const).filter((k) => p[k]);
  const chosen = account ?? (configured.length === 1 ? configured[0] : undefined);
  if (!chosen) {
    throw new Error("Specify 'account': \"demo\" (simulated money) or \"live\" (real money). I will not guess which one.");
  }
  const creds = p[chosen];
  if (!creds) throw new Error(`The ${chosen.toUpperCase()} account is not connected. Reconnect the connector and enter those keys.`);
  return { ...creds, env: chosen, readOnly: chosen === "live" && p.liveReadOnly, noCap: p.noOrderCap === true, userId: p.userId };
}

/** Runs a tool, turning errors into readable responses for Claude. */
async function run(account: T212Env | undefined, fn: (c: Ctx) => Promise<unknown>) {
  try {
    return json(await fn(resolve(account)));
  } catch (e) {
    if (e instanceof T212Error) return fail(`Trading 212 error ${e.message}`);
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Blocks write actions when the account is in read-only mode. */
function assertCanWrite(c: Ctx) {
  if (c.readOnly) {
    throw new Error(
      "The LIVE account is in READ-ONLY mode. Reconnect the connector without that option to place/cancel orders or manage pies with real money.",
    );
  }
}

function maxOrderValue(): number {
  const n = Number((env as Env).MAX_ORDER_VALUE ?? "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** quantity OR value (amount) -> quantity; applies the safety cap on buys. */
function resolveQuantity(args: {
  side: "buy" | "sell";
  quantity?: number;
  value?: number;
  price?: number; // reference price (limit/stop/estimated)
  noCap?: boolean; // risky mode: skip the MAX_ORDER_VALUE check
}): number {
  const { side, quantity, value, price, noCap } = args;
  if ((quantity === undefined) === (value === undefined)) {
    throw new Error("Provide exactly one of: quantity (number of shares) or value (amount in the account currency).");
  }
  let qty = quantity;
  if (qty === undefined) {
    if (!price) throw new Error("Using 'value' requires a reference price.");
    qty = Math.floor(((value as number) / price) * 1e4) / 1e4;
  }
  if (!(qty > 0)) throw new Error("The resulting quantity is 0: increase the amount or give the quantity directly.");
  if (side === "buy") {
    if (!price) throw new Error("Buys require a price (limit/stop/estimated) to check the safety cap.");
    const notional = qty * price;
    const cap = maxOrderValue();
    if (!noCap && notional > cap) {
      throw new Error(
        `Refused: the order is worth ~${notional.toFixed(2)}, above the safety cap MAX_ORDER_VALUE=${cap}. ` +
          `To allow bigger orders the user can reconnect the connector with "Risky mode" (requires the setup password) or raise MAX_ORDER_VALUE on the Worker. Do not split the order to get around the cap.`,
      );
    }
  }
  return side === "buy" ? qty : -qty;
}

const account = z
  .enum(["demo", "live"])
  .optional()
  .describe(
    "demo = SIMULATED money, live = REAL money. Required when both accounts are connected; ask the user if in doubt.",
  );
const ticker = z.string().describe("Trading 212 ticker, e.g. AAPL_US_EQ (use search_instruments to find it).");
const side = z.enum(["buy", "sell"]).describe("buy or sell");
const quantity = z.number().positive().optional().describe("Number of shares (fractions allowed). Use quantity OR value.");
const value = z.number().positive().optional().describe("Amount to invest in the account currency (e.g. 10). Use quantity OR value.");
const timeValidity = z
  .enum(["DAY", "GOOD_TILL_CANCEL"])
  .default("GOOD_TILL_CANCEL")
  .describe("DAY = expires at the end of the day; GOOD_TILL_CANCEL = stays active until cancelled.");

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const SOFT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const NO_RETRY =
  " The Trading 212 API is not idempotent: if there is an error or timeout, check get_pending_orders before retrying.";

// ---------- guide shown to the model when it connects ----------

const INSTRUCTIONS = `Unofficial Trading 212 server (Invest and Stocks ISA accounts only). Read this before using the tools.

ACCOUNTS
- DEMO = simulated money, LIVE = real money. If both are connected, every tool needs 'account' ("demo" or "live"). Never guess: ask the user.
- Before any write on LIVE, state what you are about to do (ticker, side, quantity/amount, price, order type) and wait for the user's confirmation.
- The LIVE account may be read-only (writes are refused), and buys are capped per order (MAX_ORDER_VALUE) unless the user connected in Risky mode. Do not try to split an order to get around the cap; if an order is refused for size, tell the user how to allow it (Risky mode or a higher MAX_ORDER_VALUE).
- Amounts are in the account currency (check get_account_summary). The API only trades in that currency.

FINDING TICKERS AND PRICES
- Orders need the Trading 212 ticker (e.g. AAPL_US_EQ, NOS_PT_EQ, VUAGl_EQ). Find it with search_instruments (name, short name or ISIN). The same company can have several tickers (different exchange/currency): pick the one in the user's account currency when possible.
- There is no live quote tool. For a stock the user already owns, get_positions has currentPrice. Otherwise ask the user for the price. Buys by 'value' and market buys need a price to convert the amount to a quantity and to check the cap.

CONDITIONAL ORDERS ("when X reaches Y, buy Z")
- You cannot watch prices, so place a resting order that Trading 212 executes later:
  - Buy when the price RISES to Y -> place_stop_order (side buy, stopPrice Y).
  - Buy when the price FALLS to Y -> place_limit_order (side buy, limitPrice Y).
  - Sell when the price FALLS to Y (stop-loss) -> place_stop_order (side sell).
  - Sell when the price RISES to Y (take-profit) -> place_limit_order (side sell).
  - place_stop_limit_order = stop that then becomes a limit order (caps the execution price).
- timeValidity: DAY expires at the end of the day, GOOD_TILL_CANCEL stays until cancelled (default).
- Give quantity (number of shares, fractions allowed) OR value (amount in account currency), never both. Sells are sent as negative quantities by the server: just use side "sell".
- Always show the user the resulting order and check it with get_pending_orders. Cancel with cancel_order (needs the order id).

ERRORS AND SAFETY
- The Trading 212 API is NOT idempotent. After a timeout (408) or any unclear error on an order, call get_pending_orders / get_order_history BEFORE retrying, or you may create a duplicate order.
- 429 = rate limit. Wait the time given in the message and retry only reads. Limits are strict (for example roughly one request per few seconds on some endpoints and about 30 s for listing pies), so do not call tools in a loop.
- 403 = the API key lacks that permission (the user enables it in Trading 212 Settings > API). 401 = wrong key or wrong environment (demo and live keys are different).

PIES
- Pie endpoints are deprecated by Trading 212 but still work. Pies created here start empty: this server has no tool to move money into a pie.
- instrumentShares are fractions that must sum to exactly 1 (e.g. {"AAPL_US_EQ":0.5,"MSFT_US_EQ":0.5}). dividendCashAction is REINVEST or TO_ACCOUNT_CASH. Optional: icon (a Trading 212 icon name such as "Coins"), goal (target value), endDate (ISO 8601).
- update_pie replaces the whole configuration: send every field again. delete_pie cannot be undone: confirm first. Shares held inside a pie are not available for normal orders (see quantityInPies in get_positions).

PAGINATION
- get_order_history, get_dividend_history and get_transactions are paginated: use the cursor / nextPagePath from the previous response for the next page.

Nothing here is financial advice. Do not recommend trades; execute what the user asks.`;

// ---------- server ----------

export function createServer(): McpServer {
  const base = new McpServer({ name: "trading212", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  // Every tool gets an 'account' argument (demo/live) and a resolved context.
  const server = {
    registerTool(name: string, config: any, handler: (c: Ctx, args: any) => Promise<unknown>) {
      base.registerTool(
        name,
        { ...config, inputSchema: { account, ...(config.inputSchema ?? {}) } },
        (args: any) => run(args?.account, (c) => handler(c, args ?? {})),
      );
    },
  };

  // ===== READ =====

  server.registerTool(
    "get_account_summary",
    {
      title: "View account summary",
      description:
        "Available cash, invested amount, total value and profit/loss of the account, with its currency. Use it first to see how much cash is available and in which currency. Strict rate limit: do not call it repeatedly.",
      annotations: READ,
    },
    (p) => t212(p, "GET", "/equity/account/summary"),
  );

  server.registerTool(
    "get_positions",
    {
      title: "View my holdings (positions)",
      description:
        "Lists open positions: ticker, quantity, average price paid, currentPrice (in the instrument currency), quantityInPies (shares inside pies are not free to trade) and profit/loss converted to the account currency. Optionally filter by ticker. This is also the way to get the current price of a stock the user already owns.",
      inputSchema: { ticker: ticker.optional() },
      annotations: READ,
    },
    (p, { ticker }) => t212(p, "GET", "/equity/positions", { query: { ticker } }),
  );

  server.registerTool(
    "search_instruments",
    {
      title: "Search stocks/ETFs",
      description:
        "Searches instruments by name, ticker or ISIN and returns the Trading 212 ticker (needed for orders). Results are cached for 1 hour.",
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
      const q = (query as string).toLowerCase();
      return list
        .filter((i) => ["ticker", "name", "shortName", "isin"].some((k) => String(i[k] ?? "").toLowerCase().includes(q)))
        .slice(0, limit);
    },
  );

  server.registerTool(
    "get_pending_orders",
    {
      title: "View pending orders",
      description:
        "Lists active orders that are not yet filled, cancelled or expired (including your stop/limit orders waiting for a price). Use it to verify an order was created and to get order ids for cancel_order.",
      annotations: READ,
    },
    (p) => t212(p, "GET", "/equity/orders"),
  );

  server.registerTool(
    "get_pending_order",
    {
      title: "View one pending order",
      description: "Details of one active order by its numeric id (from get_pending_orders).",
      inputSchema: { id: z.number().int() },
      annotations: READ,
    },
    (p, { id }) => t212(p, "GET", `/equity/orders/${id}`),
  );

  server.registerTool(
    "get_order_history",
    {
      title: "View order history",
      description:
        "History of past orders (filled, cancelled, rejected), newest first, paginated. Use the cursor / nextPagePath from the response to get the next page. For orders still waiting, use get_pending_orders instead.",
      inputSchema: {
        ticker: ticker.optional(),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.number().int().optional(),
      },
      annotations: READ,
    },
    (p, { ticker, limit, cursor }) => t212(p, "GET", "/equity/history/orders", { query: { ticker, limit, cursor } }),
  );

  server.registerTool(
    "get_dividend_history",
    {
      title: "View dividends received",
      description: "Dividends received, paginated (use the cursor / nextPagePath from the response for the next page). Amounts are in the account currency.",
      inputSchema: {
        ticker: ticker.optional(),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.number().int().optional(),
      },
      annotations: READ,
    },
    (p, { ticker, limit, cursor }) => t212(p, "GET", "/equity/history/dividends", { query: { ticker, limit, cursor } }),
  );

  server.registerTool(
    "get_transactions",
    {
      title: "View deposits and withdrawals",
      description: "Deposits, withdrawals and other cash movements of the account, paginated (use the cursor / nextPagePath from the response for the next page).",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20), cursor: z.string().optional() },
      annotations: READ,
    },
    (p, { limit, cursor }) => t212(p, "GET", "/equity/history/transactions", { query: { limit, cursor } }),
  );

  server.registerTool(
    "list_pies",
    {
      title: "View my pies",
      description:
        "Lists all pies with their id, cash, result and progress (no names or holdings: use get_pie for those). Trading 212 marks the pie endpoints as deprecated. Strict rate limit (about one call per 30 s).",
      annotations: READ,
    },
    (p) => t212(p, "GET", "/equity/pies"),
  );

  server.registerTool(
    "get_pie",
    {
      title: "View pie details",
      description:
        "Composition and settings of one pie by id: each instrument's target share (expectedShare) vs current share, owned quantity, plus name, icon, goal and dividend action. Get ids from list_pies.",
      inputSchema: { id: z.number().int() },
      annotations: READ,
    },
    (p, { id }) => t212(p, "GET", `/equity/pies/${id}`),
  );

  // ===== ORDERS (write) =====

  server.registerTool(
    "place_market_order",
    {
      title: "Place market order",
      description:
        "Buys/sells immediately at the market price (executes right away when the market is open; otherwise at the next open). For buys, 'estimatedPrice' (approximate current price, from get_positions or the user) is required to check the safety cap and to convert 'value' into a quantity. Use quantity OR value. To buy at a target price later, use place_limit_order or place_stop_order instead." +
        NO_RETRY,
      inputSchema: {
        ticker,
        side,
        quantity,
        value,
        estimatedPrice: z.number().positive().optional().describe("Approximate current price (required for buys)."),
        extendedHours: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    async (p, a) => {
      assertCanWrite(p);
      const q = resolveQuantity({ side: a.side, quantity: a.quantity, value: a.value, price: a.estimatedPrice, noCap: p.noCap });
      return t212(p, "POST", "/equity/orders/market", {
        body: { ticker: a.ticker, quantity: q, extendedHours: a.extendedHours },
      });
    },
  );

  server.registerTool(
    "place_limit_order",
    {
      title: "Place limit order",
      description:
        "Buys at limitPrice OR LOWER / sells at limitPrice OR HIGHER. Use it for 'buy when the price FALLS to X'. " +
        "If the current price is already better than the limit it fills right away. For 'buy when the price RISES to X' use place_stop_order." +
        NO_RETRY,
      inputSchema: { ticker, side, quantity, value, limitPrice: z.number().positive(), timeValidity },
      annotations: WRITE,
    },
    async (p, a) => {
      assertCanWrite(p);
      const q = resolveQuantity({ side: a.side, quantity: a.quantity, value: a.value, price: a.limitPrice, noCap: p.noCap });
      return t212(p, "POST", "/equity/orders/limit", {
        body: { ticker: a.ticker, quantity: q, limitPrice: a.limitPrice, timeValidity: a.timeValidity },
      });
    },
  );

  server.registerTool(
    "place_stop_order",
    {
      title: "Place stop order",
      description:
        "Stays idle until the price REACHES stopPrice, then executes at market. Buy: triggers when the price RISES to X (e.g. 'if it reaches 100, buy'). " +
        "Sell: triggers when it FALLS to X (stop-loss)." +
        NO_RETRY,
      inputSchema: { ticker, side, quantity, value, stopPrice: z.number().positive(), timeValidity },
      annotations: WRITE,
    },
    async (p, a) => {
      assertCanWrite(p);
      const q = resolveQuantity({ side: a.side, quantity: a.quantity, value: a.value, price: a.stopPrice, noCap: p.noCap });
      return t212(p, "POST", "/equity/orders/stop", {
        body: { ticker: a.ticker, quantity: q, stopPrice: a.stopPrice, timeValidity: a.timeValidity },
      });
    },
  );

  server.registerTool(
    "place_stop_limit_order",
    {
      title: "Place stop-limit order",
      description:
        "When the price reaches stopPrice, creates a limit order at limitPrice (controls the maximum/minimum execution price)." +
        NO_RETRY,
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
      const q = resolveQuantity({ side: a.side, quantity: a.quantity, value: a.value, price: a.limitPrice, noCap: p.noCap });
      return t212(p, "POST", "/equity/orders/stop_limit", {
        body: { ticker: a.ticker, quantity: q, stopPrice: a.stopPrice, limitPrice: a.limitPrice, timeValidity: a.timeValidity },
      });
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel pending order",
      description: "Cancels an active order that has not been filled yet. Needs the order id from get_pending_orders. Orders already filled cannot be cancelled.",
      inputSchema: { id: z.number().int() },
      annotations: WRITE,
    },
    async (p, { id }) => {
      assertCanWrite(p);
      await t212(p, "DELETE", `/equity/orders/${id}`);
      return { cancelled: id };
    },
  );

  // ===== PIES (write) =====

  const pieBody = {
    name: z.string().min(1),
    instrumentShares: z
      .record(z.string(), z.number().min(0).max(1))
      .describe('Weights per ticker, summing to 1. E.g. {"AAPL_US_EQ":0.5,"MSFT_US_EQ":0.5}'),
    dividendCashAction: z.enum(["REINVEST", "TO_ACCOUNT_CASH"]).default("REINVEST"),
    icon: z.string().optional(),
    goal: z.number().positive().optional().describe("Target value of the pie in the account currency."),
    endDate: z.string().optional().describe("Target date, ISO 8601, e.g. 2030-01-01T00:00:00Z"),
  };
  // Only the pie fields go to Trading 212 (never the 'account' argument, or the API answers "Invalid payload").
  const pieFields = (a: any) => ({
    name: a.name,
    instrumentShares: a.instrumentShares,
    dividendCashAction: a.dividendCashAction,
    icon: a.icon,
    goal: a.goal,
    endDate: a.endDate,
  });
  const checkWeights = (w: Record<string, number>) => {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.001) throw new Error(`The weights sum to ${sum.toFixed(3)}; they must sum to 1.`);
  };

  server.registerTool(
    "create_pie",
    {
      title: "Create pie",
      description:
        "Creates a pie. instrumentShares are fractions that sum to 1. The pie starts empty (no money is invested into it by this tool). Deprecated in the Trading 212 API but still available. Optional icon (e.g. \"Coins\"), goal and endDate (ISO 8601)." + NO_RETRY,
      inputSchema: pieBody,
      annotations: SOFT_WRITE,
    },
    async (p, a) => {
      assertCanWrite(p);
      checkWeights(a.instrumentShares);
      return t212(p, "POST", "/equity/pies", { body: pieFields(a) });
    },
  );

  server.registerTool(
    "update_pie",
    {
      title: "Update pie",
      description: "Replaces the whole configuration of an existing pie (name, weights, dividend action, goal, end date). Send every field again, not only the changed ones. Weights must sum to 1.",
      inputSchema: { id: z.number().int(), ...pieBody },
      annotations: WRITE,
    },
    async (p, a) => {
      assertCanWrite(p);
      checkWeights(a.instrumentShares);
      return t212(p, "POST", `/equity/pies/${a.id}`, { body: pieFields(a) });
    },
  );

  server.registerTool(
    "duplicate_pie",
    {
      title: "Duplicate pie",
      description: "Creates a copy of an existing pie, optionally with a new name and icon.",
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
      title: "Delete pie",
      description: "Deletes a pie. This cannot be undone: confirm with the user first.",
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
