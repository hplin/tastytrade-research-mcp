import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

export type EntraOAuthVerifierOptions = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  resource: string;
  requiredScope: string;
};

function httpsUrl(value: string, field: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${field} must be an HTTPS URL without credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${field} must not contain a query string or fragment.`);
  }
  return url;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty.`);
  return normalized;
}

function tokenScopes(payload: Record<string, unknown>): string[] {
  const claim =
    typeof payload.scp === "string"
      ? payload.scp
      : typeof payload.scope === "string"
        ? payload.scope
        : "";
  return [...new Set(claim.split(/\s+/).filter(Boolean))];
}

function stringClaim(
  payload: Record<string, unknown>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function createEntraTokenVerifier(
  options: EntraOAuthVerifierOptions,
  keySet?: JWTVerifyGetKey,
): OAuthTokenVerifier {
  const issuer = httpsUrl(options.issuer, "OAUTH_ISSUER").toString();
  const audience = requiredText(options.audience, "OAUTH_AUDIENCE");
  const resource = httpsUrl(options.resource, "MCP_PUBLIC_URL");
  const requiredScope = requiredText(
    options.requiredScope,
    "OAUTH_TOKEN_SCOPE",
  );
  const verificationKey =
    keySet ??
    createRemoteJWKSet(httpsUrl(options.jwksUrl, "OAUTH_JWKS_URL"), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const { payload } = await jwtVerify(token, verificationKey, {
        issuer,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
        clockTolerance: 5,
      });
      const scopes = tokenScopes(payload);
      if (!scopes.includes(requiredScope)) {
        throw new Error("Access token does not include the required scope.");
      }

      const clientId = stringClaim(
        payload,
        "azp",
        "appid",
        "client_id",
        "sub",
      );
      if (!clientId) {
        throw new Error("Access token does not identify its OAuth client.");
      }

      return {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        resource,
        extra: {
          subject: stringClaim(payload, "sub"),
          tenantId: stringClaim(payload, "tid"),
          objectId: stringClaim(payload, "oid"),
        },
      };
    },
  };
}
