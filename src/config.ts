export const OAUTH_BASE_URL =
  process.env.TASTYTRADE_OAUTH_BASE_URL?.trim() || "https://api.tastyworks.com";

export const BACKTESTER_BASE_URL =
  process.env.TASTYTRADE_BACKTESTER_BASE_URL?.trim() ||
  "https://backtester.vast.tastyworks.com";

export const USER_AGENT =
  process.env.TASTYTRADE_USER_AGENT?.trim() ||
  "tastytrade-research-mcp/0.2.0";

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function assertTrustedHosts(): void {
  const oauthHost = new URL(OAUTH_BASE_URL).hostname.toLowerCase();
  const backtesterHost = new URL(BACKTESTER_BASE_URL).hostname.toLowerCase();

  if (oauthHost !== "api.tastyworks.com") {
    throw new Error(
      `Refusing OAuth credential target: ${oauthHost}. Expected api.tastyworks.com.`,
    );
  }
  if (backtesterHost !== "backtester.vast.tastyworks.com") {
    throw new Error(
      `Refusing Backtester target: ${backtesterHost}. Expected backtester.vast.tastyworks.com.`,
    );
  }
}
