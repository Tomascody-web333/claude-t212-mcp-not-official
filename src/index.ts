import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { authHandler } from "./auth";
import type { Env } from "./env";
import { createServer } from "./tools";

const mcpHandler = createMcpHandler(createServer);

// O URL a que o Claude se liga (todos os tokens ficam presos a ele). Se MCP_RESOURCE não estiver
// definido, deduz-se do próprio pedido (https://<host>/mcp), por isso não é preciso configurar nada.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(resource: string): OAuthProvider<Env> {
  let provider = providers.get(resource);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      apiRoute: "/mcp",
      apiHandler: {
        fetch(request: Request, e: Env, ctx: ExecutionContext) {
          return mcpHandler(request, e, ctx);
        },
      },
      defaultHandler: authHandler,
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource },
    });
    providers.set(resource, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const configured = env.MCP_RESOURCE?.trim();
    const resource = configured ? configured : `${new URL(request.url).origin}/mcp`;
    return providerFor(resource).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
