import { createHash } from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import {
  OAUTH_BASE_URL,
  USER_AGENT,
  assertTrustedHosts,
} from "./config.js";
import { ExactDecimal } from "./decimal.js";
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

export type InstrumentType =
  | "EQUITY"
  | "INDEX"
  | "OPTION"
  | "FUTURE"
  | "FUTURE_OPTION"
  | "CRYPTO";

export type InstrumentLifecycle = "ACTIVE" | "EXPIRED" | "UNKNOWN";

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
  | "PROVIDER_SCHEMA_MISMATCH";

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
  snapshot_complete: boolean;
  snapshot_truncated: boolean;
  provider_snapshot_complete: boolean;
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

type QuoteToken = {
  token: string;
  url: string;
};

type QuoteTokenResponse = {
  data?: {
    token?: string;
    "dxlink-url"?: string;
  };
};

type DxlinkSocket = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type DxlinkSocketFactory = (url: string) => DxlinkSocket;

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
};

type SnapshotReadResult = {
  symbolStates: Map<string, SnapshotSymbolState>;
  requestFailureReason: HistoricalCandlesFailureReason | null;
  requestCounters: HistoricalCandlesResourceCounters & {
    unmatched_received_events: number;
    unmatched_symbol_count: number;
    peak_buffer_bytes: number;
  };
  unmatchedSymbols: string[];
  timeoutStage: HistoricalCandlesTimeoutStage | null;
};

type HistoricalCandleBudgets = {
  deadlineMs: number;
  maxOutputCandles: number;
  maxReceivedEvents: number;
  maxBufferBytes: number;
  maxCandlesCompatibilityApplied: boolean;
  timeoutMsCompatibilityApplied: boolean;
};

const DXLINK_OPEN = 1;
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
const QUOTE_TOKEN_TTL_MS = 23 * 60 * 60_000;
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

function decodeMessageData(data: unknown): Promise<string> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) {
    return Promise.resolve(Buffer.from(data).toString("utf8"));
  }
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
        "utf8",
      ),
    );
  }
  if (
    typeof Blob !== "undefined" &&
    data instanceof Blob
  ) {
    return data.text();
  }
  return Promise.resolve(String(data));
}

function messageDataByteLength(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return Buffer.byteLength(String(data), "utf8");
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

function isRetryable(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  return (
    !error.response ||
    error.response.status === 429 ||
    error.response.status >= 500
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertTrustedDxlinkUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "wss:" ||
    !(
      url.hostname.toLowerCase() === "dxfeed.com" ||
      url.hostname.toLowerCase().endsWith(".dxfeed.com")
    ) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Refusing DXLink token target: ${url.hostname}. Expected a dxfeed.com host over wss.`,
    );
  }
  return url.toString();
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
  private quoteToken: QuoteToken | null = null;
  private quoteTokenExpiresAt = 0;

  constructor(
    private readonly oauth = new TastytradeOAuthClient(),
    private readonly http: AxiosInstance = axios.create({
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
  ) {
    assertTrustedHosts();
  }

  private async getQuoteToken(): Promise<QuoteToken> {
    const now = this.clock();
    if (this.quoteToken && now < this.quoteTokenExpiresAt) {
      return this.quoteToken;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const accessToken = await this.oauth.getAccessToken();
        const response = await this.http.get<QuoteTokenResponse>(
          "/api-quote-tokens",
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        const token = response.data.data?.token;
        const url = response.data.data?.["dxlink-url"];
        if (!token || !url) {
          throw new Error(
            "Quote-token response did not contain token and dxlink-url.",
          );
        }
        this.quoteToken = {
          token,
          url: assertTrustedDxlinkUrl(url),
        };
        this.quoteTokenExpiresAt = now + QUOTE_TOKEN_TTL_MS;
        return this.quoteToken;
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === 2) throw error;
        const baseDelay = 250 * 2 ** attempt;
        await wait(baseDelay + Math.floor(Math.random() * 100));
      }
    }
    throw lastError;
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
    });
    return result;
  }

  async getHistoricalCandlesBatch(
    input: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]> {
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
    const candleSymbols = instruments.map((instrument) =>
      session.kind === "REGULAR"
        ? `${instrument.streamerSymbol}{=${providerPeriod},a=s,tho=true}`
        : `${instrument.streamerSymbol}{=${providerPeriod}}`,
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
    const quoteToken = await this.getQuoteToken();
    const snapshot = await this.readSnapshot({
      quoteToken,
      candleSymbols,
      startMs,
      endMs,
      session,
      budgets,
    });
    const retrievedAt = new Date(this.clock()).toISOString();
    const requestId = stableRequestId({
      instruments,
      interval,
      start,
      end,
      resolution_profile: normalizedProfile,
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
      const filtered = [...state.candlesByIndex.values()]
        .map((retained) => retained.candle)
        .sort((left, right) => left.timestamp - right.timestamp);
      const candles: HistoricalCandle[] = filtered.map((candle) => {
        const barStart = new Date(candle.timestamp).toISOString();
        const barEnd = new Date(candle.timestamp + intervalMs).toISOString();
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
        };
      });
      const coverageWarnings = edgeCoverageWarnings(
        candles,
        startMs,
        endMs,
        intervalMs,
      );
      const warnings = [
        ...gapWarnings(candles, intervalMs, session),
        ...coverageWarnings,
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
      }
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
        snapshot_complete: snapshotComplete,
        snapshot_truncated: state.providerSnipped,
        provider_snapshot_complete: state.providerComplete,
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
    quoteToken: QuoteToken;
    candleSymbols: string[];
    startMs: number;
    endMs: number;
    session: ReturnType<typeof sessionConfiguration>;
    budgets: HistoricalCandleBudgets;
  }): Promise<SnapshotReadResult> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(input.quoteToken.url);
      const symbolStates = new Map<string, SnapshotSymbolState>(
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
          },
        ]),
      );
      const symbolStatesByCanonical = new Map(
        [...symbolStates.values()].map((state) => [
          state.canonicalSymbol,
          state,
        ]),
      );
      const unmatchedSymbols = new Map<string, number>();
      const requestCounters = {
        ...emptyResourceCounters(),
        unmatched_received_events: 0,
        unmatched_symbol_count: 0,
        peak_buffer_bytes: 0,
      };
      const activeSymbols = new Set(input.candleSymbols);
      let subscribed = false;
      let settled = false;
      let retainedBytes = 0;
      let pendingMessageBytes = 0;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      let messageQueue = Promise.resolve();
      let stage: HistoricalCandlesTimeoutStage = "CONNECTING";

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
        unsubscribe([...activeSymbols]);
        if (socket.readyState === DXLINK_OPEN) {
          socket.close(1000, "historical snapshot stopped");
        }
      };
      const finish = (
        requestFailureReason: HistoricalCandlesFailureReason | null,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          symbolStates,
          requestFailureReason,
          requestCounters,
          unmatchedSymbols: [...unmatchedSymbols.keys()].sort(),
          timeoutStage:
            requestFailureReason === "SNAPSHOT_TIMEOUT" ? stage : null,
        });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
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
        const retained = state.candlesByIndex.get(index);
        if (!retained) return;
        state.candlesByIndex.delete(index);
        state.counters.retained_rows -= 1;
        state.counters.retained_bytes -= retained.bytes;
        requestCounters.retained_rows -= 1;
        requestCounters.retained_bytes -= retained.bytes;
        retainedBytes -= retained.bytes;
        state.snapshotDataBytes -= retained.bytes;
      };
      const resetSnapshotData = (state: SnapshotSymbolState) => {
        requestCounters.unique_observations -=
          state.counters.unique_observations;
        requestCounters.retained_rows -= state.counters.retained_rows;
        requestCounters.retained_bytes -= state.snapshotDataBytes;
        state.counters.retained_bytes -= state.snapshotDataBytes;
        retainedBytes -= state.snapshotDataBytes;
        state.candlesByIndex.clear();
        state.seenIndices.clear();
        state.counters.unique_observations = 0;
        state.counters.retained_rows = 0;
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
          return;
        }
        const existing = state.candlesByIndex.get(candle.index);
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
        if (
          message.type === "AUTH_STATE" &&
          message.state === "UNAUTHORIZED"
        ) {
          stage = "AUTHENTICATING";
          send({
            type: "AUTH",
            channel: 0,
            token: input.quoteToken.token,
          });
        } else if (
          message.type === "AUTH_STATE" &&
          message.state === "AUTHORIZED"
        ) {
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
            add: input.candleSymbols.map((symbol) => ({
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
        const bytes = messageDataByteLength(event.data);
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
            const text = await decodeMessageData(event.data);
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
