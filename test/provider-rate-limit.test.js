import { describe, expect, jest, test } from "@jest/globals";
import {
  ProviderRateLimiter,
  providerRateLimitMetadataFromError,
} from "../dist/provider-rate-limit.js";
import { TastytradeBacktesterClient } from "../dist/backtester-client.js";

describe("provider rate limiter", () => {
  test("honors Retry-After before reset metadata and blocks requests during cooldown", async () => {
    let now = Date.parse("2026-09-27T18:00:00.000Z");
    const limiter = new ProviderRateLimiter({
      provider: "tastytrade-backtester",
      now: () => now,
      random: () => 0.5,
    });
    const error = limiter.recordRateLimit({
      message: "Request failed with status code 429",
      response: {
        status: 429,
        headers: {
          "retry-after": "30",
          "x-ratelimit-reset": String(now / 1_000 + 120),
          "x-ratelimit-remaining": "0",
        },
      },
    });

    expect(error).toMatchObject({
      code: "PROVIDER_RATE_LIMIT",
      retryable: true,
      response: { status: 429 },
      provider_rate_limit: {
        provider: "tastytrade-backtester",
        cooldown_until: "2026-09-27T18:00:30.000Z",
        last_429_at: "2026-09-27T18:00:00.000Z",
        retry_after_seconds: 30,
        rate_limit_count: 1,
        remaining: 0,
        source: "RETRY_AFTER",
        cause: "HTTP_429",
      },
    });
    expect(providerRateLimitMetadataFromError(error)).toEqual(
      error.provider_rate_limit,
    );

    const providerRequest = jest.fn();
    await expect(
      limiter.run(async () => providerRequest()),
    ).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMIT",
      provider_rate_limit: {
        cause: "ACTIVE_COOLDOWN",
        cooldown_until: "2026-09-27T18:00:30.000Z",
      },
    });
    expect(providerRequest).not.toHaveBeenCalled();

    now += 30_000;
    await limiter.run(async () => providerRequest());
    expect(providerRequest).toHaveBeenCalledTimes(1);
  });

  test("uses reset metadata when Retry-After is absent", () => {
    const now = Date.parse("2026-09-27T18:00:00.000Z");
    const limiter = new ProviderRateLimiter({
      provider: "tastytrade-backtester",
      now: () => now,
      random: () => 0.5,
    });
    const error = limiter.recordRateLimit({
      response: {
        status: 429,
        headers: {
          "x-ratelimit-reset": String(now / 1_000 + 45),
        },
      },
    });

    expect(error.provider_rate_limit).toMatchObject({
      cooldown_until: "2026-09-27T18:00:45.000Z",
      retry_after_seconds: 45,
      source: "X_RATE_LIMIT_RESET",
    });
  });

  test("uses bounded 10s, 30s, and 90s fallback windows with deterministic jitter", () => {
    let now = Date.parse("2026-09-27T18:00:00.000Z");
    const limiter = new ProviderRateLimiter({
      provider: "tastytrade-backtester",
      now: () => now,
      random: () => 0.5,
    });

    const first = limiter.recordRateLimit({ response: { status: 429 } });
    expect(first.provider_rate_limit).toMatchObject({
      retry_after_seconds: 10,
      rate_limit_count: 1,
      source: "FALLBACK",
    });
    now = Date.parse(first.provider_rate_limit.cooldown_until);

    const second = limiter.recordRateLimit({ response: { status: 429 } });
    expect(second.provider_rate_limit).toMatchObject({
      retry_after_seconds: 30,
      rate_limit_count: 2,
      source: "FALLBACK",
    });
    now = Date.parse(second.provider_rate_limit.cooldown_until);

    const third = limiter.recordRateLimit({ response: { status: 429 } });
    expect(third.provider_rate_limit).toMatchObject({
      retry_after_seconds: 90,
      rate_limit_count: 3,
      source: "FALLBACK",
    });
  });

  test("paces concurrent request starts through one shared queue", async () => {
    let now = 0;
    const sleeps = [];
    const starts = [];
    const limiter = new ProviderRateLimiter({
      provider: "tastytrade-backtester",
      min_interval_ms: 100,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await Promise.all(
      Array.from({ length: 3 }, async () => {
        await limiter.run(async () => {
          starts.push(now);
        });
      }),
    );

    expect(starts).toEqual([0, 100, 200]);
    expect(sleeps).toEqual([100, 100]);
  });

  test("shares one cooldown across Backtester endpoints after an HTTP 429", async () => {
    let now = Date.parse("2026-09-27T18:00:00.000Z");
    const rateLimiter = new ProviderRateLimiter({
      provider: "tastytrade-backtester",
      now: () => now,
      random: () => 0.5,
    });
    const post = jest
      .fn()
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: "Request failed with status code 429",
        response: {
          status: 429,
          headers: { "retry-after": "30" },
        },
      })
      .mockResolvedValueOnce({
        data: { ok: true },
        headers: { "x-ratelimit-remaining": "5" },
      });
    const client = new TastytradeBacktesterClient(
      {
        getAccessToken: jest.fn(async () => "fixture-token"),
      },
      {
        rateLimiter,
        http: {
          get: jest.fn(),
          post,
        },
      },
    );

    await expect(client.createBacktest({})).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMIT",
      provider_rate_limit: {
        cooldown_until: "2026-09-27T18:00:30.000Z",
        cause: "HTTP_429",
      },
    });
    await expect(client.simulateTrade({})).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMIT",
      provider_rate_limit: {
        cooldown_until: "2026-09-27T18:00:30.000Z",
        cause: "ACTIVE_COOLDOWN",
      },
    });
    expect(post).toHaveBeenCalledTimes(1);

    now += 30_000;
    await expect(client.simulateTrade({})).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(2);
    expect(client.getProviderRateLimitState()).toMatchObject({
      cooldown_active: false,
      remaining: 5,
      rate_limit_count: 1,
    });
  });
});
