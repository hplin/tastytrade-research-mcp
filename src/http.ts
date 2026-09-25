import { requireEnv } from "./config.js";
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
const httpServer = createResearchHttpServer({
  apiKey: requireEnv("MCP_API_KEY"),
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
