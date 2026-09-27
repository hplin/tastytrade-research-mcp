import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { BACKTESTER_BASE_URL, USER_AGENT, assertTrustedHosts } from "./config.js";
import { TastytradeOAuthClient } from "./oauth-client.js";
import {
  ProviderRateLimiter,
  type ProviderRateLimitState,
} from "./provider-rate-limit.js";

export type JsonObject = Record<string, unknown>;

export type BacktesterRequestOptions = {
  timeout_ms?: number;
  signal?: AbortSignal;
};

export type BacktesterHttpClient = Pick<AxiosInstance, "get" | "post">;

export type TastytradeBacktesterClientOptions = {
  rateLimiter?: ProviderRateLimiter;
  min_request_interval_ms?: number;
  http?: BacktesterHttpClient;
};

const DEFAULT_MIN_REQUEST_INTERVAL_MS = 100;
const MAX_MIN_REQUEST_INTERVAL_MS = 60_000;

function minRequestIntervalFromEnv(): number {
  const raw =
    process.env.TASTYTRADE_BACKTESTER_MIN_REQUEST_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_MIN_REQUEST_INTERVAL_MS;
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_MIN_REQUEST_INTERVAL_MS
  ) {
    throw new Error(
      "TASTYTRADE_BACKTESTER_MIN_REQUEST_INTERVAL_MS must be an integer between 0 and 60000.",
    );
  }
  return parsed;
}

export class TastytradeBacktesterClient {
  private readonly http: BacktesterHttpClient;
  private readonly rateLimiter: ProviderRateLimiter;

  constructor(
    private readonly oauth = new TastytradeOAuthClient(),
    options: TastytradeBacktesterClientOptions = {},
  ) {
    assertTrustedHosts();
    this.http =
      options.http ??
      axios.create({
        baseURL: BACKTESTER_BASE_URL,
        timeout: 60_000,
        maxRedirects: 0,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
      });
    this.rateLimiter =
      options.rateLimiter ??
      new ProviderRateLimiter({
        provider: "tastytrade-backtester",
        min_interval_ms:
          options.min_request_interval_ms ??
          minRequestIntervalFromEnv(),
      });
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.oauth.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  private async requestConfig(options?: BacktesterRequestOptions) {
    return {
      headers: await this.headers(),
      ...(options?.timeout_ms === undefined
        ? {}
        : { timeout: options.timeout_ms }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  private async request<T>(
    operation: (
      config: AxiosRequestConfig,
    ) => Promise<AxiosResponse<T>>,
    options?: BacktesterRequestOptions,
  ): Promise<T> {
    const config = await this.requestConfig(options);
    try {
      const response = await this.rateLimiter.run(
        () => operation(config),
        options?.signal,
      );
      this.rateLimiter.recordSuccess(response.headers);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        throw this.rateLimiter.recordRateLimit(error);
      }
      throw error;
    }
  }

  getProviderRateLimitState(): ProviderRateLimitState | null {
    return this.rateLimiter.getState();
  }

  async getAvailableDates(
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    return this.request(
      (config) => this.http.get("/available-dates", config),
      options,
    );
  }

  async listBacktests(options?: BacktesterRequestOptions): Promise<unknown> {
    return this.request(
      (config) => this.http.get("/backtests", config),
      options,
    );
  }

  async createBacktest(
    request: JsonObject,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    return this.request(
      (config) => this.http.post("/backtests", request, config),
      options,
    );
  }

  async getBacktest(
    id: string,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    return this.request(
      (config) =>
        this.http.get(`/backtests/${encodeURIComponent(id)}`, config),
      options,
    );
  }

  async getBacktestLogs(
    id: string,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    return this.request(
      (config) =>
        this.http.get(
          `/backtests/${encodeURIComponent(id)}/logs`,
          config,
        ),
      options,
    );
  }

  async cancelBacktest(
    id: string,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    return this.request(
      (config) =>
        this.http.post(
          `/backtests/${encodeURIComponent(id)}/cancel`,
          {},
          config,
        ),
      options,
    );
  }

  async simulateTrade(
    request: JsonObject,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    return this.request(
      (config) => this.http.post("/simulate-trade", request, config),
      options,
    );
  }
}
