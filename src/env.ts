import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Opcional: força o URL público do MCP (acaba em /mcp). Por defeito deduz-se do pedido. */
  MCP_RESOURCE?: string;
  MAX_ORDER_VALUE?: string;
  /** Opcional (wrangler secret put SETUP_PASSWORD): palavra-passe pedida na página de ligação. */
  SETUP_PASSWORD?: string;
}

export type T212Env = "demo" | "live";

export interface Account {
  apiKey: string;
  apiSecret: string;
}

/** O que guardamos (cifrado pela biblioteca OAuth) por ligação. */
export interface Props extends Record<string, unknown> {
  userId: string;
  demo?: Account;
  live?: Account;
  /** Se true, a conta LIVE só permite leitura (a DEMO continua livre). */
  liveReadOnly: boolean;
}
