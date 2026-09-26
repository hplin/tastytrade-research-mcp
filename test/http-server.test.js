import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { createResearchHttpServer } from "../dist/http-server.js";

const API_KEY = "test-api-key-0123456789abcdef0123456789abcdef";
const openServers = new Set();

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  openServers.add(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function fakeServices() {
  return {
    backtester: {
      getAvailableDates: jest.fn(async () => []),
      listBacktests: jest.fn(async () => []),
      createBacktest: jest.fn(async () => ({ id: "job-1" })),
      getBacktest: jest.fn(async () => ({ id: "job-1" })),
      getBacktestLogs: jest.fn(async () => ({ trials: [] })),
      cancelBacktest: jest.fn(async () => ""),
      simulateTrade: jest.fn(async () => ({ snapshots: [] })),
    },
    candles: {
      getHistoricalCandles: jest.fn(async () => ({
        candles: [],
        resampled: false,
      })),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  openServers.clear();
});

describe("MCP HTTP server", () => {
  test("exposes a public health check and protects MCP with bearer auth", async () => {
    const baseUrl = await listen(
      createResearchHttpServer({
        apiKey: API_KEY,
        services: fakeServices(),
      }),
    );

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      service: "tastytrade-research-mcp",
    });

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("serves all tools over authenticated Streamable HTTP", async () => {
    const baseUrl = await listen(
      createResearchHttpServer({
        apiKey: API_KEY,
        services: fakeServices(),
      }),
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${API_KEY}` },
        },
      },
    );
    const client = new Client({
      name: "http-test-client",
      version: "1.0.0",
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(17);

      const result = await client.callTool({
        name: "tastytrade_price_option_package",
        arguments: {
          request: {
            family: "CREDIT_VERTICAL",
            evaluated_at: "2026-09-24T20:00:00.000Z",
            legs: [
              {
                symbol: "SHORT",
                action: "SELL_TO_OPEN",
                quantity: 1,
                expiration: "2026-10-16T20:00:00.000Z",
                bid: "2",
                ask: "2.1",
                as_of: "2026-09-24T20:00:00.000Z",
                source: "fixture",
              },
              {
                symbol: "LONG",
                action: "BUY_TO_OPEN",
                quantity: 1,
                expiration: "2026-10-16T20:00:00.000Z",
                bid: "0.9",
                ask: "1",
                as_of: "2026-09-24T20:00:00.000Z",
                source: "fixture",
              },
            ],
          },
        },
      });
      const text = result.content.find((item) => item.type === "text")?.text;
      expect(JSON.parse(text).synthetic_natural).toMatchObject({
        value: "1",
        price_effect: "CREDIT",
      });
    } finally {
      await client.close();
    }
  });

  test("publishes OAuth metadata and accepts a verified bearer token", async () => {
    const verifier = {
      verifyAccessToken: jest.fn(async (token) => {
        if (token !== "valid-oauth-token") {
          throw new Error("invalid token");
        }
        return {
          token,
          clientId: "chatgpt-client",
          scopes: ["mcp.read"],
          expiresAt: 2_000_000_000,
          resource: new URL("https://research.example.com/mcp"),
        };
      }),
    };
    const baseUrl = await listen(
      createResearchHttpServer({
        auth: {
          type: "oauth",
          resource: "https://research.example.com/mcp",
          issuer:
            "https://login.microsoftonline.com/tenant-id/v2.0",
          requiredScope: "api://resource-app-id/mcp.read",
          resourceName: "Research MCP",
          verifier,
        },
        services: fakeServices(),
      }),
    );

    const metadata = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource`,
    );
    await expect(metadata.json()).resolves.toEqual({
      resource: "https://research.example.com/mcp",
      authorization_servers: [
        "https://login.microsoftonline.com/tenant-id/v2.0",
      ],
      scopes_supported: ["api://resource-app-id/mcp.read"],
      bearer_methods_supported: ["header"],
      resource_name: "Research MCP",
    });
    const pathMetadata = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(pathMetadata.status).toBe(200);

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      `resource_metadata="https://research.example.com/.well-known/oauth-protected-resource"`,
    );
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      `scope="api://resource-app-id/mcp.read"`,
    );
    const invalidToken = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-oauth-token",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(invalidToken.status).toBe(401);

    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        requestInit: {
          headers: { Authorization: "Bearer valid-oauth-token" },
        },
      },
    );
    const client = new Client({
      name: "oauth-http-test-client",
      version: "1.0.0",
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(17);
      expect(verifier.verifyAccessToken).toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  test("rejects oversized and malformed request bodies", async () => {
    const baseUrl = await listen(
      createResearchHttpServer({
        apiKey: API_KEY,
        services: fakeServices(),
        maxBodyBytes: 16,
      }),
    );
    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    };

    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tooLarge: "0123456789" }),
    });
    expect(oversized.status).toBe(413);

    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });
});
