import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, jest, test } from "@jest/globals";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  CachedHistoricalCandlesService,
  FileEvidenceCache,
} from "../dist/evidence-cache.js";
import {
  getHistoricalOptionPackageAtCheckpoint,
} from "../dist/historical-option-package.js";
import {
  normalizeResolutionProfile,
  withEffectiveAggregation,
} from "../dist/resolution-profile.js";

const CACHE_POLICY = {
  dataset_id: "synthetic-dxlink-candles",
  license_scope_id: "private-test-research",
  normalization_version: "historical-candles/1.0.0",
  model_version: "no-model/1.0.0",
  source_revision: "synthetic-source/1",
};

const DD_SYMBOLS = [
  "SPXW  260904P06000000",
  "SPXW  260904C07000000",
  "SPXW  260911P05950000",
  "SPXW  260911C07050000",
];
const DV_SYMBOLS = [
  "SPXW  260924C07750000",
  "SPXW  260924C07800000",
];
const validateManifest = new Ajv2020({ strict: false }).compile(
  JSON.parse(
    readFileSync(
      new URL("../docs/evidence-cache.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

function streamerSymbol(symbol) {
  const root = symbol.slice(0, 6).trim();
  const date = symbol.slice(6, 12);
  const side = symbol.slice(12, 13);
  const strike = Number(symbol.slice(13)) / 1000;
  return `.${root}${date}${side}${strike}`;
}

function directProfile(request) {
  const profile = normalizeResolutionProfile(request.resolution_profile, {
    default_requested_aggregation: request.interval,
    default_max_observation_age_minutes: 0,
    default_max_temporal_skew_minutes: 0,
    default_fallback_aggregations: [],
    default_profile_id: request.resolution_profile
      ? undefined
      : "DIRECT_CANDLE_REQUEST",
    direct_session: {
      kind: "ALL",
      timezone: "UTC",
      start_time: null,
      end_time: null,
    },
    direct_alignment: "MIDNIGHT",
  });
  return withEffectiveAggregation(profile, request.interval);
}

function syntheticResult(request, instrument, index, options = {}) {
  const intervalMinutes = Number.parseInt(request.interval, 10);
  const barEnd = Date.parse(request.end_time);
  const barStart = new Date(
    barEnd - intervalMinutes * 60_000,
  ).toISOString();
  const retrievedAt =
    options.retrievedAt ?? "2026-09-26T16:00:00.000Z";
  const partial = options.partial ?? false;
  const close = String((options.basePrice ?? 100) + index);
  const resolutionProfile = directProfile(request);
  const candles =
    options.empty === true
      ? []
      : [
          {
            source_time: barStart,
            bar_start: barStart,
            bar_end: request.end_time,
            available_at: request.end_time,
            retrieved_at: retrievedAt,
            open: close,
            high: close,
            low: close,
            close,
            volume: "10",
            vwap: close,
            bid_volume: "4",
            ask_volume: "6",
            implied_volatility: "0.2",
            open_interest: "100",
          },
        ];
  const actualRange =
    candles.length === 0
      ? null
      : {
          start: candles[0].source_time,
          end: candles.at(-1).source_time,
        };
  return {
    contract_version: "1.0.0",
    request_id: `synthetic-${instrument.symbol}-${request.interval}`,
    status: partial
      ? "PARTIAL"
      : candles.length === 0
        ? "NOT_AVAILABLE"
        : "AVAILABLE",
    symbol: instrument.symbol,
    streamer_symbol:
      instrument.streamer_symbol ?? instrument.symbol,
    instrument_type: instrument.instrument_type,
    interval: request.interval,
    requested_range: {
      start: request.start_time,
      end: request.end_time,
    },
    actual_range: actualRange,
    timezone: resolutionProfile.session.timezone,
    session: resolutionProfile.session.kind,
    retrieved_at: retrievedAt,
    resolution_profile: resolutionProfile,
    source: "tastytrade-dxlink",
    source_timestamp_unit: "epoch_milliseconds",
    snapshot_complete: !partial,
    snapshot_truncated: partial,
    provider_snapshot_complete: !partial,
    failure_reasons: partial
      ? ["PROVIDER_SNAPSHOT_SNIPPED", "REQUESTED_WINDOW_NOT_COVERED"]
      : [],
    resource_usage: {
      limits: {
        max_output_candles_per_symbol: 20_000,
        max_received_events_per_request: 20_000,
        max_buffer_bytes_per_request: 32 * 1024 * 1024,
        deadline_ms_per_request: 15_000,
        max_candles_compatibility_applied: false,
        timeout_ms_compatibility_applied: false,
      },
      request: {
        received_events: candles.length,
        valid_candle_events: candles.length,
        unique_observations: candles.length,
        retained_rows: candles.length,
        retained_bytes: candles.length * 256,
        returned_rows: candles.length,
        unmatched_received_events: 0,
        unmatched_symbol_count: 0,
        peak_buffer_bytes: candles.length * 256,
      },
      symbol: {
        received_events: candles.length,
        valid_candle_events: candles.length,
        unique_observations: candles.length,
        retained_rows: candles.length,
        retained_bytes: candles.length * 256,
        returned_rows: candles.length,
      },
    },
    transport_diagnostics: {
      requested_symbol: `${instrument.streamer_symbol ?? instrument.symbol}{=${request.interval}}`,
      canonical_requested_symbol: `${instrument.streamer_symbol ?? instrument.symbol}{=${request.interval}}`,
      received_symbols: [
        `${instrument.streamer_symbol ?? instrument.symbol}{=${request.interval}}`,
      ],
      canonical_received_symbols: [
        `${instrument.streamer_symbol ?? instrument.symbol}{=${request.interval}}`,
      ],
      unmatched_received_symbols: [],
      oldest_received_timestamp: candles[0]?.source_time ?? null,
      newest_received_timestamp: candles.at(-1)?.source_time ?? null,
      snapshot_begin_seen: true,
      snapshot_end_seen: !partial,
      snapshot_snip_seen: partial,
      timeout_stage: null,
    },
    advisory: {
      requested_window_candle_slots_per_symbol: 2,
      continuous_calendar_replay_slots_per_symbol: 2,
      continuous_calendar_replay_is_provider_fact: false,
    },
    resampled: false,
    candles,
    warnings: partial
      ? [
          "DXLINK_SNAPSHOT_SNIPPED_NARROW_TIME_RANGE",
          "REQUEST_END_NOT_COVERED_BY_SOURCE_BARS",
        ]
      : [],
  };
}

function requestFor(symbols, asOf, evidenceCache, overrides = {}) {
  return {
    instruments: symbols.map((symbol) => ({
      symbol,
      streamer_symbol:
        symbol === "SPX" ? "SPX" : streamerSymbol(symbol),
      instrument_type: symbol === "SPX" ? "INDEX" : "OPTION",
    })),
    interval: "5m",
    start_time: new Date(Date.parse(asOf) - 30 * 60_000).toISOString(),
    end_time: asOf,
    max_output_candles: 20_000,
    max_received_events: 20_000,
    max_buffer_bytes: 32 * 1024 * 1024,
    evidence_cache: {
      ...CACHE_POLICY,
      as_of: asOf,
      evidence_role: "ENTRY",
      ...evidenceCache,
    },
    ...overrides,
  };
}

function provider(options = {}) {
  let active = 0;
  let maxActive = 0;
  let call = 0;
  const getHistoricalCandlesBatch = jest.fn(async (request) => {
    call += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (options.delayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.delayMs),
        );
      }
      if (options.error && call <= (options.errorCalls ?? 1)) {
        throw options.error;
      }
      return request.instruments.map((instrument, index) =>
        syntheticResult(request, instrument, index, {
          partial: options.partial,
          empty: options.empty,
          basePrice:
            typeof options.basePrice === "function"
              ? options.basePrice(call)
              : options.basePrice,
          retrievedAt:
            typeof options.retrievedAt === "function"
              ? options.retrievedAt(call)
              : options.retrievedAt,
        }),
      );
    } finally {
      active -= 1;
    }
  });
  return {
    getHistoricalCandlesBatch,
    getHistoricalCandles: jest.fn(async (request) => {
      const [result] = await getHistoricalCandlesBatch({
        ...request,
        instruments: [
          {
            symbol: request.symbol,
            streamer_symbol: request.streamer_symbol,
            instrument_type: request.instrument_type,
          },
        ],
      });
      return result;
    }),
    maxActive: () => maxActive,
  };
}

async function withCache(testBody, config = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), "tastytrade-evidence-cache-"),
  );
  const cache = new FileEvidenceCache({
    directory,
    maxBytes: 16 * 1024 * 1024,
    maxConcurrency: 2,
    retryableFailureTtlMs: 1_000,
    ...config,
  });
  try {
    await testBody(cache, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function manifestIds(results) {
  return [
    ...new Set(
      results.map((result) => result.evidence_cache.manifest_id),
    ),
  ];
}

function checkpointPackageRequest(
  family,
  symbols,
  asOf,
  checkpointId,
  evidenceCache,
) {
  return {
    family,
    underlying: "SPX",
    as_of: asOf,
    legs: symbols.map((providerSymbol, index) => ({
      provider_symbol: providerSymbol,
      action: index % 2 === 0 ? "BUY_TO_OPEN" : "SELL_TO_OPEN",
    })),
    max_observation_age_minutes: 60,
    max_temporal_skew_minutes: 10,
    phase: "REGRESSION_RESEARCH",
    references: { checkpoint_id: checkpointId },
    evidence_cache: {
      ...CACHE_POLICY,
      mode: "READ_WRITE",
      evidence_role: "ENTRY",
      ...evidenceCache,
    },
  };
}

describe("private immutable research evidence cache", () => {
  test("freezes the 2026-08-07 DD and 2026-08-27 DV manifests and replays cache-only without provider calls", async () => {
    await withCache(async (cache) => {
      const onlineProvider = provider();
      const online = new CachedHistoricalCandlesService(
        onlineProvider,
        cache,
      );
      const ddRequest = checkpointPackageRequest(
        "DOUBLE_DIAGONAL",
        DD_SYMBOLS,
        "2026-08-07T14:30:00.000Z",
        "spx-2026-08-07-dd-0730-pt",
      );
      const dvRequest = checkpointPackageRequest(
        "DEBIT_VERTICAL",
        DV_SYMBOLS,
        "2026-08-27T14:30:00.000Z",
        "spx-2026-08-27-dv-0730-pt",
      );

      const dd = await getHistoricalOptionPackageAtCheckpoint(
        online,
        ddRequest,
      );
      const dv = await getHistoricalOptionPackageAtCheckpoint(
        online,
        dvRequest,
      );
      expect(onlineProvider.getHistoricalCandlesBatch).toHaveBeenCalledTimes(
        2,
      );
      expect(dd).toMatchObject({
        status: "AVAILABLE",
        family: "DOUBLE_DIAGONAL",
        evidence_cache: {
          cache_misses: 1,
          normalized_content_ids: [
            expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          ],
        },
      });
      expect(dv).toMatchObject({
        status: "AVAILABLE",
        family: "DEBIT_VERTICAL",
        evidence_cache: {
          cache_misses: 1,
        },
      });
      const frozenDdManifest = await cache.readManifest(
        dd.evidence_cache.manifest_ids[0],
      );
      expect(validateManifest(frozenDdManifest)).toBe(true);
      expect(validateManifest.errors).toBeNull();
      expect(frozenDdManifest).toMatchObject({
        retrieved_at: ["2026-09-26T16:00:00.000Z"],
        status: {
          freshness_policy: {
            max_observation_age_minutes: 60,
            max_temporal_skew_minutes: 10,
          },
          temporal_skew_minutes: 0,
          results: expect.arrayContaining([
            expect.objectContaining({
              latest_available_at: "2026-08-07T14:30:00.000Z",
              observation_age_minutes: 0,
              snapshot_complete: true,
              snapshot_truncated: false,
            }),
          ]),
        },
      });
      expect(
        frozenDdManifest.objects.normalized_result.derived_from,
      ).toEqual([
        frozenDdManifest.objects.provider_payload.content_id,
      ]);
      expect(frozenDdManifest.lineage).toMatchObject({
        normalized_result_derived_from: [
          frozenDdManifest.objects.provider_payload.content_id,
        ],
        retrieved_at_is_not_availability: true,
      });

      const offlineProvider = provider({
        error: new Error("offline provider must never be called"),
        errorCalls: Number.POSITIVE_INFINITY,
      });
      const offline = new CachedHistoricalCandlesService(
        offlineProvider,
        cache,
      );
      const replayedDd = await getHistoricalOptionPackageAtCheckpoint(
        offline,
        {
        ...ddRequest,
        evidence_cache: {
          ...ddRequest.evidence_cache,
          mode: "CACHE_ONLY",
            manifest_ids: dd.evidence_cache.manifest_ids,
        },
        },
      );
      const replayedDv = await getHistoricalOptionPackageAtCheckpoint(
        offline,
        {
        ...dvRequest,
        evidence_cache: {
          ...dvRequest.evidence_cache,
          mode: "CACHE_ONLY",
            manifest_ids: dv.evidence_cache.manifest_ids,
        },
        },
      );

      expect(offlineProvider.getHistoricalCandlesBatch).not.toHaveBeenCalled();
      expect(
        replayedDd.evidence_cache.normalized_content_ids,
      ).toEqual(dd.evidence_cache.normalized_content_ids);
      expect(
        replayedDv.evidence_cache.normalized_content_ids,
      ).toEqual(dv.evidence_cache.normalized_content_ids);
      expect(replayedDd.evidence_cache.cache_only_hits).toBe(1);
      expect(replayedDv.evidence_cache.cache_only_hits).toBe(1);
    });
  });

  test("keeps source revision, profile, aggregation, and provider identities collision-free and preserves revisions", async () => {
    await withCache(async (cache) => {
      const source = provider({
        basePrice: (call) => 100 + call,
        retrievedAt: (call) =>
          `2026-09-26T16:0${call}:00.000Z`,
      });
      const service = new CachedHistoricalCandlesService(source, cache);
      const base = requestFor(
        ["SPX"],
        "2026-08-27T14:30:00.000Z",
        { mode: "READ_WRITE" },
      );
      const first = await service.getHistoricalCandlesBatch(base);
      const revised = await service.getHistoricalCandlesBatch({
        ...base,
        evidence_cache: {
          ...base.evidence_cache,
          mode: "REFRESH",
        },
      });
      const differentRevision = await service.getHistoricalCandlesBatch({
        ...base,
        evidence_cache: {
          ...base.evidence_cache,
          source_revision: "synthetic-source/2",
        },
      });
      const differentProfile = await service.getHistoricalCandlesBatch({
        ...base,
        resolution_profile: {
          profile_id: "DEFAULT_5M",
          profile_version: "1.0.0",
        },
      });
      const differentAggregation =
        await service.getHistoricalCandlesBatch({
          ...base,
          interval: "15m",
          start_time: "2026-08-27T13:30:00.000Z",
        });
      const otherProvider = await service.getHistoricalCandlesBatch({
        ...base,
        resolution_profile: {
          profile_id: "DEFAULT_5M",
          profile_version: "1.0.0",
          provider_id: "synthetic-provider-b",
        },
      });

      const ids = [
        first,
        revised,
        differentRevision,
        differentProfile,
        differentAggregation,
        otherProvider,
      ].map((results) => results[0].evidence_cache.manifest_id);
      expect(new Set(ids).size).toBe(ids.length);

      const revisedManifest = await cache.readManifest(ids[1]);
      expect(revisedManifest).toMatchObject({
        revision: 2,
        diff: {
          previous_manifest_id: ids[0],
          provider_payload_changed: true,
          normalized_result_changed: true,
          changed_symbols: ["SPX"],
        },
      });
      const firstManifest = JSON.parse(
        await readFile(cache.manifestPath(ids[0]), "utf8"),
      );
      expect(firstManifest.manifest_id).toBe(ids[0]);
      const frozenFirst = await service.getHistoricalCandlesBatch({
        ...base,
        evidence_cache: {
          ...base.evidence_cache,
          mode: "CACHE_ONLY",
          manifest_ids: [ids[0]],
        },
      });
      expect(frozenFirst[0].candles[0].close).toBe(
        first[0].candles[0].close,
      );
      expect(frozenFirst[0].candles[0].close).not.toBe(
        revised[0].candles[0].close,
      );
    });
  });

  test("reuses raw evidence when only references change", async () => {
    await withCache(async (cache) => {
      const source = provider();
      const service = new CachedHistoricalCandlesService(source, cache);
      const baseInput = {
        family: "DEBIT_VERTICAL",
        underlying: "SPX",
        as_of: "2026-08-27T14:30:00.000Z",
        legs: [
          {
            provider_symbol: DV_SYMBOLS[0],
            action: "BUY_TO_OPEN",
          },
          {
            provider_symbol: DV_SYMBOLS[1],
            action: "SELL_TO_OPEN",
          },
        ],
        max_observation_age_minutes: 60,
        max_temporal_skew_minutes: 10,
        phase: "REGRESSION_RESEARCH",
        evidence_cache: {
          ...CACHE_POLICY,
          mode: "READ_WRITE",
          evidence_role: "ENTRY",
        },
      };

      const first = await getHistoricalOptionPackageAtCheckpoint(
        service,
        {
          ...baseInput,
          references: {
            checkpoint_id: "checkpoint-a",
            paper_order_id: "paper-a",
          },
        },
      );
      const second = await getHistoricalOptionPackageAtCheckpoint(
        service,
        {
          ...baseInput,
          references: {
            checkpoint_id: "checkpoint-b",
            paper_order_id: "paper-b",
          },
        },
      );

      expect(source.getHistoricalCandlesBatch).toHaveBeenCalledTimes(1);
      expect(first.request_id).not.toBe(second.request_id);
      expect(first.evidence_cache.manifest_ids).not.toEqual(
        second.evidence_cache.manifest_ids,
      );
      expect(first.evidence_cache.normalized_content_ids).toEqual(
        second.evidence_cache.normalized_content_ids,
      );
      expect(second.evidence_cache.provider_calls_avoided).toBe(1);
    });
  });

  test("preserves partial coverage and isolates retryable failure provenance from valid evidence", async () => {
    let now = Date.parse("2026-09-26T16:00:00.000Z");
    await withCache(
      async (cache) => {
        const partialProvider = provider({ partial: true });
        const partialService = new CachedHistoricalCandlesService(
          partialProvider,
          cache,
        );
        const partialRequest = requestFor(
          ["SPX"],
          "2026-08-27T14:30:00.000Z",
          {
            mode: "READ_WRITE",
            source_revision: "partial-source/1",
          },
        );
        const partial =
          await partialService.getHistoricalCandlesBatch(partialRequest);
        const replayed =
          await partialService.getHistoricalCandlesBatch({
            ...partialRequest,
            evidence_cache: {
              ...partialRequest.evidence_cache,
              mode: "CACHE_ONLY",
              manifest_ids: manifestIds(partial),
            },
          });
        expect(replayed[0]).toMatchObject({
          status: "PARTIAL",
          snapshot_truncated: true,
          failure_reasons: [
            "PROVIDER_SNAPSHOT_SNIPPED",
            "REQUESTED_WINDOW_NOT_COVERED",
          ],
        });

        const unavailableProvider = provider({ empty: true });
        const unavailableService = new CachedHistoricalCandlesService(
          unavailableProvider,
          cache,
        );
        const unavailableRequest = requestFor(
          ["SPX"],
          "2026-08-27T15:30:00.000Z",
          {
            mode: "READ_WRITE",
            source_revision: "not-available-source/1",
          },
        );
        const unavailable =
          await unavailableService.getHistoricalCandlesBatch(
            unavailableRequest,
          );
        const replayedUnavailable =
          await unavailableService.getHistoricalCandlesBatch({
            ...unavailableRequest,
            evidence_cache: {
              ...unavailableRequest.evidence_cache,
              mode: "CACHE_ONLY",
              manifest_ids: manifestIds(unavailable),
            },
          });
        expect(replayedUnavailable[0]).toMatchObject({
          status: "NOT_AVAILABLE",
          actual_range: null,
          candles: [],
        });
        expect(
          unavailableProvider.getHistoricalCandlesBatch,
        ).toHaveBeenCalledTimes(1);

        let timeoutCalls = 0;
        const timeoutProvider = {
          getHistoricalCandles: jest.fn(),
          getHistoricalCandlesBatch: jest.fn(async (request) => {
            timeoutCalls += 1;
            if (timeoutCalls === 1) {
              return request.instruments.map((instrument, index) => {
                const result = syntheticResult(
                  request,
                  instrument,
                  index,
                  { empty: true },
                );
                return {
                  ...result,
                  status: "NOT_AVAILABLE",
                  snapshot_complete: false,
                  provider_snapshot_complete: false,
                  failure_reasons: ["SNAPSHOT_TIMEOUT"],
                  warnings: ["SNAPSHOT_TIMEOUT"],
                };
              });
            }
            return request.instruments.map((instrument, index) =>
              syntheticResult(request, instrument, index),
            );
          }),
        };
        const timeoutService = new CachedHistoricalCandlesService(
          timeoutProvider,
          cache,
        );
        const timeoutRequest = requestFor(
          ["SPX"],
          "2026-08-27T16:30:00.000Z",
          {
            mode: "READ_WRITE",
            source_revision: "timeout-result-source/1",
          },
        );
        const timedOut =
          await timeoutService.getHistoricalCandlesBatch(timeoutRequest);
        expect(timedOut[0]).toMatchObject({
          status: "NOT_AVAILABLE",
          evidence_cache: {
            cache_status: "RETRYABLE_FAILURE",
          },
        });
        expect(await cache.listValidManifests(timeoutRequest)).toEqual([]);
        const cachedTimeout =
          await timeoutService.getHistoricalCandlesBatch(timeoutRequest);
        expect(cachedTimeout[0].evidence_cache.cache_status).toBe(
          "RETRYABLE_FAILURE_HIT",
        );
        expect(timeoutProvider.getHistoricalCandlesBatch).toHaveBeenCalledTimes(
          1,
        );
        now += 1_001;
        const timeoutRecovered =
          await timeoutService.getHistoricalCandlesBatch(timeoutRequest);
        expect(timeoutRecovered[0].status).toBe("AVAILABLE");
        expect(timeoutProvider.getHistoricalCandlesBatch).toHaveBeenCalledTimes(
          2,
        );
        expect(await cache.listValidManifests(timeoutRequest)).toHaveLength(1);

        const retryable = new Error("synthetic timeout");
        retryable.code = "ETIMEDOUT";
        retryable.retryable = true;
        const flakyProvider = provider({
          error: retryable,
          errorCalls: 1,
        });
        const flaky = new CachedHistoricalCandlesService(
          flakyProvider,
          cache,
        );
        const flakyRequest = requestFor(
          ["SPX"],
          "2026-08-28T14:30:00.000Z",
          {
            mode: "READ_WRITE",
            source_revision: "retryable-source/1",
          },
        );

        let firstFailure;
        try {
          await flaky.getHistoricalCandlesBatch(flakyRequest);
        } catch (error) {
          firstFailure = error;
        }
        expect(firstFailure).toMatchObject({
          code: "EVIDENCE_CACHE_PROVIDER_ERROR",
          retryable: true,
          failure_manifest_id: expect.stringMatching(
            /^sha256:[a-f0-9]{64}$/,
          ),
        });
        await expect(
          cache.readManifest(firstFailure.failure_manifest_id),
        ).resolves.toMatchObject({
          manifest_type: "HISTORICAL_SOURCE_FAILURE",
          retryable: true,
          error: {
            code: "ETIMEDOUT",
            message: "synthetic timeout",
          },
        });
        await expect(
          flaky.getHistoricalCandlesBatch(flakyRequest),
        ).rejects.toMatchObject({
          code: "EVIDENCE_CACHE_RETRYABLE_FAILURE",
          retryable: true,
          cached: true,
        });
        expect(flakyProvider.getHistoricalCandlesBatch).toHaveBeenCalledTimes(
          1,
        );
        expect(await cache.listValidManifests(flakyRequest)).toEqual([]);

        now += 1_001;
        const recovered =
          await flaky.getHistoricalCandlesBatch(flakyRequest);
        expect(flakyProvider.getHistoricalCandlesBatch).toHaveBeenCalledTimes(
          2,
        );
        expect(recovered[0].status).toBe("AVAILABLE");
      },
      { clock: () => now },
    );
  });

  test("fails closed on missing shards, checksum corruption, and policy mismatch without calling a provider", async () => {
    await withCache(async (cache) => {
      const source = provider();
      const service = new CachedHistoricalCandlesService(source, cache);
      const request = requestFor(
        ["SPX"],
        "2026-08-27T14:30:00.000Z",
        { mode: "READ_WRITE" },
      );
      const stored = await service.getHistoricalCandlesBatch(request);
      const [manifestId] = manifestIds(stored);
      const manifest = await cache.readManifest(manifestId);
      const offlineProvider = provider({
        error: new Error("must remain offline"),
        errorCalls: Number.POSITIVE_INFINITY,
      });
      const offline = new CachedHistoricalCandlesService(
        offlineProvider,
        cache,
      );

      await expect(
        offline.getHistoricalCandlesBatch({
          ...request,
          evidence_cache: {
            ...request.evidence_cache,
            mode: "CACHE_ONLY",
            manifest_ids: [`sha256:${"0".repeat(64)}`],
          },
        }),
      ).rejects.toMatchObject({
        code: "EVIDENCE_CACHE_MANIFEST_NOT_FOUND",
      });

      await expect(
        offline.getHistoricalCandlesBatch({
          ...request,
          evidence_cache: {
            ...request.evidence_cache,
            mode: "CACHE_ONLY",
            source_revision: "wrong-source-revision",
            manifest_ids: [manifestId],
          },
        }),
      ).rejects.toMatchObject({
        code: "EVIDENCE_CACHE_POLICY_MISMATCH",
      });

      await rm(
        cache.objectPath(
          manifest.objects.provider_payload.content_id,
        ),
      );
      await expect(
        offline.getHistoricalCandlesBatch({
          ...request,
          evidence_cache: {
            ...request.evidence_cache,
            mode: "CACHE_ONLY",
            manifest_ids: [manifestId],
          },
        }),
      ).rejects.toMatchObject({
        code: "EVIDENCE_CACHE_SHARD_MISSING",
      });

      const checksumRequest = requestFor(
        ["SPX"],
        "2026-08-28T14:30:00.000Z",
        {
          mode: "READ_WRITE",
          source_revision: "checksum-source/1",
        },
      );
      const restored = await service.getHistoricalCandlesBatch({
        ...checksumRequest,
        evidence_cache: {
          ...checksumRequest.evidence_cache,
        },
      });
      const restoredManifest = await cache.readManifest(
        restored[0].evidence_cache.manifest_id,
      );
      await writeFile(
        cache.objectPath(
          restoredManifest.objects.normalized_result.content_id,
        ),
        "{\"corrupted\":true}\n",
        "utf8",
      );
      await expect(
        offline.getHistoricalCandlesBatch({
          ...checksumRequest,
          evidence_cache: {
            ...checksumRequest.evidence_cache,
            mode: "CACHE_ONLY",
            manifest_ids: [
              restored[0].evidence_cache.manifest_id,
            ],
          },
        }),
      ).rejects.toMatchObject({
        code: "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
      });
      expect(offlineProvider.getHistoricalCandlesBatch).not.toHaveBeenCalled();
    });
  });

  test("does not substitute an uncached fallback resolution during exact offline replay", async () => {
    await withCache(async (cache) => {
      const source = provider({ partial: true });
      const online = new CachedHistoricalCandlesService(source, cache);
      const asOf = "2026-08-27T14:30:00.000Z";
      const resolutionProfile = {
        profile_id: "DEFAULT_5M",
        profile_version: "1.0.0",
        max_observation_age_minutes: 60,
        max_temporal_skew_minutes: 10,
        allowed_fallback_aggregations: ["15m", "30m", "1h"],
      };
      const sourceRequest = requestFor(
        DV_SYMBOLS,
        asOf,
        {
          mode: "READ_WRITE",
          references: { checkpoint_id: "offline-no-substitution" },
        },
        {
          start_time: "2026-08-27T12:30:00.000Z",
          resolution_profile: resolutionProfile,
        },
      );
      const partial = await online.getHistoricalCandlesBatch(
        sourceRequest,
      );

      const offlineProvider = provider({
        error: new Error("provider must stay offline"),
        errorCalls: Number.POSITIVE_INFINITY,
      });
      const offline = new CachedHistoricalCandlesService(
        offlineProvider,
        cache,
      );
      await expect(
        getHistoricalOptionPackageAtCheckpoint(offline, {
          ...checkpointPackageRequest(
            "DEBIT_VERTICAL",
            DV_SYMBOLS,
            asOf,
            "offline-no-substitution",
          ),
          resolution_profile: resolutionProfile,
          evidence_cache: {
            ...CACHE_POLICY,
            mode: "CACHE_ONLY",
            evidence_role: "ENTRY",
            manifest_ids: manifestIds(partial),
          },
        }),
      ).rejects.toMatchObject({
        code: "EVIDENCE_CACHE_POLICY_MISMATCH",
      });
      expect(offlineProvider.getHistoricalCandlesBatch).not.toHaveBeenCalled();
    });
  });

  test("keeps valid evidence usable after a retryable refresh failure and rejects sensitive payloads", async () => {
    await withCache(async (cache) => {
      let fail = false;
      const source = provider();
      const original = source.getHistoricalCandlesBatch;
      source.getHistoricalCandlesBatch = jest.fn(async (request) => {
        if (fail) {
          const error = new Error("temporary refresh timeout");
          error.code = "ETIMEDOUT";
          error.retryable = true;
          throw error;
        }
        return original(request);
      });
      const service = new CachedHistoricalCandlesService(source, cache);
      const request = requestFor(
        ["SPX"],
        "2026-08-27T14:30:00.000Z",
        {
          mode: "READ_WRITE",
          source_revision: "stable-before-retry/1",
        },
      );
      const valid = await service.getHistoricalCandlesBatch(request);
      fail = true;
      await expect(
        service.getHistoricalCandlesBatch({
          ...request,
          evidence_cache: {
            ...request.evidence_cache,
            mode: "REFRESH",
          },
        }),
      ).rejects.toMatchObject({
        code: "EVIDENCE_CACHE_PROVIDER_ERROR",
        retryable: true,
      });
      const reused = await service.getHistoricalCandlesBatch(request);
      expect(reused[0].evidence_cache.cache_status).toBe("HIT");
      expect(reused[0].evidence_cache.normalized_content_id).toBe(
        valid[0].evidence_cache.normalized_content_id,
      );
      expect(source.getHistoricalCandlesBatch).toHaveBeenCalledTimes(2);

      const sensitiveProvider = provider();
      sensitiveProvider.getHistoricalCandlesBatch = jest.fn(
        async (providerRequest) =>
          providerRequest.instruments.map((instrument, index) => ({
            ...syntheticResult(providerRequest, instrument, index),
            access_token: "must-not-be-persisted",
          })),
      );
      const sensitiveService = new CachedHistoricalCandlesService(
        sensitiveProvider,
        cache,
      );
      await expect(
        sensitiveService.getHistoricalCandlesBatch(
          requestFor(
            ["SPX"],
            "2026-08-28T14:30:00.000Z",
            {
              mode: "READ_WRITE",
              source_revision: "sensitive-source/1",
            },
          ),
        ),
      ).rejects.toMatchObject({
        code: "EVIDENCE_CACHE_SENSITIVE_DATA_REJECTED",
      });
    });
  });

  test("deduplicates concurrent requests, bounds distinct provider calls, writes atomically, and enforces quota", async () => {
    await withCache(async (cache, directory) => {
      const source = provider({ delayMs: 20 });
      const service = new CachedHistoricalCandlesService(source, cache);
      const sameRequest = requestFor(
        ["SPX"],
        "2026-08-27T14:30:00.000Z",
        { mode: "READ_WRITE" },
      );
      const sameResults = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.getHistoricalCandlesBatch(
            structuredClone(sameRequest),
          ),
        ),
      );
      expect(source.getHistoricalCandlesBatch).toHaveBeenCalledTimes(1);
      expect(
        new Set(
          sameResults.map(
            (results) => results[0].evidence_cache.manifest_id,
          ),
        ).size,
      ).toBe(1);

      const distinct = Array.from({ length: 5 }, (_, index) =>
        service.getHistoricalCandlesBatch(
          requestFor(
            ["SPX"],
            `2026-09-0${index + 1}T14:30:00.000Z`,
            {
              mode: "READ_WRITE",
              source_revision: `bounded/${index}`,
            },
          ),
        ),
      );
      await Promise.all(distinct);
      expect(source.maxActive()).toBeLessThanOrEqual(2);

      const temporaryFiles = (
        await cache.listFiles()
      ).filter((path) => path.endsWith(".tmp"));
      expect(temporaryFiles).toEqual([]);
      expect(directory).toContain("tastytrade-evidence-cache-");
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      const firstManifest = sameResults[0][0].evidence_cache.manifest_id;
      expect(
        (await stat(cache.manifestPath(firstManifest))).mode & 0o777,
      ).toBe(0o600);
    });

    await withCache(
      async (cache) => {
        const source = provider();
        const service = new CachedHistoricalCandlesService(source, cache);
        await expect(
          service.getHistoricalCandlesBatch(
            requestFor(
              DD_SYMBOLS,
              "2026-08-07T14:30:00.000Z",
              { mode: "READ_WRITE" },
            ),
          ),
        ).rejects.toMatchObject({
          code: "EVIDENCE_CACHE_QUOTA_EXCEEDED",
        });
        expect(await cache.listValidManifests()).toEqual([]);
      },
      { maxBytes: 512 },
    );
  });

  test("bundles cross-month entry, +3, and +5 trading-day evidence while keeping outcomes out of entry selection", async () => {
    await withCache(async (cache) => {
      const source = provider();
      const service = new CachedHistoricalCandlesService(source, cache);
      const requests = [
        requestFor(["SPX"], "2026-08-28T14:30:00.000Z", {
          mode: "READ_WRITE",
          evidence_role: "ENTRY",
        }),
        requestFor(["SPX"], "2026-09-02T14:30:00.000Z", {
          mode: "READ_WRITE",
          evidence_role: "OUTCOME_3_TRADING_DAYS",
        }),
        requestFor(["SPX"], "2026-09-04T14:30:00.000Z", {
          mode: "READ_WRITE",
          evidence_role: "OUTCOME_5_TRADING_DAYS",
        }),
      ];
      const results = [];
      for (const request of requests) {
        results.push(
          await service.getHistoricalCandlesBatch(request),
        );
      }
      const bundle = await cache.createManifestSet({
        label: "spx-2026-08-28-cross-month",
        entry_as_of: "2026-08-28T14:30:00.000Z",
        manifests: results.map((batch, index) => ({
          evidence_role:
            requests[index].evidence_cache.evidence_role,
          manifest_id: batch[0].evidence_cache.manifest_id,
        })),
      });
      expect(bundle).toMatchObject({
        contract_version: "1.0.0",
        manifest_type: "EVIDENCE_MANIFEST_SET",
        entry_as_of: "2026-08-28T14:30:00.000Z",
        manifests: [
          { evidence_role: "ENTRY" },
          { evidence_role: "OUTCOME_3_TRADING_DAYS" },
          { evidence_role: "OUTCOME_5_TRADING_DAYS" },
        ],
      });
      expect(validateManifest(bundle)).toBe(true);
      expect(validateManifest.errors).toBeNull();

      const offlineProvider = provider({
        error: new Error("offline"),
        errorCalls: Number.POSITIVE_INFINITY,
      });
      const offline = new CachedHistoricalCandlesService(
        offlineProvider,
        cache,
      );
      const replayed = await offline.getHistoricalCandlesBatch({
        ...requests[2],
        evidence_cache: {
          ...requests[2].evidence_cache,
          mode: "CACHE_ONLY",
          manifest_ids: [bundle.manifest_id],
        },
      });
      expect(replayed[0].candles).toEqual(results[2][0].candles);
      expect(offlineProvider.getHistoricalCandlesBatch).not.toHaveBeenCalled();
    });
  });
});
