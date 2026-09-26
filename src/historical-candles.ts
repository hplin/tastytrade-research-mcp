import axios, { type AxiosInstance } from "axios";
import {
  OAUTH_BASE_URL,
  USER_AGENT,
  assertTrustedHosts,
} from "./config.js";
import { ExactDecimal } from "./decimal.js";
import { TastytradeOAuthClient } from "./oauth-client.js";
import { normalizeRfc3339 } from "./time.js";

export type InstrumentType =
  | "EQUITY"
  | "INDEX"
  | "OPTION"
  | "FUTURE"
  | "FUTURE_OPTION"
  | "CRYPTO";

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
  interval: string;
  start_time: string;
  end_time: string;
  session?: CandleSession;
  timeout_ms?: number;
  max_candles?: number;
};

export type HistoricalCandleInstrument = {
  symbol: string;
  streamer_symbol?: string;
  instrument_type: InstrumentType;
};

export type HistoricalCandlesBatchInput = {
  instruments: HistoricalCandleInstrument[];
  interval: string;
  start_time: string;
  end_time: string;
  session?: CandleSession;
  timeout_ms?: number;
  max_candles?: number;
};

export type HistoricalCandle = {
  source_time: string;
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
};

export type HistoricalCandlesResult = {
  contract_version: "1.0.0";
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
  source: "tastytrade-dxlink";
  source_timestamp_unit: "epoch_milliseconds";
  snapshot_complete: boolean;
  snapshot_truncated: boolean;
  resampled: false;
  candles: HistoricalCandle[];
  warnings: string[];
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

const DXLINK_OPEN = 1;
const REMOVE_EVENT = 2;
const SNAPSHOT_END = 8;
const SNAPSHOT_SNIP = 16;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CANDLES = 10_000;
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
  candles: RawCandle[];
  snapshotComplete: boolean;
  snapshotTruncated: boolean;
  completedSymbols: string[];
  truncatedSymbols: string[];
} {
  if (!Array.isArray(data)) {
    return {
      candles: [],
      snapshotComplete: false,
      snapshotTruncated: false,
      completedSymbols: [],
      truncatedSymbols: [],
    };
  }
  const candles: RawCandle[] = [];
  let snapshotComplete = false;
  let snapshotTruncated = false;
  const completedSymbols = new Set<string>();
  const truncatedSymbols = new Set<string>();

  for (let index = 0; index + 1 < data.length; index += 2) {
    if (data[index] !== "Candle") continue;
    for (const row of parseRows(data[index + 1])) {
      const eventSymbol = typeof row[1] === "string" ? row[1] : "";
      const flags = Number(row[2]);
      if (!Number.isFinite(flags)) continue;
      if ((flags & SNAPSHOT_END) !== 0) {
        snapshotComplete = true;
        if (eventSymbol) completedSymbols.add(eventSymbol);
      }
      if ((flags & SNAPSHOT_SNIP) !== 0) {
        snapshotTruncated = true;
        if (eventSymbol) truncatedSymbols.add(eventSymbol);
      }
      if ((flags & REMOVE_EVENT) !== 0) continue;

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
        continue;
      }
      candles.push({
        eventSymbol,
        index: String(row[3]),
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
      });
    }
  }

  return {
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

function edgeCoverageWarnings(
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
        },
      ],
      interval: input.interval,
      start_time: input.start_time,
      end_time: input.end_time,
      session: input.session,
      timeout_ms: input.timeout_ms,
      max_candles: input.max_candles,
    });
    return result;
  }

  async getHistoricalCandlesBatch(
    input: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]> {
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
    const start = normalizeTimestamp(input.start_time, "start_time");
    const end = normalizeTimestamp(input.end_time, "end_time");
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (endMs <= startMs) throw new Error("end_time must be later than start_time.");

    const timeoutMs = normalizeDuration(
      input.timeout_ms,
      DEFAULT_TIMEOUT_MS,
      "timeout_ms",
      60_000,
    );
    const maxCandles = normalizeDuration(
      input.max_candles,
      DEFAULT_MAX_CANDLES,
      "max_candles",
      20_000,
    );
    const estimatedCandles = Math.ceil((endMs - startMs) / intervalMs) + 1;
    if (estimatedCandles > maxCandles) {
      throw new Error(
        `Requested range may contain ${estimatedCandles} candles; reduce the range or raise max_candles up to 20000.`,
      );
    }
    const estimatedSnapshotEvents =
      Math.ceil((this.clock() - startMs) / intervalMs) + 1;
    if (estimatedSnapshotEvents > maxCandles) {
      throw new Error(
        `DXLink replays from start_time through the present and does not honor toTime; this request may require ${estimatedSnapshotEvents} snapshot events, exceeding max_candles=${maxCandles}. Use a coarser interval or a more recent start_time.`,
      );
    }
    const session = sessionConfiguration(input.session);
    const candleSymbols = instruments.map((instrument) =>
      session.kind === "REGULAR"
        ? `${instrument.streamerSymbol}{=${interval},a=s,tho=true}`
        : `${instrument.streamerSymbol}{=${interval}}`,
    );
    if (new Set(candleSymbols).size !== candleSymbols.length) {
      throw new Error("instruments must have unique streamer_symbol values.");
    }
    const quoteToken = await this.getQuoteToken();
    const snapshot = await this.readSnapshot({
      quoteToken,
      candleSymbols,
      startMs,
      timeoutMs,
      maxCandles,
    });

    const completedSymbols = new Set(snapshot.completedSymbols);
    const truncatedSymbols = new Set(snapshot.truncatedSymbols);
    return instruments.map((instrument, instrumentIndex) => {
      const candleSymbol = candleSymbols[instrumentIndex];
      const byIndex = new Map<string, RawCandle>();
      for (const candle of snapshot.candles) {
        if (candle.eventSymbol === candleSymbol) {
          byIndex.set(candle.index, candle);
        }
      }
      const filtered = [...byIndex.values()]
        .filter(
          (candle) =>
            candle.timestamp >= startMs &&
            candle.timestamp <= endMs &&
            isWithinSession(candle.timestamp, session),
        )
        .sort((left, right) => left.timestamp - right.timestamp);
      const candles: HistoricalCandle[] = filtered.map((candle) => ({
        source_time: new Date(candle.timestamp).toISOString(),
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
      }));
      const warnings = [
        ...gapWarnings(candles, intervalMs, session),
        ...edgeCoverageWarnings(candles, startMs, endMs, intervalMs),
      ];
      if (session.kind === "CUSTOM") {
        warnings.push(
          "CUSTOM_SESSION_FILTERS_COMPLETE_SOURCE_BARS_WITHOUT_REAGGREGATION",
        );
      }
      if (truncatedSymbols.has(candleSymbol)) {
        warnings.push("DXLINK_SNAPSHOT_SNIPPED_NARROW_TIME_RANGE");
      }
      if (!completedSymbols.has(candleSymbol)) {
        warnings.push("DXLINK_SNAPSHOT_END_NOT_OBSERVED");
      }
      if (candles.length === 0) {
        warnings.push("NO_CANDLES_IN_REQUESTED_RANGE_AND_SESSION");
      }

      return {
        contract_version: "1.0.0",
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
        source: "tastytrade-dxlink",
        source_timestamp_unit: "epoch_milliseconds",
        snapshot_complete: completedSymbols.has(candleSymbol),
        snapshot_truncated: truncatedSymbols.has(candleSymbol),
        resampled: false,
        candles,
        warnings,
      };
    });
  }

  private readSnapshot(input: {
    quoteToken: QuoteToken;
    candleSymbols: string[];
    startMs: number;
    timeoutMs: number;
    maxCandles: number;
  }): Promise<{
    candles: RawCandle[];
    snapshotComplete: boolean;
    snapshotTruncated: boolean;
    completedSymbols: string[];
    truncatedSymbols: string[];
  }> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(input.quoteToken.url);
      const candles: RawCandle[] = [];
      const completedSymbols = new Set<string>();
      const truncatedSymbols = new Set<string>();
      let subscribed = false;
      let settled = false;
      let keepalive: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        clearTimeout(timeout);
        if (keepalive) clearInterval(keepalive);
        if (socket.readyState === DXLINK_OPEN) {
          socket.close(1000, "historical snapshot complete");
        }
      };
      const finish = (
        result: {
          snapshotComplete: boolean;
          snapshotTruncated: boolean;
        },
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          candles,
          completedSymbols: [...completedSymbols],
          truncatedSymbols: [...truncatedSymbols],
          ...result,
        });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const send = (message: Record<string, unknown>) => {
        socket.send(JSON.stringify(message));
      };
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              `DXLink candle snapshot timed out after ${input.timeoutMs}ms.`,
            ),
          ),
        input.timeoutMs,
      );

      socket.onopen = () => {
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
        void decodeMessageData(event.data)
          .then((text) => {
            for (const line of text.split(/\n+/).filter(Boolean)) {
              let message: Record<string, unknown>;
              try {
                message = JSON.parse(line) as Record<string, unknown>;
              } catch {
                fail(new Error("DXLink returned invalid JSON."));
                return;
              }

              if (
                message.type === "AUTH_STATE" &&
                message.state === "UNAUTHORIZED"
              ) {
                send({
                  type: "AUTH",
                  channel: 0,
                  token: input.quoteToken.token,
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
                  acceptEventFields: { Candle: CANDLE_FIELDS },
                });
              } else if (
                message.type === "FEED_CONFIG" &&
                message.channel === 3 &&
                !subscribed
              ) {
                subscribed = true;
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
                if (
                  candles.length + parsed.candles.length >
                  input.maxCandles
                ) {
                  fail(
                    new Error(
                      `DXLink snapshot exceeded max_candles=${input.maxCandles}; use a coarser interval or a more recent start_time.`,
                    ),
                  );
                  return;
                }
                candles.push(...parsed.candles);
                for (const symbol of parsed.completedSymbols) {
                  completedSymbols.add(symbol);
                }
                for (const symbol of parsed.truncatedSymbols) {
                  truncatedSymbols.add(symbol);
                }
                const finished = input.candleSymbols.every(
                  (symbol) =>
                    completedSymbols.has(symbol) ||
                    truncatedSymbols.has(symbol),
                );
                if (finished) {
                  if (socket.readyState === DXLINK_OPEN) {
                    send({
                      type: "FEED_SUBSCRIPTION",
                      channel: 3,
                      remove: input.candleSymbols.map((symbol) => ({
                        type: "Candle",
                        symbol,
                      })),
                    });
                  }
                  finish({
                    snapshotComplete: input.candleSymbols.every((symbol) =>
                      completedSymbols.has(symbol),
                    ),
                    snapshotTruncated: truncatedSymbols.size > 0,
                  });
                }
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
            }
          })
          .catch((error: unknown) =>
            fail(error instanceof Error ? error : new Error(String(error))),
          );
      };
    });
  }
}
