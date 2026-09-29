import { createHash } from "node:crypto";
import type { AxiosInstance } from "axios";
import { assertTrustedHosts } from "./config.js";
import { ExactDecimal, type DecimalInput } from "./decimal.js";
import {
  DXLINK_OPEN,
  DxlinkAbortedError,
  TastytradeDxlinkTokenClient,
  assertDxlinkNotAborted,
  createTastytradeApiHttpClient,
  decodeDxlinkMessageData,
  type DxlinkQuoteToken,
  type DxlinkQuoteTokenProvider,
  type DxlinkSocket,
  type DxlinkSocketFactory,
  type TastytradeAccessTokenProvider,
} from "./dxlink.js";
import { TastytradeOAuthClient } from "./oauth-client.js";

export const LIVE_OPTION_SNAPSHOT_CONTRACT_VERSION = "1.1.0";
export const GAMMA_CONCENTRATION_METHODOLOGY =
  "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION";
export const GAMMA_CONCENTRATION_METHODOLOGY_VERSION = "1.0.0";

export type LiveOptionUnderlying = "SPX" | "SPXW";
export type LiveOptionSide = "CALL" | "PUT";
export type LiveOptionPhase = "LIVE_SUPPORT";
export type LiveOptionEvidenceRole = "SUPPORTING_EVIDENCE";
export type TemporalAlignmentStatus =
  | "ALIGNED"
  | "MISALIGNED"
  | "UNVERIFIABLE"
  | "INCOMPLETE";
export type EventTimestampAlignmentStatus =
  | "ALIGNED"
  | "MISALIGNED"
  | "UNVERIFIABLE";
export type CohortAlignmentStatus =
  | "CONFIRMED"
  | "PARTIAL"
  | "NOT_CONFIRMED";
export type SourceFreshnessStatus =
  | "CONFIRMED"
  | "STALE"
  | "UNKNOWN";
export type LiveOptionDxlinkEventType =
  | "Quote"
  | "Greeks"
  | "Summary";
export type LiveOptionDxlinkSubscription = {
  type: LiveOptionDxlinkEventType;
  symbol: string;
};
export type LiveOptionDxlinkBatchStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "TIMED_OUT"
  | "FAILED";

export type LiveOptionSnapshotInput = {
  underlying: LiveOptionUnderlying;
  expirations: string[];
  around_price: DecimalInput;
  strike_count?: number;
  include_quotes?: boolean;
  include_greeks?: boolean;
  include_summary?: boolean;
  phase: LiveOptionPhase;
  deadline_ms?: number;
  max_temporal_skew_ms?: number;
  signal?: AbortSignal;
};

export const LIVE_OPTION_SNAPSHOT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        underlying: {
          type: "string",
          enum: ["SPX", "SPXW"],
          description:
            "SPX includes both SPX and SPXW roots returned by the canonical SPX chain. SPXW restricts the result to weekly/PM-settled SPXW roots.",
        },
        expirations: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
        },
        around_price: {
          description:
            "Positive SPX reference price used only to select nearby strikes and calculate the unsigned concentration proxy.",
          anyOf: [
            {
              type: "string",
              pattern:
                "^(?:0*[1-9][0-9]*(?:\\.[0-9]+)?|0*\\.[0-9]*[1-9][0-9]*)$",
            },
            { type: "number", exclusiveMinimum: 0 },
          ],
        },
        strike_count: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
          description:
            "Nearest distinct strikes selected per root/expiration series.",
        },
        include_quotes: { type: "boolean", default: true },
        include_greeks: { type: "boolean", default: true },
        include_summary: { type: "boolean", default: true },
        phase: {
          type: "string",
          const: "LIVE_SUPPORT",
        },
        deadline_ms: {
          type: "integer",
          minimum: 100,
          maximum: 30000,
          default: 5000,
        },
        max_temporal_skew_ms: {
          type: "integer",
          minimum: 0,
          maximum: 300000,
          default: 5000,
        },
      },
      required: [
        "underlying",
        "expirations",
        "around_price",
        "phase",
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

type NormalizedLiveOptionSnapshotInput = {
  underlying: LiveOptionUnderlying;
  expirations: string[];
  aroundPrice: string;
  strikeCount: number;
  includeQuotes: boolean;
  includeGreeks: boolean;
  includeSummary: boolean;
  phase: LiveOptionPhase;
  deadlineMs: number;
  maxTemporalSkewMs: number;
  signal?: AbortSignal;
};

export type LiveOptionContractMetadata = {
  provider_symbol: string;
  occ_symbol: string;
  streamer_symbol: string;
  underlying: "SPX";
  root_symbol: string;
  strike: string;
  option_type: LiveOptionSide;
  expiration: string;
  dte: number | null;
  multiplier: string | null;
  settlement: string | null;
};

export type LiveOptionQuote = {
  bid: string | null;
  ask: string | null;
  bid_size: string | null;
  ask_size: string | null;
  bid_time: string | null;
  ask_time: string | null;
  timestamp: string;
  timestamp_source: "PROVIDER_SIDE_TIME" | "LOCAL_RECEIVE_TIME";
  received_at: string;
};

export type LiveOptionGreeks = {
  delta: string | null;
  gamma: string | null;
  theta: string | null;
  vega: string | null;
  rho: string | null;
  implied_volatility: string | null;
  price: string | null;
  timestamp: string;
  timestamp_source: "PROVIDER_EVENT_TIME" | "LOCAL_RECEIVE_TIME";
  received_at: string;
};

export type LiveOptionSummary = {
  open_interest: string | null;
  timestamp: string;
  timestamp_source: "PROVIDER_EVENT_TIME" | "LOCAL_RECEIVE_TIME";
  received_at: string;
};

export type LiveOptionSnapshotContract = LiveOptionContractMetadata & {
  quote: LiveOptionQuote | null;
  greeks: LiveOptionGreeks | null;
  summary: LiveOptionSummary | null;
  event_timestamp_alignment: {
    status: EventTimestampAlignmentStatus;
    skew_ms: number | null;
    receive_skew_ms: number | null;
    threshold_ms: number;
  };
  cohort_alignment: {
    status: CohortAlignmentStatus;
    receive_skew_ms: number | null;
    threshold_ms: number;
    exact_contract_identity: boolean;
  };
  oi_freshness: {
    status: SourceFreshnessStatus;
    basis:
      | "CURRENT_REQUEST_RECEIVE_TIME"
      | "PROVIDER_EVENT_TIME"
      | "NOT_AVAILABLE";
    age_ms: number | null;
  };
  greeks_freshness: {
    status: SourceFreshnessStatus;
    basis: "PROVIDER_EVENT_TIME" | "NOT_AVAILABLE";
    age_ms: number | null;
  };
  temporal_alignment: {
    status: TemporalAlignmentStatus;
    skew_ms: number | null;
    receive_skew_ms: number | null;
    threshold_ms: number;
  };
};

type CoverageSummary = {
  requested: boolean;
  received_contracts: number;
  usable_contracts: number;
  missing_contracts: number;
  complete: boolean;
};

export type GammaConcentrationGroup = {
  key: string;
  concentration: string;
  contract_count: number;
  share_of_total: string;
};

export type GammaConcentrationProxy = {
  methodology: typeof GAMMA_CONCENTRATION_METHODOLOGY;
  methodology_version: typeof GAMMA_CONCENTRATION_METHODOLOGY_VERSION;
  status: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  phase: LiveOptionPhase;
  evidence_role: LiveOptionEvidenceRole;
  research_only: true;
  production_gate_eligible: false;
  underlying_price: string;
  proxy_as_of: string;
  total_concentration: string;
  by_strike: GammaConcentrationGroup[];
  by_expiration: GammaConcentrationGroup[];
  by_option_type: GammaConcentrationGroup[];
  by_dte_bucket: GammaConcentrationGroup[];
  by_distance_from_spot: GammaConcentrationGroup[];
  near_spot_concentration: {
    threshold_percent: "1";
    concentration: string;
    contract_count: number;
    share_of_total: string;
  };
  top_concentration_strikes: GammaConcentrationGroup[];
  data_completeness: {
    total_contracts: number;
    eligible_contracts: number;
    excluded_contracts: number;
    missing_gamma: number;
    missing_open_interest: number;
    missing_multiplier: number;
    temporally_unaligned: number;
    temporal_alignment_incomplete: number;
    temporal_alignment_unverifiable: number;
    cohort_alignment_not_confirmed: number;
    oi_freshness_not_confirmed: number;
    greeks_freshness_not_confirmed: number;
    coverage_ratio: string;
  };
  gamma_risk: "UNKNOWN";
  dealer_gex_status: "UNKNOWN";
  signed_dealer_positioning: "UNKNOWN";
  gamma_flip_status: "UNKNOWN";
  semantic_boundaries: [
    "OI_BASED_GAMMA_CONCENTRATION_IS_NOT_DEALER_GEX",
    "OPEN_INTEREST_DOES_NOT_IDENTIFY_DEALER_OR_CUSTOMER_POSITIONING",
    "UNSIGNED_CONCENTRATION_DOES_NOT_ESTABLISH_GAMMA_FLIP_OR_ZERO_GAMMA",
  ];
  warnings: string[];
};

export type LiveOptionSnapshotResult = {
  contract_version: typeof LIVE_OPTION_SNAPSHOT_CONTRACT_VERSION;
  request_id: string;
  snapshot_id: string;
  status: "AVAILABLE" | "PARTIAL" | "NOT_AVAILABLE";
  provider: "tastytrade-dxlink";
  source: {
    contract_metadata: "tastytrade-option-chain";
    quote: "DXLink Quote";
    greeks: "DXLink Greeks";
    open_interest: "DXLink Summary.openInterest";
  };
  underlying: LiveOptionUnderlying;
  canonical_chain_underlying: "SPX";
  underlying_price: string;
  requested_expirations: string[];
  available_expirations: string[];
  strike_count_per_series: number;
  phase: LiveOptionPhase;
  evidence_role: LiveOptionEvidenceRole;
  research_only: true;
  production_gate_eligible: false;
  retrieved_at: string;
  chain_retrieved_at: string;
  snapshot_complete: boolean;
  quote_complete: boolean;
  greeks_complete: boolean;
  summary_complete: boolean;
  transport: {
    strategy: "BOUNDED_AUTO_CHUNK";
    max_frame_bytes: number;
    max_concurrent_batches: number;
    requested_subscriptions: number;
    batch_count: number;
    complete_batches: number;
    partial_batches: number;
    timed_out_batches: number;
    failed_batches: number;
    batches: Array<{
      batch_index: number;
      symbol_count: number;
      subscription_count: number;
      frame_bytes: number;
      status: LiveOptionDxlinkBatchStatus;
      affected_symbols: string[];
      unmatched_symbols: string[];
      error: string | null;
    }>;
  };
  event_timestamp_alignment: {
    status: EventTimestampAlignmentStatus;
    threshold_ms: number;
    max_skew_ms: number | null;
    aligned_contracts: number;
    misaligned_contracts: number;
    unverifiable_contracts: number;
  };
  cohort_alignment: {
    status: CohortAlignmentStatus;
    confirmed_contracts: number;
    partial_contracts: number;
    not_confirmed_contracts: number;
  };
  oi_freshness: {
    status: SourceFreshnessStatus;
    confirmed_contracts: number;
    stale_contracts: number;
    unknown_contracts: number;
  };
  greeks_freshness: {
    status: SourceFreshnessStatus;
    confirmed_contracts: number;
    stale_contracts: number;
    unknown_contracts: number;
  };
  temporal_alignment: {
    status: TemporalAlignmentStatus;
    threshold_ms: number;
    max_skew_ms: number | null;
    aligned_contracts: number;
    misaligned_contracts: number;
    unverifiable_contracts: number;
    incomplete_contracts: number;
  };
  data_completeness: {
    chain_complete: boolean;
    selected_contracts: number;
    quote: CoverageSummary;
    greeks: CoverageSummary & {
      gamma_available_contracts: number;
    };
    summary: CoverageSummary & {
      open_interest_available_contracts: number;
    };
    timestamp_provenance: {
      quote_provider: number;
      quote_local_receive: number;
      greeks_provider: number;
      greeks_local_receive: number;
      summary_provider: number;
      summary_local_receive: number;
    };
  };
  contracts: LiveOptionSnapshotContract[];
  gamma_concentration_proxy: GammaConcentrationProxy;
  market_data_handoff: {
    gamma_concentration_proxy: string | null;
    gamma_proxy_methodology: typeof GAMMA_CONCENTRATION_METHODOLOGY;
    gamma_proxy_as_of: string;
    gamma_proxy_completeness: {
      status: GammaConcentrationProxy["status"];
      coverage_ratio: string;
      snapshot_complete: boolean;
      temporal_alignment: TemporalAlignmentStatus;
      event_timestamp_alignment: EventTimestampAlignmentStatus;
      cohort_alignment: CohortAlignmentStatus;
      oi_freshness: SourceFreshnessStatus;
      greeks_freshness: SourceFreshnessStatus;
    };
    dealer_gex_status: "UNKNOWN";
    evidence_role: LiveOptionEvidenceRole;
    phase: LiveOptionPhase;
  };
  regression_record: {
    record_type: "LIVE_OPTION_GAMMA_CONCENTRATION";
    record_version: "1.1.0";
    request_id: string;
    snapshot_id: string;
    as_of: string;
    methodology: typeof GAMMA_CONCENTRATION_METHODOLOGY;
    methodology_version: typeof GAMMA_CONCENTRATION_METHODOLOGY_VERSION;
    evidence_role: LiveOptionEvidenceRole;
  };
  warnings: string[];
};

type NestedOptionChainResponse = {
  data?: {
    items?: unknown[];
  };
};

type SelectedContracts = {
  contracts: LiveOptionContractMetadata[];
  availableExpirations: string[];
  warnings: string[];
};

type RawQuoteEvent = {
  type: "Quote";
  symbol: string;
  bid: string | null;
  ask: string | null;
  bidSize: string | null;
  askSize: string | null;
  bidTimeMs: number | null;
  askTimeMs: number | null;
  receivedAtMs: number;
};

type RawGreeksEvent = {
  type: "Greeks";
  symbol: string;
  removed: boolean;
  price: string | null;
  volatility: string | null;
  delta: string | null;
  gamma: string | null;
  theta: string | null;
  rho: string | null;
  vega: string | null;
  timeMs: number | null;
  receivedAtMs: number;
};

type RawSummaryEvent = {
  type: "Summary";
  symbol: string;
  openInterest: string | null;
  eventTimeMs: number | null;
  receivedAtMs: number;
};

export type ParsedLiveOptionEvent =
  | RawQuoteEvent
  | RawGreeksEvent
  | RawSummaryEvent;

type LiveOptionEventState = {
  quote: RawQuoteEvent | null;
  greeks: RawGreeksEvent | null;
  summary: RawSummaryEvent | null;
};

type LiveOptionSnapshotReadResult = {
  states: Map<string, LiveOptionEventState>;
  unmatchedSymbols: string[];
  timedOut: boolean;
};

export type LiveOptionDxlinkSubscriptionBatch = {
  subscriptions: LiveOptionDxlinkSubscription[];
  frame_bytes: number;
};

type LiveOptionSnapshotAggregateReadResult = {
  states: Map<string, LiveOptionEventState>;
  unmatchedSymbols: string[];
  timedOut: boolean;
  transport: LiveOptionSnapshotResult["transport"];
};

const QUOTE_FIELDS = [
  "eventType",
  "eventSymbol",
  "bidTime",
  "askTime",
  "bidPrice",
  "askPrice",
  "bidSize",
  "askSize",
] as const;

const GREEKS_FIELDS = [
  "eventType",
  "eventSymbol",
  "eventFlags",
  "index",
  "time",
  "sequence",
  "price",
  "volatility",
  "delta",
  "gamma",
  "theta",
  "rho",
  "vega",
] as const;

const SUMMARY_FIELDS = [
  "eventType",
  "eventSymbol",
  "eventTime",
  "openInterest",
] as const;

const REMOVE_EVENT = 2;
const DEFAULT_STRIKE_COUNT = 25;
const DEFAULT_DEADLINE_MS = 5_000;
const DEFAULT_MAX_TEMPORAL_SKEW_MS = 5_000;
const MAX_STRIKE_COUNT = 100;
const MAX_EXPIRATIONS = 10;
const MAX_DEADLINE_MS = 30_000;
const MAX_TEMPORAL_SKEW_MS = 300_000;
const MAX_DXLINK_SUBSCRIPTIONS_PER_REQUEST = 5_000;
export const DXLINK_SAFE_SUBSCRIPTION_FRAME_BYTES = 48 * 1024;
const MAX_DXLINK_CONCURRENT_BATCHES = 4;

function subscriptionMessage(
  subscriptions: LiveOptionDxlinkSubscription[],
): Record<string, unknown> {
  return {
    type: "FEED_SUBSCRIPTION",
    channel: 3,
    reset: true,
    add: subscriptions,
  };
}

export function dxlinkSubscriptionFrameBytes(
  subscriptions: LiveOptionDxlinkSubscription[],
): number {
  return Buffer.byteLength(
    JSON.stringify(subscriptionMessage(subscriptions)),
    "utf8",
  );
}

export function chunkDxlinkSubscriptions(
  subscriptions: LiveOptionDxlinkSubscription[],
  maxFrameBytes = DXLINK_SAFE_SUBSCRIPTION_FRAME_BYTES,
): LiveOptionDxlinkSubscriptionBatch[] {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new Error("maxFrameBytes must be a positive integer.");
  }
  if (subscriptions.length === 0) return [];
  const emptyFrameBytes = dxlinkSubscriptionFrameBytes([]);
  const batches: LiveOptionDxlinkSubscriptionBatch[] = [];
  let current: LiveOptionDxlinkSubscription[] = [];
  let currentFrameBytes = emptyFrameBytes;
  for (const subscription of subscriptions) {
    const subscriptionBytes = Buffer.byteLength(
      JSON.stringify(subscription),
      "utf8",
    );
    const candidateFrameBytes =
      currentFrameBytes +
      subscriptionBytes +
      (current.length === 0 ? 0 : 1);
    if (candidateFrameBytes > maxFrameBytes && current.length > 0) {
      batches.push({
        subscriptions: current,
        frame_bytes: currentFrameBytes,
      });
      current = [];
      currentFrameBytes = emptyFrameBytes;
    }
    const nextFrameBytes =
      currentFrameBytes +
      subscriptionBytes +
      (current.length === 0 ? 0 : 1);
    if (nextFrameBytes > maxFrameBytes) {
      throw new Error(
        `DXLink subscription ${subscription.type}/${subscription.symbol} exceeds the configured frame limit.`,
      );
    }
    current.push(subscription);
    currentFrameBytes = nextFrameBytes;
  }
  if (current.length > 0) {
    batches.push({
      subscriptions: current,
      frame_bytes: currentFrameBytes,
    });
  }
  return batches;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function integerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  const integer = integerOrNull(value);
  return integer !== null && integer > 0 ? integer : null;
}

function decimalOrNull(value: unknown): string | null {
  if (
    value === null ||
    value === undefined ||
    value === "NaN" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") return null;
  try {
    return ExactDecimal.parse(value).toString();
  } catch {
    return null;
  }
}

function nonNegativeDecimalOrNull(value: unknown): string | null {
  const decimal = decimalOrNull(value);
  if (
    decimal === null ||
    ExactDecimal.parse(decimal).compare(ExactDecimal.zero()) < 0
  ) {
    return null;
  }
  return decimal;
}

function providerEpochMilliseconds(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  return Number.isSafeInteger(Math.trunc(milliseconds))
    ? Math.trunc(milliseconds)
    : null;
}

function isoTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function validateDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || isoTimestamp(timestamp).slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date.`);
  }
  return value;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
  minimum = 1,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function normalizeInput(
  input: LiveOptionSnapshotInput,
): NormalizedLiveOptionSnapshotInput {
  const underlying = input.underlying?.trim().toUpperCase();
  if (underlying !== "SPX" && underlying !== "SPXW") {
    throw new Error("underlying must be SPX or SPXW.");
  }
  if (
    !Array.isArray(input.expirations) ||
    input.expirations.length < 1 ||
    input.expirations.length > MAX_EXPIRATIONS
  ) {
    throw new Error(
      `expirations must contain between 1 and ${MAX_EXPIRATIONS} dates.`,
    );
  }
  const expirations = input.expirations.map((expiration, index) =>
    validateDate(expiration, `expirations[${index}]`),
  );
  if (new Set(expirations).size !== expirations.length) {
    throw new Error("expirations must not contain duplicates.");
  }
  const aroundPrice = ExactDecimal.parse(
    input.around_price,
    "around_price",
  );
  if (aroundPrice.compare(ExactDecimal.zero()) <= 0) {
    throw new Error("around_price must be positive.");
  }
  if (input.phase !== "LIVE_SUPPORT") {
    throw new Error("phase must be LIVE_SUPPORT.");
  }
  const includeQuotes = input.include_quotes ?? true;
  const includeGreeks = input.include_greeks ?? true;
  const includeSummary = input.include_summary ?? true;
  if (!includeQuotes && !includeGreeks && !includeSummary) {
    throw new Error(
      "At least one of include_quotes, include_greeks, or include_summary must be true.",
    );
  }
  return {
    underlying,
    expirations: [...expirations].sort(),
    aroundPrice: aroundPrice.toString(),
    strikeCount: normalizePositiveInteger(
      input.strike_count,
      DEFAULT_STRIKE_COUNT,
      MAX_STRIKE_COUNT,
      "strike_count",
    ),
    includeQuotes,
    includeGreeks,
    includeSummary,
    phase: input.phase,
    deadlineMs: normalizePositiveInteger(
      input.deadline_ms,
      DEFAULT_DEADLINE_MS,
      MAX_DEADLINE_MS,
      "deadline_ms",
      100,
    ),
    maxTemporalSkewMs: normalizePositiveInteger(
      input.max_temporal_skew_ms,
      DEFAULT_MAX_TEMPORAL_SKEW_MS,
      MAX_TEMPORAL_SKEW_MS,
      "max_temporal_skew_ms",
      0,
    ),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function stableId(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

function parseRows(payload: unknown, width: number): unknown[][] {
  if (!Array.isArray(payload)) return [];
  if (payload.length > 0 && Array.isArray(payload[0])) {
    return payload.filter(Array.isArray) as unknown[][];
  }
  const rows: unknown[][] = [];
  for (let index = 0; index + width <= payload.length; index += width) {
    rows.push(payload.slice(index, index + width));
  }
  return rows;
}

export function parseDxlinkLiveOptionData(
  data: unknown,
  receivedAtMs: number,
): ParsedLiveOptionEvent[] {
  if (!Array.isArray(data)) return [];
  const events: ParsedLiveOptionEvent[] = [];
  for (let index = 0; index + 1 < data.length; index += 2) {
    const type = data[index];
    if (type === "Quote") {
      for (const row of parseRows(data[index + 1], QUOTE_FIELDS.length)) {
        const symbol = stringOrNull(row[1]);
        if (!symbol) continue;
        events.push({
          type,
          symbol,
          bidTimeMs: providerEpochMilliseconds(row[2]),
          askTimeMs: providerEpochMilliseconds(row[3]),
          bid: decimalOrNull(row[4]),
          ask: decimalOrNull(row[5]),
          bidSize: decimalOrNull(row[6]),
          askSize: decimalOrNull(row[7]),
          receivedAtMs,
        });
      }
    } else if (type === "Greeks") {
      for (const row of parseRows(data[index + 1], GREEKS_FIELDS.length)) {
        const symbol = stringOrNull(row[1]);
        if (!symbol) continue;
        const flags = Number(row[2]);
        events.push({
          type,
          symbol,
          removed: Number.isFinite(flags) && (flags & REMOVE_EVENT) !== 0,
          timeMs: providerEpochMilliseconds(row[4]),
          price: decimalOrNull(row[6]),
          volatility: decimalOrNull(row[7]),
          delta: decimalOrNull(row[8]),
          gamma: decimalOrNull(row[9]),
          theta: decimalOrNull(row[10]),
          rho: decimalOrNull(row[11]),
          vega: decimalOrNull(row[12]),
          receivedAtMs,
        });
      }
    } else if (type === "Summary") {
      for (const row of parseRows(data[index + 1], SUMMARY_FIELDS.length)) {
        const symbol = stringOrNull(row[1]);
        if (!symbol) continue;
        events.push({
          type,
          symbol,
          eventTimeMs: providerEpochMilliseconds(row[2]),
          openInterest: nonNegativeDecimalOrNull(row[3]),
          receivedAtMs,
        });
      }
    }
  }
  return events;
}

export function mergeLiveOptionEvents(
  states: Map<string, LiveOptionEventState>,
  events: ParsedLiveOptionEvent[],
): string[] {
  const unmatched = new Set<string>();
  for (const event of events) {
    const state = states.get(event.symbol);
    if (!state) {
      unmatched.add(event.symbol);
      continue;
    }
    if (event.type === "Quote") {
      state.quote = event;
    } else if (event.type === "Greeks") {
      state.greeks = event.removed ? null : event;
    } else {
      state.summary = event;
    }
  }
  return [...unmatched].sort();
}

function subscriptionSatisfied(
  states: Map<string, LiveOptionEventState>,
  subscription: LiveOptionDxlinkSubscription,
): boolean {
  const state = states.get(subscription.symbol);
  if (!state) return false;
  if (subscription.type === "Quote") return state.quote !== null;
  if (subscription.type === "Greeks") return state.greeks !== null;
  return state.summary !== null;
}

function affectedSubscriptionSymbols(
  states: Map<string, LiveOptionEventState>,
  subscriptions: LiveOptionDxlinkSubscription[],
): string[] {
  return [
    ...new Set(
      subscriptions
        .filter(
          (subscription) =>
            !subscriptionSatisfied(states, subscription),
        )
        .map((subscription) => subscription.symbol),
    ),
  ].sort();
}

function targetRoot(
  requestedUnderlying: LiveOptionUnderlying,
  root: string,
): boolean {
  return requestedUnderlying === "SPXW"
    ? root === "SPXW"
    : root === "SPX" || root === "SPXW";
}

function selectContracts(
  response: NestedOptionChainResponse,
  input: NormalizedLiveOptionSnapshotInput,
): SelectedContracts {
  const items = response.data?.items;
  if (!Array.isArray(items)) {
    throw new Error(
      "Nested option-chain response did not contain data.items.",
    );
  }
  const requestedExpirations = new Set(input.expirations);
  const availableExpirations = new Set<string>();
  const contracts: LiveOptionContractMetadata[] = [];
  const warnings: string[] = [];
  const aroundPrice = ExactDecimal.parse(input.aroundPrice);

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = asRecord(items[itemIndex], `data.items[${itemIndex}]`);
    const root = stringOrNull(item["root-symbol"]);
    if (!root || !targetRoot(input.underlying, root)) continue;
    const multiplierValue = positiveIntegerOrNull(
      item["shares-per-contract"],
    );
    const multiplier =
      multiplierValue === null ? null : String(multiplierValue);
    if (multiplier === null) {
      warnings.push(`MISSING_MULTIPLIER:${root}`);
    }
    const expirations = item.expirations;
    if (!Array.isArray(expirations)) {
      throw new Error(
        `data.items[${itemIndex}].expirations must be an array.`,
      );
    }
    for (
      let expirationIndex = 0;
      expirationIndex < expirations.length;
      expirationIndex += 1
    ) {
      const expiration = asRecord(
        expirations[expirationIndex],
        `data.items[${itemIndex}].expirations[${expirationIndex}]`,
      );
      const expirationDate = stringOrNull(
        expiration["expiration-date"],
      );
      if (
        !expirationDate ||
        !requestedExpirations.has(expirationDate)
      ) {
        continue;
      }
      availableExpirations.add(expirationDate);
      const dte = integerOrNull(expiration["days-to-expiration"]);
      const settlement = stringOrNull(expiration["settlement-type"]);
      const strikes = expiration.strikes;
      if (!Array.isArray(strikes)) {
        throw new Error(
          `data.items[${itemIndex}].expirations[${expirationIndex}].strikes must be an array.`,
        );
      }
      const parsedStrikes = strikes.map((value, strikeIndex) => {
        const strike = asRecord(
          value,
          `data.items[${itemIndex}].expirations[${expirationIndex}].strikes[${strikeIndex}]`,
        );
        const strikePrice = decimalOrNull(strike["strike-price"]);
        if (strikePrice === null) {
          throw new Error(
            `Nested option-chain strike ${root}/${expirationDate}/${strikeIndex} is missing strike-price.`,
          );
        }
        return {
          strike,
          strikePrice,
          distance: ExactDecimal.parse(strikePrice)
            .subtract(aroundPrice)
            .abs(),
        };
      });
      parsedStrikes.sort((left, right) => {
        const distance = left.distance.compare(right.distance);
        return distance !== 0
          ? distance
          : ExactDecimal.parse(left.strikePrice).compare(
              ExactDecimal.parse(right.strikePrice),
            );
      });
      for (const selected of parsedStrikes.slice(0, input.strikeCount)) {
        const sides = [
          {
            type: "CALL" as const,
            symbol: stringOrNull(selected.strike.call),
            streamer: stringOrNull(
              selected.strike["call-streamer-symbol"],
            ),
          },
          {
            type: "PUT" as const,
            symbol: stringOrNull(selected.strike.put),
            streamer: stringOrNull(
              selected.strike["put-streamer-symbol"],
            ),
          },
        ];
        for (const side of sides) {
          if (!side.symbol || !side.streamer) {
            warnings.push(
              `MISSING_${side.type}_IDENTITY:${root}/${expirationDate}/${selected.strikePrice}`,
            );
            continue;
          }
          contracts.push({
            provider_symbol: side.symbol,
            occ_symbol: side.symbol,
            streamer_symbol: side.streamer,
            underlying: "SPX",
            root_symbol: root,
            strike: selected.strikePrice,
            option_type: side.type,
            expiration: expirationDate,
            dte,
            multiplier,
            settlement,
          });
        }
      }
    }
  }

  for (const expiration of input.expirations) {
    if (!availableExpirations.has(expiration)) {
      warnings.push(`EXPIRATION_NOT_FOUND:${expiration}`);
    }
  }
  const providerSymbols = new Set<string>();
  const streamerSymbols = new Set<string>();
  for (const contract of contracts) {
    if (providerSymbols.has(contract.provider_symbol)) {
      throw new Error(
        `Nested option-chain response contained duplicate provider symbol ${contract.provider_symbol}.`,
      );
    }
    if (streamerSymbols.has(contract.streamer_symbol)) {
      throw new Error(
        `Nested option-chain response contained duplicate streamer symbol ${contract.streamer_symbol}.`,
      );
    }
    providerSymbols.add(contract.provider_symbol);
    streamerSymbols.add(contract.streamer_symbol);
  }
  contracts.sort(
    (left, right) =>
      left.expiration.localeCompare(right.expiration) ||
      left.root_symbol.localeCompare(right.root_symbol) ||
      ExactDecimal.parse(left.strike).compare(
        ExactDecimal.parse(right.strike),
      ) ||
      left.option_type.localeCompare(right.option_type),
  );
  return {
    contracts,
    availableExpirations: [...availableExpirations].sort(),
    warnings: [...new Set(warnings)].sort(),
  };
}

function eventTimestamp(
  providerMilliseconds: number | null,
  receivedAtMs: number,
): {
  timestamp: string;
  timestampSource: "PROVIDER_EVENT_TIME" | "LOCAL_RECEIVE_TIME";
} {
  return providerMilliseconds === null
    ? {
        timestamp: isoTimestamp(receivedAtMs),
        timestampSource: "LOCAL_RECEIVE_TIME",
      }
    : {
        timestamp: isoTimestamp(providerMilliseconds),
        timestampSource: "PROVIDER_EVENT_TIME",
      };
}

function normalizeQuote(event: RawQuoteEvent): LiveOptionQuote {
  const sideTimes = [event.bidTimeMs, event.askTimeMs].filter(
    (value): value is number => value !== null,
  );
  const providerTimestamp =
    sideTimes.length === 0 ? null : Math.max(...sideTimes);
  return {
    bid: event.bid,
    ask: event.ask,
    bid_size: event.bidSize,
    ask_size: event.askSize,
    bid_time:
      event.bidTimeMs === null ? null : isoTimestamp(event.bidTimeMs),
    ask_time:
      event.askTimeMs === null ? null : isoTimestamp(event.askTimeMs),
    timestamp:
      providerTimestamp === null
        ? isoTimestamp(event.receivedAtMs)
        : isoTimestamp(providerTimestamp),
    timestamp_source:
      providerTimestamp === null
        ? "LOCAL_RECEIVE_TIME"
        : "PROVIDER_SIDE_TIME",
    received_at: isoTimestamp(event.receivedAtMs),
  };
}

function normalizeGreeks(event: RawGreeksEvent): LiveOptionGreeks {
  const timestamp = eventTimestamp(event.timeMs, event.receivedAtMs);
  return {
    delta: event.delta,
    gamma: event.gamma,
    theta: event.theta,
    vega: event.vega,
    rho: event.rho,
    implied_volatility: event.volatility,
    price: event.price,
    timestamp: timestamp.timestamp,
    timestamp_source: timestamp.timestampSource,
    received_at: isoTimestamp(event.receivedAtMs),
  };
}

function normalizeSummary(event: RawSummaryEvent): LiveOptionSummary {
  const timestamp = eventTimestamp(
    event.eventTimeMs,
    event.receivedAtMs,
  );
  return {
    open_interest: event.openInterest,
    timestamp: timestamp.timestamp,
    timestamp_source: timestamp.timestampSource,
    received_at: isoTimestamp(event.receivedAtMs),
  };
}

function contractAlignment(
  quote: LiveOptionQuote | null,
  greeks: LiveOptionGreeks | null,
  summary: LiveOptionSummary | null,
  input: NormalizedLiveOptionSnapshotInput,
): LiveOptionSnapshotContract["temporal_alignment"] {
  const timestamps: Array<{
    source: number;
    received: number;
    provider: boolean;
  }> = [];
  if (input.includeQuotes) {
    if (!quote) {
      return {
        status: "INCOMPLETE",
        skew_ms: null,
        receive_skew_ms: null,
        threshold_ms: input.maxTemporalSkewMs,
      };
    }

    timestamps.push({
      source: Date.parse(quote.timestamp),
      received: Date.parse(quote.received_at),
      provider: quote.timestamp_source === "PROVIDER_SIDE_TIME",
    });
  }
  if (input.includeGreeks) {
    if (!greeks) {
      return {
        status: "INCOMPLETE",
        skew_ms: null,
        receive_skew_ms: null,
        threshold_ms: input.maxTemporalSkewMs,
      };
    }
    timestamps.push({
      source: Date.parse(greeks.timestamp),
      received: Date.parse(greeks.received_at),
      provider: greeks.timestamp_source === "PROVIDER_EVENT_TIME",
    });
  }
  if (input.includeSummary) {
    if (!summary) {
      return {
        status: "INCOMPLETE",
        skew_ms: null,
        receive_skew_ms: null,
        threshold_ms: input.maxTemporalSkewMs,
      };
    }
    timestamps.push({
      source: Date.parse(summary.timestamp),
      received: Date.parse(summary.received_at),
      provider: summary.timestamp_source === "PROVIDER_EVENT_TIME",
    });
  }
  const receivedTimes = timestamps.map((timestamp) => timestamp.received);
  const receiveSkewMs =
    receivedTimes.length < 2
      ? 0
      : Math.max(...receivedTimes) - Math.min(...receivedTimes);
  if (timestamps.length < 2) {
    return {
      status: "ALIGNED",
      skew_ms: 0,
      receive_skew_ms: receiveSkewMs,
      threshold_ms: input.maxTemporalSkewMs,
    };
  }
  const providerTimes = timestamps
    .filter((timestamp) => timestamp.provider)
    .map((timestamp) => timestamp.source);
  const skewMs =
    providerTimes.length < 2
      ? null
      : Math.max(...providerTimes) - Math.min(...providerTimes);
  if (providerTimes.length !== timestamps.length) {
    return {
      status: "UNVERIFIABLE",
      skew_ms: skewMs,
      receive_skew_ms: receiveSkewMs,
      threshold_ms: input.maxTemporalSkewMs,
    };
  }
  return {
    status: skewMs! <= input.maxTemporalSkewMs ? "ALIGNED" : "MISALIGNED",
    skew_ms: skewMs,
    receive_skew_ms: receiveSkewMs,
    threshold_ms: input.maxTemporalSkewMs,
  };
}

function eventTimestampAlignment(
  temporalAlignment: LiveOptionSnapshotContract["temporal_alignment"],
): LiveOptionSnapshotContract["event_timestamp_alignment"] {
  return {
    status:
      temporalAlignment.status === "INCOMPLETE"
        ? "UNVERIFIABLE"
        : temporalAlignment.status,
    skew_ms: temporalAlignment.skew_ms,
    receive_skew_ms: temporalAlignment.receive_skew_ms,
    threshold_ms: temporalAlignment.threshold_ms,
  };
}

function receivedDuringRequest(
  receivedAt: string,
  requestStartedAtMs: number,
  retrievedAtMs: number,
): boolean {
  const receivedAtMs = Date.parse(receivedAt);
  return (
    Number.isFinite(receivedAtMs) &&
    receivedAtMs >= requestStartedAtMs &&
    receivedAtMs <= retrievedAtMs
  );
}

function oiFreshness(
  summary: LiveOptionSummary | null,
  requestStartedAtMs: number,
  retrievedAtMs: number,
): LiveOptionSnapshotContract["oi_freshness"] {
  if (!summary || summary.open_interest === null) {
    return {
      status: "UNKNOWN",
      basis: "NOT_AVAILABLE",
      age_ms: null,
    };
  }
  const receivedAtMs = Date.parse(summary.received_at);
  if (
    !receivedDuringRequest(
      summary.received_at,
      requestStartedAtMs,
      retrievedAtMs,
    )
  ) {
    return {
      status: "STALE",
      basis: "CURRENT_REQUEST_RECEIVE_TIME",
      age_ms: Number.isFinite(receivedAtMs)
        ? Math.abs(retrievedAtMs - receivedAtMs)
        : null,
    };
  }
  return {
    status: "CONFIRMED",
    basis: "CURRENT_REQUEST_RECEIVE_TIME",
    age_ms: Math.max(0, retrievedAtMs - receivedAtMs),
  };
}

function greeksFreshness(
  greeks: LiveOptionGreeks | null,
  requestStartedAtMs: number,
  retrievedAtMs: number,
): LiveOptionSnapshotContract["greeks_freshness"] {
  if (
    !greeks ||
    greeks.gamma === null ||
    greeks.timestamp_source !== "PROVIDER_EVENT_TIME"
  ) {
    return {
      status: "UNKNOWN",
      basis: "NOT_AVAILABLE",
      age_ms: null,
    };
  }
  const providerTimestampMs = Date.parse(greeks.timestamp);
  const receivedAtMs = Date.parse(greeks.received_at);
  if (
    !Number.isFinite(providerTimestampMs) ||
    !Number.isFinite(receivedAtMs)
  ) {
    return {
      status: "UNKNOWN",
      basis: "NOT_AVAILABLE",
      age_ms: null,
    };
  }
  const ageMs = Math.abs(receivedAtMs - providerTimestampMs);
  if (
    !receivedDuringRequest(
      greeks.received_at,
      requestStartedAtMs,
      retrievedAtMs,
    )
  ) {
    return {
      status: "STALE",
      basis: "PROVIDER_EVENT_TIME",
      age_ms: ageMs,
    };
  }
  return {
    status: "CONFIRMED",
    basis: "PROVIDER_EVENT_TIME",
    age_ms: ageMs,
  };
}

function cohortAlignment(
  greeks: LiveOptionGreeks | null,
  summary: LiveOptionSummary | null,
  input: NormalizedLiveOptionSnapshotInput,
  requestStartedAtMs: number,
  retrievedAtMs: number,
): LiveOptionSnapshotContract["cohort_alignment"] {
  const greeksUsable =
    input.includeGreeks && greeks !== null && greeks.gamma !== null;
  const summaryUsable =
    input.includeSummary &&
    summary !== null &&
    summary.open_interest !== null;
  const exactContractIdentity = greeks !== null || summary !== null;
  if (!input.includeGreeks || !input.includeSummary) {
    return {
      status: "NOT_CONFIRMED",
      receive_skew_ms: null,
      threshold_ms: input.maxTemporalSkewMs,
      exact_contract_identity: exactContractIdentity,
    };
  }
  if (!greeksUsable && !summaryUsable) {
    return {
      status: "NOT_CONFIRMED",
      receive_skew_ms: null,
      threshold_ms: input.maxTemporalSkewMs,
      exact_contract_identity: false,
    };
  }
  if (!greeksUsable || !summaryUsable) {
    return {
      status: "PARTIAL",
      receive_skew_ms: null,
      threshold_ms: input.maxTemporalSkewMs,
      exact_contract_identity: exactContractIdentity,
    };
  }
  const greeksReceivedAtMs = Date.parse(greeks.received_at);
  const summaryReceivedAtMs = Date.parse(summary.received_at);
  if (
    !Number.isFinite(greeksReceivedAtMs) ||
    !Number.isFinite(summaryReceivedAtMs)
  ) {
    return {
      status: "NOT_CONFIRMED",
      receive_skew_ms: null,
      threshold_ms: input.maxTemporalSkewMs,
      exact_contract_identity: true,
    };
  }
  const receiveSkewMs = Math.abs(
    greeksReceivedAtMs - summaryReceivedAtMs,
  );
  const currentRequestCohort =
    receivedDuringRequest(
      greeks.received_at,
      requestStartedAtMs,
      retrievedAtMs,
    ) &&
    receivedDuringRequest(
      summary.received_at,
      requestStartedAtMs,
      retrievedAtMs,
    );
  return {
    status:
      currentRequestCohort &&
      receiveSkewMs <= input.maxTemporalSkewMs
        ? "CONFIRMED"
        : "NOT_CONFIRMED",
    receive_skew_ms: receiveSkewMs,
    threshold_ms: input.maxTemporalSkewMs,
    exact_contract_identity: true,
  };
}

function coverage(
  requested: boolean,
  contracts: LiveOptionSnapshotContract[],
  received: (contract: LiveOptionSnapshotContract) => boolean,
  usable: (contract: LiveOptionSnapshotContract) => boolean,
): CoverageSummary {
  if (!requested) {
    return {
      requested: false,
      received_contracts: 0,
      usable_contracts: 0,
      missing_contracts: 0,
      complete: true,
    };
  }
  const receivedContracts = contracts.filter(received).length;
  const usableContracts = contracts.filter(usable).length;
  return {
    requested: true,
    received_contracts: receivedContracts,
    usable_contracts: usableContracts,
    missing_contracts: contracts.length - usableContracts,
    complete:
      contracts.length > 0 && usableContracts === contracts.length,
  };
}

function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return "0";
  return ExactDecimal.parse(String(numerator))
    .divide(ExactDecimal.parse(String(denominator)))
    .toString();
}

function share(value: ExactDecimal, total: ExactDecimal): string {
  return total.isZero() ? "0" : value.divide(total).toString();
}

function dteBucket(dte: number | null): string {
  if (dte === null) return "UNKNOWN";
  if (dte === 0) return "0_DTE";
  if (dte <= 7) return "1_TO_7_DTE";
  if (dte <= 30) return "8_TO_30_DTE";
  if (dte <= 60) return "31_TO_60_DTE";
  return "61_PLUS_DTE";
}

function distanceBucket(
  strike: string,
  underlyingPrice: ExactDecimal,
): string {
  const percent = ExactDecimal.parse(strike)
    .subtract(underlyingPrice)
    .abs()
    .divide(underlyingPrice)
    .multiply(ExactDecimal.parse("100"));
  if (percent.compare(ExactDecimal.parse("1")) <= 0) {
    return "WITHIN_1_PERCENT";
  }
  if (percent.compare(ExactDecimal.parse("3")) <= 0) {
    return "ONE_TO_THREE_PERCENT";
  }
  if (percent.compare(ExactDecimal.parse("5")) <= 0) {
    return "THREE_TO_FIVE_PERCENT";
  }
  return "BEYOND_FIVE_PERCENT";
}

type EligibleConcentration = {
  contract: LiveOptionSnapshotContract;
  value: ExactDecimal;
  distanceBucket: string;
};

function groupedConcentration(
  eligible: EligibleConcentration[],
  total: ExactDecimal,
  key: (item: EligibleConcentration) => string,
  compareKeys: (left: string, right: string) => number = (left, right) =>
    left.localeCompare(right),
): GammaConcentrationGroup[] {
  const groups = new Map<
    string,
    { concentration: ExactDecimal; contractCount: number }
  >();
  for (const item of eligible) {
    const groupKey = key(item);
    const group = groups.get(groupKey) ?? {
      concentration: ExactDecimal.zero(),
      contractCount: 0,
    };
    group.concentration = group.concentration.add(item.value);
    group.contractCount += 1;
    groups.set(groupKey, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([groupKey, group]) => ({
      key: groupKey,
      concentration: group.concentration.toString(),
      contract_count: group.contractCount,
      share_of_total: share(group.concentration, total),
    }));
}

export function calculateGammaConcentrationProxy(
  contracts: LiveOptionSnapshotContract[],
  underlyingPriceValue: DecimalInput,
  asOf: string,
  sourceComplete: boolean,
): GammaConcentrationProxy {
  const underlyingPrice = ExactDecimal.parse(
    underlyingPriceValue,
    "underlying_price",
  );
  if (underlyingPrice.compare(ExactDecimal.zero()) <= 0) {
    throw new Error("underlying_price must be positive.");
  }
  const missingGamma = contracts.filter(
    (contract) => contract.greeks?.gamma === null || !contract.greeks,
  ).length;
  const missingOpenInterest = contracts.filter(
    (contract) =>
      contract.summary?.open_interest === null || !contract.summary,
  ).length;
  const missingMultiplier = contracts.filter(
    (contract) => contract.multiplier === null,
  ).length;
  const temporallyUnaligned = contracts.filter(
    (contract) => contract.temporal_alignment.status === "MISALIGNED",
  ).length;
  const temporalAlignmentIncomplete = contracts.filter(
    (contract) => contract.temporal_alignment.status === "INCOMPLETE",
  ).length;
  const temporalAlignmentUnverifiable = contracts.filter(
    (contract) =>
      contract.temporal_alignment.status === "UNVERIFIABLE",
  ).length;
  const cohortAlignmentNotConfirmed = contracts.filter(
    (contract) => contract.cohort_alignment.status !== "CONFIRMED",
  ).length;
  const oiFreshnessNotConfirmed = contracts.filter(
    (contract) => contract.oi_freshness.status !== "CONFIRMED",
  ).length;
  const greeksFreshnessNotConfirmed = contracts.filter(
    (contract) =>
      contract.greeks_freshness.status !== "CONFIRMED",
  ).length;
  const factor = ExactDecimal.parse("0.01");
  const eligible: EligibleConcentration[] = [];
  for (const contract of contracts) {
    if (
      contract.greeks?.gamma === null ||
      !contract.greeks ||
      contract.summary?.open_interest === null ||
      !contract.summary ||
      contract.multiplier === null ||
      contract.cohort_alignment.status !== "CONFIRMED" ||
      contract.oi_freshness.status !== "CONFIRMED" ||
      contract.greeks_freshness.status !== "CONFIRMED"
    ) {
      continue;
    }
    const value = ExactDecimal.parse(contract.greeks.gamma)
      .abs()
      .multiply(ExactDecimal.parse(contract.summary.open_interest))
      .multiply(ExactDecimal.parse(contract.multiplier))
      .multiply(underlyingPrice)
      .multiply(underlyingPrice)
      .multiply(factor);
    eligible.push({
      contract,
      value,
      distanceBucket: distanceBucket(contract.strike, underlyingPrice),
    });
  }
  const total = eligible.reduce(
    (sum, item) => sum.add(item.value),
    ExactDecimal.zero(),
  );
  const numericKeyComparison = (left: string, right: string) =>
    ExactDecimal.parse(left).compare(ExactDecimal.parse(right));
  const byStrike = groupedConcentration(
    eligible,
    total,
    (item) => item.contract.strike,
    numericKeyComparison,
  );
  const nearSpot = eligible.filter(
    (item) => item.distanceBucket === "WITHIN_1_PERCENT",
  );
  const nearSpotTotal = nearSpot.reduce(
    (sum, item) => sum.add(item.value),
    ExactDecimal.zero(),
  );
  const warnings: string[] = [];
  if (missingGamma > 0) warnings.push("MISSING_GAMMA_EXCLUDED");
  if (missingOpenInterest > 0) {
    warnings.push("MISSING_OPEN_INTEREST_EXCLUDED_NOT_ZERO_FILLED");
  }
  if (missingMultiplier > 0) warnings.push("MISSING_MULTIPLIER_EXCLUDED");
  if (temporallyUnaligned > 0) {
    warnings.push(
      "EVENT_TIMESTAMP_MISALIGNMENT_RECORDED_SEPARATELY_FROM_COHORT",
    );
  }
  if (temporalAlignmentIncomplete > 0) {
    warnings.push("EVENT_TIMESTAMP_ALIGNMENT_INCOMPLETE");
  }
  if (temporalAlignmentUnverifiable > 0) {
    warnings.push(
      "EVENT_TIMESTAMP_ALIGNMENT_UNVERIFIABLE_NON_BLOCKING_FOR_CURRENT_COHORT",
    );
  }
  if (cohortAlignmentNotConfirmed > 0) {
    warnings.push("GAMMA_OI_COHORT_ALIGNMENT_NOT_CONFIRMED");
  }
  if (oiFreshnessNotConfirmed > 0) {
    warnings.push("OI_FRESHNESS_NOT_CONFIRMED");
  }
  if (greeksFreshnessNotConfirmed > 0) {
    warnings.push("GREEKS_FRESHNESS_NOT_CONFIRMED");
  }
  if (!sourceComplete) {
    warnings.push("SOURCE_GAMMA_OI_COHORT_INCOMPLETE");
  }
  return {
    methodology: GAMMA_CONCENTRATION_METHODOLOGY,
    methodology_version: GAMMA_CONCENTRATION_METHODOLOGY_VERSION,
    status:
      eligible.length === 0
        ? "NOT_AVAILABLE"
        : sourceComplete && eligible.length === contracts.length
          ? "COMPLETE"
          : "PARTIAL",
    phase: "LIVE_SUPPORT",
    evidence_role: "SUPPORTING_EVIDENCE",
    research_only: true,
    production_gate_eligible: false,
    underlying_price: underlyingPrice.toString(),
    proxy_as_of: asOf,
    total_concentration: total.toString(),
    by_strike: byStrike,
    by_expiration: groupedConcentration(
      eligible,
      total,
      (item) => item.contract.expiration,
    ),
    by_option_type: groupedConcentration(
      eligible,
      total,
      (item) => item.contract.option_type,
    ),
    by_dte_bucket: groupedConcentration(
      eligible,
      total,
      (item) => dteBucket(item.contract.dte),
      (left, right) => {
        const order = [
          "0_DTE",
          "1_TO_7_DTE",
          "8_TO_30_DTE",
          "31_TO_60_DTE",
          "61_PLUS_DTE",
          "UNKNOWN",
        ];
        return order.indexOf(left) - order.indexOf(right);
      },
    ),
    by_distance_from_spot: groupedConcentration(
      eligible,
      total,
      (item) => item.distanceBucket,
      (left, right) => {
        const order = [
          "WITHIN_1_PERCENT",
          "ONE_TO_THREE_PERCENT",
          "THREE_TO_FIVE_PERCENT",
          "BEYOND_FIVE_PERCENT",
        ];
        return order.indexOf(left) - order.indexOf(right);
      },
    ),
    near_spot_concentration: {
      threshold_percent: "1",
      concentration: nearSpotTotal.toString(),
      contract_count: nearSpot.length,
      share_of_total: share(nearSpotTotal, total),
    },
    top_concentration_strikes: [...byStrike]
      .sort(
        (left, right) =>
          ExactDecimal.parse(right.concentration).compare(
            ExactDecimal.parse(left.concentration),
          ) || numericKeyComparison(left.key, right.key),
      )
      .slice(0, 10),
    data_completeness: {
      total_contracts: contracts.length,
      eligible_contracts: eligible.length,
      excluded_contracts: contracts.length - eligible.length,
      missing_gamma: missingGamma,
      missing_open_interest: missingOpenInterest,
      missing_multiplier: missingMultiplier,
      temporally_unaligned: temporallyUnaligned,
      temporal_alignment_incomplete: temporalAlignmentIncomplete,
      temporal_alignment_unverifiable:
        temporalAlignmentUnverifiable,
      cohort_alignment_not_confirmed: cohortAlignmentNotConfirmed,
      oi_freshness_not_confirmed: oiFreshnessNotConfirmed,
      greeks_freshness_not_confirmed:
        greeksFreshnessNotConfirmed,
      coverage_ratio: ratio(eligible.length, contracts.length),
    },
    gamma_risk: "UNKNOWN",
    dealer_gex_status: "UNKNOWN",
    signed_dealer_positioning: "UNKNOWN",
    gamma_flip_status: "UNKNOWN",
    semantic_boundaries: [
      "OI_BASED_GAMMA_CONCENTRATION_IS_NOT_DEALER_GEX",
      "OPEN_INTEREST_DOES_NOT_IDENTIFY_DEALER_OR_CUSTOMER_POSITIONING",
      "UNSIGNED_CONCENTRATION_DOES_NOT_ESTABLISH_GAMMA_FLIP_OR_ZERO_GAMMA",
    ],
    warnings,
  };
}

export type LiveOptionSnapshotClientOptions = {
  oauth?: TastytradeAccessTokenProvider;
  http?: AxiosInstance;
  quoteTokens?: DxlinkQuoteTokenProvider;
  socketFactory?: DxlinkSocketFactory;
  clock?: () => number;
  maxDxlinkSubscriptionFrameBytes?: number;
  maxConcurrentDxlinkBatches?: number;
};

export class TastytradeLiveOptionSnapshotClient {
  private readonly oauth: TastytradeAccessTokenProvider;
  private readonly http: AxiosInstance;
  private readonly quoteTokens: DxlinkQuoteTokenProvider;
  private readonly socketFactory: DxlinkSocketFactory;
  private readonly clock: () => number;
  private readonly maxDxlinkSubscriptionFrameBytes: number;
  private readonly maxConcurrentDxlinkBatches: number;

  constructor(options: LiveOptionSnapshotClientOptions = {}) {
    assertTrustedHosts();
    this.oauth = options.oauth ?? new TastytradeOAuthClient();
    this.http = options.http ?? createTastytradeApiHttpClient();
    this.clock = options.clock ?? (() => Date.now());
    this.quoteTokens =
      options.quoteTokens ??
      new TastytradeDxlinkTokenClient(
        this.oauth,
        this.http,
        this.clock,
      );
    this.socketFactory =
      options.socketFactory ??
      ((url) => new WebSocket(url) as unknown as DxlinkSocket);
    this.maxDxlinkSubscriptionFrameBytes = normalizePositiveInteger(
      options.maxDxlinkSubscriptionFrameBytes,
      DXLINK_SAFE_SUBSCRIPTION_FRAME_BYTES,
      DXLINK_SAFE_SUBSCRIPTION_FRAME_BYTES,
      "maxDxlinkSubscriptionFrameBytes",
      256,
    );
    this.maxConcurrentDxlinkBatches = normalizePositiveInteger(
      options.maxConcurrentDxlinkBatches,
      MAX_DXLINK_CONCURRENT_BATCHES,
      MAX_DXLINK_CONCURRENT_BATCHES,
      "maxConcurrentDxlinkBatches",
    );
  }

  async getLiveOptionSnapshot(
    request: LiveOptionSnapshotInput,
  ): Promise<LiveOptionSnapshotResult> {
    const input = normalizeInput(request);
    assertDxlinkNotAborted(input.signal);
    const requestId = stableId({
      underlying: input.underlying,
      expirations: input.expirations,
      around_price: input.aroundPrice,
      strike_count: input.strikeCount,
      include_quotes: input.includeQuotes,
      include_greeks: input.includeGreeks,
      include_summary: input.includeSummary,
      phase: input.phase,
      deadline_ms: input.deadlineMs,
      max_temporal_skew_ms: input.maxTemporalSkewMs,
    });
    const accessToken = await this.oauth.getAccessToken();
    assertDxlinkNotAborted(input.signal);
    const chainResponse = await this.http.get<NestedOptionChainResponse>(
      "/option-chains/SPX/nested",
      {
        signal: input.signal,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const chainRetrievedAtMs = this.clock();
    const chainRetrievedAt = isoTimestamp(chainRetrievedAtMs);
    const selected = selectContracts(chainResponse.data, input);
    const states = new Map<string, LiveOptionEventState>(
      selected.contracts.map((contract) => [
        contract.streamer_symbol,
        { quote: null, greeks: null, summary: null },
      ]),
    );
    const eventTypes: LiveOptionDxlinkEventType[] = [
      ...(input.includeQuotes ? (["Quote"] as const) : []),
      ...(input.includeGreeks ? (["Greeks"] as const) : []),
      ...(input.includeSummary ? (["Summary"] as const) : []),
    ];
    const subscriptions = selected.contracts.flatMap((contract) =>
      eventTypes.map((type) => ({
        type,
        symbol: contract.streamer_symbol,
      })),
    );
    if (
      subscriptions.length >
      MAX_DXLINK_SUBSCRIPTIONS_PER_REQUEST
    ) {
      throw new Error(
        `Live option snapshot requires ${subscriptions.length} DXLink subscriptions; the provider session budget permits at most ${MAX_DXLINK_SUBSCRIPTIONS_PER_REQUEST} event subscriptions per request.`,
      );
    }
    let snapshotRead: LiveOptionSnapshotAggregateReadResult = {
      states,
      unmatchedSymbols: [],
      timedOut: false,
      transport: {
        strategy: "BOUNDED_AUTO_CHUNK",
        max_frame_bytes: this.maxDxlinkSubscriptionFrameBytes,
        max_concurrent_batches: this.maxConcurrentDxlinkBatches,
        requested_subscriptions: subscriptions.length,
        batch_count: 0,
        complete_batches: 0,
        partial_batches: 0,
        timed_out_batches: 0,
        failed_batches: 0,
        batches: [],
      },
    };
    if (subscriptions.length > 0) {
      const quoteToken = await this.quoteTokens.getQuoteToken(input.signal);
      snapshotRead = await this.readSnapshotBatches(
        quoteToken,
        subscriptions,
        input,
        states,
      );
    }
    const retrievedAtMs = this.clock();
    const retrievedAt = isoTimestamp(retrievedAtMs);
    const contracts = selected.contracts.map((metadata) => {
      const state = snapshotRead.states.get(metadata.streamer_symbol)!;
      const quote = state.quote ? normalizeQuote(state.quote) : null;
      const greeks = state.greeks ? normalizeGreeks(state.greeks) : null;
      const summary = state.summary ? normalizeSummary(state.summary) : null;
      const temporalAlignment = contractAlignment(
        quote,
        greeks,
        summary,
        input,
      );
      return {
        ...metadata,
        quote,
        greeks,
        summary,
        event_timestamp_alignment: eventTimestampAlignment(
          temporalAlignment,
        ),
        cohort_alignment: cohortAlignment(
          greeks,
          summary,
          input,
          chainRetrievedAtMs,
          retrievedAtMs,
        ),
        oi_freshness: oiFreshness(
          summary,
          chainRetrievedAtMs,
          retrievedAtMs,
        ),
        greeks_freshness: greeksFreshness(
          greeks,
          chainRetrievedAtMs,
          retrievedAtMs,
        ),
        temporal_alignment: temporalAlignment,
      };
    });
    const quoteCoverage = coverage(
      input.includeQuotes,
      contracts,
      (contract) => contract.quote !== null,
      (contract) =>
        contract.quote !== null &&
        contract.quote.bid !== null &&
        contract.quote.ask !== null &&
        contract.quote.bid_size !== null &&
        contract.quote.ask_size !== null,
    );
    const greeksCoverageBase = coverage(
      input.includeGreeks,
      contracts,
      (contract) => contract.greeks !== null,
      (contract) =>
        contract.greeks !== null && contract.greeks.gamma !== null,
    );
    const summaryCoverageBase = coverage(
      input.includeSummary,
      contracts,
      (contract) => contract.summary !== null,
      (contract) =>
        contract.summary !== null &&
        contract.summary.open_interest !== null,
    );
    const alignedContracts = contracts.filter(
      (contract) => contract.temporal_alignment.status === "ALIGNED",
    ).length;
    const misalignedContracts = contracts.filter(
      (contract) => contract.temporal_alignment.status === "MISALIGNED",
    ).length;
    const unverifiableContracts = contracts.filter(
      (contract) =>
        contract.temporal_alignment.status === "UNVERIFIABLE",
    ).length;
    const incompleteContracts = contracts.filter(
      (contract) => contract.temporal_alignment.status === "INCOMPLETE",
    ).length;
    const eventAlignedContracts = contracts.filter(
      (contract) =>
        contract.event_timestamp_alignment.status === "ALIGNED",
    ).length;
    const eventMisalignedContracts = contracts.filter(
      (contract) =>
        contract.event_timestamp_alignment.status === "MISALIGNED",
    ).length;
    const eventUnverifiableContracts = contracts.filter(
      (contract) =>
        contract.event_timestamp_alignment.status === "UNVERIFIABLE",
    ).length;
    const maxSkewValues = contracts
      .map((contract) => contract.event_timestamp_alignment.skew_ms)
      .filter((value): value is number => value !== null);
    const temporalAlignmentStatus: TemporalAlignmentStatus =
      incompleteContracts > 0
        ? "INCOMPLETE"
        : misalignedContracts > 0
          ? "MISALIGNED"
          : unverifiableContracts > 0
            ? "UNVERIFIABLE"
            : contracts.length > 0
              ? "ALIGNED"
              : "INCOMPLETE";
    const eventTimestampAlignmentStatus: EventTimestampAlignmentStatus =
      eventMisalignedContracts > 0
        ? "MISALIGNED"
        : eventUnverifiableContracts > 0
          ? "UNVERIFIABLE"
          : eventAlignedContracts > 0
            ? "ALIGNED"
            : "UNVERIFIABLE";
    const confirmedCohortContracts = contracts.filter(
      (contract) => contract.cohort_alignment.status === "CONFIRMED",
    ).length;
    const partialCohortContracts = contracts.filter(
      (contract) => contract.cohort_alignment.status === "PARTIAL",
    ).length;
    const notConfirmedCohortContracts =
      contracts.length -
      confirmedCohortContracts -
      partialCohortContracts;
    const cohortAlignmentStatus: CohortAlignmentStatus =
      contracts.length > 0 &&
      confirmedCohortContracts === contracts.length
        ? "CONFIRMED"
        : confirmedCohortContracts > 0 || partialCohortContracts > 0
          ? "PARTIAL"
          : "NOT_CONFIRMED";
    const oiConfirmedContracts = contracts.filter(
      (contract) => contract.oi_freshness.status === "CONFIRMED",
    ).length;
    const oiStaleContracts = contracts.filter(
      (contract) => contract.oi_freshness.status === "STALE",
    ).length;
    const oiUnknownContracts =
      contracts.length - oiConfirmedContracts - oiStaleContracts;
    const oiFreshnessStatus: SourceFreshnessStatus =
      oiStaleContracts > 0
        ? "STALE"
        : contracts.length > 0 &&
            oiConfirmedContracts === contracts.length
          ? "CONFIRMED"
          : "UNKNOWN";
    const greeksConfirmedContracts = contracts.filter(
      (contract) =>
        contract.greeks_freshness.status === "CONFIRMED",
    ).length;
    const greeksStaleContracts = contracts.filter(
      (contract) => contract.greeks_freshness.status === "STALE",
    ).length;
    const greeksUnknownContracts =
      contracts.length -
      greeksConfirmedContracts -
      greeksStaleContracts;
    const greeksFreshnessStatus: SourceFreshnessStatus =
      greeksStaleContracts > 0
        ? "STALE"
        : contracts.length > 0 &&
            greeksConfirmedContracts === contracts.length
          ? "CONFIRMED"
          : "UNKNOWN";
    const chainComplete =
      selected.availableExpirations.length === input.expirations.length;
    const gammaOiRequested =
      input.includeGreeks && input.includeSummary;
    const transportComplete =
      snapshotRead.transport.batch_count > 0 &&
      snapshotRead.transport.complete_batches ===
        snapshotRead.transport.batch_count;
    const snapshotComplete =
      contracts.length > 0 &&
      chainComplete &&
      transportComplete &&
      quoteCoverage.complete &&
      greeksCoverageBase.complete &&
      summaryCoverageBase.complete;
    const gammaOiSourceComplete =
      contracts.length > 0 &&
      chainComplete &&
      gammaOiRequested &&
      greeksCoverageBase.complete &&
      summaryCoverageBase.complete;
    const gammaProxy = calculateGammaConcentrationProxy(
      contracts,
      input.aroundPrice,
      retrievedAt,
      gammaOiSourceComplete,
    );
    const warnings = [...selected.warnings];
    if (snapshotRead.timedOut) warnings.push("SNAPSHOT_DEADLINE_EXCEEDED");
    if (snapshotRead.transport.partial_batches > 0) {
      warnings.push("DXLINK_BATCH_PARTIAL");
    }
    if (snapshotRead.transport.timed_out_batches > 0) {
      warnings.push("DXLINK_BATCH_TIMED_OUT");
    }
    if (snapshotRead.transport.failed_batches > 0) {
      warnings.push("DXLINK_BATCH_FAILED");
    }
    if (snapshotRead.unmatchedSymbols.length > 0) {
      warnings.push("UNMATCHED_DXLINK_SYMBOLS_IGNORED");
    }
    if (
      contracts.some(
        (contract) =>
          contract.quote?.timestamp_source === "LOCAL_RECEIVE_TIME",
      )
    ) {
      warnings.push(
        "QUOTE_PROVIDER_TIMESTAMP_UNAVAILABLE_USED_LOCAL_RECEIVE_TIME",
      );
    }
    if (
      contracts.some(
        (contract) =>
          contract.greeks?.timestamp_source === "LOCAL_RECEIVE_TIME",
      )
    ) {
      warnings.push(
        "GREEKS_PROVIDER_TIMESTAMP_UNAVAILABLE_USED_LOCAL_RECEIVE_TIME",
      );
    }
    if (
      contracts.some(
        (contract) =>
          contract.summary?.timestamp_source === "LOCAL_RECEIVE_TIME",
      )
    ) {
      warnings.push(
        "SUMMARY_PROVIDER_TIMESTAMP_UNAVAILABLE_USED_LOCAL_RECEIVE_TIME",
      );
    }
    if (!quoteCoverage.complete && input.includeQuotes) {
      warnings.push("QUOTE_COVERAGE_INCOMPLETE");
    }
    if (!greeksCoverageBase.complete && input.includeGreeks) {
      warnings.push("GREEKS_COVERAGE_INCOMPLETE");
    }
    if (!summaryCoverageBase.complete && input.includeSummary) {
      warnings.push("SUMMARY_OPEN_INTEREST_COVERAGE_INCOMPLETE");
    }
    if (eventTimestampAlignmentStatus === "MISALIGNED") {
      warnings.push("EVENT_TIMESTAMP_ALIGNMENT_MISALIGNED");
    } else if (eventTimestampAlignmentStatus === "UNVERIFIABLE") {
      warnings.push("EVENT_TIMESTAMP_ALIGNMENT_UNVERIFIABLE");
    }
    if (
      gammaOiRequested &&
      cohortAlignmentStatus !== "CONFIRMED"
    ) {
      warnings.push("GAMMA_OI_COHORT_ALIGNMENT_NOT_CONFIRMED");
    }
    if (gammaOiRequested && oiFreshnessStatus !== "CONFIRMED") {
      warnings.push("OI_FRESHNESS_NOT_CONFIRMED");
    }
    if (
      gammaOiRequested &&
      greeksFreshnessStatus !== "CONFIRMED"
    ) {
      warnings.push("GREEKS_FRESHNESS_NOT_CONFIRMED");
    }
    warnings.push(...gammaProxy.warnings);
    const timestampProvenance = {
      quote_provider: contracts.filter(
        (contract) =>
          contract.quote?.timestamp_source === "PROVIDER_SIDE_TIME",
      ).length,
      quote_local_receive: contracts.filter(
        (contract) =>
          contract.quote?.timestamp_source === "LOCAL_RECEIVE_TIME",
      ).length,
      greeks_provider: contracts.filter(
        (contract) =>
          contract.greeks?.timestamp_source === "PROVIDER_EVENT_TIME",
      ).length,
      greeks_local_receive: contracts.filter(
        (contract) =>
          contract.greeks?.timestamp_source === "LOCAL_RECEIVE_TIME",
      ).length,
      summary_provider: contracts.filter(
        (contract) =>
          contract.summary?.timestamp_source === "PROVIDER_EVENT_TIME",
      ).length,
      summary_local_receive: contracts.filter(
        (contract) =>
          contract.summary?.timestamp_source === "LOCAL_RECEIVE_TIME",
      ).length,
    };
    const snapshotId = stableId({
      request_id: requestId,
      retrieved_at: retrievedAt,
      contracts: contracts.map((contract) => ({
        provider_symbol: contract.provider_symbol,
        streamer_symbol: contract.streamer_symbol,
        quote: contract.quote,
        greeks: contract.greeks,
        summary: contract.summary,
        event_timestamp_alignment:
          contract.event_timestamp_alignment,
        cohort_alignment: contract.cohort_alignment,
        oi_freshness: contract.oi_freshness,
        greeks_freshness: contract.greeks_freshness,
        temporal_alignment: contract.temporal_alignment,
      })),
      transport: snapshotRead.transport,
    });
    const proxyEvidenceComplete =
      !gammaOiRequested ||
      (cohortAlignmentStatus === "CONFIRMED" &&
        oiFreshnessStatus === "CONFIRMED" &&
        greeksFreshnessStatus === "CONFIRMED");
    const status: LiveOptionSnapshotResult["status"] =
      snapshotComplete && proxyEvidenceComplete
        ? "AVAILABLE"
        : contracts.some(
            (contract) =>
              contract.quote || contract.greeks || contract.summary,
          )
          ? "PARTIAL"
          : "NOT_AVAILABLE";
    return {
      contract_version: LIVE_OPTION_SNAPSHOT_CONTRACT_VERSION,
      request_id: requestId,
      snapshot_id: snapshotId,
      status,
      provider: "tastytrade-dxlink",
      source: {
        contract_metadata: "tastytrade-option-chain",
        quote: "DXLink Quote",
        greeks: "DXLink Greeks",
        open_interest: "DXLink Summary.openInterest",
      },
      underlying: input.underlying,
      canonical_chain_underlying: "SPX",
      underlying_price: input.aroundPrice,
      requested_expirations: input.expirations,
      available_expirations: selected.availableExpirations,
      strike_count_per_series: input.strikeCount,
      phase: input.phase,
      evidence_role: "SUPPORTING_EVIDENCE",
      research_only: true,
      production_gate_eligible: false,
      retrieved_at: retrievedAt,
      chain_retrieved_at: chainRetrievedAt,
      snapshot_complete: snapshotComplete,
      quote_complete: quoteCoverage.complete,
      greeks_complete: greeksCoverageBase.complete,
      summary_complete: summaryCoverageBase.complete,
      transport: snapshotRead.transport,
      event_timestamp_alignment: {
        status: eventTimestampAlignmentStatus,
        threshold_ms: input.maxTemporalSkewMs,
        max_skew_ms:
          maxSkewValues.length === 0 ? null : Math.max(...maxSkewValues),
        aligned_contracts: eventAlignedContracts,
        misaligned_contracts: eventMisalignedContracts,
        unverifiable_contracts: eventUnverifiableContracts,
      },
      cohort_alignment: {
        status: cohortAlignmentStatus,
        confirmed_contracts: confirmedCohortContracts,
        partial_contracts: partialCohortContracts,
        not_confirmed_contracts: notConfirmedCohortContracts,
      },
      oi_freshness: {
        status: oiFreshnessStatus,
        confirmed_contracts: oiConfirmedContracts,
        stale_contracts: oiStaleContracts,
        unknown_contracts: oiUnknownContracts,
      },
      greeks_freshness: {
        status: greeksFreshnessStatus,
        confirmed_contracts: greeksConfirmedContracts,
        stale_contracts: greeksStaleContracts,
        unknown_contracts: greeksUnknownContracts,
      },
      temporal_alignment: {
        status: temporalAlignmentStatus,
        threshold_ms: input.maxTemporalSkewMs,
        max_skew_ms:
          maxSkewValues.length === 0 ? null : Math.max(...maxSkewValues),
        aligned_contracts: alignedContracts,
        misaligned_contracts: misalignedContracts,
        unverifiable_contracts: unverifiableContracts,
        incomplete_contracts: incompleteContracts,
      },
      data_completeness: {
        chain_complete: chainComplete,
        selected_contracts: contracts.length,
        quote: quoteCoverage,
        greeks: {
          ...greeksCoverageBase,
          gamma_available_contracts: contracts.filter(
            (contract) => contract.greeks?.gamma !== null && contract.greeks,
          ).length,
        },
        summary: {
          ...summaryCoverageBase,
          open_interest_available_contracts: contracts.filter(
            (contract) =>
              contract.summary?.open_interest !== null && contract.summary,
          ).length,
        },
        timestamp_provenance: timestampProvenance,
      },
      contracts,
      gamma_concentration_proxy: gammaProxy,
      market_data_handoff: {
        gamma_concentration_proxy:
          gammaProxy.status === "NOT_AVAILABLE"
            ? null
            : gammaProxy.total_concentration,
        gamma_proxy_methodology: GAMMA_CONCENTRATION_METHODOLOGY,
        gamma_proxy_as_of: retrievedAt,
        gamma_proxy_completeness: {
          status: gammaProxy.status,
          coverage_ratio: gammaProxy.data_completeness.coverage_ratio,
          snapshot_complete: snapshotComplete,
          temporal_alignment: temporalAlignmentStatus,
          event_timestamp_alignment: eventTimestampAlignmentStatus,
          cohort_alignment: cohortAlignmentStatus,
          oi_freshness: oiFreshnessStatus,
          greeks_freshness: greeksFreshnessStatus,
        },
        dealer_gex_status: "UNKNOWN",
        evidence_role: "SUPPORTING_EVIDENCE",
        phase: "LIVE_SUPPORT",
      },
      regression_record: {
        record_type: "LIVE_OPTION_GAMMA_CONCENTRATION",
        record_version: "1.1.0",
        request_id: requestId,
        snapshot_id: snapshotId,
        as_of: retrievedAt,
        methodology: GAMMA_CONCENTRATION_METHODOLOGY,
        methodology_version: GAMMA_CONCENTRATION_METHODOLOGY_VERSION,
        evidence_role: "SUPPORTING_EVIDENCE",
      },
      warnings: [...new Set(warnings)].sort(),
    };
  }

  private async readSnapshotBatches(
    quoteToken: DxlinkQuoteToken,
    subscriptions: LiveOptionDxlinkSubscription[],
    input: NormalizedLiveOptionSnapshotInput,
    states: Map<string, LiveOptionEventState>,
  ): Promise<LiveOptionSnapshotAggregateReadResult> {
    const batches = chunkDxlinkSubscriptions(
      subscriptions,
      this.maxDxlinkSubscriptionFrameBytes,
    );
    const batchResults = new Array<
      LiveOptionSnapshotResult["transport"]["batches"][number]
    >(batches.length);
    const unmatchedSymbols = new Set<string>();
    const aggregateDeadlineAt = this.clock() + input.deadlineMs;
    let nextBatchIndex = 0;

    const readNextBatch = async () => {
      while (true) {
        const batchIndex = nextBatchIndex;
        nextBatchIndex += 1;
        const batch = batches[batchIndex];
        if (!batch) return;
        const symbols = [
          ...new Set(
            batch.subscriptions.map(
              (subscription) => subscription.symbol,
            ),
          ),
        ].sort();
        const remainingDeadlineMs =
          aggregateDeadlineAt - this.clock();
        if (remainingDeadlineMs <= 0) {
          batchResults[batchIndex] = {
            batch_index: batchIndex + 1,
            symbol_count: symbols.length,
            subscription_count: batch.subscriptions.length,
            frame_bytes: batch.frame_bytes,
            status: "TIMED_OUT",
            affected_symbols: symbols,
            unmatched_symbols: [],
            error:
              "Aggregate snapshot deadline elapsed before this batch started.",
          };
          continue;
        }
        try {
          const result = await this.readSnapshot(
            quoteToken,
            batch.subscriptions,
            input,
            states,
            remainingDeadlineMs,
          );
          for (const symbol of result.unmatchedSymbols) {
            unmatchedSymbols.add(symbol);
          }
          const affectedSymbols = affectedSubscriptionSymbols(
            states,
            batch.subscriptions,
          );
          const receivedSubscriptions =
            batch.subscriptions.length -
            batch.subscriptions.filter(
              (subscription) =>
                !subscriptionSatisfied(states, subscription),
            ).length;
          const status: LiveOptionDxlinkBatchStatus = result.timedOut
            ? receivedSubscriptions > 0
              ? "PARTIAL"
              : "TIMED_OUT"
            : affectedSymbols.length === 0
              ? "COMPLETE"
              : "PARTIAL";
          batchResults[batchIndex] = {
            batch_index: batchIndex + 1,
            symbol_count: symbols.length,
            subscription_count: batch.subscriptions.length,
            frame_bytes: batch.frame_bytes,
            status,
            affected_symbols: affectedSymbols,
            unmatched_symbols: result.unmatchedSymbols,
            error:
              status === "COMPLETE"
                ? null
                : "DXLink batch deadline elapsed before all subscriptions were received.",
          };
        } catch (error) {
          if (
            error instanceof DxlinkAbortedError ||
            input.signal?.aborted
          ) {
            throw error;
          }
          const affectedSymbols = affectedSubscriptionSymbols(
            states,
            batch.subscriptions,
          );
          batchResults[batchIndex] = {
            batch_index: batchIndex + 1,
            symbol_count: symbols.length,
            subscription_count: batch.subscriptions.length,
            frame_bytes: batch.frame_bytes,
            status: "FAILED",
            affected_symbols:
              affectedSymbols.length > 0 ? affectedSymbols : symbols,
            unmatched_symbols: [],
            error:
              error instanceof Error ? error.message : String(error),
          };
        }
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            batches.length,
            this.maxConcurrentDxlinkBatches,
          ),
        },
        () => readNextBatch(),
      ),
    );
    const completeBatches = batchResults.filter(
      (batch) => batch.status === "COMPLETE",
    ).length;
    const partialBatches = batchResults.filter(
      (batch) => batch.status === "PARTIAL",
    ).length;
    const timedOutBatches = batchResults.filter(
      (batch) => batch.status === "TIMED_OUT",
    ).length;
    const failedBatches = batchResults.filter(
      (batch) => batch.status === "FAILED",
    ).length;
    return {
      states,
      unmatchedSymbols: [...unmatchedSymbols].sort(),
      timedOut: partialBatches > 0 || timedOutBatches > 0,
      transport: {
        strategy: "BOUNDED_AUTO_CHUNK",
        max_frame_bytes: this.maxDxlinkSubscriptionFrameBytes,
        max_concurrent_batches: this.maxConcurrentDxlinkBatches,
        requested_subscriptions: subscriptions.length,
        batch_count: batchResults.length,
        complete_batches: completeBatches,
        partial_batches: partialBatches,
        timed_out_batches: timedOutBatches,
        failed_batches: failedBatches,
        batches: batchResults,
      },
    };
  }

  private readSnapshot(
    quoteToken: DxlinkQuoteToken,
    subscriptions: LiveOptionDxlinkSubscription[],
    input: NormalizedLiveOptionSnapshotInput,
    states: Map<string, LiveOptionEventState>,
    deadlineMs: number,
  ): Promise<LiveOptionSnapshotReadResult> {
    assertDxlinkNotAborted(input.signal);
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(quoteToken.url);
      const unmatchedSymbols = new Set<string>();
      let subscribed = false;
      let settled = false;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      let abortListener: (() => void) | null = null;
      let messageQueue = Promise.resolve();

      const send = (message: Record<string, unknown>) => {
        socket.send(JSON.stringify(message));
      };
      const unsubscribe = () => {
        if (
          !subscribed ||
          subscriptions.length === 0 ||
          socket.readyState !== DXLINK_OPEN
        ) {
          return;
        }
        send({
          type: "FEED_SUBSCRIPTION",
          channel: 3,
          remove: subscriptions,
        });
        subscribed = false;
      };
      const cleanup = () => {
        if (deadline) clearTimeout(deadline);
        if (keepalive) clearInterval(keepalive);
        if (abortListener) {
          input.signal?.removeEventListener("abort", abortListener);
        }
        unsubscribe();
        if (socket.readyState === DXLINK_OPEN) {
          socket.close(1000, "live option snapshot stopped");
        }
      };
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          states,
          unmatchedSymbols: [...unmatchedSymbols].sort(),
          timedOut,
        });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const complete = () =>
        subscriptions.every((subscription) =>
          subscriptionSatisfied(states, subscription),
        );
      const processMessage = (message: Record<string, unknown>) => {
        if (
          message.type === "AUTH_STATE" &&
          message.state === "UNAUTHORIZED"
        ) {
          send({
            type: "AUTH",
            channel: 0,
            token: quoteToken.token,
          });
        } else if (
          message.type === "AUTH_STATE" &&
          message.state === "AUTHORIZED"
        ) {
          send({
            type: "CHANNEL_REQUEST",
            channel: 3,
            service: "FEED",
            parameters: { contract: "AUTO" },
          });
        } else if (
          message.type === "CHANNEL_OPENED" &&
          message.channel === 3
        ) {
          send({
            type: "FEED_SETUP",
            channel: 3,
            acceptAggregationPeriod: 0.1,
            acceptDataFormat: "COMPACT",
            acceptEventFields: {
              ...(input.includeQuotes ? { Quote: QUOTE_FIELDS } : {}),
              ...(input.includeGreeks ? { Greeks: GREEKS_FIELDS } : {}),
              ...(input.includeSummary ? { Summary: SUMMARY_FIELDS } : {}),
            },
          });
        } else if (
          message.type === "FEED_CONFIG" &&
          message.channel === 3 &&
          !subscribed
        ) {
          subscribed = true;
          send(subscriptionMessage(subscriptions));
        } else if (
          message.type === "FEED_DATA" &&
          message.channel === 3
        ) {
          const events = parseDxlinkLiveOptionData(
            message.data,
            this.clock(),
          );
          for (const symbol of mergeLiveOptionEvents(states, events)) {
            unmatchedSymbols.add(symbol);
          }
          if (complete()) finish(false);
        } else if (
          message.type === "ERROR" ||
          message.type === "CHANNEL_CLOSED"
        ) {
          fail(
            new Error(
              `DXLink rejected the live option snapshot: ${JSON.stringify(message)}`,
            ),
          );
        }
      };

      abortListener = () => fail(new DxlinkAbortedError());
      input.signal?.addEventListener("abort", abortListener, {
        once: true,
      });
      deadline = setTimeout(() => finish(true), deadlineMs);
      socket.onopen = () => {
        if (settled) {
          socket.close(1000, "live option snapshot already settled");
          return;
        }
        send({
          type: "SETUP",
          channel: 0,
          version: "0.1-DXF-JS/0.3.0",
          keepaliveTimeout: 60,
          acceptKeepaliveTimeout: 60,
        });
        keepalive = setInterval(() => {
          if (socket.readyState === DXLINK_OPEN) {
            send({ type: "KEEPALIVE", channel: 0 });
          }
        }, 30_000);
      };
      socket.onerror = () =>
        fail(new Error("DXLink live option snapshot WebSocket error."));
      socket.onclose = (event) => {
        if (!settled) {
          fail(
            new Error(
              `DXLink closed before live option snapshot completion (${event.code}: ${event.reason || "no reason"}).`,
            ),
          );
        }
      };
      socket.onmessage = (event) => {
        if (settled) return;
        messageQueue = messageQueue
          .then(async () => {
            if (settled) return;
            const text = await decodeDxlinkMessageData(event.data);
            if (settled) return;
            for (const line of text.split(/\n+/).filter(Boolean)) {
              if (settled) return;
              let message: Record<string, unknown>;
              try {
                message = JSON.parse(line) as Record<string, unknown>;
              } catch {
                fail(new Error("DXLink returned invalid JSON."));
                return;
              }
              processMessage(message);
            }
          })
          .catch((error: unknown) =>
            fail(error instanceof Error ? error : new Error(String(error))),
          );
      };
    });
  }
}
