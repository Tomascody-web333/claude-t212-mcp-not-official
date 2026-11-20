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

/** x-ratelimit-reset is in seconds since 1970; returns how many seconds are left. */
function secondsUntilReset(headers: Headers): number | undefined {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset) || reset < 1e9) return undefined;
  return Math.max(1, Math.ceil(reset - Date.now() / 1000));
}

function explain(status: number, body: string, headers: Headers): string {
  const detail = body.slice(0, 500);
  switch (status) {
    case 401:
      return "401: invalid API key/secret, or the key belongs to another environment (DEMO and LIVE keys are different).";
    case 403:
      return `403: the key does not have permission for this operation (enable the right permission in Trading 212 Settings > API). ${detail}`;
    case 408:
      return "408: Trading 212 timed out. Do NOT blindly repeat the order: call get_pending_orders to check whether it was created.";
    case 429: {
      const wait = secondsUntilReset(headers);
      return `429: Trading 212 rate limit reached${wait ? ` (try again in ~${wait}s)` : ""}. Wait a few seconds.`;
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
  const send = () =>
    fetch(url, {
      method,
      headers: {
        Authorization: "Basic " + btoa(`${creds.apiKey}:${creds.apiSecret}`),
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  const t0 = Date.now(); // TEMP-LOG
  let res = await send();
  // Reads (GET) are safe to repeat: if the limit resets within a few seconds, wait and retry once.
  if (res.status === 429 && method === "GET") {
    const wait = secondsUntilReset(res.headers);
    if (wait !== undefined && wait <= 8) {
      await new Promise((r) => setTimeout(r, wait * 1000 + 300));
      res = await send();
    }
  }
  console.log(`[t212] ${creds.env} ${method} ${path} -> ${res.status} in ${Date.now() - t0}ms`); // TEMP-LOG
  const text = await res.text();
  if (!res.ok) throw new T212Error(res.status, explain(res.status, text, res.headers));
  return (text ? JSON.parse(text) : null) as T;
}
