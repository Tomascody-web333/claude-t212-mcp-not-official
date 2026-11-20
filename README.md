# Trading 212 MCP (Cloudflare Worker)

## Deploy
1. `npm install`
2. `npx wrangler login`
3. `npx wrangler deploy` — cria o KV `OAUTH_KV` sozinho e mostra o URL (`https://t212-mcp.<subdominio>.workers.dev`)
4. (Opcional, recomendado) `npx wrangler secret put SETUP_PASSWORD` — palavra-passe pedida na página de ligação

O URL público do MCP (`<URL>/mcp`) é deduzido do pedido; só precisas de `MCP_RESOURCE` se quiseres forçá-lo.

## Ligar no Claude
Definições → Conectores → Adicionar conector personalizado → URL `https://…/mcp`.
Abre a página de login: preenche as chaves da conta **DEMO** (dinheiro simulado), da **LIVE** (dinheiro real) ou das duas. Com as duas ligadas, cada tool recebe `account: demo | live` e o Claude tem de o indicar. Recomendado: marca "LIVE só em leitura" até confiares no setup.
Depois, em cada tool do conector, escolhe "Pedir aprovação" nas de escrita (ordens, pies).

## Segurança
- `MAX_ORDER_VALUE` (wrangler.jsonc): recusa compras acima deste valor por ordem.
- "LIVE só em leitura" na página de ligação bloqueia ordens/pies no dinheiro real (a DEMO continua livre).
- Chaves ficam cifradas (workers-oauth-provider); nunca são devolvidas ao Claude.
