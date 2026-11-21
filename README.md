# Trading 212 MCP server (Cloudflare Worker)

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude read and trade on your
Trading 212 account (Invest / Stocks ISA). It runs on your own Cloudflare account, supports
**DEMO** (simulated money) and **LIVE** (real money) in the same connector, and exposes every action
as a separate tool so you can set permissions per tool in Claude (e.g. "needs approval" for orders).

> **Unofficial project.** Not affiliated with, endorsed by or supported by Trading 212.
> Uses the public Trading 212 API (v0, beta). **LIVE mode can place real orders with real money.**
> Use at your own risk, start with DEMO, and read the [Safety](#safety) section. Nothing here is financial advice.

## What you can ask Claude

- "Show my positions / pies / pending orders / dividends."
- "If NOS reaches 6 €, buy 10 € worth." (Claude cannot watch prices, so it places a stop/limit order for you.)
- "Create a pie with 60% X and 40% Y."

## Requirements

- A Cloudflare account (the free plan is enough).
- Node.js 20+ and `npm`.
- A Trading 212 API key + secret (Trading 212 app → Settings → API). Create separate keys for DEMO and LIVE
  and grant only the permissions you need (read-only if you just want to look).
- A Claude plan that supports custom connectors.

## Deploy

```bash
git clone <this-repo> && cd <this-repo>
npm install
npx wrangler login

# 1. Create your own KV namespace (stores OAuth state and encrypted credentials)
npx wrangler kv namespace create OAUTH_KV
#    -> copy the printed id into wrangler.jsonc (kv_namespaces[0].id), replacing the existing one

# 2. (Optional, recommended) password asked on the connect page
npx wrangler secret put SETUP_PASSWORD

# 3. Deploy
npx wrangler deploy
```

Wrangler prints your URL, e.g. `https://t212-mcp.<your-subdomain>.workers.dev`.
The MCP endpoint is that URL plus `/mcp`.

You can also deploy from GitHub with Cloudflare **Workers Builds** (build command: none/`npm install`,
deploy command: `npx wrangler deploy`). Every push to `main` then redeploys automatically.

Change the worker name in `wrangler.jsonc` if you want a different URL.

## Connect in Claude

1. Settings → Connectors → **Add custom connector**.
2. URL: `https://<your-worker>.workers.dev/mcp` (leave the OAuth client fields empty).
3. A page opens. Choose **DEMO**, **LIVE** or **Both**, and enter only the API key and secret you need
   (plus the setup password if you set one).
4. The keys are validated against Trading 212 before the connection is approved.

When both accounts are connected, every tool takes `account: demo | live` and Claude has to say which one.

Recommended: tick **"LIVE account read-only"** until you trust the setup, and set the write tools
(orders and pies) to **"needs approval"** in the connector's tool permissions.

## Tools

| Type | Tools |
| --- | --- |
| Read | `get_account_summary`, `get_positions`, `search_instruments`, `get_pending_orders`, `get_pending_order`, `get_order_history`, `get_dividend_history`, `get_transactions`, `list_pies`, `get_pie` |
| Write | `place_market_order`, `place_limit_order`, `place_stop_order`, `place_stop_limit_order`, `cancel_order`, `create_pie`, `update_pie`, `duplicate_pie`, `delete_pie` |

Orders take either a `quantity` or a `value` (amount to spend). Buys by value need a price estimate,
so they are limited by the safety cap below. Sells use a negative quantity internally.

Conditional orders:

- "Buy when the price **rises** to X" → `place_stop_order`
- "Buy when the price **falls** to X" → `place_limit_order`
- Pie weights must sum to 1.

## Safety

- `MAX_ORDER_VALUE` (`wrangler.jsonc`, default `100`): refuses buy orders worth more than this per order,
  in the account currency. Lower it, or raise it deliberately.
- **LIVE account read-only** (connect page): blocks orders and pies with real money. DEMO stays unrestricted.
- Per-tool permissions in Claude: keep write tools on "needs approval" and read the order before approving.
- API keys are stored encrypted at rest ([workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider))
  and are never returned to Claude.
- Orders are never retried automatically (the Trading 212 API is not idempotent), so a timeout will not double-buy.
- The connect page sets a strict CSP, `X-Frame-Options: DENY` and `no-store`.
- Anyone who can complete the connect page with valid API keys can connect to *their own* account only;
  set `SETUP_PASSWORD` to stop strangers from using your Worker URL at all.

## Limits and notes

- Trading 212 rate limits apply (for example about 1 request per 5 s on the account summary and
  1 per 2 s for limit-type orders). Claude gets a clear message when a limit is hit.
- The pies endpoints are deprecated by Trading 212 and may stop working.
- Prices reflect what the API returns; they can be delayed and are not a trading signal.

## Develop

```bash
npm run dev         # wrangler dev
npm run typecheck   # tsc --noEmit
```

Layout: `src/index.ts` (OAuth provider + MCP routing), `src/auth.ts` (connect page and key validation),
`src/tools.ts` (all MCP tools), `src/t212.ts` (Trading 212 API client), `src/env.ts` (types).

## Environment

| Name | Where | Purpose |
| --- | --- | --- |
| `OAUTH_KV` | KV binding | OAuth state and encrypted credentials (required) |
| `MAX_ORDER_VALUE` | var | Per-order cap for buys (default `100`) |
| `SETUP_PASSWORD` | secret | Optional password on the connect page |
| `MCP_RESOURCE` | var | Optional override of the public MCP URL (normally derived from the request) |

## License

No license file is included yet. Add one (for example MIT) before publishing if you want others to reuse the code.
