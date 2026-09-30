import axios, { type AxiosInstance } from "axios";
import {
  OAUTH_BASE_URL,
  USER_AGENT,
  assertTrustedHosts,
} from "./config.js";
import { TastytradeOAuthClient } from "./oauth-client.js";

export type DxlinkQuoteToken = {
  token: string;
  url: string;
  expiresAt?: number;
  tokenSource?: "API_QUOTE_TOKEN" | "CACHE";
  tokenReused?: boolean;
};

type QuoteTokenResponse = {
  data?: {
    token?: string;
    "dxlink-url"?: string;
    "expires-at"?: string;
  };
};

export type DxlinkSocket = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type DxlinkSocketFactory = (url: string) => DxlinkSocket;

export type DxlinkQuoteTokenRequest = {
  forceRefresh?: boolean;
};

export type DxlinkQuoteTokenProvider = {
  getQuoteToken(
    signal?: AbortSignal,
    request?: DxlinkQuoteTokenRequest,
  ): Promise<DxlinkQuoteToken>;
  invalidateQuoteToken?(): void;
};

export type TastytradeAccessTokenProvider = {
  getAccessToken(): Promise<string>;
  invalidateAccessToken?(): void;
};

export const DXLINK_OPEN = 1;

const QUOTE_TOKEN_TTL_MS = 23 * 60 * 60_000;
const QUOTE_TOKEN_EXPIRY_SKEW_MS = 60_000;

export type DxlinkAuthStatus =
  | "NOT_ATTEMPTED"
  | "NOT_CONFIRMED"
  | "CONFIRMED"
  | "REFRESHED"
  | "FAILED";

export type DxlinkAuthDiagnostics = {
  status: DxlinkAuthStatus;
  token_source: "API_QUOTE_TOKEN" | "CACHE" | "QUOTE_TOKEN_PROVIDER" | "NONE";
  token_reused: boolean;
  refresh_attempted: boolean;
  retry_count: 0 | 1;
};

export type DxlinkProviderError = {
  code: "UNAUTHORIZED";
  message: string;
};

export class DxlinkAuthenticationError extends Error {
  readonly code = "AUTH_FAILED";
  readonly providerError: DxlinkProviderError;

  constructor(providerError: DxlinkProviderError) {
    super(
      `DXLink authentication failed: ${providerError.code}: ${providerError.message}`,
    );
    this.name = "DxlinkAuthenticationError";
    this.providerError = providerError;
  }
}

export class DxlinkAuthFailedError extends Error {
  readonly code = "AUTH_FAILED";
  readonly retryable = false;

  constructor(
    readonly dxlinkAuth: DxlinkAuthDiagnostics,
    readonly providerError: DxlinkProviderError,
  ) {
    super(
      `AUTH_FAILED: DXLink authentication failed after one credential refresh (${providerError.code}: ${providerError.message}).`,
    );
    this.name = "DxlinkAuthFailedError";
  }
}

export class DxlinkAbortedError extends Error {
  readonly code = "PROVIDER_TIMEOUT";
  readonly retryable = true;

  constructor(message = "DXLink request was aborted.") {
    super(message);
    this.name = "DxlinkAbortedError";
  }
}

export function assertDxlinkNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DxlinkAbortedError();
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  assertDxlinkNotAborted(signal);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DxlinkAbortedError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isRetryable(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  return (
    !error.response ||
    error.response.status === 429 ||
    error.response.status >= 500
  );
}

function isAuthorizationFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  return error.response?.status === 401 || error.response?.status === 403;
}

function providerErrorMessage(message: Record<string, unknown>): string {
  return typeof message.message === "string" && message.message.trim()
    ? message.message.trim()
    : "Authentication failed";
}

export function dxlinkAuthenticationError(
  message: Record<string, unknown>,
  authSent: boolean,
): DxlinkAuthenticationError | null {
  const unauthorizedAuthState =
    authSent &&
    message.type === "AUTH_STATE" &&
    message.state === "UNAUTHORIZED";
  const unauthorizedError =
    message.type === "ERROR" &&
    typeof message.error === "string" &&
    message.error.toUpperCase() === "UNAUTHORIZED";
  if (!unauthorizedAuthState && !unauthorizedError) return null;
  return new DxlinkAuthenticationError({
    code: "UNAUTHORIZED",
    message: providerErrorMessage(message),
  });
}

function authDiagnostics(
  quoteToken: DxlinkQuoteToken | null,
  status: DxlinkAuthStatus,
  retryCount: 0 | 1,
): DxlinkAuthDiagnostics {
  return {
    status,
    token_source:
      quoteToken?.tokenSource ??
      (quoteToken ? "QUOTE_TOKEN_PROVIDER" : "NONE"),
    token_reused: quoteToken?.tokenReused ?? false,
    refresh_attempted: retryCount === 1,
    retry_count: retryCount,
  };
}

export type DxlinkAuthRecoveryResult<T> = {
  value: T;
  dxlinkAuth: DxlinkAuthDiagnostics;
  providerError: DxlinkProviderError | null;
};

export async function withDxlinkAuthRecovery<T>(
  quoteTokens: DxlinkQuoteTokenProvider,
  operation: (
    quoteToken: DxlinkQuoteToken,
    retryCount: 0 | 1,
  ) => Promise<T>,
  signal?: AbortSignal,
): Promise<DxlinkAuthRecoveryResult<T>> {
  let providerError: DxlinkProviderError | null = null;
  let lastQuoteToken: DxlinkQuoteToken | null = null;

  for (const retryCount of [0, 1] as const) {
    assertDxlinkNotAborted(signal);
    let quoteToken: DxlinkQuoteToken;
    try {
      quoteToken = await quoteTokens.getQuoteToken(
        signal,
        retryCount === 1 ? { forceRefresh: true } : undefined,
      );
      lastQuoteToken = quoteToken;
    } catch (error) {
      if (retryCount === 1 && providerError) {
        throw new DxlinkAuthFailedError(
          authDiagnostics(lastQuoteToken, "FAILED", 1),
          providerError,
        );
      }
      throw error;
    }

    try {
      const value = await operation(quoteToken, retryCount);
      return {
        value,
        dxlinkAuth: authDiagnostics(
          quoteToken,
          retryCount === 0 ? "CONFIRMED" : "REFRESHED",
          retryCount,
        ),
        providerError,
      };
    } catch (error) {
      if (!(error instanceof DxlinkAuthenticationError)) throw error;
      providerError = error.providerError;
      if (retryCount === 1) {
        throw new DxlinkAuthFailedError(
          authDiagnostics(quoteToken, "FAILED", 1),
          providerError,
        );
      }
      quoteTokens.invalidateQuoteToken?.();
    }
  }

  throw new Error("DXLink authentication recovery exhausted unexpectedly.");
}

export function assertTrustedDxlinkUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "wss:" ||
    !(
      url.hostname.toLowerCase() === "dxfeed.com" ||
      url.hostname.toLowerCase().endsWith(".dxfeed.com")
    ) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Refusing DXLink token target: ${url.hostname}. Expected a dxfeed.com host over wss.`,
    );
  }
  return url.toString();
}

export function decodeDxlinkMessageData(data: unknown): Promise<string> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) {
    return Promise.resolve(Buffer.from(data).toString("utf8"));
  }
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
        "utf8",
      ),
    );
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }
  return Promise.resolve(String(data));
}

export function dxlinkMessageDataByteLength(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return Buffer.byteLength(String(data), "utf8");
}

export function createTastytradeApiHttpClient(): AxiosInstance {
  return axios.create({
    baseURL: OAUTH_BASE_URL,
    timeout: 30_000,
    maxRedirects: 0,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
  });
}

export class TastytradeDxlinkTokenClient
  implements DxlinkQuoteTokenProvider
{
  private quoteToken: {
    token: string;
    url: string;
    expiresAt: number;
  } | null = null;
  private quoteTokenExpiresAt = 0;

  constructor(
    private readonly oauth: TastytradeAccessTokenProvider =
      new TastytradeOAuthClient(),
    private readonly http: AxiosInstance = createTastytradeApiHttpClient(),
    private readonly clock: () => number = () => Date.now(),
    private readonly random: () => number = () => Math.random(),
  ) {
    assertTrustedHosts();
  }

  invalidateQuoteToken(): void {
    this.quoteToken = null;
    this.quoteTokenExpiresAt = 0;
    this.oauth.invalidateAccessToken?.();
  }

  async getQuoteToken(
    signal?: AbortSignal,
    request: DxlinkQuoteTokenRequest = {},
  ): Promise<DxlinkQuoteToken> {
    assertDxlinkNotAborted(signal);
    if (request.forceRefresh) {
      this.quoteToken = null;
      this.quoteTokenExpiresAt = 0;
    }
    if (this.quoteToken && this.clock() < this.quoteTokenExpiresAt) {
      return {
        ...this.quoteToken,
        tokenSource: "CACHE",
        tokenReused: true,
      };
    }

    let lastError: unknown;
    let accessTokenRefreshAttempted = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const accessToken = await this.oauth.getAccessToken();
        assertDxlinkNotAborted(signal);
        const response = await this.http.get<QuoteTokenResponse>(
          "/api-quote-tokens",
          {
            signal,
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        const token = response.data.data?.token;
        const url = response.data.data?.["dxlink-url"];
        const expiresAtValue = response.data.data?.["expires-at"];
        if (!token || !url) {
          throw new Error(
            "Quote-token response did not contain token and dxlink-url.",
          );
        }
        const now = this.clock();
        const parsedExpiresAt =
          typeof expiresAtValue === "string"
            ? Date.parse(expiresAtValue)
            : Number.NaN;
        if (
          typeof expiresAtValue === "string" &&
          !Number.isFinite(parsedExpiresAt)
        ) {
          throw new Error(
            "Quote-token response contained an invalid expires-at timestamp.",
          );
        }
        const expiresAt = Number.isFinite(parsedExpiresAt)
          ? parsedExpiresAt
          : now + QUOTE_TOKEN_TTL_MS;
        const usableUntil = expiresAt - QUOTE_TOKEN_EXPIRY_SKEW_MS;
        if (usableUntil <= now) {
          throw new Error(
            "Quote-token response contained an expired or near-expiry token.",
          );
        }
        this.quoteToken = {
          token,
          url: assertTrustedDxlinkUrl(url),
          expiresAt,
        };
        this.quoteTokenExpiresAt = usableUntil;
        return {
          ...this.quoteToken,
          tokenSource: "API_QUOTE_TOKEN",
          tokenReused: false,
        };
      } catch (error) {
        lastError = error;
        if (
          isAuthorizationFailure(error) &&
          !accessTokenRefreshAttempted &&
          this.oauth.invalidateAccessToken
        ) {
          accessTokenRefreshAttempted = true;
          this.oauth.invalidateAccessToken();
          continue;
        }
        if (!isRetryable(error) || attempt === 2) throw error;
        const baseDelay = 250 * 2 ** attempt;
        await wait(
          baseDelay + Math.floor(this.random() * 100),
          signal,
        );
      }
    }
    throw lastError;
  }
}
