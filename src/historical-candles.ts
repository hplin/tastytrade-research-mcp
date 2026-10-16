import { createHash } from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import {
  OAUTH_BASE_URL,
  USER_AGENT,
  assertTrustedHosts,
} from "./config.js";
import { ExactDecimal } from "./decimal.js";
import {
  DXLINK_OPEN,
  TastytradeDxlinkTokenClient,
  decodeDxlinkMessageData,
  DxlinkAuthenticationError,
  DxlinkAuthFailedError,
  dxlinkAuthenticationError,
  dxlinkMessageDataByteLength,
  withDxlinkAuthRecovery,
  type DxlinkAuthDiagnostics,
  type DxlinkAuthRecoveryResult,
  type DxlinkProviderError,
  type DxlinkQuoteToken,
  type DxlinkQuoteTokenProvider,
  type DxlinkSocket,
  type DxlinkSocketFactory,
  type TastytradeAccessTokenProvider,
} from "./dxlink.js";
import type {
  EvidenceCacheRecord,
  EvidenceCacheRequest,
} from "./evidence-cache.js";
import { TastytradeOAuthClient } from "./oauth-client.js";
import {
  normalizeResolutionProfile,
  withEffectiveAggregation,
  type ResolutionProfile,
  type ResolutionProfileInput,
  type ResolutionProfileSession,
} from "./resolution-profile.js";
import { normalizeRfc3339 } from "./time.js";
import {
  RTH_CALENDAR_VERSION,
  planRthSessions,
  rthDate,
  rthSession,
  type RthCalendarPlan,
} from "./rth-calendar.js";

export type InstrumentType =
  | "EQUITY"
  | "INDEX"
  | "OPTION"
  | "FUTURE"
  | "FUTURE_OPTION"
  | "CRYPTO";

export type InstrumentLifecycle = "ACTIVE" | "EXPIRED" | "UNKNOWN";

export type HistoricalCandlePriceType = "LAST" | "BID" | "ASK";

export function normalizeHistoricalCandlePriceType(
  value: HistoricalCandlePriceType | undefined,
): HistoricalCandlePriceType {
  if (value === undefined) return "LAST";
  if (value !== "LAST" && value !== "BID" && value !== "ASK") {
    throw new Error("price_type must be LAST, BID, or ASK.");
  }
  return value;
}

export type CandleSession =
  | {
      kind: "ALL";
      timezone?: string;
    }
  | {
      kind: "REGULAR";
      timezone?: string;
    }
  | {
      kind: "CUSTOM";
      timezone: string;
      start_time: string;
      end_time: string;
    };

export type HistoricalCandlesInput = {
  symbol: string;
  streamer_symbol?: string;
  instrument_type: InstrumentType;
  lifecycle?: InstrumentLifecycle;
  interval: string;
  price_type?: HistoricalCandlePriceType;
  start_time: string;
  end_time: string;
  session?: CandleSession;
  resolution_profile?: ResolutionProfileInput;
  deadline_ms?: number;
  max_output_candles?: number;
  max_received_events?: number;
  max_buffer_bytes?: number;
  timeout_ms?: number;
  max_candles?: number;
  evidence_cache?: EvidenceCacheRequest;
  signal?: AbortSignal;
};

export type HistoricalCandleInstrument = {
  symbol: string;
  streamer_symbol?: string;
  instrument_type: InstrumentType;
  lifecycle?: InstrumentLifecycle;
};

export type HistoricalCandlesBatchInput = {
  instruments: HistoricalCandleInstrument[];
  interval: string;
  price_type?: HistoricalCandlePriceType;
  start_time: string;
  end_time: string;
  session?: CandleSession;
  resolution_profile?: ResolutionProfileInput;
  deadline_ms?: number;
  max_output_candles?: number;
  max_received_events?: number;
  max_buffer_bytes?: number;
  timeout_ms?: number;
  max_candles?: number;
  evidence_cache?: EvidenceCacheRequest;
  signal?: AbortSignal;
};

export type HistoricalCandle = {
  source_time: string;
  bar_start: string;
  bar_end: string;
  available_at: string;
  retrieved_at: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  vwap: string | null;
  bid_volume: string | null;
  ask_volume: string | null;
  implied_volatility: string | null;
  open_interest: string | null;
  provider_evidence?: {
    dataset_id: string;
    revision: string;
    method: string;
    native_symbol: string;
    native_fields: Record<string, string | number | boolean | null>;
    bid_price: string | null;
    ask_price: string | null;
    delta: string | null;
    warnings: string[];
  };
  session_timing?: { calendar_id: string; session_date: string };
};

export type HistoricalCandlesFailureReason =
  | "LOCAL_RECEIVE_BUDGET_EXCEEDED"
  | "LOCAL_BUFFER_BUDGET_EXCEEDED"
  | "LOCAL_OUTPUT_BUDGET_EXCEEDED"
  | "PROVIDER_SNAPSHOT_SNIPPED"
  | "REQUESTED_WINDOW_NOT_COVERED"
  | "SNAPSHOT_TIMEOUT"
  | "MISSING_CONTRACT_EVIDENCE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_TEMPORARY_FAILURE"
  | "PROVIDER_PARTIAL_RESPONSE"
  | "PROVIDER_SCHEMA_MISMATCH"
  | "SOURCE_RTH_DAILY_MISSING"
  | "CALENDAR_EXPECTED_SESSION_MISSING"
  | "PROVIDER_COMPLETE_BUT_COVERAGE_PARTIAL"
  | "CALENDAR_UNSUPPORTED"
  | "SOURCE_RTH_DAILY_TIME_UNVERIFIED"
  | "AUTH_FAILED";

export type HistoricalCandlesResourceCounters = {
  received_events: number;
  valid_candle_events: number;
  unique_observations: number;
  retained_rows: number;
  retained_bytes: number;
  returned_rows: number;
};

export type HistoricalCandlesTimeoutStage =
  | "CONNECTING"
  | "AUTHENTICATING"
  | "OPENING_FEED_CHANNEL"
  | "CONFIGURING_FEED"
  | "SNAPSHOT";

export type HistoricalCandlesResult = {
  contract_version: "1.0.0";
  request_id: string;
  status: "AVAILABLE" | "PARTIAL" | "NOT_AVAILABLE";
  symbol: string;
  streamer_symbol: string;
  instrument_type: InstrumentType;
  interval: string;
  price_type?: HistoricalCandlePriceType;
  evidence_class?: "VALUATION_ONLY";
  requested_range: {
    start: string;
    end: string;
  };
  actual_range: {
    start: string;
    end: string;
  } | null;
  timezone: string;
  session: CandleSession["kind"];
  retrieved_at: string;
  resolution_profile: ResolutionProfile;
  source: string;
  source_timestamp_unit: "epoch_milliseconds" | "RFC3339";
  dxlink_auth?: DxlinkAuthDiagnostics;
  provider_error?: DxlinkProviderError | null;
  snapshot_complete: boolean;
  snapshot_truncated: boolean;
  provider_snapshot_complete: boolean;
  session_coverage_complete?: boolean | null;
  expected_session_dates?: string[];
  observed_session_dates?: string[];
  missing_session_dates?: string[];
  missing_session_diagnostics?: {
    session_date: string;
    attribution: "NO_VALID_CANONICAL_PROVIDER_ROW_OBSERVED" | "VALID_PROVIDER_ROW_NOT_RETURNED_LOCALLY";
    provider_cause_confirmed: false;
  }[];
  coverage_ratio?: number | null;
  session_coverage?: {
    calendar_id: string;
    status: "VERIFIED" | "UNSUPPORTED";
    reason: string | null;
    evaluated_through: string;
    ma20_eligible: boolean;
    ma20_expected_session_dates: string[];
  };
  recovery_diagnostics?: {
    attempts: number;
    maximum_attempts: number;
    recovered_session_dates: string[];
    failures: HistoricalCandlesFailureReason[];
    stopped_reason: string | null;
    initial_windows: {
      start: string;
      end: string;
      provider_snapshot_complete: boolean;
      failure_reason: HistoricalCandlesFailureReason | null;
      timeout_stage: HistoricalCandlesTimeoutStage | null;
      failure_stage: HistoricalCandlesTimeoutStage | null;
      received_events: number;
    }[];
    windows: {
      start: string;
      end: string;
      provider_snapshot_complete: boolean;
      failure_reason: HistoricalCandlesFailureReason | null;
      timeout_stage: HistoricalCandlesTimeoutStage | null;
      received_events: number;
    }[];
  };
  failure_reasons: HistoricalCandlesFailureReason[];
  resource_usage: {
    limits: {
      max_output_candles_per_symbol: number;
      max_received_events_per_request: number;
      max_buffer_bytes_per_request: number;
      deadline_ms_per_request: number;
      max_candles_compatibility_applied: boolean;
      timeout_ms_compatibility_applied: boolean;
    };
    request: HistoricalCandlesResourceCounters & {
      unmatched_received_events: number;
      unmatched_symbol_count: number;
      peak_buffer_bytes: number;
    };
    symbol: HistoricalCandlesResourceCounters;
  };
  transport_diagnostics: {
    requested_symbol: string;
    canonical_requested_symbol: string;
    received_symbols: string[];
    canonical_received_symbols: string[];
    unmatched_received_symbols: string[];
    oldest_received_timestamp: string | null;
    newest_received_timestamp: string | null;
    snapshot_begin_seen: boolean;
    snapshot_end_seen: boolean;
    snapshot_snip_seen: boolean;
    timeout_stage: HistoricalCandlesTimeoutStage | null;
    received_session_dates?: string[];
    local_pipeline?: {
      invalid_candle_events: number;
      outside_request_or_session: number;
      replaced_indices: number;
      removed_indices: number;
      snapshot_resets: number;
      unverified_daily_times: number;
      unfinished_daily_rows: number;
    };
  };
  advisory: {
    requested_window_candle_slots_per_symbol: number;
    continuous_calendar_replay_slots_per_symbol: number;
    continuous_calendar_replay_is_provider_fact: false;
  };
  resampled: false;
  candles: HistoricalCandle[];
  warnings: string[];
  bounded_history?: {
    contract_version: "1.0.0";
    provider_id: string;
    dataset_id: string;
    source_revision: string;
    approval_reference: string;
    shard_count: number;
    completed_shards: number;
    failed_shards: number;
    page_count: number;
    requested_fields: string[];
  };
  evidence_cache?: EvidenceCacheRecord | null;
};

export type { DxlinkSocketFactory } from "./dxlink.js";

type RawCandle = {
  eventSymbol: string;
  index: string;
  timestamp: number;
  flags: number;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
  vwap: string | null;
  bidVolume: string | null;
  askVolume: string | null;
  impliedVolatility: string | null;
  openInterest: string | null;
};

type ParsedCandleEvent = {
  eventSymbol: string;
  index: string;
  flags: number | null;
  candle: RawCandle | null;
};

type RetainedCandle = {
  candle: RawCandle;
  bytes: number;
};

type PendingCandleEvent = {
  event: ParsedCandleEvent;
  bytes: number;
};

type SnapshotSymbolState = {
  candleSymbol: string;
  canonicalSymbol: string;
  candlesByIndex: Map<string, RetainedCandle>;
  seenIndices: Set<string>;
  receivedSymbols: Set<string>;
  canonicalReceivedSymbols: Set<string>;
  oldestReceivedTimestamp: number | null;
  newestReceivedTimestamp: number | null;
  snapshotBeginSeen: boolean;
  snapshotEndSeen: boolean;
  snapshotSnipSeen: boolean;
  pendingTransactionEvents: PendingCandleEvent[];
  snapshotDataBytes: number;
  providerComplete: boolean;
  providerSnipped: boolean;
  localFailureReason: HistoricalCandlesFailureReason | null;
  counters: HistoricalCandlesResourceCounters;
  receivedSessionDates: Set<string>;
  pipeline: NonNullable<HistoricalCandlesResult["transport_diagnostics"]["local_pipeline"]>;
};

type SnapshotReadResult = {
  symbolStates: Map<string, SnapshotSymbolState>;
  authConfirmed: boolean;
  requestFailureReason: HistoricalCandlesFailureReason | null;
  requestCounters: HistoricalCandlesResourceCounters & {
    unmatched_received_events: number;
    unmatched_symbol_count: number;
    peak_buffer_bytes: number;
  };
  unmatchedSymbols: string[];
  timeoutStage: HistoricalCandlesTimeoutStage | null;
};

class SnapshotAuthenticationError extends DxlinkAuthenticationError {
  constructor(readonly snapshot: SnapshotReadResult) {
    super({ code: "UNAUTHORIZED", message: "Authentication failed" });
  }
}

class SnapshotReadError extends Error {
  constructor(readonly snapshot: SnapshotReadResult) {
    super("DXLink snapshot failed before completion.");
  }
}

type HistoricalCandleBudgets = {
  deadlineMs: number;
  maxOutputCandles: number;
  maxReceivedEvents: number;
  maxBufferBytes: number;
  maxCandlesCompatibilityApplied: boolean;
  timeoutMsCompatibilityApplied: boolean;
};

const TX_PENDING = 1;
const REMOVE_EVENT = 2;
const SNAPSHOT_BEGIN = 4;
const SNAPSHOT_END = 8;
const SNAPSHOT_SNIP = 16;
const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CANDLES = 10_000;
const DEFAULT_MAX_RECEIVED_EVENTS = 10_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_CANDLES = 250_000;
const MAX_RECEIVED_EVENTS = 1_000_000;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const LEGACY_MAX_CANDLES = 20_000;
const RETAINED_CANDLE_OVERHEAD_BYTES = 256;
const RETAINED_INDEX_OVERHEAD_BYTES = 64;
const CANDLE_FIELDS = [
  "eventType",
  "eventSymbol",
  "eventFlags",
  "index",
  "time",
  "sequence",
  "count",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "vwap",
  "bidVolume",
  "askVolume",
  "impVolatility",
  "openInterest",
] as const;

function normalizeTimestamp(value: string, field: string): string {
  return normalizeRfc3339(value, field);
}

function normalizeDuration(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${field} must be a positive integer <= ${maximum}.`);
  }
  return value;
}

function normalizeBudgets(
  input: Pick<
    HistoricalCandlesBatchInput,
    | "deadline_ms"
    | "max_output_candles"
    | "max_received_events"
    | "max_buffer_bytes"
    | "timeout_ms"
    | "max_candles"
  >,
): HistoricalCandleBudgets {
  if (
    input.max_candles !== undefined &&
    (input.max_output_candles !== undefined ||
      input.max_received_events !== undefined)
  ) {
    throw new Error(
      "max_candles cannot be combined with max_output_candles or max_received_events; migrate to the explicit budgets.",
    );
  }
  if (input.deadline_ms !== undefined && input.timeout_ms !== undefined) {
    throw new Error(
      "deadline_ms cannot be combined with deprecated timeout_ms.",
    );
  }

  const legacyMaxCandles =
    input.max_candles === undefined
      ? undefined
      : normalizeDuration(
          input.max_candles,
          DEFAULT_MAX_OUTPUT_CANDLES,
          "max_candles",
          LEGACY_MAX_CANDLES,
        );
  return {
    deadlineMs: normalizeDuration(
      input.deadline_ms ?? input.timeout_ms,
      DEFAULT_DEADLINE_MS,
      input.deadline_ms === undefined ? "timeout_ms" : "deadline_ms",
      60_000,
    ),
    maxOutputCandles:
      legacyMaxCandles ??
      normalizeDuration(
        input.max_output_candles,
        DEFAULT_MAX_OUTPUT_CANDLES,
        "max_output_candles",
        MAX_OUTPUT_CANDLES,
      ),
    maxReceivedEvents:
      legacyMaxCandles ??
      normalizeDuration(
        input.max_received_events,
        DEFAULT_MAX_RECEIVED_EVENTS,
        "max_received_events",
        MAX_RECEIVED_EVENTS,
      ),
    maxBufferBytes: normalizeDuration(
      input.max_buffer_bytes,
      DEFAULT_MAX_BUFFER_BYTES,
      "max_buffer_bytes",
      MAX_BUFFER_BYTES,
    ),
    maxCandlesCompatibilityApplied: input.max_candles !== undefined,
    timeoutMsCompatibilityApplied: input.timeout_ms !== undefined,
  };
}

function canonicalCandlePeriod(value: string): string {
  const match =
    /^((?:[1-9]\d*(?:\.\d+)?|0\.\d+))?([a-z]+)$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid DXLink candle period: ${value}.`);
  }
  const periodTypes: Record<string, string> = {
    t: "t",
    tick: "t",
    ticks: "t",
    s: "s",
    sec: "s",
    second: "s",
    seconds: "s",
    m: "m",
    min: "m",
    minute: "m",
    minutes: "m",
    h: "h",
    hour: "h",
    hours: "h",
    d: "d",
    day: "d",
    days: "d",
    w: "w",
    week: "w",
    weeks: "w",
    mo: "mo",
    month: "mo",
    months: "mo",
  };
  const type = periodTypes[match[2].toLowerCase()];
  if (!type) {
    throw new Error(`Unsupported DXLink candle period type: ${match[2]}.`);
  }
  const amount = match[1] === undefined ? 1 : Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid DXLink candle period value: ${value}.`);
  }
  return `${amount === 1 ? "" : String(amount)}${type}`;
}

function canonicalAlignment(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "m" || normalized === "midnight") return "m";
  if (normalized === "s" || normalized === "session") return "s";
  return normalized;
}

function canonicalPrice(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "settlement") return "s";
  return normalized;
}

export function canonicalizeDxlinkCandleSymbol(value: string): string {
  const symbol = value.trim();
  if (!symbol) throw new Error("DXLink CandleSymbol must be non-empty.");
  const openBrace = symbol.indexOf("{");
  if (openBrace === -1) return symbol;
  if (
    !symbol.endsWith("}") ||
    symbol.indexOf("{", openBrace + 1) !== -1 ||
    symbol.slice(openBrace + 1, -1).includes("}")
  ) {
    throw new Error(`Invalid DXLink CandleSymbol: ${value}.`);
  }
  const baseSymbol = symbol.slice(0, openBrace);
  if (!baseSymbol) throw new Error(`Invalid DXLink CandleSymbol: ${value}.`);

  const attributes = new Map<string, string>();
  const seenAttributeKeys = new Set<string>();
  const rawAttributes = symbol.slice(openBrace + 1, -1);
  if (!rawAttributes) {
    throw new Error(`Invalid DXLink CandleSymbol: ${value}.`);
  }
  for (const component of rawAttributes.split(",")) {
    const separator = component.indexOf("=");
    if (separator === -1) {
      throw new Error(`Invalid DXLink CandleSymbol attribute: ${component}.`);
    }
    const key = component.slice(0, separator).trim();
    const rawValue = component.slice(separator + 1).trim();
    if (!rawValue || seenAttributeKeys.has(key)) {
      throw new Error(`Invalid DXLink CandleSymbol attribute: ${component}.`);
    }
    seenAttributeKeys.add(key);

    let normalizedValue = rawValue.toLowerCase();
    if (key === "") {
      normalizedValue = canonicalCandlePeriod(rawValue);
      if (normalizedValue === "t") continue;
    } else if (key === "a") {
      normalizedValue = canonicalAlignment(rawValue);
      if (normalizedValue === "m") continue;
    } else if (key === "price") {
      normalizedValue = canonicalPrice(rawValue);
      if (normalizedValue === "last") continue;
    } else if (key === "tho") {
      if (normalizedValue !== "true" && normalizedValue !== "false") {
        throw new Error(`Invalid DXLink tho attribute: ${rawValue}.`);
      }
      if (normalizedValue === "false") continue;
    } else if (key === "pl" && normalizedValue === "nan") {
      continue;
    }
    attributes.set(key, normalizedValue);
  }

  const serialized = [...attributes.entries()]
    .sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    .map(([key, attributeValue]) => `${key}=${attributeValue}`)
    .join(",");
  return serialized ? `${baseSymbol}{${serialized}}` : baseSymbol;
}

function intervalMilliseconds(interval: string): number {
  const match = /^([1-9]\d*)(s|m|h|d|w)$/.exec(interval);
  if (!match) {
    throw new Error(
      "interval must use a fixed DXLink period such as 1m, 5m, 1h, 1d, or 1w.",
    );
  }
  const amount = Number(match[1]);
  const unitMs =
    match[2] === "s"
      ? 1_000
      : match[2] === "m"
        ? 60_000
        : match[2] === "h"
          ? 3_600_000
          : match[2] === "d"
            ? 86_400_000
            : 604_800_000;
  return amount * unitMs;
}

function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}.`);
  }
  return timezone;
}

function parseClock(value: string, field: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`${field} must use HH:MM 24-hour time.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function sessionConfiguration(session: CandleSession | undefined): {
  kind: CandleSession["kind"];
  timezone: string;
  startMinute: number | null;
  endMinute: number | null;
} {
  if (!session || session.kind === "ALL") {
    return {
      kind: "ALL",
      timezone: validateTimezone(session?.timezone ?? "UTC"),
      startMinute: null,
      endMinute: null,
    };
  }

  if (session.kind === "REGULAR") {
    return {
      kind: "REGULAR",
      timezone: validateTimezone(session.timezone ?? "America/New_York"),
      startMinute: null,
      endMinute: null,
    };
  }
  return {
    kind: "CUSTOM",
    timezone: validateTimezone(session.timezone),
    startMinute: parseClock(session.start_time, "session.start_time"),
    endMinute: parseClock(session.end_time, "session.end_time"),
  };
}

function resolutionSession(
  session: CandleSession | undefined,
): ResolutionProfileSession {
  const normalized = sessionConfiguration(session);
  if (normalized.kind === "ALL") {
    return {
      kind: "ALL",
      timezone: normalized.timezone,
      start_time: null,
      end_time: null,
    };
  }
  if (normalized.kind === "REGULAR") {
    return {
      kind: "REGULAR",
      timezone: normalized.timezone,
      start_time: "09:30",
      end_time: "16:00",
    };
  }
  const customSession = session as Extract<CandleSession, { kind: "CUSTOM" }>;
  return {
    kind: "CUSTOM",
    timezone: normalized.timezone,
    start_time: customSession.start_time,
    end_time: customSession.end_time,
  };
}

function candleSession(profile: ResolutionProfile): CandleSession {
  if (profile.session.kind === "ALL") {
    return {
      kind: "ALL",
      timezone: profile.session.timezone,
    };
  }
  if (profile.session.kind === "REGULAR") {
    return {
      kind: "REGULAR",
      timezone: profile.session.timezone,
    };
  }
  return {
    kind: "CUSTOM",
    timezone: profile.session.timezone,
    start_time: profile.session.start_time,
    end_time: profile.session.end_time,
  };
}

function sameSession(
  left: ResolutionProfileSession,
  right: ResolutionProfileSession,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableRequestId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function localTimeParts(
  timestamp: number,
  timezone: string,
): { weekday: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    weekday: value.weekday,
    minute: Number(value.hour) * 60 + Number(value.minute),
  };
}

function isWithinSession(
  timestamp: number,
  session: ReturnType<typeof sessionConfiguration>,
): boolean {
  if (session.kind === "ALL") return true;
  if (session.kind === "REGULAR") return true;
  const local = localTimeParts(timestamp, session.timezone);
  const start = session.startMinute!;
  const end = session.endMinute!;
  return start < end
    ? local.minute >= start && local.minute < end
    : local.minute >= start || local.minute < end;
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

function parseRows(payload: unknown): unknown[][] {
  if (!Array.isArray(payload)) return [];
  if (payload.length > 0 && Array.isArray(payload[0])) {
    return payload.filter(Array.isArray) as unknown[][];
  }
  const rows: unknown[][] = [];
  for (
    let index = 0;
    index + CANDLE_FIELDS.length <= payload.length;
    index += CANDLE_FIELDS.length
  ) {
    rows.push(payload.slice(index, index + CANDLE_FIELDS.length));
  }
  return rows;
}

export function parseDxlinkCandleData(data: unknown): {
  events: ParsedCandleEvent[];
  candles: RawCandle[];
  snapshotComplete: boolean;
  snapshotTruncated: boolean;
  completedSymbols: string[];
  truncatedSymbols: string[];
} {
  if (!Array.isArray(data)) {
    return {
      events: [],
      candles: [],
      snapshotComplete: false,
      snapshotTruncated: false,
      completedSymbols: [],
      truncatedSymbols: [],
    };
  }
  const events: ParsedCandleEvent[] = [];
  const candles: RawCandle[] = [];
  let snapshotComplete = false;
  let snapshotTruncated = false;
  const completedSymbols = new Set<string>();
  const truncatedSymbols = new Set<string>();

  for (let index = 0; index + 1 < data.length; index += 2) {
    if (data[index] !== "Candle") continue;
    for (const row of parseRows(data[index + 1])) {
      const eventSymbol = typeof row[1] === "string" ? row[1] : "";
      const eventIndex = String(row[3]);
      const flags = Number(row[2]);
      if (!Number.isFinite(flags)) {
        events.push({
          eventSymbol,
          index: eventIndex,
          flags: null,
          candle: null,
        });
        continue;
      }
      if ((flags & SNAPSHOT_END) !== 0) {
        snapshotComplete = true;
        if (eventSymbol) completedSymbols.add(eventSymbol);
      }
      if ((flags & SNAPSHOT_SNIP) !== 0) {
        snapshotTruncated = true;
        if (eventSymbol) truncatedSymbols.add(eventSymbol);
      }
      if ((flags & REMOVE_EVENT) !== 0) {
        events.push({
          eventSymbol,
          index: eventIndex,
          flags,
          candle: null,
        });
        continue;
      }

      const timestamp = Number(row[4]);
      const open = decimalOrNull(row[7]);
      const high = decimalOrNull(row[8]);
      const low = decimalOrNull(row[9]);
      const close = decimalOrNull(row[10]);
      if (
        !Number.isFinite(timestamp) ||
        !open ||
        !high ||
        !low ||
        !close
      ) {
        events.push({
          eventSymbol,
          index: eventIndex,
          flags,
          candle: null,
        });
        continue;
      }
      const candle = {
        eventSymbol,
        index: eventIndex,
        timestamp,
        flags,
        open,
        high,
        low,
        close,
        volume: decimalOrNull(row[11]),
        vwap: decimalOrNull(row[12]),
        bidVolume: decimalOrNull(row[13]),
        askVolume: decimalOrNull(row[14]),
        impliedVolatility: decimalOrNull(row[15]),
        openInterest: decimalOrNull(row[16]),
      };
      candles.push(candle);
      events.push({
        eventSymbol,
        index: eventIndex,
        flags,
        candle,
      });
    }
  }

  return {
    events,
    candles,
    snapshotComplete,
    snapshotTruncated,
    completedSymbols: [...completedSymbols],
    truncatedSymbols: [...truncatedSymbols],
  };
}

function retainedCandleBytes(candle: RawCandle): number {
  return (
    RETAINED_CANDLE_OVERHEAD_BYTES +
    Buffer.byteLength(JSON.stringify(candle), "utf8")
  );
}

function retainedIndexBytes(index: string): number {
  return (
    RETAINED_INDEX_OVERHEAD_BYTES + Buffer.byteLength(index, "utf8")
  );
}

function pendingCandleEventBytes(event: ParsedCandleEvent): number {
  return (
    RETAINED_INDEX_OVERHEAD_BYTES +
    Buffer.byteLength(JSON.stringify(event), "utf8")
  );
}

function emptyResourceCounters(): HistoricalCandlesResourceCounters {
  return {
    received_events: 0,
    valid_candle_events: 0,
    unique_observations: 0,
    retained_rows: 0,
    retained_bytes: 0,
    returned_rows: 0,
  };
}

export class HistoricalCandlesAbortedError extends Error {
  readonly code = "PROVIDER_TIMEOUT";
  readonly retryable = true;

  constructor() {
    super("Historical candle request was aborted.");
    this.name = "HistoricalCandlesAbortedError";
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HistoricalCandlesAbortedError();
}

function gapWarnings(
  candles: HistoricalCandle[],
  intervalMs: number,
  session: ReturnType<typeof sessionConfiguration>,
): string[] {
  const warnings: string[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = Date.parse(candles[index - 1].source_time);
    const current = Date.parse(candles[index].source_time);
    if (current - previous <= intervalMs * 1.5) continue;

    let missingDuringSession = session.kind === "ALL";
    if (session.kind === "REGULAR") {
      const previousDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: session.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(previous));
      const currentDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: session.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(current));
      missingDuringSession = previousDate === currentDate;
    }
    if (!missingDuringSession) {
      const checks = Math.min(
        Math.ceil((current - previous) / intervalMs) - 1,
        10_000,
      );
      for (let step = 1; step <= checks; step += 1) {
        const candidate = previous + step * intervalMs;
        if (candidate >= current) break;
        if (isWithinSession(candidate, session)) {
          missingDuringSession = true;
          break;
        }
      }
    }
    if (missingDuringSession) {
      warnings.push(
        `MISSING_BAR_GAP:${candles[index - 1].source_time}/${candles[index].source_time}`,
      );
    }
  }
  return warnings;
}

export function edgeCoverageWarnings(
  candles: HistoricalCandle[],
  requestedStart: number,
  requestedEnd: number,
  intervalMs: number,
): string[] {
  if (candles.length === 0) return [];
  const warnings: string[] = [];
  const first = Date.parse(candles[0].source_time);
  const last = Date.parse(candles.at(-1)!.source_time);
  if (first - requestedStart > intervalMs * 1.5) {
    warnings.push("REQUEST_START_NOT_COVERED_BY_SOURCE_BARS");
  }
  if (requestedEnd - last > intervalMs * 1.5) {
    warnings.push("REQUEST_END_NOT_COVERED_BY_SOURCE_BARS");
  }
  return warnings;
}

export class TastytradeHistoricalCandlesClient {
  private readonly quoteTokens: DxlinkQuoteTokenProvider;

  constructor(
    oauth: TastytradeAccessTokenProvider = new TastytradeOAuthClient(),
    http: AxiosInstance = axios.create({
      baseURL: OAUTH_BASE_URL,
      timeout: 30_000,
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
    }),
    private readonly socketFactory: DxlinkSocketFactory = (url) =>
      new WebSocket(url) as unknown as DxlinkSocket,
    private readonly clock: () => number = () => Date.now(),
    quoteTokens?: DxlinkQuoteTokenProvider,
  ) {
    assertTrustedHosts();
    this.quoteTokens =
      quoteTokens ??
      new TastytradeDxlinkTokenClient(
        oauth,
        http,
        this.clock,
      );
  }

  async getHistoricalCandles(
    input: HistoricalCandlesInput,
  ): Promise<HistoricalCandlesResult> {
    const [result] = await this.getHistoricalCandlesBatch({
      instruments: [
        {
          symbol: input.symbol,
          streamer_symbol: input.streamer_symbol,
          instrument_type: input.instrument_type,
          lifecycle: input.lifecycle,
        },
      ],
      interval: input.interval,
      price_type: input.price_type,
      start_time: input.start_time,
      end_time: input.end_time,
      session: input.session,
      resolution_profile: input.resolution_profile,
      deadline_ms: input.deadline_ms,
      max_output_candles: input.max_output_candles,
      max_received_events: input.max_received_events,
      max_buffer_bytes: input.max_buffer_bytes,
      timeout_ms: input.timeout_ms,
      max_candles: input.max_candles,
      evidence_cache: input.evidence_cache,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return result;
  }

  async getHistoricalCandlesBatch(
    input: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]> {
    assertNotAborted(input.signal);
    if (
      input.evidence_cache &&
      input.evidence_cache.mode !== "BYPASS"
    ) {
      throw new Error(
        "Evidence cache modes require CachedHistoricalCandlesService.",
      );
    }
    if (
      !Array.isArray(input.instruments) ||
      input.instruments.length < 1 ||
      input.instruments.length > 100
    ) {
      throw new Error("instruments must contain between 1 and 100 items.");
    }
    const instruments = input.instruments.map((instrument, index) => {
      const symbol = instrument.symbol.trim().toUpperCase();
      const streamerSymbol = (
        instrument.streamer_symbol ?? symbol
      ).trim();
      if (!symbol || !streamerSymbol) {
        throw new Error(
          `instruments[${index}].symbol and streamer_symbol must be non-empty.`,
        );
      }
      if (/[{}]/.test(streamerSymbol)) {
        throw new Error(
          `instruments[${index}].streamer_symbol must not include Candle interval attributes.`,
        );
      }
      return {
        symbol,
        streamerSymbol,
        instrumentType: instrument.instrument_type,
      };
    });
    const interval = input.interval.trim();
    const priceType = normalizeHistoricalCandlePriceType(input.price_type);
    const intervalMs = intervalMilliseconds(interval);
    const providerPeriod = canonicalCandlePeriod(interval);
    const start = normalizeTimestamp(input.start_time, "start_time");
    const end = normalizeTimestamp(input.end_time, "end_time");
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (endMs <= startMs) throw new Error("end_time must be later than start_time.");

    const budgets = normalizeBudgets(input);
    const requestedWindowCandleSlots =
      Math.ceil((endMs - startMs) / intervalMs) + 1;
    const continuousCalendarReplaySlots = Math.max(
      0,
      Math.ceil((this.clock() - startMs) / intervalMs) + 1,
    );
    const directSession = resolutionSession(input.session);
    const normalizedProfile = normalizeResolutionProfile(
      input.resolution_profile,
      {
        default_requested_aggregation: interval,
        default_max_observation_age_minutes: 0,
        default_max_temporal_skew_minutes: 0,
        default_fallback_aggregations: [],
        default_profile_id: "DIRECT_CANDLE_REQUEST",
        direct_session: directSession,
        direct_alignment:
          directSession.kind === "ALL" ? "MIDNIGHT" : "SESSION",
      },
    );
    if (
      input.resolution_profile &&
      normalizedProfile.requested_aggregation !== interval.toLowerCase() &&
      !normalizedProfile.fallback_policy.aggregations.includes(
        interval.toLowerCase(),
      )
    ) {
      throw new Error(
        `interval must match the requested aggregation or an allowed fallback in resolution_profile ${normalizedProfile.profile_id}.`,
      );
    }
    if (
      input.resolution_profile &&
      input.session &&
      !sameSession(directSession, normalizedProfile.session)
    ) {
      throw new Error(
        "session must match the selected resolution_profile session.",
      );
    }
    const effectiveProfile = withEffectiveAggregation(
      normalizedProfile,
      interval.toLowerCase(),
    );
    const session = sessionConfiguration(candleSession(effectiveProfile));
    const rthDaily = providerPeriod === "d" && session.kind === "REGULAR";
    const coverageNow = this.clock();
    const calendarPlans: (RthCalendarPlan | null)[] = instruments.map((instrument) =>
      rthDaily && ["EQUITY", "INDEX"].includes(instrument.instrumentType)
        ? planRthSessions(instrument.symbol, instrument.streamerSymbol,
            instrument.instrumentType, session.timezone, startMs, endMs, coverageNow)
        : null,
    );
    const calendarDailyRequest = calendarPlans.some((plan) => plan !== null);
    const priceAttribute =
      priceType === "LAST" ? "" : `,price=${priceType.toLowerCase()}`;
    const candleSymbols = instruments.map((instrument) =>
      session.kind === "REGULAR"
        ? `${instrument.streamerSymbol}{=${providerPeriod}${priceAttribute},a=s,tho=true}`
        : `${instrument.streamerSymbol}{=${providerPeriod}${priceAttribute}}`,
    );
    const canonicalCandleSymbols = candleSymbols.map(
      canonicalizeDxlinkCandleSymbol,
    );
    if (
      new Set(canonicalCandleSymbols).size !==
      canonicalCandleSymbols.length
    ) {
      throw new Error("instruments must have unique streamer_symbol values.");
    }
    const recoveryDiagnostics = instruments.map(() => ({
      attempts: 0,
      maximum_attempts: 4,
      recovered_session_dates: [] as string[],
      failures: [] as HistoricalCandlesFailureReason[],
      stopped_reason: null as string | null,
      initial_windows: [] as NonNullable<HistoricalCandlesResult["recovery_diagnostics"]>["initial_windows"],
      windows: [] as NonNullable<HistoricalCandlesResult["recovery_diagnostics"]>["windows"],
    }));
    const reserveRecoveryTime = budgets.deadlineMs >= 20 &&
      calendarPlans.some((plan) => plan?.supported && plan.sessions.length >= 30);
    let snapshotDeadlineAt: number | null = null;
    let snapshotStartedAt: number | null = null;
    const deadlineRemaining = () => Math.max(0, Math.min(
      snapshotDeadlineAt! - this.clock(),
      budgets.deadlineMs - (performance.now() - snapshotStartedAt!),
    ));
    let retainedSnapshot: SnapshotReadResult | null = null;
    let initialInterrupted = false;
    let attempts = 0;
    let resumeIndex = 0;
    let interruptedWindow: RthCalendarPlan["sessions"] | null = null;
    let authRefreshDeadlineExpired = false;
    const quoteTokens: DxlinkQuoteTokenProvider = calendarDailyRequest ? {
      invalidateQuoteToken: () => this.quoteTokens.invalidateQuoteToken?.(),
      getQuoteToken: async (signal, request) => {
        if (!request?.forceRefresh) return this.quoteTokens.getQuoteToken(signal, request);
        assertNotAborted(signal);
        const remaining = deadlineRemaining();
        const timeout = () => {
          authRefreshDeadlineExpired = true;
          return new Error("Historical candle authentication refresh exceeded the original deadline.");
        };
        if (remaining < 1) throw timeout();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        const interrupted = new Promise<never>((_, reject) => {
          abort = () => {
            const error = new HistoricalCandlesAbortedError();
            reject(error);
            controller.abort(error);
          };
          signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => {
            const error = timeout();
            reject(error);
            controller.abort(error);
          }, remaining);
        });
        try {
          // Race only acquisition: a late provider cannot resume snapshot processing.
          return await Promise.race([
            Promise.resolve().then(() => {
              assertNotAborted(signal);
              return this.quoteTokens.getQuoteToken(controller.signal, request);
            }),
            interrupted,
          ]);
        } finally {
          clearTimeout(timer);
          if (abort) signal?.removeEventListener("abort", abort);
        }
      },
    } : this.quoteTokens;
    const recovery = await withDxlinkAuthRecovery(
      quoteTokens,
      async (quoteToken) => {
        assertNotAborted(input.signal);
        const now = this.clock();
        snapshotDeadlineAt ??= now + budgets.deadlineMs;
        snapshotStartedAt ??= performance.now();
        if (initialInterrupted && retainedSnapshot &&
            (deadlineRemaining() < 1 ||
              retainedSnapshot.requestCounters.received_events >= budgets.maxReceivedEvents ||
              retainedSnapshot.requestCounters.retained_bytes >= budgets.maxBufferBytes)) {
          for (const [index, state] of [...retainedSnapshot.symbolStates.values()].entries()) {
            if (state.providerComplete || state.providerSnipped || state.localFailureReason) continue;
            recoveryDiagnostics[index].failures.push("AUTH_FAILED");
            recoveryDiagnostics[index].stopped_reason = "SHARED_RESOURCE_BUDGET_EXHAUSTED";
          }
          return retainedSnapshot;
        }
        let snapshot = retainedSnapshot;
        if (!snapshot || initialInterrupted) {
          const reconnecting = initialInterrupted;
          const previousEvents = new Map(
            [...(snapshot?.symbolStates.values() ?? [])]
              .map((state) => [state.candleSymbol, state.counters.received_events]),
          );
          let authenticationError: SnapshotAuthenticationError | null = null;
          try {
            const remainingInitialTime = Math.min(deadlineRemaining(),
              reserveRecoveryTime ? Math.floor(budgets.deadlineMs * 0.75) : budgets.deadlineMs);
            snapshot = await this.readSnapshot({
              quoteToken, candleSymbols, startMs, endMs, session,
              budgets: {
                ...budgets,
                deadlineMs: calendarDailyRequest ? remainingInitialTime : Math.max(1, remainingInitialTime),
              },
              signal: input.signal,
              rthDaily: calendarDailyRequest,
              preserveFailureSnapshot: calendarDailyRequest,
              ...(reconnecting ? { retainedSnapshot: snapshot! } : {}),
            });
          } catch (error) {
            assertNotAborted(input.signal);
            if (error instanceof SnapshotAuthenticationError) {
              snapshot = error.snapshot;
              authenticationError = error;
            } else if (error instanceof SnapshotReadError) {
              snapshot = error.snapshot;
            } else {
              throw error;
            }
          }
          retainedSnapshot = snapshot;
          if (authenticationError || reconnecting) {
            for (const [index, state] of [...snapshot.symbolStates.values()].entries()) {
              if (reconnecting && (state.providerComplete || state.providerSnipped || state.localFailureReason) &&
                  state.counters.received_events === previousEvents.get(state.candleSymbol)) continue;
              recoveryDiagnostics[index].initial_windows.push({
                start, end, provider_snapshot_complete: state.providerComplete,
                failure_reason: state.localFailureReason ?? (state.providerSnipped ? "PROVIDER_SNAPSHOT_SNIPPED" : null) ??
                  (state.providerComplete ? null : snapshot.requestFailureReason),
                timeout_stage: snapshot.timeoutStage,
                failure_stage: state.providerComplete ? null
                  : authenticationError ? "AUTHENTICATING" : snapshot.timeoutStage,
                received_events: state.counters.received_events - (previousEvents.get(state.candleSymbol) ?? 0),
              });
            }
          }
          initialInterrupted = authenticationError !== null;
          if (authenticationError) throw authenticationError;
        }
        retainedSnapshot = snapshot;
        for (const [index, plan] of calendarPlans.entries()) {
          if (index < resumeIndex) continue;
          if (!plan?.supported) continue;
          const resuming = index === resumeIndex && interruptedWindow !== null;
          const state = snapshot.symbolStates.get(candleSymbols[index])!;
          const diagnostic = recoveryDiagnostics[index];
          const observed = new Set([...state.candlesByIndex.values()]
            .map(({ candle }) => candle.timestamp));
          const missing = plan.sessions.filter((candidate) => !observed.has(candidate.open));
          if (missing.length === 0 && !resuming) continue;
          if ((!snapshot.authConfirmed && !resuming) || state.localFailureReason || state.providerSnipped ||
              (snapshot.requestFailureReason === "SNAPSHOT_TIMEOUT" && !reserveRecoveryTime) ||
              (snapshot.requestFailureReason && !["SNAPSHOT_TIMEOUT", "PROVIDER_TEMPORARY_FAILURE"]
                .includes(snapshot.requestFailureReason))) {
            diagnostic.stopped_reason = "INITIAL_RESOURCE_OR_TRANSPORT_FAILURE";
            continue;
          }
          const remainingTime = deadlineRemaining();
          const remainingEvents = budgets.maxReceivedEvents - snapshot.requestCounters.received_events;
          const remainingBytes = budgets.maxBufferBytes - snapshot.requestCounters.retained_bytes;
          const remainingRows = budgets.maxOutputCandles - state.candlesByIndex.size;
          if (attempts >= 4 || remainingTime < 1 || remainingEvents <= 0 ||
              remainingBytes <= 0 || (remainingRows <= 0 && !resuming)) {
            diagnostic.stopped_reason = attempts >= 4 ? "RECOVERY_ATTEMPT_LIMIT" : "SHARED_RESOURCE_BUDGET_EXHAUSTED";
            if (resuming) diagnostic.failures.push("AUTH_FAILED");
            continue;
          }
          // Refresh resumes this window, never the initial batch or its budgets.
          const firstMissing = plan.sessions.indexOf(missing[0]);
          const window = resuming ? interruptedWindow! : [];
          if (!resuming) {
            for (const candidate of plan.sessions.slice(firstMissing, firstMissing + 5)) {
              if (observed.has(candidate.open)) break;
              window.push(candidate);
            }
          }
          attempts += 1;
          diagnostic.attempts += 1;
          let retry: SnapshotReadResult;
          let authenticationError: SnapshotAuthenticationError | null = null;
          try {
            retry = await this.readSnapshot({
              quoteToken,
              candleSymbols: [state.candleSymbol],
              startMs: window[0].open,
              endMs: window.at(-1)!.close,
              session,
              budgets: { ...budgets, deadlineMs: Math.max(1, Math.floor(remainingTime)),
                maxReceivedEvents: remainingEvents, maxBufferBytes: remainingBytes,
                maxOutputCandles: remainingRows },
              signal: input.signal,
              rthDaily: calendarDailyRequest,
              preserveFailureSnapshot: true,
              ...(resuming ? { excludedTimestamps: observed } : {}),
            });
          } catch (error) {
            assertNotAborted(input.signal);
            if (error instanceof SnapshotAuthenticationError) {
              retry = error.snapshot;
              authenticationError = error;
            } else if (error instanceof SnapshotReadError) {
              retry = error.snapshot;
            } else {
              throw error;
            }
          }
          const retryState = retry.symbolStates.get(state.candleSymbol)!;
          state.oldestReceivedTimestamp = [state.oldestReceivedTimestamp, retryState.oldestReceivedTimestamp]
            .filter((value): value is number => value !== null)
            .reduce<number | null>((oldest, value) => oldest === null ? value : Math.min(oldest, value), null);
          state.newestReceivedTimestamp = [state.newestReceivedTimestamp, retryState.newestReceivedTimestamp]
            .filter((value): value is number => value !== null)
            .reduce<number | null>((newest, value) => newest === null ? value : Math.max(newest, value), null);
          const allowedTimes = new Set(window.map((candidate) => candidate.open));
          for (const [key, retained] of retryState.candlesByIndex) {
            if (!allowedTimes.has(retained.candle.timestamp)) continue;
            if (state.candlesByIndex.has(key)) {
              diagnostic.failures.push("PROVIDER_SCHEMA_MISMATCH");
            } else {
              state.candlesByIndex.set(key, retained);
              diagnostic.recovered_session_dates.push(rthDate(retained.candle.timestamp));
            }
          }
          for (const date of retryState.receivedSessionDates) state.receivedSessionDates.add(date);
          for (const symbol of retryState.receivedSymbols) state.receivedSymbols.add(symbol);
          for (const symbol of retryState.canonicalReceivedSymbols) state.canonicalReceivedSymbols.add(symbol);
          state.snapshotBeginSeen ||= retryState.snapshotBeginSeen;
          state.snapshotEndSeen ||= retryState.snapshotEndSeen;
          state.snapshotSnipSeen ||= retryState.snapshotSnipSeen;
          for (const key of Object.keys(state.pipeline) as (keyof typeof state.pipeline)[]) {
            state.pipeline[key] += retryState.pipeline[key];
          }
          const originalRetainedBytes = snapshot.requestCounters.retained_bytes;
          for (const key of Object.keys(emptyResourceCounters()) as (keyof HistoricalCandlesResourceCounters)[]) {
            snapshot.requestCounters[key] += retry.requestCounters[key];
            state.counters[key] += retryState.counters[key];
          }
          snapshot.requestCounters.peak_buffer_bytes = Math.max(
            snapshot.requestCounters.peak_buffer_bytes,
            originalRetainedBytes + retry.requestCounters.peak_buffer_bytes,
          );
          snapshot.requestCounters.unmatched_received_events += retry.requestCounters.unmatched_received_events;
          snapshot.unmatchedSymbols = [...new Set([...snapshot.unmatchedSymbols, ...retry.unmatchedSymbols])];
          snapshot.requestCounters.unmatched_symbol_count = snapshot.unmatchedSymbols.length;
          const failure = retryState.localFailureReason ?? retry.requestFailureReason ??
            (retryState.providerSnipped ? "PROVIDER_SNAPSHOT_SNIPPED" : null);
          diagnostic.windows.push({
            start: new Date(window[0].open).toISOString(),
            end: new Date(window.at(-1)!.close).toISOString(),
            provider_snapshot_complete: retryState.providerComplete,
            failure_reason: failure,
            timeout_stage: retry.timeoutStage,
            received_events: retry.requestCounters.received_events,
          });
          if (authenticationError) {
            snapshot.authConfirmed = false;
            resumeIndex = index;
            interruptedWindow = window;
            diagnostic.stopped_reason = "AUTHENTICATION_REFRESH_REQUIRED";
            throw authenticationError;
          }
          if (resuming) snapshot.authConfirmed = retry.authConfirmed;
          interruptedWindow = null;
          resumeIndex = index + 1;
          if (failure) {
            diagnostic.failures.push(failure);
            if (failure === "SNAPSHOT_TIMEOUT") diagnostic.failures.push("PROVIDER_TIMEOUT");
          }
          diagnostic.stopped_reason = missing.length > window.length
            ? "RECOVERY_WINDOW_LIMIT" : "ONE_RETRY_PER_SYMBOL";
        }
        return snapshot;
      },
      input.signal,
    ).catch((error: unknown): DxlinkAuthRecoveryResult<SnapshotReadResult> => {
      assertNotAborted(input.signal);
      if (!(error instanceof DxlinkAuthFailedError) || !retainedSnapshot ||
          (!interruptedWindow && !initialInterrupted)) {
        throw error;
      }
      const failedIndices = initialInterrupted
        ? [...retainedSnapshot.symbolStates.values()].flatMap((state, index) =>
            state.providerComplete || state.providerSnipped || state.localFailureReason ? [] : [index])
        : [resumeIndex];
      for (const index of failedIndices) {
        recoveryDiagnostics[index].failures.push("AUTH_FAILED");
        if (authRefreshDeadlineExpired) {
          recoveryDiagnostics[index].failures.push("SNAPSHOT_TIMEOUT", "PROVIDER_TIMEOUT");
        }
        recoveryDiagnostics[index].stopped_reason = authRefreshDeadlineExpired
          ? "AUTH_REFRESH_DEADLINE_EXHAUSTED" : "AUTH_FAILED_PRESERVED_COMMITTED_BARS";
      }
      if (authRefreshDeadlineExpired && initialInterrupted) {
        retainedSnapshot.requestFailureReason = "SNAPSHOT_TIMEOUT";
        retainedSnapshot.timeoutStage = "AUTHENTICATING";
      }
      return {
        value: retainedSnapshot,
        dxlinkAuth: error.dxlinkAuth,
        providerError: error.providerError,
      };
    });
    const snapshot = recovery.value;
    const dxlinkAuth: DxlinkAuthDiagnostics = snapshot.authConfirmed || recovery.dxlinkAuth.status === "FAILED"
      ? recovery.dxlinkAuth
      : {
          ...recovery.dxlinkAuth,
          status: "NOT_CONFIRMED",
        };
    const retrievedAt = new Date(this.clock()).toISOString();
    const requestId = stableRequestId({
      instruments,
      interval,
      ...(priceType === "LAST" ? {} : { price_type: priceType }),
      start,
      end,
      resolution_profile: normalizedProfile,
      ...(calendarDailyRequest
        ? { rth_daily_coverage_version: RTH_CALENDAR_VERSION } : {}),
      budgets: {
        max_output_candles: budgets.maxOutputCandles,
        max_received_events: budgets.maxReceivedEvents,
        max_buffer_bytes: budgets.maxBufferBytes,
        deadline_ms: budgets.deadlineMs,
      },
    });

    const prepared = instruments.map((instrument, instrumentIndex) => {
      const candleSymbol = candleSymbols[instrumentIndex];
      const state = snapshot.symbolStates.get(candleSymbol)!;
      const calendarPlan = calendarPlans[instrumentIndex];
      const filtered = [...state.candlesByIndex.values()]
        .map((retained) => retained.candle)
        .sort((left, right) => left.timestamp - right.timestamp);
      const timestampCounts = new Map<number, number>();
      if (calendarPlan) {
        for (const candle of filtered) timestampCounts.set(
          candle.timestamp, (timestampCounts.get(candle.timestamp) ?? 0) + 1,
        );
      }
      const eligible = calendarPlan ? filtered.filter((candle) => {
        const bounds = calendarPlan.supported ? rthSession(rthDate(candle.timestamp)) : null;
        if (!bounds || candle.timestamp !== bounds.open) {
          state.pipeline.unverified_daily_times += 1;
          return false;
        }
        if (timestampCounts.get(candle.timestamp)! > 1) {
          state.pipeline.unverified_daily_times += 1;
          return false;
        }
        if (bounds.close > Math.min(endMs, coverageNow)) {
          state.pipeline.unfinished_daily_rows += 1;
          return false;
        }
        return true;
      }) : filtered;
      const candles: HistoricalCandle[] = eligible.map((candle) => {
        const barStart = new Date(candle.timestamp).toISOString();
        const sessionBounds = calendarPlan?.supported ? rthSession(rthDate(candle.timestamp)) : null;
        const barEnd = new Date(sessionBounds?.close ?? candle.timestamp + intervalMs).toISOString();
        return {
          source_time: barStart,
          bar_start: barStart,
          bar_end: barEnd,
          available_at: barEnd,
          retrieved_at: retrievedAt,
          open: candle.open!,
          high: candle.high!,
          low: candle.low!,
          close: candle.close!,
          volume: candle.volume,
          vwap: candle.vwap,
          bid_volume: candle.bidVolume,
          ask_volume: candle.askVolume,
          implied_volatility: candle.impliedVolatility,
          open_interest: candle.openInterest,
          ...(sessionBounds ? { session_timing: {
            calendar_id: RTH_CALENDAR_VERSION, session_date: sessionBounds.date,
          } } : {}),
        };
      });
      const expectedDates = calendarPlan?.sessions.map((candidate) => candidate.date) ?? [];
      const observedDates = [...new Set(candles.map((candle) => rthDate(Date.parse(candle.source_time))))];
      const missingDates = expectedDates.filter((date) => !observedDates.includes(date));
      const coverageWarnings = calendarPlan ? [] : edgeCoverageWarnings(
        candles,
        startMs,
        endMs,
        intervalMs,
      );
      const warnings = [
        ...(calendarPlan ? missingDates.map((date) => `CALENDAR_EXPECTED_SESSION_MISSING:${date}`)
          : gapWarnings(candles, intervalMs, session)),
        ...coverageWarnings,
        ...(calendarPlan?.reason ? [calendarPlan.reason] : []),
        ...(state.pipeline.unfinished_daily_rows ? ["UNFINISHED_RTH_DAILY_BAR_EXCLUDED"] : []),
        ...(priceType === "LAST"
          ? []
          : [
              "BID_ASK_CANDLE_AGGREGATES_NOT_SYNCHRONIZED_QUOTES",
              "BID_ASK_CANDLE_SIZES_UNAVAILABLE",
              "VALUATION_ONLY_NOT_EXECUTABLE",
            ]),
      ];
      const failureReasons: HistoricalCandlesFailureReason[] = [];
      const addFailureReason = (reason: HistoricalCandlesFailureReason) => {
        if (!failureReasons.includes(reason)) failureReasons.push(reason);
      };
      if (state.localFailureReason) {
        addFailureReason(state.localFailureReason);
      }
      const requestFailureApplied = Boolean(
        snapshot.requestFailureReason &&
          !state.providerComplete &&
          !state.providerSnipped &&
          !state.localFailureReason,
      );
      if (requestFailureApplied) {
        addFailureReason(snapshot.requestFailureReason!);
        if (snapshot.requestFailureReason === "SNAPSHOT_TIMEOUT") addFailureReason("PROVIDER_TIMEOUT");
      }
      if (calendarPlan && !calendarPlan.supported) addFailureReason("CALENDAR_UNSUPPORTED");
      if (calendarPlan && state.pipeline.unverified_daily_times > 0) addFailureReason("SOURCE_RTH_DAILY_TIME_UNVERIFIED");
      if (missingDates.length > 0) {
        addFailureReason("SOURCE_RTH_DAILY_MISSING");
        addFailureReason("CALENDAR_EXPECTED_SESSION_MISSING");
        if (state.providerComplete) addFailureReason("PROVIDER_COMPLETE_BUT_COVERAGE_PARTIAL");
      }
      for (const failure of recoveryDiagnostics[instrumentIndex].failures) addFailureReason(failure);
      if (state.providerSnipped) {
        addFailureReason("PROVIDER_SNAPSHOT_SNIPPED");
      }
      if (coverageWarnings.length > 0) {
        addFailureReason("REQUESTED_WINDOW_NOT_COVERED");
      }
      if (candles.length === 0) {
        addFailureReason("MISSING_CONTRACT_EVIDENCE");
      }
      if (session.kind === "CUSTOM") {
        warnings.push(
          "CUSTOM_SESSION_FILTERS_COMPLETE_SOURCE_BARS_WITHOUT_REAGGREGATION",
        );
      }
      if (state.providerSnipped) {
        warnings.push("DXLINK_SNAPSHOT_SNIPPED_NARROW_TIME_RANGE");
      }
      if (!state.providerComplete) {
        warnings.push("DXLINK_SNAPSHOT_END_NOT_OBSERVED");
      }
      if (candles.length === 0) {
        warnings.push("NO_CANDLES_IN_REQUESTED_RANGE_AND_SESSION");
      }
      if (budgets.maxCandlesCompatibilityApplied) {
        warnings.push("MAX_CANDLES_DEPRECATED_USE_EXPLICIT_BUDGETS");
      }
      if (budgets.timeoutMsCompatibilityApplied) {
        warnings.push("TIMEOUT_MS_DEPRECATED_USE_DEADLINE_MS");
      }
      for (const reason of failureReasons) {
        if (!warnings.includes(reason)) warnings.push(reason);
      }

      state.counters.returned_rows = candles.length;
      const snapshotComplete =
        state.providerComplete &&
        !state.providerSnipped &&
        !state.localFailureReason &&
        !requestFailureApplied;

      return {
        contract_version: "1.0.0" as const,
        request_id: requestId,
        status: snapshotComplete && failureReasons.length === 0
          ? ("AVAILABLE" as const)
          : candles.length > 0
            ? ("PARTIAL" as const)
            : ("NOT_AVAILABLE" as const),
        symbol: instrument.symbol,
        streamer_symbol: instrument.streamerSymbol,
        instrument_type: instrument.instrumentType,
        interval,
        price_type: priceType,
        evidence_class: "VALUATION_ONLY" as const,
        requested_range: { start, end },
        actual_range:
          candles.length === 0
            ? null
            : {
                start: candles[0].source_time,
                end: candles.at(-1)!.source_time,
              },
        timezone: session.timezone,
        session: session.kind,
        retrieved_at: retrievedAt,
        resolution_profile: effectiveProfile,
        source: "tastytrade-dxlink" as const,
        source_timestamp_unit: "epoch_milliseconds" as const,
        dxlink_auth: dxlinkAuth,
        provider_error: recovery.providerError,
        snapshot_complete: snapshotComplete,
        snapshot_truncated: state.providerSnipped,
        provider_snapshot_complete: state.providerComplete,
        session_coverage_complete: calendarPlan
          ? calendarPlan.supported && missingDates.length === 0 &&
            state.pipeline.unverified_daily_times === 0
          : null,
        ...(calendarPlan ? {
          expected_session_dates: expectedDates,
          observed_session_dates: observedDates,
          missing_session_dates: missingDates,
          missing_session_diagnostics: missingDates.map((date) => ({
            session_date: date,
            attribution: state.receivedSessionDates.has(date)
              ? "VALID_PROVIDER_ROW_NOT_RETURNED_LOCALLY" as const
              : "NO_VALID_CANONICAL_PROVIDER_ROW_OBSERVED" as const,
            provider_cause_confirmed: false as const,
          })),
          coverage_ratio: calendarPlan.supported
            ? expectedDates.length === 0 ? 1 : (expectedDates.length - missingDates.length) / expectedDates.length
            : null,
          session_coverage: {
            calendar_id: RTH_CALENDAR_VERSION,
            status: calendarPlan.supported ? "VERIFIED" as const : "UNSUPPORTED" as const,
            reason: calendarPlan.reason,
            evaluated_through: new Date(Math.min(endMs, coverageNow)).toISOString(),
            ma20_eligible: snapshotComplete && failureReasons.length === 0 &&
              calendarPlan.supported && expectedDates.length >= 20 &&
              expectedDates.slice(-20).every((date) => observedDates.includes(date)) &&
              state.pipeline.unverified_daily_times === 0,
            ma20_expected_session_dates: expectedDates.slice(-20),
          },
          recovery_diagnostics: recoveryDiagnostics[instrumentIndex],
        } : {}),
        failure_reasons: failureReasons,
        symbol_resource_usage: { ...state.counters },
        transport_diagnostics: {
          requested_symbol: state.candleSymbol,
          canonical_requested_symbol: state.canonicalSymbol,
          received_symbols: [...state.receivedSymbols].sort(),
          canonical_received_symbols: [
            ...state.canonicalReceivedSymbols,
          ].sort(),
          unmatched_received_symbols: snapshot.unmatchedSymbols,
          oldest_received_timestamp:
            state.oldestReceivedTimestamp === null
              ? null
              : new Date(
                  state.oldestReceivedTimestamp,
                ).toISOString(),
          newest_received_timestamp:
            state.newestReceivedTimestamp === null
              ? null
              : new Date(
                  state.newestReceivedTimestamp,
                ).toISOString(),
          snapshot_begin_seen: state.snapshotBeginSeen,
          snapshot_end_seen: state.snapshotEndSeen,
          snapshot_snip_seen: state.snapshotSnipSeen,
          timeout_stage: requestFailureApplied
            ? snapshot.timeoutStage
            : null,
          ...(calendarPlan ? {
            received_session_dates: [...state.receivedSessionDates].sort(),
            local_pipeline: state.pipeline,
          } : {}),
        },
        resampled: false as const,
        candles,
        warnings,
      };
    });

    const requestCounters = {
      ...snapshot.requestCounters,
      returned_rows: prepared.reduce(
        (total, result) => total + result.candles.length,
        0,
      ),
    };
    return prepared.map(({ symbol_resource_usage, ...result }) => ({
      ...result,
      resource_usage: {
        limits: {
          max_output_candles_per_symbol: budgets.maxOutputCandles,
          max_received_events_per_request: budgets.maxReceivedEvents,
          max_buffer_bytes_per_request: budgets.maxBufferBytes,
          deadline_ms_per_request: budgets.deadlineMs,
          max_candles_compatibility_applied:
            budgets.maxCandlesCompatibilityApplied,
          timeout_ms_compatibility_applied:
            budgets.timeoutMsCompatibilityApplied,
        },
        request: requestCounters,
        symbol: symbol_resource_usage,
      },
      advisory: {
        requested_window_candle_slots_per_symbol:
          requestedWindowCandleSlots,
        continuous_calendar_replay_slots_per_symbol:
          continuousCalendarReplaySlots,
        continuous_calendar_replay_is_provider_fact: false as const,
      },
    }));
  }

  private readSnapshot(input: {
    quoteToken: DxlinkQuoteToken;
    candleSymbols: string[];
    startMs: number;
    endMs: number;
    session: ReturnType<typeof sessionConfiguration>;
    budgets: HistoricalCandleBudgets;
    signal?: AbortSignal;
    rthDaily?: boolean;
    excludedTimestamps?: Set<number>;
    preserveFailureSnapshot?: boolean;
    retainedSnapshot?: SnapshotReadResult;
  }): Promise<SnapshotReadResult> {
    assertNotAborted(input.signal);
    return new Promise((resolve, reject) => {
      const symbolStates = input.retainedSnapshot?.symbolStates ?? new Map<string, SnapshotSymbolState>(
        input.candleSymbols.map((candleSymbol) => [
          candleSymbol,
          {
            candleSymbol,
            canonicalSymbol:
              canonicalizeDxlinkCandleSymbol(candleSymbol),
            candlesByIndex: new Map(),
            seenIndices: new Set(),
            receivedSymbols: new Set(),
            canonicalReceivedSymbols: new Set(),
            oldestReceivedTimestamp: null,
            newestReceivedTimestamp: null,
            snapshotBeginSeen: false,
            snapshotEndSeen: false,
            snapshotSnipSeen: false,
            pendingTransactionEvents: [],
            snapshotDataBytes: 0,
            providerComplete: false,
            providerSnipped: false,
            localFailureReason: null,
            counters: emptyResourceCounters(),
            receivedSessionDates: new Set<string>(),
            pipeline: {
              invalid_candle_events: 0, outside_request_or_session: 0,
              replaced_indices: 0, removed_indices: 0, snapshot_resets: 0,
              unverified_daily_times: 0, unfinished_daily_rows: 0,
            },
          },
        ]),
      );
      const protectedData = new Map((input.retainedSnapshot ? [...symbolStates.values()] : []).map((state) => [
        state.candleSymbol, {
          candles: new Map(state.candlesByIndex),
          indices: new Set(state.seenIndices),
          unique: state.counters.unique_observations,
          rows: state.counters.retained_rows,
        },
      ]));
      if (input.retainedSnapshot) {
        for (const state of symbolStates.values()) {
          // Uncommitted transactions cannot cross sockets; their memory stays charged.
          state.pendingTransactionEvents = [];
          state.snapshotDataBytes = 0;
        }
      }
      const symbolStatesByCanonical = new Map(
        [...symbolStates.values()].map((state) => [
          state.canonicalSymbol,
          state,
        ]),
      );
      const unmatchedSymbols = new Map<string, number>(
        input.retainedSnapshot?.unmatchedSymbols.map((symbol) => [symbol, 0]),
      );
      const requestCounters = input.retainedSnapshot?.requestCounters ?? {
        ...emptyResourceCounters(),
        unmatched_received_events: 0,
        unmatched_symbol_count: 0,
        peak_buffer_bytes: 0,
      };
      const activeSymbols = new Set(input.candleSymbols.filter((symbol) =>
        !symbolStates.get(symbol)!.providerComplete &&
        !symbolStates.get(symbol)!.providerSnipped &&
        !symbolStates.get(symbol)!.localFailureReason));
      let subscribed = false;
      let settled = false;
      let retainedBytes = requestCounters.retained_bytes;
      let pendingMessageBytes = 0;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      let abortListener: (() => void) | null = null;
      let messageQueue = Promise.resolve();
      let stage: HistoricalCandlesTimeoutStage = "CONNECTING";
      let authSent = false;
      let authConfirmed = false;
      let socket: DxlinkSocket;
      try {
        socket = this.socketFactory(input.quoteToken.url);
      } catch (error) {
        reject(input.preserveFailureSnapshot ? new SnapshotReadError({
          symbolStates, authConfirmed, requestCounters,
          requestFailureReason: "PROVIDER_TEMPORARY_FAILURE",
          unmatchedSymbols: [], timeoutStage: null,
        }) : error);
        return;
      }

      const send = (message: Record<string, unknown>) => {
        socket.send(JSON.stringify(message));
      };
      const unsubscribe = (symbols: string[]) => {
        if (!subscribed || socket.readyState !== DXLINK_OPEN) return;
        const removable = symbols.filter((symbol) =>
          activeSymbols.has(symbol),
        );
        if (removable.length === 0) return;
        send({
          type: "FEED_SUBSCRIPTION",
          channel: 3,
          remove: removable.map((symbol) => ({
            type: "Candle",
            symbol,
          })),
        });
        for (const symbol of removable) activeSymbols.delete(symbol);
      };
      const cleanup = () => {
        if (deadline) clearTimeout(deadline);
        if (keepalive) clearInterval(keepalive);
        if (abortListener) {
          input.signal?.removeEventListener("abort", abortListener);
        }
        unsubscribe([...activeSymbols]);
        if (socket.readyState === DXLINK_OPEN) {
          socket.close(1000, "historical snapshot stopped");
        }
      };
      const snapshotResult = (
        requestFailureReason: HistoricalCandlesFailureReason | null,
      ): SnapshotReadResult => ({
        symbolStates,
        authConfirmed,
        requestFailureReason,
        requestCounters,
        unmatchedSymbols: [...unmatchedSymbols.keys()].sort(),
        timeoutStage:
          requestFailureReason === "SNAPSHOT_TIMEOUT" ? stage : null,
      });
      const finish = (
        requestFailureReason: HistoricalCandlesFailureReason | null,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(snapshotResult(requestFailureReason));
      };
      const fail = (error: Error, preservePartial = true) => {
        if (settled) return;
        if (preservePartial && subscribed && authConfirmed) {
          finish("PROVIDER_TEMPORARY_FAILURE");
          return;
        }
        settled = true;
        cleanup();
        if (error instanceof HistoricalCandlesAbortedError || !input.preserveFailureSnapshot) {
          reject(error);
        } else if (error instanceof DxlinkAuthenticationError) {
          authConfirmed = false;
          reject(new SnapshotAuthenticationError(snapshotResult("AUTH_FAILED")));
        } else {
          reject(new SnapshotReadError(snapshotResult("PROVIDER_TEMPORARY_FAILURE")));
        }
      };
      abortListener = () => fail(new HistoricalCandlesAbortedError(), false);
      input.signal?.addEventListener("abort", abortListener, {
        once: true,
      });
      const isTerminal = (state: SnapshotSymbolState) =>
        state.providerComplete ||
        state.providerSnipped ||
        state.localFailureReason !== null;
      const finishIfTerminal = () => {
        if ([...symbolStates.values()].every(isTerminal)) {
          finish(null);
        }
      };
      const recordPeakBuffer = (bytes: number) => {
        requestCounters.peak_buffer_bytes = Math.max(
          requestCounters.peak_buffer_bytes,
          bytes,
        );
      };
      const reserveDiagnosticBytes = (
        state: SnapshotSymbolState | null,
        value: string,
      ): number | null => {
        const bytes = retainedIndexBytes(value);
        const attemptedBufferBytes =
          retainedBytes + pendingMessageBytes + bytes;
        recordPeakBuffer(attemptedBufferBytes);
        if (attemptedBufferBytes > input.budgets.maxBufferBytes) {
          finish("LOCAL_BUFFER_BUDGET_EXCEEDED");
          return null;
        }
        if (state) state.counters.retained_bytes += bytes;
        requestCounters.retained_bytes += bytes;
        retainedBytes += bytes;
        return bytes;
      };
      const retainReceivedSymbol = (
        state: SnapshotSymbolState,
        symbols: Set<string>,
        value: string,
      ): boolean => {
        if (symbols.has(value)) return true;
        if (reserveDiagnosticBytes(state, value) === null) return false;
        symbols.add(value);
        return true;
      };
      const retainUnmatchedSymbol = (value: string): boolean => {
        if (unmatchedSymbols.has(value)) return true;
        const bytes = reserveDiagnosticBytes(null, value);
        if (bytes === null) return false;
        unmatchedSymbols.set(value, bytes);
        requestCounters.unmatched_symbol_count = unmatchedSymbols.size;
        return true;
      };
      const removeRetainedCandle = (
        state: SnapshotSymbolState,
        index: string,
      ) => {
        if (input.retainedSnapshot && protectedData.get(state.candleSymbol)!.candles.has(index)) return;
        const retained = state.candlesByIndex.get(index);
        if (!retained) return;
        state.pipeline.removed_indices += 1;
        state.candlesByIndex.delete(index);
        state.counters.retained_rows -= 1;
        state.counters.retained_bytes -= retained.bytes;
        requestCounters.retained_rows -= 1;
        requestCounters.retained_bytes -= retained.bytes;
        retainedBytes -= retained.bytes;
        state.snapshotDataBytes -= retained.bytes;
      };
      const resetSnapshotData = (state: SnapshotSymbolState) => {
        state.pipeline.snapshot_resets += 1;
        const protectedState = input.retainedSnapshot ? protectedData.get(state.candleSymbol)! : null;
        const removedUnique = state.counters.unique_observations - (protectedState?.unique ?? 0);
        const removedRows = state.counters.retained_rows - (protectedState?.rows ?? 0);
        requestCounters.unique_observations -=
          removedUnique;
        requestCounters.retained_rows -= removedRows;
        requestCounters.retained_bytes -= state.snapshotDataBytes;
        state.counters.retained_bytes -= state.snapshotDataBytes;
        retainedBytes -= state.snapshotDataBytes;
        state.candlesByIndex.clear();
        state.seenIndices.clear();
        for (const [key, value] of protectedState?.candles ?? []) state.candlesByIndex.set(key, value);
        for (const key of protectedState?.indices ?? []) state.seenIndices.add(key);
        state.counters.unique_observations = protectedState?.unique ?? 0;
        state.counters.retained_rows = protectedState?.rows ?? 0;
        state.counters.returned_rows = 0;
        state.snapshotDataBytes = 0;
        state.providerComplete = false;
        state.providerSnipped = false;
      };
      const retainCandle = (
        state: SnapshotSymbolState,
        candle: RawCandle,
      ) => {
        if (
          candle.timestamp < input.startMs ||
          candle.timestamp > input.endMs ||
          !isWithinSession(candle.timestamp, input.session)
        ) {
          state.pipeline.outside_request_or_session += 1;
          return;
        }
        if (input.excludedTimestamps?.has(candle.timestamp)) return;
        if (input.retainedSnapshot) {
          const protectedCandles = protectedData.get(state.candleSymbol)!.candles;
          const earlier = protectedCandles.get(candle.index);
          const sameTimestamp = [...protectedCandles.values()].find(
            (value) => value.candle.timestamp === candle.timestamp,
          );
          if ((earlier && earlier.candle.timestamp !== candle.timestamp) ||
              (sameTimestamp && sameTimestamp.candle.index !== candle.index)) {
            state.localFailureReason = "PROVIDER_SCHEMA_MISMATCH";
            return;
          }
          if (earlier) return;
        }
        const existing = state.candlesByIndex.get(candle.index);
        if (existing) state.pipeline.replaced_indices += 1;
        if (
          !existing &&
          state.candlesByIndex.size >=
            input.budgets.maxOutputCandles
        ) {
          state.localFailureReason = "LOCAL_OUTPUT_BUDGET_EXCEEDED";
          return;
        }

        const candleBytes = retainedCandleBytes(candle);
        const newIndex = !state.seenIndices.has(candle.index);
        const indexBytes = newIndex
          ? retainedIndexBytes(candle.index)
          : 0;
        const candleByteDelta = candleBytes - (existing?.bytes ?? 0);
        const additionalBytes =
          indexBytes + Math.max(0, candleByteDelta);
        const attemptedBufferBytes =
          retainedBytes + pendingMessageBytes + additionalBytes;
        recordPeakBuffer(attemptedBufferBytes);
        if (attemptedBufferBytes > input.budgets.maxBufferBytes) {
          finish("LOCAL_BUFFER_BUDGET_EXCEEDED");
          return;
        }

        if (newIndex) {
          state.seenIndices.add(candle.index);
          state.counters.unique_observations += 1;
          state.counters.retained_bytes += indexBytes;
          requestCounters.unique_observations += 1;
          requestCounters.retained_bytes += indexBytes;
          retainedBytes += indexBytes;
          state.snapshotDataBytes += indexBytes;
        }
        state.candlesByIndex.set(candle.index, {
          candle,
          bytes: candleBytes,
        });
        if (!existing) {
          state.counters.retained_rows += 1;
          requestCounters.retained_rows += 1;
        }
        state.counters.retained_bytes += candleByteDelta;
        requestCounters.retained_bytes += candleByteDelta;
        retainedBytes += candleByteDelta;
        state.snapshotDataBytes += candleByteDelta;
        recordPeakBuffer(retainedBytes + pendingMessageBytes);
      };
      const applyCandleEvents = (
        state: SnapshotSymbolState,
        events: ParsedCandleEvent[],
      ) => {
        if (state.providerComplete || state.providerSnipped) return;
        for (const event of events) {
          if (settled) return;
          if (
            event.flags !== null &&
            (event.flags & SNAPSHOT_BEGIN) !== 0
          ) {
            resetSnapshotData(state);
          }
          if (
            event.flags !== null &&
            (event.flags & REMOVE_EVENT) !== 0
          ) {
            removeRetainedCandle(state, event.index);
          } else if (!state.localFailureReason && event.candle) {
            retainCandle(state, event.candle);
          }
          if (event.flags !== null) {
            if ((event.flags & SNAPSHOT_END) !== 0) {
              state.providerComplete = true;
            }
            if ((event.flags & SNAPSHOT_SNIP) !== 0) {
              state.providerSnipped = true;
            }
          }
        }
        if (isTerminal(state)) {
          unsubscribe([state.candleSymbol]);
        }
      };
      const queueTransactionEvent = (
        state: SnapshotSymbolState,
        event: ParsedCandleEvent,
      ): boolean => {
        const bytes = pendingCandleEventBytes(event);
        const attemptedBufferBytes =
          retainedBytes + pendingMessageBytes + bytes;
        recordPeakBuffer(attemptedBufferBytes);
        if (attemptedBufferBytes > input.budgets.maxBufferBytes) {
          finish("LOCAL_BUFFER_BUDGET_EXCEEDED");
          return false;
        }
        state.pendingTransactionEvents.push({ event, bytes });
        state.counters.retained_bytes += bytes;
        requestCounters.retained_bytes += bytes;
        retainedBytes += bytes;
        return true;
      };
      const releasePendingTransaction = (
        state: SnapshotSymbolState,
      ): ParsedCandleEvent[] => {
        const pending = state.pendingTransactionEvents;
        state.pendingTransactionEvents = [];
        for (const item of pending) {
          state.counters.retained_bytes -= item.bytes;
          requestCounters.retained_bytes -= item.bytes;
          retainedBytes -= item.bytes;
        }
        return pending.map((item) => item.event);
      };
      const processCandleEvent = (event: ParsedCandleEvent) => {
        if (input.rthDaily && requestCounters.received_events >= input.budgets.maxReceivedEvents) {
          finish("LOCAL_RECEIVE_BUDGET_EXCEEDED");
          return;
        }
        requestCounters.received_events += 1;
        if (
          requestCounters.received_events >
          input.budgets.maxReceivedEvents
        ) {
          finish("LOCAL_RECEIVE_BUDGET_EXCEEDED");
          return;
        }
        if (event.candle) {
          requestCounters.valid_candle_events += 1;
        }
        let canonicalReceivedSymbol: string | null = null;
        try {
          canonicalReceivedSymbol =
            canonicalizeDxlinkCandleSymbol(event.eventSymbol);
        } catch {
          canonicalReceivedSymbol = null;
        }
        const state =
          canonicalReceivedSymbol === null
            ? undefined
            : symbolStatesByCanonical.get(canonicalReceivedSymbol);
        if (!state) {
          requestCounters.unmatched_received_events += 1;
          if (!retainUnmatchedSymbol(event.eventSymbol || "<missing>")) {
            return;
          }
        } else {
          state.counters.received_events += 1;
          if (
            !retainReceivedSymbol(
              state,
              state.receivedSymbols,
              event.eventSymbol,
            ) ||
            !retainReceivedSymbol(
              state,
              state.canonicalReceivedSymbols,
              canonicalReceivedSymbol!,
            )
          ) {
            return;
          }
          if (event.flags !== null) {
            if ((event.flags & SNAPSHOT_BEGIN) !== 0) {
              state.snapshotBeginSeen = true;
            }
            if ((event.flags & SNAPSHOT_END) !== 0) {
              state.snapshotEndSeen = true;
            }
            if ((event.flags & SNAPSHOT_SNIP) !== 0) {
              state.snapshotSnipSeen = true;
            }
          }
          if (event.candle) {
            if (input.rthDaily) {
              const date = rthDate(event.candle.timestamp);
              if (!retainReceivedSymbol(state, state.receivedSessionDates, date)) return;
            }
            state.counters.valid_candle_events += 1;
            state.oldestReceivedTimestamp =
              state.oldestReceivedTimestamp === null
                ? event.candle.timestamp
                : Math.min(
                    state.oldestReceivedTimestamp,
                    event.candle.timestamp,
                  );
            state.newestReceivedTimestamp =
              state.newestReceivedTimestamp === null
                ? event.candle.timestamp
                : Math.max(
                    state.newestReceivedTimestamp,
                    event.candle.timestamp,
                  );
          } else if (event.flags !== null && (event.flags & REMOVE_EVENT) === 0) {
            state.pipeline.invalid_candle_events += 1;
          }
        }
        if (!state) return;
        if (state.providerComplete || state.providerSnipped) return;
        if (state.localFailureReason) {
          if (
            event.flags !== null &&
            (event.flags & TX_PENDING) === 0
          ) {
            if ((event.flags & SNAPSHOT_END) !== 0) {
              state.providerComplete = true;
            }
            if ((event.flags & SNAPSHOT_SNIP) !== 0) {
              state.providerSnipped = true;
            }
          }
          unsubscribe([state.candleSymbol]);
          return;
        }
        if (event.flags === null) return;

        if (
          (event.flags & TX_PENDING) !== 0
        ) {
          queueTransactionEvent(state, event);
          return;
        }
        if (state.pendingTransactionEvents.length > 0) {
          const transaction = releasePendingTransaction(state);
          transaction.push(event);
          applyCandleEvents(state, transaction);
        } else {
          applyCandleEvents(state, [event]);
        }
      };
      const processMessage = (message: Record<string, unknown>) => {
        const authError = dxlinkAuthenticationError(message, authSent);
        if (authError) {
          stage = "AUTHENTICATING";
          fail(authError, false);
          return;
        }
        if (
          message.type === "AUTH_STATE" &&
          message.state === "UNAUTHORIZED"
        ) {
          stage = "AUTHENTICATING";
          authSent = true;
          send({
            type: "AUTH",
            channel: 0,
            token: input.quoteToken.token,
          });
        } else if (
          message.type === "AUTH_STATE" &&
          message.state === "AUTHORIZED"
        ) {
          authConfirmed = true;
          stage = "OPENING_FEED_CHANNEL";
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
          stage = "CONFIGURING_FEED";
          send({
            type: "FEED_SETUP",
            channel: 3,
            acceptAggregationPeriod: 0.1,
            acceptDataFormat: "COMPACT",
            acceptEventFields: { Candle: CANDLE_FIELDS },
          });
        } else if (
          message.type === "FEED_CONFIG" &&
          message.channel === 3 &&
          !subscribed
        ) {
          subscribed = true;
          stage = "SNAPSHOT";
          send({
            type: "FEED_SUBSCRIPTION",
            channel: 3,
            reset: true,
            add: [...activeSymbols].map((symbol) => ({
              type: "Candle",
              symbol,
              // Production DXLink expects milliseconds despite the
              // published AsyncAPI description saying seconds.
              fromTime: input.startMs,
            })),
          });
        } else if (
          message.type === "FEED_DATA" &&
          message.channel === 3
        ) {
          const parsed = parseDxlinkCandleData(message.data);
          for (const event of parsed.events) {
            if (settled) return;
            processCandleEvent(event);
          }
          finishIfTerminal();
        } else if (
          message.type === "ERROR" ||
          message.type === "CHANNEL_CLOSED"
        ) {
          fail(
            new Error(
              `DXLink rejected the candle request: ${JSON.stringify(message)}`,
            ),
          );
        }
      };

      deadline = setTimeout(
        () => finish("SNAPSHOT_TIMEOUT"),
        input.budgets.deadlineMs,
      );

      socket.onopen = () => {
        stage = "AUTHENTICATING";
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
      socket.onerror = () => fail(new Error("DXLink WebSocket error."));
      socket.onclose = (event) => {
        if (!settled) {
          fail(
            new Error(
              `DXLink closed before snapshot completion (${event.code}: ${event.reason || "no reason"}).`,
            ),
          );
        }
      };
      socket.onmessage = (event) => {
        if (settled) return;
        const bytes = dxlinkMessageDataByteLength(event.data);
        const attemptedBufferBytes =
          retainedBytes + pendingMessageBytes + bytes;
        recordPeakBuffer(attemptedBufferBytes);
        if (attemptedBufferBytes > input.budgets.maxBufferBytes) {
          finish("LOCAL_BUFFER_BUDGET_EXCEEDED");
          return;
        }
        pendingMessageBytes += bytes;
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
          )
          .finally(() => {
            pendingMessageBytes -= bytes;
          });
      };
    });
  }
}
