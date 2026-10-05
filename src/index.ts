import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { authenticate, AuthError, authErrorResponse, protectedResourceMetadata } from "./auth";
import { buildMcpServer } from "./mcp";
import type { Env } from "./types";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,mcp-protocol-version,mcp-session-id,last-event-id",
  "access-control-expose-headers": "mcp-session-id,mcp-protocol-version",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health") return Response.json({ ok: true, service: "personal-job-feed", version: "1.1.0" });
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") return protectedResourceMetadata(request, env);
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    try {
      const principal = await authenticate(request, env);
      const authInfo: AuthInfo = {
        token: principal.token, clientId: "chatgpt-personal-job-feed", scopes: principal.scopes,
        expiresAt: principal.expiresAt, resource: new URL(env.AUTH0_AUDIENCE), extra: { sub: principal.sub },
      };
      const handler = createMcpHandler(() => buildMcpServer(env, principal));
      const response = await handler.fetch(request, { authInfo });
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      if (error instanceof AuthError) return authErrorResponse(request, env, error);
      console.error(error);
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },
};
