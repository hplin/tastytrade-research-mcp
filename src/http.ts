import { requireEnv } from "./config.js";
import { createEntraTokenVerifier } from "./entra-oauth.js";
import { createResearchHttpServer } from "./http-server.js";

function httpPort(): number {
  const raw = process.env.MCP_HTTP_PORT?.trim() || "8000";
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP_HTTP_PORT must be an integer from 1 through 65535.");
  }
  return port;
}

for (const name of [
  "TASTYTRADE_CLIENT_ID",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
]) {
  requireEnv(name);
}

const host = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
const port = httpPort();
const authMode = process.env.MCP_AUTH_MODE?.trim().toLowerCase() || "api-key";
const auth =
  authMode === "api-key"
    ? {
        type: "api-key" as const,
        apiKey: requireEnv("MCP_API_KEY"),
      }
    : authMode === "oauth"
      ? (() => {
          const resource = requireEnv("MCP_PUBLIC_URL");
          const issuer = requireEnv("OAUTH_ISSUER");
          const audience = requireEnv("OAUTH_AUDIENCE");
          const jwksUrl = requireEnv("OAUTH_JWKS_URL");
          const requiredScope = requireEnv("OAUTH_REQUIRED_SCOPE");
          const tokenScope =
            process.env.OAUTH_TOKEN_SCOPE?.trim() ||
            requiredScope.split("/").at(-1) ||
            requiredScope;
          return {
            type: "oauth" as const,
            resource,
            issuer,
            requiredScope,
            resourceName:
              process.env.OAUTH_RESOURCE_NAME?.trim() ||
              "Tastytrade Research MCP",
            verifier: createEntraTokenVerifier({
              issuer,
              audience,
              jwksUrl,
              resource,
              requiredScope: tokenScope,
            }),
          };
        })()
      : (() => {
          throw new Error(
            "MCP_AUTH_MODE must be either api-key or oauth.",
          );
        })();
const httpServer = createResearchHttpServer({
  auth,
});

await new Promise<void>((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(port, host, () => {
    httpServer.off("error", reject);
    resolve();
  });
});

console.error(
  `tastytrade-research-mcp HTTP listening on http://${host}:${port}`,
);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  httpServer.close((error) => {
    if (error) {
      console.error("HTTP shutdown failed.", error);
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
