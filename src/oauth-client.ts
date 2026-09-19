import axios from "axios";
import { OAUTH_BASE_URL, USER_AGENT, assertTrustedHosts, requireEnv } from "./config.js";

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
};

export class TastytradeOAuthClient {
  private accessToken: string | null = null;
  private expiresAt = 0;

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.expiresAt - 60_000) return this.accessToken;

    assertTrustedHosts();

    const response = await axios.post<TokenResponse>(
      `${OAUTH_BASE_URL}/oauth/token`,
      {
        grant_type: "refresh_token",
        refresh_token: requireEnv("TASTYTRADE_REFRESH_TOKEN"),
        client_id: requireEnv("TASTYTRADE_CLIENT_ID"),
        client_secret: requireEnv("TASTYTRADE_CLIENT_SECRET"),
      },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        timeout: 30_000,
        maxRedirects: 0,
      },
    );

    const token = response.data.access_token;
    if (!token) throw new Error("OAuth response did not contain access_token.");

    this.accessToken = token;
    const ttlSeconds =
      typeof response.data.expires_in === "number" && response.data.expires_in > 0
        ? response.data.expires_in
        : 900;
    this.expiresAt = now + ttlSeconds * 1000;
    return token;
  }
}
