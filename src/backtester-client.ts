import axios, { type AxiosInstance } from "axios";
import { BACKTESTER_BASE_URL, USER_AGENT, assertTrustedHosts } from "./config.js";
import { TastytradeOAuthClient } from "./oauth-client.js";

export type JsonObject = Record<string, unknown>;

export type BacktesterRequestOptions = {
  timeout_ms?: number;
  signal?: AbortSignal;
};

export class TastytradeBacktesterClient {
  private readonly http: AxiosInstance;

  constructor(private readonly oauth = new TastytradeOAuthClient()) {
    assertTrustedHosts();
    this.http = axios.create({
      baseURL: BACKTESTER_BASE_URL,
      timeout: 60_000,
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
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

  async getAvailableDates(
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    const response = await this.http.get("/available-dates", {
      ...(await this.requestConfig(options)),
    });
    return response.data;
  }

  async listBacktests(options?: BacktesterRequestOptions): Promise<unknown> {
    const response = await this.http.get("/backtests", {
      ...(await this.requestConfig(options)),
    });
    return response.data;
  }

  async createBacktest(
    request: JsonObject,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    const response = await this.http.post("/backtests", request, {
      ...(await this.requestConfig(options)),
    });
    return response.data;
  }

  async getBacktest(
    id: string,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    const response = await this.http.get(`/backtests/${encodeURIComponent(id)}`, {
      ...(await this.requestConfig(options)),
    });
    return response.data;
  }

  async getBacktestLogs(
    id: string,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    const response = await this.http.get(
      `/backtests/${encodeURIComponent(id)}/logs`,
      await this.requestConfig(options),
    );
    return response.data;
  }

  async cancelBacktest(
    id: string,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    const response = await this.http.post(
      `/backtests/${encodeURIComponent(id)}/cancel`,
      {},
      await this.requestConfig(options),
    );
    return response.data;
  }

  async simulateTrade(
    request: JsonObject,
    options?: BacktesterRequestOptions,
  ): Promise<unknown> {
    const response = await this.http.post("/simulate-trade", request, {
      ...(await this.requestConfig(options)),
    });
    return response.data;
  }
}
