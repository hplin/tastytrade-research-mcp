import axios, { type AxiosInstance } from "axios";
import { BACKTESTER_BASE_URL, USER_AGENT, assertTrustedHosts } from "./config.js";
import { TastytradeOAuthClient } from "./oauth-client.js";

export type JsonObject = Record<string, unknown>;

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

  async getAvailableDates(): Promise<unknown> {
    const response = await this.http.get("/available-dates", {
      headers: await this.headers(),
    });
    return response.data;
  }

  async listBacktests(): Promise<unknown> {
    const response = await this.http.get("/backtests", {
      headers: await this.headers(),
    });
    return response.data;
  }

  async createBacktest(request: JsonObject): Promise<unknown> {
    const response = await this.http.post("/backtests", request, {
      headers: await this.headers(),
    });
    return response.data;
  }

  async getBacktest(id: string): Promise<unknown> {
    const response = await this.http.get(`/backtests/${encodeURIComponent(id)}`, {
      headers: await this.headers(),
    });
    return response.data;
  }

  async getBacktestLogs(id: string): Promise<unknown> {
    const response = await this.http.get(
      `/backtests/${encodeURIComponent(id)}/logs`,
      { headers: await this.headers() },
    );
    return response.data;
  }

  async cancelBacktest(id: string): Promise<unknown> {
    const response = await this.http.post(
      `/backtests/${encodeURIComponent(id)}/cancel`,
      {},
      { headers: await this.headers() },
    );
    return response.data;
  }

  async simulateTrade(request: JsonObject): Promise<unknown> {
    const response = await this.http.post("/simulate-trade", request, {
      headers: await this.headers(),
    });
    return response.data;
  }
}
