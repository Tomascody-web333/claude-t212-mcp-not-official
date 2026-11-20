# Trading 212 MCP (Cloudflare Worker)

A remote MCP server that lets Claude read and trade on your Trading 212 account
(Invest / Stocks ISA), with separate **DEMO** (simulated money) and **LIVE** (real money) accounts.

## Deploy
1. `npm install`
2. `npx wrangler login`
3. `npx wrangler deploy` — uses the `OAUTH_KV` namespace (id in `wrangler.jsonc`; on another account remove the `id` and wrangler creates a new one) and prints the URL (`https://t212-mcp.<subdomain>.workers.dev`)
4. (Optional, recommended) `npx wrangler secret put SETUP_PASSWORD` — password asked on the connect page

The public MCP URL (`<URL>/mcp`) is derived from the request; set `MCP_RESOURCE` only if you want to force it.

## Connect in Claude
Settings → Connectors → Add custom connector → URL `https://…/mcp`.
On the connect page choose **DEMO**, **LIVE** or **Both** and enter only the API key/secret you need.
When both are connected, every tool takes `account: demo | live` and Claude has to say which one.
Recommended: tick "LIVE account read-only" until you trust the setup, and set the write tools
(orders, pies) to "needs approval" in the connector's tool permissions.

## Tools
Read: `get_account_summary`, `get_positions`, `search_instruments`, `get_pending_orders`, `get_pending_order`,
`get_order_history`, `get_dividend_history`, `get_transactions`, `list_pies`, `get_pie`.
Write: `place_market_order`, `place_limit_order`, `place_stop_order`, `place_stop_limit_order`, `cancel_order`,
`create_pie`, `update_pie`, `duplicate_pie`, `delete_pie`.

"Buy when the price **rises** to X" → `place_stop_order`. "Buy when the price **falls** to X" → `place_limit_order`.

## Safety
- `MAX_ORDER_VALUE` (wrangler.jsonc): refuses buy orders worth more than this per order.
- "LIVE account read-only" on the connect page blocks orders/pies with real money (DEMO stays free).
- Keys are stored encrypted (workers-oauth-provider) and are never returned to Claude.
- Orders are never retried automatically (the Trading 212 API is not idempotent).
