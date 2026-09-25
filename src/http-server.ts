import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
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

export type ApiKeyHttpAuth = {
  type: "api-key";
  apiKey: string;
};

export type OAuthHttpAuth = {
  type: "oauth";
  resource: string;
  issuer: string;
  requiredScope: string;
  resourceName?: string;
  verifier: OAuthTokenVerifier;
};

export type ResearchHttpServerOptions = {
  auth?: ApiKeyHttpAuth | OAuthHttpAuth;
  apiKey?: string;
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

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;

  const match = /^Bearer[ \t]+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function apiKeyAuthInfo(
  token: string,
  apiKeyDigest: Buffer,
): AuthInfo | null {
  if (!timingSafeEqual(digest(token), apiKeyDigest)) return null;
  return {
    token,
    clientId: "api-key",
    scopes: [],
  };
}

function safeHeaderValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f"]/u.test(normalized)) {
    throw new Error(`${field} contains invalid HTTP header characters.`);
  }
  return normalized;
}

function oauthMetadata(auth: OAuthHttpAuth) {
  const resource = new URL(auth.resource);
  if (
    resource.protocol !== "https:" ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash
  ) {
    throw new Error(
      "OAuth resource must be an HTTPS URL without credentials, query, or fragment.",
    );
  }
  if (resource.pathname !== "/mcp") {
    throw new Error("OAuth resource must use the /mcp path.");
  }

  const issuer = new URL(auth.issuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error(
      "OAuth issuer must be an HTTPS URL without credentials, query, or fragment.",
    );
  }

  const requiredScope = safeHeaderValue(
    auth.requiredScope,
    "OAuth required scope",
  );
  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    resource,
  );
  return {
    resource,
    metadataUrl,
    pathSpecificMetadataPath:
      `/.well-known/oauth-protected-resource${resource.pathname}`,
    requiredScope,
    document: {
      resource: resource.toString(),
      authorization_servers: [issuer.toString()],
      scopes_supported: [requiredScope],
      bearer_methods_supported: ["header"],
      resource_name:
        auth.resourceName?.trim() || "Tastytrade Research MCP",
    },
  };
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
  if (options.auth && options.apiKey) {
    throw new Error("Configure either auth or apiKey, not both.");
  }
  const auth: ApiKeyHttpAuth | OAuthHttpAuth =
    options.auth ??
    (options.apiKey
      ? { type: "api-key", apiKey: options.apiKey }
      : (() => {
          throw new Error("HTTP authentication must be configured.");
        })());
  if (auth.type === "api-key" && auth.apiKey.length < 32) {
    throw new Error("MCP_API_KEY must contain at least 32 characters.");
  }

  const services = options.services ?? defaultServices();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive integer.");
  }
  const apiKeyDigest =
    auth.type === "api-key" ? digest(auth.apiKey) : null;
  const metadata = auth.type === "oauth" ? oauthMetadata(auth) : null;
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

    if (
      metadata &&
      (pathname === metadata.metadataUrl.pathname ||
        pathname === metadata.pathSpecificMetadataPath)
    ) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(
          response,
          405,
          { error: "Method not allowed." },
          { Allow: "GET, HEAD" },
        );
        return;
      }
      writeJson(response, 200, metadata.document, {
        "Cache-Control": "public, max-age=3600",
      });
      return;
    }

    if (pathname !== "/mcp") {
      writeJson(response, 404, { error: "Not found." });
      return;
    }

    const token = bearerToken(request);
    let authInfo: AuthInfo | null = null;
    if (token) {
      if (auth.type === "api-key") {
        authInfo = apiKeyAuthInfo(token, apiKeyDigest!);
      } else {
        try {
          authInfo = await auth.verifier.verifyAccessToken(token);
        } catch {
          authInfo = null;
        }
      }
    }

    if (!authInfo) {
      const challenge =
        auth.type === "oauth"
          ? `Bearer resource_metadata="${metadata!.metadataUrl.toString()}", scope="${metadata!.requiredScope}"`
          : 'Bearer realm="tastytrade-research-mcp"';
      writeJson(
        response,
        401,
        jsonRpcError(-32001, "Unauthorized."),
        { "WWW-Authenticate": challenge },
      );
      return;
    }
    (
      request as IncomingMessage & { auth?: AuthInfo }
    ).auth = authInfo;

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
