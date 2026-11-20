import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { authHandler } from "./auth";
import type { Env } from "./env";
import { createServer } from "./tools";

const mcpHandler = createMcpHandler(createServer);

// The URL Claude connects to (every token is bound to it). If MCP_RESOURCE is not set it is derived
// from the request itself (https://<host>/mcp), so nothing needs to be configured.
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
