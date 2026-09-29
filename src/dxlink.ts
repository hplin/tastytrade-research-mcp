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
};

type QuoteTokenResponse = {
  data?: {
    token?: string;
    "dxlink-url"?: string;
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

export type DxlinkQuoteTokenProvider = {
  getQuoteToken(signal?: AbortSignal): Promise<DxlinkQuoteToken>;
};

export type TastytradeAccessTokenProvider = {
  getAccessToken(): Promise<string>;
};

export const DXLINK_OPEN = 1;

const QUOTE_TOKEN_TTL_MS = 23 * 60 * 60_000;

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
  private quoteToken: DxlinkQuoteToken | null = null;
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

  async getQuoteToken(signal?: AbortSignal): Promise<DxlinkQuoteToken> {
    assertDxlinkNotAborted(signal);
    const now = this.clock();
    if (this.quoteToken && now < this.quoteTokenExpiresAt) {
      return this.quoteToken;
    }

    let lastError: unknown;
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
        if (!token || !url) {
          throw new Error(
            "Quote-token response did not contain token and dxlink-url.",
          );
        }
        this.quoteToken = {
          token,
          url: assertTrustedDxlinkUrl(url),
        };
        this.quoteTokenExpiresAt = now + QUOTE_TOKEN_TTL_MS;
        return this.quoteToken;
      } catch (error) {
        lastError = error;
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
