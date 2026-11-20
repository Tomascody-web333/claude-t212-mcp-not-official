import type { T212Env } from "./env";

const BASE = {
  demo: "https://demo.trading212.com/api/v0",
  live: "https://live.trading212.com/api/v0",
} as const;

export class T212Error extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Creds = { apiKey: string; apiSecret: string; env: T212Env };

function explain(status: number, body: string, headers: Headers): string {
  const detail = body.slice(0, 500);
  switch (status) {
    case 401:
      return "401: API key/secret inválidas, ou a chave é de outro ambiente (as chaves DEMO e LIVE são diferentes).";
    case 403:
      return `403: a chave não tem permissão para esta operação (ativa a permissão certa em Definições > API na T212). ${detail}`;
    case 408:
      return "408: timeout da T212. NÃO repitas a ordem às cegas: chama get_pending_orders para ver se foi criada.";
    case 429: {
      const reset = headers.get("x-ratelimit-reset");
      return `429: limite de pedidos da T212 atingido${reset ? ` (repete após ${reset})` : ""}. Espera uns segundos.`;
    }
    default:
      return `${status}: ${detail}`;
  }
}

export async function t212<T = unknown>(
  creds: Creds,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(BASE[creds.env] + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Basic " + btoa(`${creds.apiKey}:${creds.apiSecret}`),
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new T212Error(res.status, explain(res.status, text, res.headers));
  return (text ? JSON.parse(text) : null) as T;
}
