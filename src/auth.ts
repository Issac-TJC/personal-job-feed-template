import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env, Principal } from "./types";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizedIssuer(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export async function authenticate(request: Request, env: Env): Promise<Principal> {
  const host = new URL(request.url).hostname;
  if (env.ENVIRONMENT === "development" && env.DEV_BYPASS_AUTH === "true" && (host === "localhost" || host === "127.0.0.1")) {
    return { sub: env.ALLOWED_USER_SUB || "local-user", scopes: ["jobfeed:read", "jobfeed:write", "jobfeed:resume"], token: "local-dev" };
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new AuthError("missing_token", 401);
  const token = header.slice(7);
  const issuer = normalizedIssuer(env.AUTH0_ISSUER);
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
    jwksByIssuer.set(issuer, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.AUTH0_AUDIENCE });
    if (!payload.sub || payload.sub !== env.ALLOWED_USER_SUB) throw new AuthError("owner_only", 403);
    const scopeClaim = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
    const permissionClaim = Array.isArray(payload.permissions) ? payload.permissions.filter((v): v is string => typeof v === "string") : [];
    return { sub: payload.sub, scopes: [...new Set([...scopeClaim, ...permissionClaim])], token, expiresAt: payload.exp };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("invalid_token", 401);
  }
}

export function requireScope(principal: Principal, scope: "jobfeed:read" | "jobfeed:write" | "jobfeed:resume"): void {
  if (!principal.scopes.includes(scope)) throw new AuthError(`missing_scope:${scope}`, 403);
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function protectedResourceMetadata(request: Request, env: Env): Response {
  const resource = new URL("/mcp", request.url).toString();
  return Response.json({
    resource,
    authorization_servers: [normalizedIssuer(env.AUTH0_ISSUER)],
    scopes_supported: ["jobfeed:read", "jobfeed:write", "jobfeed:resume"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/Issac-TJC/personal-job-feed-template",
  }, { headers: { "cache-control": "public, max-age=3600" } });
}

export function authErrorResponse(request: Request, env: Env, error: AuthError): Response {
  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", request.url).toString();
  const headers = new Headers({ "content-type": "application/json" });
  if (error.status === 401) headers.set("www-authenticate", `Bearer resource_metadata=\"${metadataUrl}\"`);
  return new Response(JSON.stringify({ error: error.message }), { status: error.status, headers });
}
