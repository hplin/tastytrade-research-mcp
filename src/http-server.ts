import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TastytradeBacktesterClient } from "./backtester-client.js";
import { TastytradeHistoricalCandlesClient } from "./historical-candles.js";
import { TastytradeOAuthClient } from "./oauth-client.js";
import {
  createResearchServer,
  type ResearchServices,
} from "./server.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

type HttpLogger = {
  error(message: string): void;
};

export type ResearchHttpServerOptions = {
  apiKey: string;
  services?: ResearchServices;
  maxBodyBytes?: number;
  logger?: HttpLogger;
};

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function defaultServices(): ResearchServices {
  const oauth = new TastytradeOAuthClient();
  return {
    backtester: new TastytradeBacktesterClient(oauth),
    candles: new TastytradeHistoricalCandlesClient(oauth),
  };
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function jsonRpcError(code: number, message: string) {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(request: IncomingMessage, apiKeyDigest: Buffer): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;

  const match = /^Bearer[ \t]+(.+)$/i.exec(header);
  if (!match) return false;

  return timingSafeEqual(digest(match[1]), apiKeyDigest);
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (
    typeof contentLength === "string" &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxBodyBytes
  ) {
    throw new HttpRequestError(413, "Request body is too large.");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new HttpRequestError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (total === 0) {
    throw new HttpRequestError(400, "Request body is required.");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpRequestError(400, "Request body must be valid JSON.");
  }
}

export function createResearchHttpServer(
  options: ResearchHttpServerOptions,
): HttpServer {
  if (options.apiKey.length < 32) {
    throw new Error("MCP_API_KEY must contain at least 32 characters.");
  }

  const services = options.services ?? defaultServices();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive integer.");
  }
  const apiKeyDigest = digest(options.apiKey);
  const logger = options.logger ?? console;

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const pathname = new URL(
      request.url ?? "/",
      "http://localhost",
    ).pathname;

    if (
      pathname === "/healthz" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      writeJson(response, 200, {
        status: "ok",
        service: "tastytrade-research-mcp",
        version: "0.2.0",
      });
      return;
    }

    if (pathname !== "/mcp") {
      writeJson(response, 404, { error: "Not found." });
      return;
    }

    if (!authorized(request, apiKeyDigest)) {
      writeJson(
        response,
        401,
        jsonRpcError(-32001, "Unauthorized."),
        { "WWW-Authenticate": 'Bearer realm="tastytrade-research-mcp"' },
      );
      return;
    }

    if (request.method !== "POST") {
      writeJson(
        response,
        405,
        jsonRpcError(-32000, "Method not allowed."),
        { Allow: "POST" },
      );
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        writeJson(
          response,
          error.status,
          jsonRpcError(
            error.status === 400 ? -32700 : -32000,
            error.message,
          ),
        );
        return;
      }
      throw error;
    }

    const server = createResearchServer(services);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await server.close();
    };
    response.once("close", () => {
      void close().catch((error) => {
        logger.error(
          `Failed to close MCP HTTP request: ${errorMessage(error)}`,
        );
      });
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      logger.error(`MCP HTTP request failed: ${errorMessage(error)}`);
      await close().catch(() => {});
      writeJson(
        response,
        500,
        jsonRpcError(-32603, "Internal server error."),
      );
    }
  };

  return createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      logger.error(`Unhandled HTTP request failure: ${errorMessage(error)}`);
      writeJson(
        response,
        500,
        jsonRpcError(-32603, "Internal server error."),
      );
    });
  });
}
