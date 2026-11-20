import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Optional: forces the public MCP URL (ends in /mcp). By default it is derived from the request. */
  MCP_RESOURCE?: string;
  MAX_ORDER_VALUE?: string;
  /** Optional (wrangler secret put SETUP_PASSWORD): password asked on the connect page. */
  SETUP_PASSWORD?: string;
}

export type T212Env = "demo" | "live";

export interface Account {
  apiKey: string;
  apiSecret: string;
}

/** What we store per connection (encrypted by the OAuth library). */
export interface Props extends Record<string, unknown> {
  userId: string;
  demo?: Account;
  live?: Account;
  /** If true, the LIVE account is read-only (DEMO stays unrestricted). */
  liveReadOnly: boolean;
}
