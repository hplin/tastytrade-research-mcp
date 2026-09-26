import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CachedHistoricalCandlesService,
  FileEvidenceCache,
} from "../dist/evidence-cache.js";
import {
  normalizeResolutionProfile,
  withEffectiveAggregation,
} from "../dist/resolution-profile.js";

const fixedNow = Date.parse("2026-09-26T16:00:00.000Z");
const directory = await mkdtemp(
  join(tmpdir(), "tastytrade-evidence-cache-report-"),
);
let providerCalls = 0;

const request = {
  instruments: [
    {
      symbol: "SPX",
      streamer_symbol: "SPX",
      instrument_type: "INDEX",
    },
  ],
  interval: "5m",
  start_time: "2026-08-27T14:00:00.000Z",
  end_time: "2026-08-27T14:30:00.000Z",
  max_output_candles: 20_000,
  max_received_events: 20_000,
  max_buffer_bytes: 32 * 1024 * 1024,
  evidence_cache: {
    mode: "READ_WRITE",
    dataset_id: "synthetic-dxlink-candles",
    license_scope_id: "private-test-research",
    normalization_version: "historical-candles/1.0.0",
    model_version: "no-model/1.0.0",
    source_revision: "synthetic-source/1",
    as_of: "2026-08-27T14:30:00.000Z",
    evidence_role: "ENTRY",
    references: {
      checkpoint_id: "synthetic-2026-08-27-0730-pt",
    },
  },
};

const resolutionProfile = withEffectiveAggregation(
  normalizeResolutionProfile(undefined, {
    default_requested_aggregation: "5m",
    default_max_observation_age_minutes: 0,
    default_max_temporal_skew_minutes: 0,
    default_fallback_aggregations: [],
    default_profile_id: "DIRECT_CANDLE_REQUEST",
    direct_session: {
      kind: "ALL",
      timezone: "UTC",
      start_time: null,
      end_time: null,
    },
    direct_alignment: "MIDNIGHT",
  }),
  "5m",
);

const provider = {
  async getHistoricalCandles() {
    throw new Error("The synthetic report uses batched retrieval.");
  },
  async getHistoricalCandlesBatch(input) {
    providerCalls += 1;
    return input.instruments.map((instrument) => ({
      contract_version: "1.0.0",
      request_id: "synthetic-report-request",
      status: "AVAILABLE",
      symbol: instrument.symbol,
      streamer_symbol: instrument.streamer_symbol,
      instrument_type: instrument.instrument_type,
      interval: input.interval,
      requested_range: {
        start: input.start_time,
        end: input.end_time,
      },
      actual_range: {
        start: "2026-08-27T14:25:00.000Z",
        end: "2026-08-27T14:25:00.000Z",
      },
      timezone: "UTC",
      session: "ALL",
      retrieved_at: "2026-09-26T16:00:00.000Z",
      resolution_profile: resolutionProfile,
      source: "tastytrade-dxlink",
      source_timestamp_unit: "epoch_milliseconds",
      snapshot_complete: true,
      snapshot_truncated: false,
      provider_snapshot_complete: true,
      failure_reasons: [],
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
          received_events: 1,
          valid_candle_events: 1,
          unique_observations: 1,
          retained_rows: 1,
          retained_bytes: 256,
          returned_rows: 1,
          unmatched_received_events: 0,
          unmatched_symbol_count: 0,
          peak_buffer_bytes: 256,
        },
        symbol: {
          received_events: 1,
          valid_candle_events: 1,
          unique_observations: 1,
          retained_rows: 1,
          retained_bytes: 256,
          returned_rows: 1,
        },
      },
      transport_diagnostics: {
        requested_symbol: "SPX{=5m}",
        canonical_requested_symbol: "SPX{=5m}",
        received_symbols: ["SPX{=5m}"],
        canonical_received_symbols: ["SPX{=5m}"],
        unmatched_received_symbols: [],
        oldest_received_timestamp: "2026-08-27T14:25:00.000Z",
        newest_received_timestamp: "2026-08-27T14:25:00.000Z",
        snapshot_begin_seen: true,
        snapshot_end_seen: true,
        snapshot_snip_seen: false,
        timeout_stage: null,
      },
      advisory: {
        requested_window_candle_slots_per_symbol: 7,
        continuous_calendar_replay_slots_per_symbol: 7,
        continuous_calendar_replay_is_provider_fact: false,
      },
      resampled: false,
      candles: [
        {
          source_time: "2026-08-27T14:25:00.000Z",
          bar_start: "2026-08-27T14:25:00.000Z",
          bar_end: "2026-08-27T14:30:00.000Z",
          available_at: "2026-08-27T14:30:00.000Z",
          retrieved_at: "2026-09-26T16:00:00.000Z",
          open: "6500",
          high: "6501",
          low: "6499",
          close: "6500",
          volume: "10",
          vwap: "6500",
          bid_volume: "4",
          ask_volume: "6",
          implied_volatility: "0.2",
          open_interest: "100",
        },
      ],
      warnings: [],
    }));
  },
};

try {
  const cache = new FileEvidenceCache({
    directory,
    maxBytes: 16 * 1024 * 1024,
    maxConcurrency: 2,
    retryableFailureTtlMs: 1_000,
    clock: () => fixedNow,
  });
  const service = new CachedHistoricalCandlesService(provider, cache);
  const first = await service.getHistoricalCandlesBatch(request);
  const firstProviderCalls = providerCalls;
  const second = await service.getHistoricalCandlesBatch({
    ...request,
    evidence_cache: {
      ...request.evidence_cache,
      mode: "CACHE_ONLY",
      manifest_ids: [first[0].evidence_cache.manifest_id],
    },
  });
  const secondProviderCalls = providerCalls - firstProviderCalls;
  const metrics = cache.getMetrics();
  const expectedWithoutCache = 2;
  const callsAvoided = expectedWithoutCache - providerCalls;

  console.log(
    JSON.stringify(
      {
        contract_version: "1.0.0",
        data_classification: "SYNTHETIC_SANITIZED",
        first_run: {
          cache_status: first[0].evidence_cache.cache_status,
          manifest_id: first[0].evidence_cache.manifest_id,
          normalized_content_id:
            first[0].evidence_cache.normalized_content_id,
          bytes_written: first[0].evidence_cache.bytes_written,
          provider_calls: firstProviderCalls,
        },
        second_cache_only_run: {
          cache_status: second[0].evidence_cache.cache_status,
          normalized_content_id:
            second[0].evidence_cache.normalized_content_id,
          bytes_read: second[0].evidence_cache.bytes_read,
          provider_calls: secondProviderCalls,
        },
        normalized_hash_stable:
          first[0].evidence_cache.normalized_content_id ===
          second[0].evidence_cache.normalized_content_id,
        provider_call_reduction: {
          expected_without_cache: expectedWithoutCache,
          actual: providerCalls,
          avoided: callsAvoided,
          percent: (callsAvoided / expectedWithoutCache) * 100,
        },
        cache_metrics: metrics,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
