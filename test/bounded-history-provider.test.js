import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, jest, test } from "@jest/globals";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  BoundedHistoricalProviderAdapter,
  BoundedHistoryError,
} from "../dist/bounded-history-provider.js";
import {
  CachedHistoricalCandlesService,
  FileEvidenceCache,
} from "../dist/evidence-cache.js";

const DAY_MS = 24 * 60 * 60_000;
const EXACT_EXPIRED_SYMBOL = "SPXW  260320P05000000";
const NATIVE_EXPIRED_SYMBOL = ".SPXW260320P5000";
const validateManifest = new Ajv2020({ strict: false }).compile(
  JSON.parse(
    readFileSync(
      new URL("../docs/evidence-cache.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

function approvedConfig(overrides = {}) {
  const capabilities = {
    maximum_window_ms: 7 * DAY_MS,
    maximum_total_window_ms: 366 * DAY_MS,
    maximum_symbols_per_request: 10,
    maximum_pages_per_shard: 3,
    maximum_records_per_request: 1000,
    page_size: 100,
    supports_session_filtering: true,
    expired_symbol_coverage: "CONFIRMED",
    cache_reuse: "CONFIRMED",
    field_entitlements: {
      OHLC: "CONFIRMED",
      TRADE_PRICE: "CONFIRMED",
      IMPLIED_VOLATILITY: "CONFIRMED",
      DELTA: "CONFIRMED",
      BID_ASK: "CONFIRMED",
      OPEN_INTEREST: "CONFIRMED",
      VOLUME: "CONFIRMED",
    },
    native_field_allowlist: {
      OHLC: ["EventSymbol", "Close"],
      IMPLIED_VOLATILITY: ["ImpVolatility"],
    },
    earliest_available_at: "2014-01-01T00:00:00.000Z",
    ...overrides.capabilities,
  };
  return {
    provider_id: "approved-test-provider",
    dataset_id: "synthetic-bounded-candles",
    license_scope_id: "private-test-research",
    source_revision: "synthetic-provider/1",
    endpoint: "https://history.example.test/v1/",
    allowed_hosts: ["history.example.test"],
    credential_environment_variables: ["BOUNDED_TEST_TOKEN"],
    authorization: {
      status: "APPROVED",
      approval_reference: "approval/test-only",
      approved_at: "2026-09-26T00:00:00.000Z",
      provider_id: "approved-test-provider",
      dataset_id: "synthetic-bounded-candles",
      license_scope_id: "private-test-research",
    },
    capabilities,
    retry: {
      maximum_attempts: 2,
      base_delay_ms: 0,
      maximum_delay_ms: 0,
      request_timeout_ms: 1000,
    },
    ...overrides,
    capabilities,
  };
}

function request(overrides = {}) {
  return {
    instruments: [
      {
        exact_symbol: EXACT_EXPIRED_SYMBOL,
        native_symbol: NATIVE_EXPIRED_SYMBOL,
        instrument_type: "OPTION",
        lifecycle: "EXPIRED",
      },
    ],
    resolution: "5m",
    requested_fields: [
      "OHLC",
      "IMPLIED_VOLATILITY",
      "DELTA",
      "BID_ASK",
      "OPEN_INTEREST",
      "VOLUME",
    ],
    start_time: "2026-03-01T00:00:00.000Z",
    end_time: "2026-03-10T00:00:00.000Z",
    as_of: "2026-03-10T00:00:00.000Z",
    deadline_ms: 5000,
    ...overrides,
  };
}

function recordFor(pageRequest, sourceTime, overrides = {}) {
  const barEnd = new Date(Date.parse(sourceTime) + 5 * 60_000).toISOString();
  return {
    exact_symbol: EXACT_EXPIRED_SYMBOL,
    native_symbol: NATIVE_EXPIRED_SYMBOL,
    instrument_type: "OPTION",
    resolution: pageRequest.resolution,
    source_time: sourceTime,
    bar_start: sourceTime,
    bar_end: barEnd,
    available_at: barEnd,
    revision: "revision-1",
    method: "SYNTHETIC_FIXTURE",
    field_methods: {
      OHLC: "NATIVE_CANDLE",
      IMPLIED_VOLATILITY: "NATIVE_CANDLE",
      DELTA: "NATIVE_GREEK",
      BID_ASK: "NATIVE_NBBO",
      OPEN_INTEREST: "NATIVE_CANDLE",
      VOLUME: "NATIVE_CANDLE",
    },
    native_fields: {
      EventSymbol: NATIVE_EXPIRED_SYMBOL,
      Close: "100.5",
      ImpVolatility: "0.2",
    },
    normalized: {
      open: "100",
      high: "101",
      low: "99",
      close: "100.5",
      trade_price: null,
      volume: "10",
      vwap: "100.4",
      bid_volume: "4",
      ask_volume: "6",
      implied_volatility: "0.2",
      delta: "-25",
      bid_price: "100.4",
      ask_price: "100.6",
      open_interest: "200",
    },
    warnings: [],
    ...overrides,
  };
}

function page(pageRequest, records, overrides = {}) {
  return {
    contract_version: "1.0.0",
    provider_id: pageRequest.provider_id,
    dataset_id: pageRequest.dataset_id,
    source_revision: pageRequest.source_revision,
    window: pageRequest.window,
    records,
    next_cursor: null,
    partial: false,
    warnings: [],
    ...overrides,
  };
}

function transportWith(handler) {
  return {
    fetchPage: jest.fn(handler),
  };
}

async function withCache(run) {
  const directory = await mkdtemp(
    join(tmpdir(), "bounded-history-cache-"),
  );
  try {
    await run(
      new FileEvidenceCache({
        directory,
        defaultMode: "BYPASS",
        datasetId: "synthetic-bounded-candles",
        licenseScopeId: "private-test-research",
        normalizationVersion: "bounded-history/1.0.0",
        modelVersion: "provider-native/1.0.0",
        sourceRevision: "synthetic-provider/1",
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("approval-gated bounded historical provider adapter", () => {
  test("blocks unapproved providers, untrusted hosts, and tastytrade credential reuse", () => {
    const transport = transportWith(async () => {
      throw new Error("must not be called");
    });

    expect(
      () =>
        new BoundedHistoricalProviderAdapter(
          approvedConfig({
            authorization: {
              status: "NOT_APPROVED",
              reason: "No purchase or data-license approval.",
            },
          }),
          transport,
        ),
    ).toThrow(
      expect.objectContaining({ code: "PROVIDER_NOT_APPROVED" }),
    );
    expect(
      () =>
        new BoundedHistoricalProviderAdapter(
          approvedConfig({
            endpoint: "https://untrusted.example/v1/",
          }),
          transport,
        ),
    ).toThrow(
      expect.objectContaining({ code: "UNTRUSTED_PROVIDER_HOST" }),
    );
    expect(
      () =>
        new BoundedHistoricalProviderAdapter(
          approvedConfig({
            credential_environment_variables: [
              "TASTYTRADE_REFRESH_TOKEN",
            ],
          }),
          transport,
        ),
    ).toThrow(
      expect.objectContaining({
        code: "TASTYTRADE_CREDENTIAL_REUSE_FORBIDDEN",
      }),
    );
    expect(transport.fetchPage).not.toHaveBeenCalled();
  });

  test("requires confirmed expired-symbol and field entitlements", () => {
    const transport = transportWith(async () => {
      throw new Error("must not be called");
    });
    const expiredUnknown = new BoundedHistoricalProviderAdapter(
      approvedConfig({
        capabilities: {
          expired_symbol_coverage: "UNCONFIRMED",
        },
      }),
      transport,
    );
    const deltaUnknown = new BoundedHistoricalProviderAdapter(
      approvedConfig({
        capabilities: {
          field_entitlements: {
            ...approvedConfig().capabilities.field_entitlements,
            DELTA: "UNCONFIRMED",
          },
        },
      }),
      transport,
    );

    expect(() => expiredUnknown.normalizeRequest(request())).toThrow(
      expect.objectContaining({
        code: "EXPIRED_SYMBOL_COVERAGE_UNCONFIRMED",
      }),
    );
    expect(() =>
      expiredUnknown.normalizeRequest(
        request({
          instruments: [
            {
              exact_symbol: EXACT_EXPIRED_SYMBOL,
              native_symbol: NATIVE_EXPIRED_SYMBOL,
              instrument_type: "OPTION",
              lifecycle: "ACTIVE",
            },
          ],
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "EXPIRED_SYMBOL_COVERAGE_UNCONFIRMED",
      }),
    );
    expect(() => deltaUnknown.normalizeRequest(request())).toThrow(
      expect.objectContaining({
        code: "FIELD_ENTITLEMENT_UNCONFIRMED",
      }),
    );
    expect(transport.fetchPage).not.toHaveBeenCalled();
  });

  test("shards a long request, paginates, and preserves an expired exact symbol", async () => {
    const transport = transportWith(async (pageRequest) => {
      if (pageRequest.window.index === 0 && pageRequest.cursor === null) {
        return page(
          pageRequest,
          [recordFor(pageRequest, "2026-03-01T14:25:00.000Z")],
          { next_cursor: "page-2" },
        );
      }
      if (pageRequest.window.index === 0) {
        return page(pageRequest, [
          recordFor(pageRequest, "2026-03-02T14:25:00.000Z"),
        ]);
      }
      return page(pageRequest, [
        recordFor(pageRequest, "2026-03-08T14:25:00.000Z"),
      ]);
    });
    const adapter = new BoundedHistoricalProviderAdapter(
      approvedConfig({
        capabilities: {
          maximum_pages_per_shard: 2,
        },
      }),
      transport,
      () => Date.parse("2026-09-26T17:00:00.000Z"),
    );

    const result = await adapter.getBoundedHistory(request());

    expect(result.status).toBe("COMPLETE");
    expect(result.records).toHaveLength(3);
    expect(result.records.every(
      (record) => record.exact_symbol === EXACT_EXPIRED_SYMBOL,
    )).toBe(true);
    expect(result.shards).toEqual([
      expect.objectContaining({
        index: 0,
        start: "2026-03-01T00:00:00.000Z",
        stop_exclusive: "2026-03-08T00:00:00.000Z",
        pages: 2,
        status: "COMPLETE",
      }),
      expect.objectContaining({
        index: 1,
        start: "2026-03-08T00:00:00.000Z",
        stop_exclusive: "2026-03-10T00:00:00.000Z",
        pages: 1,
        status: "COMPLETE",
      }),
    ]);
    expect(transport.fetchPage).toHaveBeenCalledTimes(3);
    expect(transport.fetchPage.mock.calls[0][0]).toMatchObject({
      endpoint: "https://history.example.test/v1/",
      redirect_policy: "ERROR",
      cursor: null,
    });
    expect(transport.fetchPage.mock.calls[0][0]).not.toHaveProperty(
      "credentials",
    );
  });

  test("normalizes IANA windows across DST and rejects nonexistent local times", () => {
    const adapter = new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      transportWith(async () => {
        throw new Error("not used");
      }),
    );
    const local = adapter.normalizeRequest({
      ...request(),
      start_time: undefined,
      end_time: undefined,
      local_start: {
        local_date: "2026-03-08",
        local_time: "01:30",
        timezone: "America/New_York",
      },
      local_end: {
        local_date: "2026-03-08",
        local_time: "03:30",
        timezone: "America/New_York",
      },
      as_of: "2026-03-08T07:30:00.000Z",
    });

    expect(local.requested_range).toEqual({
      start: "2026-03-08T06:30:00.000Z",
      stop_exclusive: "2026-03-08T07:30:00.000Z",
    });
    expect(() =>
      adapter.normalizeRequest({
        ...request(),
        start_time: undefined,
        end_time: undefined,
        local_start: {
          local_date: "2026-03-08",
          local_time: "02:30",
          timezone: "America/New_York",
        },
        local_end: {
          local_date: "2026-03-08",
          local_time: "03:30",
          timezone: "America/New_York",
        },
        as_of: "2026-03-08T07:30:00.000Z",
      }),
    ).toThrow(/does not exist/);
  });

  test("reports partial shards and null field coverage without inventing data", async () => {
    const transport = transportWith(async (pageRequest) => {
      if (pageRequest.window.index === 1) {
        throw Object.assign(new Error("licensed endpoint rate limited"), {
          code: "PROVIDER_RATE_LIMIT",
          retryable: true,
        });
      }
      const record = recordFor(
        pageRequest,
        "2026-03-01T14:25:00.000Z",
      );
      record.normalized.implied_volatility = null;
      record.normalized.delta = null;
      record.normalized.bid_price = null;
      record.normalized.ask_price = null;
      delete record.field_methods.IMPLIED_VOLATILITY;
      delete record.field_methods.DELTA;
      delete record.field_methods.BID_ASK;
      return page(pageRequest, [record]);
    });
    const adapter = new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      transport,
      () => Date.parse("2026-09-26T17:00:00.000Z"),
      async () => {},
    );

    const result = await adapter.getBoundedHistory(request());

    expect(result.status).toBe("PARTIAL");
    expect(result.records).toHaveLength(1);
    expect(result.coverage.fields).toMatchObject({
      IMPLIED_VOLATILITY: { available: 0, missing: 1 },
      DELTA: { available: 0, missing: 1 },
      BID_ASK: { available: 0, missing: 1 },
      OHLC: { available: 1, missing: 0 },
    });
    expect(result.shards[1]).toMatchObject({
      status: "FAILED",
      failure_code: "PROVIDER_RATE_LIMIT",
    });
    expect(transport.fetchPage).toHaveBeenCalledTimes(3);
    expect(result.warnings).toContain("REQUESTED_FIELDS_HAVE_NULLS");
    expect(result.warnings.join(" ")).not.toContain(
      "licensed endpoint rate limited",
    );
  });

  test("turns schema mismatches and bounded timeouts into explicit failures", async () => {
    const mismatchTransport = transportWith(async (pageRequest) =>
      page(pageRequest, [
        recordFor(pageRequest, "2026-03-01T14:25:00.000Z", {
          exact_symbol: "UNREQUESTED",
        }),
      ]),
    );
    const mismatch = await new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      mismatchTransport,
    ).getBoundedHistory(
      request({
        end_time: "2026-03-02T00:00:00.000Z",
        as_of: "2026-03-02T00:00:00.000Z",
      }),
    );
    expect(mismatch).toMatchObject({
      status: "NOT_AVAILABLE",
      records: [],
      shards: [
        expect.objectContaining({
          failure_code: "PROVIDER_SCHEMA_MISMATCH",
        }),
      ],
    });

    const timeoutTransport = transportWith(
      (_pageRequest, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("aborted"), {
                code: "PROVIDER_TIMEOUT",
                retryable: true,
              }),
            ),
          );
        }),
    );
    const timeout = await new BoundedHistoricalProviderAdapter(
      approvedConfig({
        retry: {
          maximum_attempts: 2,
          base_delay_ms: 0,
          maximum_delay_ms: 0,
          request_timeout_ms: 5,
        },
      }),
      timeoutTransport,
      Date.now,
      async () => {},
    ).getBoundedHistory(
      request({
        end_time: "2026-03-02T00:00:00.000Z",
        as_of: "2026-03-02T00:00:00.000Z",
        deadline_ms: 100,
      }),
    );
    expect(timeout.shards[0].failure_code).toBe("PROVIDER_TIMEOUT");
    expect(timeoutTransport.fetchPage).toHaveBeenCalledTimes(2);
  });

  test("rejects undeclared fields and credential-shaped provider data", async () => {
    const adapter = new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      transportWith(async () => {
        throw new Error("not used");
      }),
    );
    expect(() =>
      adapter.normalizeRequest(
        request({ requested_fields: ["OHLC", "SECRET_FIELD"] }),
      ),
    ).toThrow(/Unsupported historical field/);

    const unrequested = await new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      transportWith(async (pageRequest) =>
        page(pageRequest, [
          recordFor(pageRequest, "2026-03-01T14:25:00.000Z"),
        ]),
      ),
    ).getBoundedHistory(
      request({
        end_time: "2026-03-02T00:00:00.000Z",
        as_of: "2026-03-02T00:00:00.000Z",
        requested_fields: ["OHLC"],
      }),
    );
    expect(unrequested.shards[0].failure_code).toBe(
      "PROVIDER_SCHEMA_MISMATCH",
    );

    const unrequestedNative = await new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      transportWith(async (pageRequest) => {
        const nativeOnly = recordFor(
          pageRequest,
          "2026-03-01T14:25:00.000Z",
        );
        nativeOnly.normalized.trade_price = null;
        nativeOnly.normalized.volume = null;
        nativeOnly.normalized.vwap = null;
        nativeOnly.normalized.bid_volume = null;
        nativeOnly.normalized.ask_volume = null;
        nativeOnly.normalized.implied_volatility = null;
        nativeOnly.normalized.delta = null;
        nativeOnly.normalized.bid_price = null;
        nativeOnly.normalized.ask_price = null;
        nativeOnly.normalized.open_interest = null;
        nativeOnly.field_methods = { OHLC: "NATIVE_CANDLE" };
        return page(pageRequest, [nativeOnly]);
      }),
    ).getBoundedHistory(
      request({
        end_time: "2026-03-02T00:00:00.000Z",
        as_of: "2026-03-02T00:00:00.000Z",
        requested_fields: ["OHLC"],
      }),
    );
    expect(unrequestedNative.shards[0].failure_code).toBe(
      "PROVIDER_SCHEMA_MISMATCH",
    );

    const sensitive = await new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      transportWith(async (pageRequest) =>
        page(pageRequest, [
          recordFor(pageRequest, "2026-03-01T14:25:00.000Z", {
            native_fields: {
              apiKey: "must-not-enter-evidence",
            },
          }),
        ]),
      ),
    ).getBoundedHistory(
      request({
        end_time: "2026-03-02T00:00:00.000Z",
        as_of: "2026-03-02T00:00:00.000Z",
      }),
    );
    expect(sensitive.shards[0].failure_code).toBe(
      "PROVIDER_SCHEMA_MISMATCH",
    );
    expect(JSON.stringify(sensitive)).not.toContain(
      "must-not-enter-evidence",
    );
  });

  test("keeps page insertion atomic and recalculates retry deadlines", async () => {
    const pagedTransport = transportWith(async (pageRequest) => {
      if (pageRequest.cursor === null) {
        return page(
          pageRequest,
          [recordFor(pageRequest, "2026-03-01T14:25:00.000Z")],
          { next_cursor: "page-2" },
        );
      }
      return page(pageRequest, [
        recordFor(pageRequest, "2026-03-01T14:30:00.000Z"),
      ]);
    });
    const limited = await new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      pagedTransport,
    ).getBoundedHistory(
      request({
        end_time: "2026-03-02T00:00:00.000Z",
        as_of: "2026-03-02T00:00:00.000Z",
        maximum_records: 1,
      }),
    );
    expect(limited.records.map((record) => record.source_time)).toEqual([
      "2026-03-01T14:25:00.000Z",
    ]);
    expect(limited.shards[0]).toMatchObject({
      status: "PARTIAL",
      pages: 1,
      records: 1,
      failure_code: "MAXIMUM_RECORDS_EXCEEDED",
    });

    let elapsed = 0;
    const retryTransport = transportWith(async () => {
      throw Object.assign(new Error("temporary"), {
        code: "PROVIDER_RATE_LIMIT",
        retryable: true,
      });
    });
    const deadline = await new BoundedHistoricalProviderAdapter(
      approvedConfig({
        retry: {
          maximum_attempts: 3,
          base_delay_ms: 60,
          maximum_delay_ms: 60,
          request_timeout_ms: 1000,
        },
      }),
      retryTransport,
      () => Date.parse("2026-09-26T17:00:00.000Z"),
      async (delay) => {
        elapsed += delay;
      },
      () => elapsed,
    ).getBoundedHistory(
      request({
        end_time: "2026-03-02T00:00:00.000Z",
        as_of: "2026-03-02T00:00:00.000Z",
        deadline_ms: 100,
      }),
    );
    expect(deadline.shards[0].failure_code).toBe(
      "DEADLINE_EXCEEDED",
    );
    expect(retryTransport.fetchPage).toHaveBeenCalledTimes(2);

    let postFetchElapsed = 0;
    let wallClock = Date.parse("2026-09-26T17:00:00.000Z");
    const lateTransport = transportWith(async (pageRequest) => {
      postFetchElapsed = 101;
      wallClock += 5000;
      return page(pageRequest, [
        recordFor(pageRequest, "2026-03-01T14:25:00.000Z"),
      ]);
    });
    const late = await new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      lateTransport,
      () => wallClock,
      async () => {},
      () => postFetchElapsed,
    ).getBoundedHistory(
      request({
        end_time: "2026-03-02T00:00:00.000Z",
        as_of: "2026-03-02T00:00:00.000Z",
        deadline_ms: 100,
      }),
    );
    expect(late).toMatchObject({
      status: "NOT_AVAILABLE",
      records: [],
      shards: [
        expect.objectContaining({
          failure_code: "DEADLINE_EXCEEDED",
        }),
      ],
      retrieved_at: "2026-09-26T17:00:05.000Z",
    });
  });

  test("enforces historical-candle output and buffer budgets", async () => {
    const transport = transportWith(async (pageRequest) =>
      page(pageRequest, [
        recordFor(pageRequest, "2026-08-25T14:20:00.000Z"),
        recordFor(pageRequest, "2026-08-25T14:25:00.000Z"),
      ]),
    );
    const adapter = new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      transport,
      () => Date.parse("2026-09-26T17:00:00.000Z"),
    );
    const baseRequest = {
      instruments: [
        {
          symbol: EXACT_EXPIRED_SYMBOL,
          streamer_symbol: NATIVE_EXPIRED_SYMBOL,
          instrument_type: "OPTION",
          lifecycle: "EXPIRED",
        },
      ],
      interval: "5m",
      start_time: "2026-08-25T14:20:00.000Z",
      end_time: "2026-08-25T14:30:00.000Z",
    };

    const [outputLimited] = await adapter.getHistoricalCandlesBatch({
      ...baseRequest,
      max_output_candles: 1,
    });
    expect(outputLimited).toMatchObject({
      status: "PARTIAL",
      snapshot_complete: false,
      snapshot_truncated: true,
      failure_reasons: expect.arrayContaining([
        "LOCAL_OUTPUT_BUDGET_EXCEEDED",
      ]),
    });
    expect(outputLimited.candles).toHaveLength(1);

    const [bufferLimited] = await adapter.getHistoricalCandlesBatch({
      ...baseRequest,
      max_buffer_bytes: 10,
    });
    expect(bufferLimited).toMatchObject({
      status: "NOT_AVAILABLE",
      snapshot_complete: false,
      snapshot_truncated: true,
      failure_reasons: expect.arrayContaining([
        "LOCAL_BUFFER_BUDGET_EXCEEDED",
      ]),
    });
    expect(bufferLimited.candles).toEqual([]);
  });

  test("replays provider-neutral candles through the immutable evidence cache", async () => {
    await withCache(async (cache) => {
      const transport = transportWith(async (pageRequest) =>
        page(pageRequest, [
          recordFor(pageRequest, "2026-08-25T14:25:00.000Z"),
        ]),
      );
      const provider = new BoundedHistoricalProviderAdapter(
        approvedConfig(),
        transport,
        () => Date.parse("2026-09-26T17:00:00.000Z"),
      );
      const cached = new CachedHistoricalCandlesService(provider, cache);
      const onlineRequest = {
        instruments: [
          {
            symbol: EXACT_EXPIRED_SYMBOL,
            streamer_symbol: NATIVE_EXPIRED_SYMBOL,
            instrument_type: "OPTION",
            lifecycle: "EXPIRED",
          },
        ],
        interval: "5m",
        start_time: "2026-08-25T14:20:00.000Z",
        end_time: "2026-08-25T14:30:00.000Z",
        resolution_profile: {
          profile_id: "DEFAULT_5M",
          profile_version: "1.0.0",
          provider_id: "approved-test-provider",
        },
        evidence_cache: {
          mode: "READ_WRITE",
          dataset_id: "synthetic-bounded-candles",
          license_scope_id: "private-test-research",
          normalization_version: "bounded-history/1.0.0",
          model_version: "provider-native/1.0.0",
          source_revision: "synthetic-provider/1",
          as_of: "2026-08-25T14:30:00.000Z",
          evidence_role: "ENTRY",
        },
      };

      const [online] = await cached.getHistoricalCandlesBatch(
        onlineRequest,
      );
      const [offline] = await cached.getHistoricalCandlesBatch({
        ...onlineRequest,
        evidence_cache: {
          ...onlineRequest.evidence_cache,
          mode: "CACHE_ONLY",
          manifest_ids: [online.evidence_cache.manifest_id],
        },
      });

      expect(transport.fetchPage).toHaveBeenCalledTimes(1);
      expect(online).toMatchObject({
        status: "AVAILABLE",
        source: "approved-test-provider",
        bounded_history: {
          approval_reference: "approval/test-only",
          shard_count: 1,
        },
        evidence_cache: {
          cache_status: "MISS",
        },
      });
      expect(online.candles).toHaveLength(1);
      expect(online.candles[0]).toMatchObject({
        provider_evidence: {
          dataset_id: "synthetic-bounded-candles",
          revision: "revision-1",
          method: "SYNTHETIC_FIXTURE",
          native_symbol: NATIVE_EXPIRED_SYMBOL,
          delta: "-25",
        },
      });
      const manifest = await cache.readManifest(
        online.evidence_cache.manifest_id,
      );
      expect(validateManifest(manifest)).toBe(true);
      expect(manifest.source_identity.exact_symbols[0].lifecycle).toBe(
        "EXPIRED",
      );
      expect(offline.evidence_cache.cache_status).toBe(
        "CACHE_ONLY_HIT",
      );
      expect(offline.candles).toEqual(online.candles);
      expect(transport.fetchPage).toHaveBeenCalledTimes(1);
    });
  });

  test("normalizes result defaults and marks sparse windows partial", async () => {
    await withCache(async (cache) => {
      const transport = transportWith(async (pageRequest) =>
        page(pageRequest, [
          recordFor(pageRequest, "2026-08-25T14:20:00.000Z", {
            exact_symbol: "SPX",
            native_symbol: "SPX",
            instrument_type: "INDEX",
            native_fields: {
              EventSymbol: "SPX",
              Close: "7664.96",
              ImpVolatility: "0.2",
            },
          }),
        ]),
      );
      const provider = new BoundedHistoricalProviderAdapter(
        approvedConfig(),
        transport,
        () => Date.parse("2026-09-26T17:00:00.000Z"),
      );
      const cached = new CachedHistoricalCandlesService(provider, cache);
      const [result] = await cached.getHistoricalCandlesBatch({
        instruments: [
          {
            symbol: "spx",
            instrument_type: "INDEX",
            lifecycle: "ACTIVE",
          },
        ],
        interval: "5m",
        start_time: "2026-08-25T14:20:00.000Z",
        end_time: "2026-08-25T15:20:00.000Z",
        resolution_profile: {
          profile_id: "DEFAULT_5M",
          profile_version: "1.0.0",
          provider_id: "approved-test-provider",
        },
        evidence_cache: {
          mode: "READ_WRITE",
          dataset_id: "synthetic-bounded-candles",
          license_scope_id: "private-test-research",
          normalization_version: "bounded-history/1.0.0",
          model_version: "provider-native/1.0.0",
          source_revision: "synthetic-provider/1",
          as_of: "2026-08-25T15:20:00.000Z",
          evidence_role: "ENTRY",
        },
      });

      expect(result).toMatchObject({
        status: "PARTIAL",
        symbol: "SPX",
        streamer_symbol: "SPX",
        session: "ALL",
        timezone: "UTC",
        failure_reasons: expect.arrayContaining([
          "REQUESTED_WINDOW_NOT_COVERED",
        ]),
        evidence_cache: {
          cache_status: "MISS",
        },
      });

      const [regular] = await provider.getHistoricalCandlesBatch({
        instruments: [
          {
            symbol: "spx",
            instrument_type: "INDEX",
            lifecycle: "ACTIVE",
          },
        ],
        interval: "5m",
        start_time: "2026-08-25T14:20:00.000Z",
        end_time: "2026-08-25T14:30:00.000Z",
        session: { kind: "REGULAR" },
      });
      expect(regular).toMatchObject({
        symbol: "SPX",
        streamer_symbol: "SPX",
        session: "REGULAR",
        timezone: "America/New_York",
      });
    });
  });

  test("stores exhausted transient failures only in the retryable TTL path", async () => {
    await withCache(async (cache) => {
      const transport = transportWith(async () => {
        throw Object.assign(
          new Error("socket reset with secret=must-not-persist"),
          { code: "ECONNRESET" },
        );
      });
      const provider = new BoundedHistoricalProviderAdapter(
        approvedConfig(),
        transport,
        () => Date.parse("2026-09-26T17:00:00.000Z"),
        async () => {},
      );
      const cached = new CachedHistoricalCandlesService(provider, cache);
      const cacheRequest = {
        instruments: [
          {
            symbol: EXACT_EXPIRED_SYMBOL,
            streamer_symbol: NATIVE_EXPIRED_SYMBOL,
            instrument_type: "OPTION",
            lifecycle: "EXPIRED",
          },
        ],
        interval: "5m",
        start_time: "2026-08-25T14:20:00.000Z",
        end_time: "2026-08-25T14:30:00.000Z",
        resolution_profile: {
          profile_id: "DEFAULT_5M",
          profile_version: "1.0.0",
          provider_id: "approved-test-provider",
        },
        evidence_cache: {
          mode: "READ_WRITE",
          dataset_id: "synthetic-bounded-candles",
          license_scope_id: "private-test-research",
          normalization_version: "bounded-history/1.0.0",
          model_version: "provider-native/1.0.0",
          source_revision: "synthetic-provider/1",
          as_of: "2026-08-25T14:30:00.000Z",
          evidence_role: "ENTRY",
        },
      };

      const [first] = await cached.getHistoricalCandlesBatch(
        cacheRequest,
      );
      const [second] = await cached.getHistoricalCandlesBatch(
        cacheRequest,
      );

      expect(first).toMatchObject({
        status: "NOT_AVAILABLE",
        failure_reasons: expect.arrayContaining([
          "PROVIDER_TEMPORARY_FAILURE",
        ]),
        evidence_cache: {
          cache_status: "RETRYABLE_FAILURE",
        },
      });
      expect(second.evidence_cache.cache_status).toBe(
        "RETRYABLE_FAILURE_HIT",
      );
      expect(JSON.stringify(second)).not.toContain("must-not-persist");
      expect(transport.fetchPage).toHaveBeenCalledTimes(2);
    });
  });

  test("fails closed on ambiguous option lifecycle and cache identity drift", async () => {
    const transport = transportWith(async () => {
      throw new Error("must not be called");
    });
    const provider = new BoundedHistoricalProviderAdapter(
      approvedConfig({
        capabilities: {
          expired_symbol_coverage: "UNCONFIRMED",
        },
      }),
      transport,
    );
    await expect(
      provider.getHistoricalCandlesBatch({
        instruments: [
          {
            symbol: EXACT_EXPIRED_SYMBOL,
            streamer_symbol: NATIVE_EXPIRED_SYMBOL,
            instrument_type: "OPTION",
          },
        ],
        interval: "5m",
        start_time: "2026-08-25T14:20:00.000Z",
        end_time: "2026-08-25T14:30:00.000Z",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "EXPIRED_SYMBOL_COVERAGE_UNCONFIRMED",
      }),
    );

    const approved = new BoundedHistoricalProviderAdapter(
      approvedConfig(),
      transport,
    );
    expect(() =>
      approved.assertEvidenceCacheAllowed({
        instruments: [
          {
            symbol: EXACT_EXPIRED_SYMBOL,
            streamer_symbol: NATIVE_EXPIRED_SYMBOL,
            instrument_type: "OPTION",
            lifecycle: "EXPIRED",
          },
        ],
        interval: "5m",
        start_time: "2026-08-25T14:20:00.000Z",
        end_time: "2026-08-25T14:30:00.000Z",
        resolution_profile: {
          profile_id: "DEFAULT_5M",
          profile_version: "1.0.0",
          provider_id: "approved-test-provider",
        },
        evidence_cache: {
          mode: "READ_WRITE",
          dataset_id: "wrong-dataset",
          license_scope_id: "private-test-research",
          normalization_version: "bounded-history/1.0.0",
          model_version: "provider-native/1.0.0",
          source_revision: "synthetic-provider/1",
          as_of: "2026-08-25T14:30:00.000Z",
          evidence_role: "ENTRY",
        },
      }),
    ).toThrow(
      expect.objectContaining({ code: "APPROVAL_SCOPE_MISMATCH" }),
    );
    expect(transport.fetchPage).not.toHaveBeenCalled();
  });

  test("blocks evidence-cache writes when storage/reuse is unconfirmed", async () => {
    await withCache(async (cache) => {
      const transport = transportWith(async () => {
        throw new Error("must not be called");
      });
      const provider = new BoundedHistoricalProviderAdapter(
        approvedConfig({
          capabilities: { cache_reuse: "UNCONFIRMED" },
        }),
        transport,
      );
      const cached = new CachedHistoricalCandlesService(provider, cache);

      await expect(
        cached.getHistoricalCandlesBatch({
          instruments: [
            {
              symbol: EXACT_EXPIRED_SYMBOL,
              streamer_symbol: NATIVE_EXPIRED_SYMBOL,
              instrument_type: "OPTION",
              lifecycle: "EXPIRED",
            },
          ],
          interval: "5m",
          start_time: "2026-08-25T14:20:00.000Z",
          end_time: "2026-08-25T14:30:00.000Z",
          resolution_profile: {
            profile_id: "DEFAULT_5M",
            profile_version: "1.0.0",
            provider_id: "approved-test-provider",
          },
          evidence_cache: {
            mode: "READ_WRITE",
            dataset_id: "synthetic-bounded-candles",
            license_scope_id: "private-test-research",
            normalization_version: "bounded-history/1.0.0",
            model_version: "provider-native/1.0.0",
            source_revision: "synthetic-provider/1",
            as_of: "2026-08-25T14:30:00.000Z",
            evidence_role: "ENTRY",
          },
        }),
      ).rejects.toEqual(
        expect.objectContaining({ code: "CACHE_REUSE_NOT_APPROVED" }),
      );
      expect(transport.fetchPage).not.toHaveBeenCalled();
    });
  });
});
