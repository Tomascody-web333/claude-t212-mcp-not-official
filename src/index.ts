import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { authHandler } from "./auth";
import type { Env } from "./env";
import { createServer } from "./tools";

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider<Env>({
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
  // O URL a que o Claude se liga; todos os tokens ficam presos a ele.
  resourceMetadata: { resource: (env as Env).MCP_RESOURCE },
});
