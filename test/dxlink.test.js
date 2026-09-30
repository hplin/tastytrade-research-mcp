import { describe, expect, jest, test } from "@jest/globals";
import {
  DxlinkAuthFailedError,
  DxlinkAuthenticationError,
  TastytradeDxlinkTokenClient,
  dxlinkAuthenticationError,
  withDxlinkAuthRecovery,
} from "../dist/dxlink.js";

const DXLINK_URL =
  "wss://tasty-openapi-ws.dxfeed.com/realtime";

function quoteTokenResponse(token, expiresAt) {
  return {
    data: {
      data: {
        token,
        "dxlink-url": DXLINK_URL,
        "expires-at": new Date(expiresAt).toISOString(),
      },
    },
  };
}

describe("DXLink authentication lifecycle", () => {
  test("uses provider expiry metadata and stops reusing a near-expiry token", async () => {
    let now = Date.parse("2026-09-29T12:00:00.000Z");
    const oauth = {
      getAccessToken: jest.fn(async () => "access-token"),
      invalidateAccessToken: jest.fn(),
    };
    const http = {
      get: jest
        .fn()
        .mockResolvedValueOnce(
          quoteTokenResponse("quote-token-1", now + 120_000),
        )
        .mockImplementationOnce(async () =>
          quoteTokenResponse("quote-token-2", now + 120_000),
        ),
    };
    const client = new TastytradeDxlinkTokenClient(
      oauth,
      http,
      () => now,
      () => 0,
    );

    const first = await client.getQuoteToken();
    now += 30_000;
    const cached = await client.getQuoteToken();
    now += 31_000;
    const refreshed = await client.getQuoteToken();

    expect(first).toMatchObject({
      token: "quote-token-1",
      tokenSource: "API_QUOTE_TOKEN",
      tokenReused: false,
    });
    expect(cached).toMatchObject({
      token: "quote-token-1",
      tokenSource: "CACHE",
      tokenReused: true,
    });
    expect(refreshed).toMatchObject({
      token: "quote-token-2",
      tokenSource: "API_QUOTE_TOKEN",
      tokenReused: false,
    });
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  test("invalidates both quote-token and OAuth cache state", async () => {
    const now = Date.parse("2026-09-29T12:00:00.000Z");
    const oauth = {
      getAccessToken: jest.fn(async () => "access-token"),
      invalidateAccessToken: jest.fn(),
    };
    const http = {
      get: jest.fn(async () =>
        quoteTokenResponse("quote-token", now + 3_600_000),
      ),
    };
    const client = new TastytradeDxlinkTokenClient(
      oauth,
      http,
      () => now,
      () => 0,
    );

    await client.getQuoteToken();
    client.invalidateQuoteToken();
    await client.getQuoteToken();

    expect(oauth.invalidateAccessToken).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  test("distinguishes the initial auth challenge from rejected credentials", () => {
    const challenge = {
      type: "AUTH_STATE",
      channel: 0,
      state: "UNAUTHORIZED",
    };
    expect(dxlinkAuthenticationError(challenge, false)).toBeNull();
    expect(dxlinkAuthenticationError(challenge, true)).toBeInstanceOf(
      DxlinkAuthenticationError,
    );
    expect(
      dxlinkAuthenticationError(
        {
          type: "ERROR",
          channel: 0,
          error: "UNAUTHORIZED",
          message: "Authentication failed",
        },
        false,
      ),
    ).toMatchObject({
      providerError: {
        code: "UNAUTHORIZED",
        message: "Authentication failed",
      },
    });
  });

  test("invalidates and reconnects exactly once after UNAUTHORIZED", async () => {
    const quoteTokens = {
      getQuoteToken: jest
        .fn()
        .mockResolvedValueOnce({
          token: "stale-token",
          url: DXLINK_URL,
          tokenSource: "CACHE",
          tokenReused: true,
        })
        .mockResolvedValueOnce({
          token: "fresh-token",
          url: DXLINK_URL,
          tokenSource: "API_QUOTE_TOKEN",
          tokenReused: false,
        }),
      invalidateQuoteToken: jest.fn(),
    };
    const operation = jest
      .fn()
      .mockRejectedValueOnce(
        new DxlinkAuthenticationError({
          code: "UNAUTHORIZED",
          message: "Authentication failed",
        }),
      )
      .mockResolvedValueOnce("connected");

    const result = await withDxlinkAuthRecovery(
      quoteTokens,
      operation,
    );

    expect(result).toEqual({
      value: "connected",
      dxlinkAuth: {
        status: "REFRESHED",
        token_source: "API_QUOTE_TOKEN",
        token_reused: false,
        refresh_attempted: true,
        retry_count: 1,
      },
      providerError: {
        code: "UNAUTHORIZED",
        message: "Authentication failed",
      },
    });
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.getQuoteToken.mock.calls[1][1]).toEqual({
      forceRefresh: true,
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("returns AUTH_FAILED after one retry without exposing either token", async () => {
    const quoteTokens = {
      getQuoteToken: jest
        .fn()
        .mockResolvedValueOnce({
          token: "synthetic-stale-secret",
          url: DXLINK_URL,
        })
        .mockResolvedValueOnce({
          token: "synthetic-fresh-secret",
          url: DXLINK_URL,
        }),
      invalidateQuoteToken: jest.fn(),
    };
    const operation = jest.fn(async () => {
      throw new DxlinkAuthenticationError({
        code: "UNAUTHORIZED",
        message: "Authentication failed",
      });
    });

    let caught;
    try {
      await withDxlinkAuthRecovery(quoteTokens, operation);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DxlinkAuthFailedError);
    expect(caught).toMatchObject({
      code: "AUTH_FAILED",
      retryable: false,
      dxlinkAuth: {
        status: "FAILED",
        refresh_attempted: true,
        retry_count: 1,
      },
      providerError: {
        code: "UNAUTHORIZED",
        message: "Authentication failed",
      },
    });
    expect(caught.message).toContain("AUTH_FAILED");
    expect(caught.message).not.toContain("synthetic-stale-secret");
    expect(caught.message).not.toContain("synthetic-fresh-secret");
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
