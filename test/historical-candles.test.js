import { readFileSync } from "node:fs";
import { describe, expect, jest, test } from "@jest/globals";
import {
  TastytradeHistoricalCandlesClient,
  canonicalizeDxlinkCandleSymbol,
  parseDxlinkCandleData,
} from "../dist/historical-candles.js";
import { planRthSessions, rthSession, RTH_CALENDAR_VERSION } from "../dist/rth-calendar.js";
import { resolveHistoricalBarTiming, historicalBarMatchesResolutionProfile } from "../dist/resolution-profile.js";

const dailyFixture = JSON.parse(readFileSync(
  new URL("./fixtures/dxlink-rth-daily-synthetic.json", import.meta.url), "utf8",
));

function dailyRows(symbol, dates, complete = true) {
  const nativeSymbol = `${symbol}${dailyFixture.wire_shape.canonical_equivalent_received}`;
  const rows = dates.map((date, index) => row(rthSession(date).open, index === 0 ? 4 : 0,
    "100", nativeSymbol));
  if (complete) rows.push(marker(Date.parse("2026-01-01T00:00:00Z"), nativeSymbol));
  return rows;
}

function dailyClient(attempts, clock = () => Date.parse("2026-12-31T23:00:00Z"), onToken = () => {}) {
  const sockets = [];
  const quoteTokens = {
    getQuoteToken: jest.fn(async (signal, request) => {
      await onToken(signal, request);
      return {
        token: request?.forceRefresh ? "synthetic-fresh-token" : "synthetic-stale-token",
        url: "wss://tasty-openapi-dxlink-md-ws.dxfeed.com/realtime",
      };
    }),
    invalidateQuoteToken: jest.fn(),
  };
  const client = new TastytradeHistoricalCandlesClient(
    { getAccessToken: async () => "synthetic-token" }, undefined,
    () => {
      const attempt = attempts[Math.min(sockets.length, attempts.length - 1)];
      if (attempt?.constructionError) throw new Error("Synthetic socket construction failure");
      const rows = attempt?.rows ?? attempt;
      const socket = new FakeSocket(rows === null ? [] : [rows], {
        unauthorizedTokens: attempt?.unauthorizedTokens,
        afterFeedError: attempt?.unauthorized,
        feedConfig: attempt?.feedConfig,
      });
      if (attempt?.error) {
        const emit = socket.emit.bind(socket);
        socket.emit = (message) => {
          emit(message);
          if (message.type === "FEED_DATA") setTimeout(() => socket.onerror?.(), 1);
        };
      }
      sockets.push(socket);
      return socket;
    }, clock,
    quoteTokens,
  );
  return { client, sockets, quoteTokens };
}

function dailyRequest(symbol = "SPY", overrides = {}) {
  return {
    symbol, instrument_type: symbol === "SPX" ? "INDEX" : "EQUITY",
    interval: "1d", start_time: dailyFixture.start_time, end_time: dailyFixture.end_time,
    session: { kind: "REGULAR", timezone: "America/New_York" },
    deadline_ms: 100, max_output_candles: 100, max_received_events: 1000,
    max_buffer_bytes: 1_000_000, ...overrides,
  };
}

const FIELDS_PER_ROW = 17;
const nativeHourFixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/dxlink-native-hour-sanitized.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const nativeHourRows = [];
for (
  let index = 0;
  index < nativeHourFixture.feed_data.data[1].length;
  index += FIELDS_PER_ROW
) {
  nativeHourRows.push(
    nativeHourFixture.feed_data.data[1].slice(
      index,
      index + FIELDS_PER_ROW,
    ),
  );
}

function row(
  time,
  flags = 0,
  price = "100",
  eventSymbol = "SPY{=1h}",
  index = String(time),
) {
  return [
    "Candle",
    eventSymbol,
    flags,
    index,
    time,
    0,
    1,
    price,
    price,
    price,
    price,
    "1000",
    price,
    "400",
    "600",
    "0.2",
    "NaN",
  ];
}

function marker(
  time,
  eventSymbol = "SPY{=1h}",
  flags = 10,
  index = String(time),
) {
  const value = row(time, flags, "100", eventSymbol, index);
  for (let index = 7; index < FIELDS_PER_ROW; index += 1) {
    value[index] = "NaN";
  }
  return value;
}

class FakeSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];

  constructor(batches, options = {}) {
    this.batches = batches;
    this.feedConfig = options.feedConfig ?? {
      type: "FEED_CONFIG",
      channel: 3,
    };
    this.useBlob = options.useBlob ?? false;
    this.afterFeedError = options.afterFeedError ?? false;
    this.unauthorizedTokens = new Set(
      options.unauthorizedTokens ?? [],
    );
    this.closeCalls = [];
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data) {
    const message = JSON.parse(data);
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.type === "SETUP") {
        this.emit({ type: "AUTH_STATE", channel: 0, state: "UNAUTHORIZED" });
      } else if (message.type === "AUTH") {
        if (this.unauthorizedTokens.has(message.token)) {
          this.emit({
            type: "ERROR",
            channel: 0,
            error: "UNAUTHORIZED",
            message: "Authentication failed",
          });
        } else {
          this.emit({ type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" });
        }
      } else if (message.type === "CHANNEL_REQUEST") {
        this.emit({ type: "CHANNEL_OPENED", channel: 3, service: "FEED" });
      } else if (message.type === "FEED_SETUP") {
        this.emit(this.feedConfig);
      } else if (message.type === "FEED_SUBSCRIPTION" && message.add) {
        for (const rows of this.batches) {
          this.emit({
            type: "FEED_DATA",
            channel: 3,
            data: ["Candle", rows.flat()],
          });
        }
        if (this.afterFeedError) {
          this.emit({
            type: "ERROR", channel: 0, error: "UNAUTHORIZED",
            message: "Rejected synthetic-stale-token synthetic-fresh-token",
          });
        }
      }
    });
  }

  emit(message) {
    const data = JSON.stringify(message);
    this.onmessage?.({ data: this.useBlob ? new Blob([data]) : data });
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

function clientWithRows(
  rows,
  clock = () => Date.parse("2026-09-25T12:00:00.000Z"),
  socketOptions = {},
) {
  let socket;
  const client = new TastytradeHistoricalCandlesClient(
    { getAccessToken: async () => "access-token" },
    {
      get: async () => ({
        data: {
          data: {
            token: "quote-token",
            "dxlink-url":
              "wss://tasty-openapi-dxlink-md-ws.dxfeed.com/realtime",
          },
        },
      }),
    },
    () => {
      socket = new FakeSocket(
        rows === null ? [] : [rows],
        socketOptions,
      );
      return socket;
    },
    clock,
  );
  return { client, getSocket: () => socket };
}

function clientWithAuthTokens(rows, tokens, unauthorizedTokens) {
  const sockets = [];
  let tokenIndex = 0;
  const quoteTokens = {
    getQuoteToken: jest.fn(async () => ({
      token: tokens[Math.min(tokenIndex++, tokens.length - 1)],
      url: "wss://tasty-openapi-dxlink-md-ws.dxfeed.com/realtime",
    })),
    invalidateQuoteToken: jest.fn(),
  };
  const client = new TastytradeHistoricalCandlesClient(
    { getAccessToken: async () => "access-token" },
    undefined,
    () => {
      const socket = new FakeSocket([rows], {
        unauthorizedTokens,
      });
      sockets.push(socket);
      return socket;
    },
    () => Date.parse("2026-09-25T12:00:00.000Z"),
    quoteTokens,
  );
  return { client, quoteTokens, sockets };
}

describe("calendar-verified RTH daily coverage (synthetic, not live)", () => {
  test.each([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
    "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
    "2026-11-26", "2026-12-25",
  ])("published full closure %s is not a missing session", (date) => {
    expect(rthSession(date)).toBeNull();
  });

  test.each(["SPX", "SPY", "QQQ", "IWM"])("%s reported missing dates remain partial despite provider END", async (symbol) => {
    const missing = dailyFixture.omissions[symbol];
    const dates = dailyFixture.expected_session_dates.filter((date) => !missing.includes(date));
    const { client, sockets } = dailyClient([dailyRows(symbol, dates), dailyRows(symbol, [])]);
    const result = await client.getHistoricalCandles(dailyRequest(symbol));
    expect(result).toMatchObject({
      status: "PARTIAL", snapshot_complete: true, provider_snapshot_complete: true,
      session_coverage_complete: false, expected_session_dates: dailyFixture.expected_session_dates,
      observed_session_dates: dates, missing_session_dates: missing,
      coverage_ratio: dates.length / 33,
      session_coverage: { ma20_eligible: false, calendar_id: RTH_CALENDAR_VERSION },
    });
    expect(result.candles).toHaveLength(symbol === "SPX" ? 30 : 32);
    expect(result.failure_reasons).toEqual(expect.arrayContaining([
      "SOURCE_RTH_DAILY_MISSING", "CALENDAR_EXPECTED_SESSION_MISSING",
      "PROVIDER_COMPLETE_BUT_COVERAGE_PARTIAL",
    ]));
    expect(result.transport_diagnostics.received_session_dates).toEqual(dates);
    expect(result.missing_session_diagnostics).toEqual(missing.map((session_date) => ({
      session_date, attribution: "NO_VALID_CANONICAL_PROVIDER_ROW_OBSERVED",
      provider_cause_confirmed: false,
    })));
    expect(result.transport_diagnostics.local_pipeline.unverified_daily_times).toBe(0);
    expect(result.warnings.some((warning) => warning.startsWith("MISSING_BAR_GAP"))).toBe(false);
    expect(sockets).toHaveLength(2);
    expect(result.recovery_diagnostics.attempts).toBe(1);
  });

  test.each(["SPX", "SPY", "QQQ", "IWM"])("%s same-native-cohort short retry restores only missing dates", async (symbol) => {
    const missing = dailyFixture.omissions[symbol];
    const dates = dailyFixture.expected_session_dates.filter((date) => !missing.includes(date));
    const { client, sockets } = dailyClient([dailyRows(symbol, dates), dailyRows(symbol, missing)]);
    const result = await client.getHistoricalCandles(dailyRequest(symbol));
    expect(result.status).toBe("AVAILABLE");
    expect(result.session_coverage_complete).toBe(true);
    expect(result.missing_session_dates).toEqual([]);
    expect(result.coverage_ratio).toBe(1);
    expect(result.session_coverage.ma20_eligible).toBe(true);
    expect(result.candles).toHaveLength(33);
    expect(result.recovery_diagnostics.recovered_session_dates).toEqual(missing);
    for (const socket of sockets) {
      const subscription = socket.sent.find((message) => message.type === "FEED_SUBSCRIPTION" && message.add);
      expect(subscription.add[0].symbol).toBe(`${symbol}{=d,a=s,tho=true}`);
    }
    expect(sockets[1].sent.find((message) => message.add).add[0].fromTime).toBe(rthSession(missing[0]).open);
    expect(result.resource_usage.request.received_events).toBe(35);
    expect(result.resource_usage.request.retained_bytes).toBeLessThanOrEqual(1_000_000);
    expect(result.candles[0]).toMatchObject({
      source_time: "2026-08-25T13:30:00.000Z", bar_start: "2026-08-25T13:30:00.000Z",
      bar_end: "2026-08-25T20:00:00.000Z", available_at: "2026-08-25T20:00:00.000Z",
      session_timing: { calendar_id: RTH_CALENDAR_VERSION, session_date: "2026-08-25" },
    });
    const timing = resolveHistoricalBarTiming(result.candles[0], "1d");
    expect(historicalBarMatchesResolutionProfile(timing, "1d", result.resolution_profile)).toBe(true);
  });

  test.each([
    ["2026-09-04", "2026-09-08"],
    ["2026-04-02", "2026-04-06"],
    ["2026-07-02", "2026-07-06"],
    ["2026-10-09", "2026-10-12"],
  ])("weekend/holiday %s to %s has no false gap", async (first, last) => {
    const { client, sockets } = dailyClient([dailyRows("SPY", [first, last])]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: `${first}T00:00:00Z`, end_time: `${last}T23:00:00Z`,
    }));
    expect(result.status).toBe("AVAILABLE");
    expect(result.expected_session_dates).toEqual([first, last]);
    expect(result.warnings).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  test.each([
    ["2026-03-06", "2026-03-09", "2026-03-06T21:00:00.000Z", "2026-03-09T20:00:00.000Z"],
    ["2026-10-30", "2026-11-02", "2026-10-30T20:00:00.000Z", "2026-11-02T21:00:00.000Z"],
    ["2026-11-25", "2026-11-27", "2026-11-25T21:00:00.000Z", "2026-11-27T18:00:00.000Z"],
    ["2026-12-23", "2026-12-24", "2026-12-23T21:00:00.000Z", "2026-12-24T18:00:00.000Z"],
  ])("DST/half-day timing %s to %s", async (first, last, firstClose, lastClose) => {
    const { client } = dailyClient([dailyRows("SPY", [first, last])]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: `${first}T00:00:00Z`, end_time: `${last}T23:00:00Z`,
    }));
    expect(result.expected_session_dates).toEqual([first, last]);
    expect(result.candles.map((candle) => candle.available_at)).toEqual([firstClose, lastClose]);
    expect(resolveHistoricalBarTiming(result.candles[1], "1d").bar_end).toBe(lastClose);
  });

  test("Monday INITIAL excludes unfinished/future bars but keeps Friday CLOSE", async () => {
    const { client, sockets } = dailyClient([dailyRows("SPY", ["2026-10-09", "2026-10-12", "2026-10-13"])],
      () => Date.parse("2026-10-12T14:00:00Z"));
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: "2026-10-09T00:00:00Z", end_time: "2026-10-13T23:00:00Z",
    }));
    expect(result.expected_session_dates).toEqual(["2026-10-09"]);
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].available_at).toBe("2026-10-09T20:00:00.000Z");
    expect(result.transport_diagnostics.local_pipeline.unfinished_daily_rows).toBe(2);
    expect(result.session_coverage.evaluated_through).toBe("2026-10-12T14:00:00.000Z");
    expect(sockets).toHaveLength(1);
  });

  test("range checkpoint excludes an unfinished half-day even when retrieved later", async () => {
    const { client } = dailyClient([dailyRows("SPY", ["2026-11-25", "2026-11-27"])]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: "2026-11-25T00:00:00Z", end_time: "2026-11-27T17:59:59Z",
    }));
    expect(result.expected_session_dates).toEqual(["2026-11-25"]);
    expect(result.candles).toHaveLength(1);
  });

  test("twenty rows with an internal expected-date hole do not qualify ma20", async () => {
    const expected = dailyFixture.expected_session_dates.slice(-21);
    const missing = "2026-10-08";
    const { client } = dailyClient([
      dailyRows("SPY", expected.filter((date) => date !== missing)), dailyRows("SPY", []),
    ]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: `${expected[0]}T00:00:00Z`,
    }));
    expect(result.candles).toHaveLength(20);
    expect(result.session_coverage.ma20_expected_session_dates).toHaveLength(20);
    expect(result.session_coverage.ma20_eligible).toBe(false);
  });

  test("exactly twenty contiguous completed expected sessions qualify ma20", async () => {
    const dates = dailyFixture.expected_session_dates.slice(-20);
    const { client, sockets } = dailyClient([dailyRows("SPY", dates)]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: `${dates[0]}T00:00:00Z`,
    }));
    expect(result.status).toBe("AVAILABLE");
    expect(result.session_coverage.ma20_eligible).toBe(true);
    expect(result.session_coverage.ma20_expected_session_dates).toEqual(dates);
    expect(sockets).toHaveLength(1);
  });

  test("unknown timestamp alignment is observable local rejection, not claimed provider absence", async () => {
    const date = "2026-10-08";
    const native = "SPY{=d,a=s,tho=true}";
    const misaligned = row(Date.parse(`${date}T00:00:00Z`), 4, "100", native);
    const { client } = dailyClient([[misaligned, marker(0, native)], dailyRows("SPY", [])]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: `${date}T00:00:00Z`, end_time: `${date}T23:00:00Z`,
    }));
    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.failure_reasons).toContain("SOURCE_RTH_DAILY_TIME_UNVERIFIED");
    expect(result.transport_diagnostics.local_pipeline.unverified_daily_times).toBe(1);
    expect(result.transport_diagnostics.received_session_dates).toEqual(["2026-10-07"]);
    expect(result.missing_session_dates).toEqual([date]);
  });

  test("different-index duplicate daily sessions fail closed rather than count twice", async () => {
    const native = "SPY{=d,a=s,tho=true}";
    const time = rthSession("2026-10-08").open;
    const { client } = dailyClient([[
      row(time, 4, "100", native, "one"), row(time, 0, "101", native, "two"), marker(0, native),
    ]]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: "2026-10-08T00:00:00Z", end_time: "2026-10-08T23:00:00Z",
    }));
    expect(result.candles).toEqual([]);
    expect(result.failure_reasons).toContain("SOURCE_RTH_DAILY_TIME_UNVERIFIED");
    expect(result.transport_diagnostics.received_session_dates).toEqual(["2026-10-08"]);
  });

  test.each([
    { symbol: "UNKNOWN" }, { streamer_symbol: "SPY:UNKNOWN" },
    { session: { kind: "REGULAR", timezone: "UTC" } },
    { start_time: "2025-12-31T00:00:00Z" }, { end_time: "2027-01-02T00:00:00Z" },
  ])("unsupported calendar scope fails closed: %j", async (overrides) => {
    const { client } = dailyClient([dailyRows(overrides.symbol ?? "SPY", [])]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", overrides));
    expect(result.session_coverage_complete).toBe(false);
    expect(result.coverage_ratio).toBeNull();
    expect(result.session_coverage.status).toBe("UNSUPPORTED");
    expect(result.failure_reasons).toContain("CALENDAR_UNSUPPORTED");
    expect(result.status).not.toBe("AVAILABLE");
  });

  test("ALL daily is not allowed to fill the REGULAR cohort", async () => {
    const time = rthSession("2026-10-08").open;
    const { client } = dailyClient([[
      row(time, 4, "751.28", "QQQ{=d}"), marker(0, "QQQ{=d}"),
    ]]);
    const result = await client.getHistoricalCandles(dailyRequest("QQQ", {
      start_time: "2026-10-08T00:00:00Z", end_time: "2026-10-08T23:00:00Z", deadline_ms: 5,
    }));
    expect(result.candles).toEqual([]);
    expect(result.transport_diagnostics.unmatched_received_symbols).toEqual(["QQQ{=d}"]);
    expect(result.failure_reasons).toContain("PROVIDER_TIMEOUT");
    expect(result.session_coverage_complete).toBe(false);
  });

  test("sixty sessions recover within original aggregate event/output/buffer limits", async () => {
    const request = dailyRequest("SPY", { start_time: "2026-07-17T00:00:00Z",
      max_output_candles: 60, max_received_events: 62 });
    const plan = planRthSessions("SPY", "SPY", "EQUITY", "America/New_York",
      Date.parse(request.start_time), Date.parse(request.end_time), Date.parse("2026-12-31T23:00:00Z"));
    expect(plan.sessions).toHaveLength(60);
    const dates = plan.sessions.map((session) => session.date);
    const { client } = dailyClient([
      dailyRows("SPY", dates.filter((date) => date !== "2026-10-08")),
      dailyRows("SPY", ["2026-10-08"]),
    ]);
    const result = await client.getHistoricalCandles(request);
    expect(result.status).toBe("AVAILABLE");
    expect(result.candles).toHaveLength(60);
    expect(result.resource_usage.request.received_events).toBe(62);
    expect(result.resource_usage.request.returned_rows).toBe(60);
    expect(result.resource_usage.request.retained_bytes).toBeLessThanOrEqual(1_000_000);
  });

  test("output truncation reports coverage of returned rows without falsely blaming provider", async () => {
    const { client, sockets } = dailyClient([dailyRows("SPY", dailyFixture.expected_session_dates)]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", { max_output_candles: 20 }));
    expect(result.status).toBe("PARTIAL");
    expect(result.candles).toHaveLength(20);
    expect(result.expected_session_dates).toHaveLength(33);
    expect(result.missing_session_dates).toHaveLength(13);
    expect(result.coverage_ratio).toBe(20 / 33);
    expect(result.failure_reasons).toContain("LOCAL_OUTPUT_BUDGET_EXCEEDED");
    expect(result.transport_diagnostics.received_session_dates.length).toBeGreaterThan(20);
    expect(sockets).toHaveLength(1);
  });

  test("receive limit is shared across retry and retains previously good bars", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client } = dailyClient([dailyRows("SPY", dates), dailyRows("SPY", ["2026-10-08"])]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", { max_received_events: 34 }));
    expect(result.candles).toHaveLength(33);
    expect(result.resource_usage.request.received_events).toBe(34);
    expect(result.status).toBe("PARTIAL");
    expect(result.failure_reasons).toContain("LOCAL_RECEIVE_BUDGET_EXCEEDED");
    expect(result.snapshot_complete).toBe(true);
    expect(result.session_coverage.ma20_eligible).toBe(false);
  });

  test("retry timeout keeps original bars and exposes provider-timeout diagnostics", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets } = dailyClient([dailyRows("SPY", dates), null]);
    const before = performance.now();
    const result = await client.getHistoricalCandles(dailyRequest("SPY", { deadline_ms: 15 }));
    expect(performance.now() - before).toBeLessThan(100);
    expect(result.candles).toHaveLength(32);
    expect(result.status).toBe("PARTIAL");
    expect(result.recovery_diagnostics.failures).toContain("PROVIDER_TIMEOUT");
    expect(sockets).toHaveLength(2);
    expect(sockets.every((socket) => socket.closeCalls.length === 1)).toBe(true);
  });

  test("batch symbol isolation preserves completed SPY while IWM times out", async () => {
    const { client, sockets } = dailyClient([dailyRows("SPY", dailyFixture.expected_session_dates)]);
    const request = dailyRequest();
    const results = await client.getHistoricalCandlesBatch({
      ...request, instruments: [{ symbol: "SPY", instrument_type: "EQUITY" },
        { symbol: "IWM", instrument_type: "EQUITY" }], deadline_ms: 5,
    });
    expect(results[0].status).toBe("AVAILABLE");
    expect(results[0].candles).toHaveLength(33);
    expect(results[1].status).toBe("NOT_AVAILABLE");
    expect(results[1].failure_reasons).toContain("PROVIDER_TIMEOUT");
    expect(sockets).toHaveLength(1);
  });

  test.each(["SPY", "QQQ", "IWM"])("%s short Oct7-Oct9 window reproduces the same missing Oct8", async (symbol) => {
    const { client } = dailyClient([
      dailyRows(symbol, ["2026-10-07", "2026-10-09"]), dailyRows(symbol, []),
    ]);
    const result = await client.getHistoricalCandles(dailyRequest(symbol, {
      start_time: "2026-10-07T00:00:00Z", end_time: "2026-10-09T23:00:00Z",
    }));
    expect(result.expected_session_dates).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(result.missing_session_dates).toEqual(["2026-10-08"]);
    expect(result.missing_session_diagnostics[0].attribution).toBe("NO_VALID_CANONICAL_PROVIDER_ROW_OBSERVED");
    expect(result.coverage_ratio).toBe(2 / 3);
    expect(result.status).toBe("PARTIAL");
  });

  test("local index replacement/removal is diagnosed distinctly from absent native events", async () => {
    const native = "SPY{=d,a=s,tho=true}";
    const first = rthSession("2026-10-07").open;
    const removed = rthSession("2026-10-08").open;
    const { client } = dailyClient([[
      row(first, 4, "100", native), row(first, 0, "101", native),
      row(removed, 0, "100", native), row(removed, 2, "100", native),
      row(rthSession("2026-10-09").open, 0, "100", native), marker(0, native),
    ], dailyRows("SPY", [])]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      start_time: "2026-10-07T00:00:00Z", end_time: "2026-10-09T23:00:00Z",
    }));
    expect(result.candles[0].close).toBe("101");
    expect(result.transport_diagnostics.received_session_dates)
      .toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(result.transport_diagnostics.local_pipeline).toMatchObject({
      replaced_indices: 1, removed_indices: 1, snapshot_resets: 1,
    });
    expect(result.missing_session_dates).toEqual(["2026-10-08"]);
    expect(result.missing_session_diagnostics[0].attribution).toBe("VALID_PROVIDER_ROW_NOT_RETURNED_LOCALLY");
  });

  test("failed recovery retains both original rows and a completed session from the interrupted retry", async () => {
    const missing = dailyFixture.omissions.SPX;
    const { client } = dailyClient([
      dailyRows("SPX", dailyFixture.expected_session_dates.filter((date) => !missing.includes(date))),
      { rows: dailyRows("SPX", [missing[0]], false), error: true },
    ]);
    const result = await client.getHistoricalCandles(dailyRequest("SPX"));
    expect(result.candles).toHaveLength(31);
    expect(result.status).toBe("PARTIAL");
    expect(result.missing_session_dates).toEqual(missing.slice(1));
    expect(result.recovery_diagnostics.failures).toContain("PROVIDER_TEMPORARY_FAILURE");
    expect(result.resource_usage.request.received_events).toBe(32);
  });

  test.each([false, true])("recovery rejection with committed row=%s refreshes only its window with cumulative evidence", async (committed) => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const refreshedRows = dailyRows("SPY", ["2026-10-08"]);
    for (let index = 7; index <= 10; index += 1) refreshedRows[0][index] = "101";
    const { client, sockets, quoteTokens } = dailyClient([
      dailyRows("SPY", dates),
      { rows: committed ? dailyRows("SPY", ["2026-10-08"], false) : [], unauthorized: true },
      refreshedRows,
    ]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      max_output_candles: 33, max_received_events: committed ? 36 : 35,
    }));
    expect(result.status).toBe("AVAILABLE");
    expect(result.candles.map((candle) => candle.session_timing.session_date))
      .toEqual(dailyFixture.expected_session_dates);
    expect(result.resource_usage.request).toMatchObject({
      received_events: committed ? 36 : 35, retained_rows: 33, returned_rows: 33,
      valid_candle_events: committed ? 34 : 33,
    });
    expect(result.resource_usage.symbol.received_events).toBe(committed ? 36 : 35);
    expect(result.candles.find((candle) => candle.session_timing.session_date === "2026-10-08"))
      .toMatchObject({
        close: committed ? "100" : "101", source_time: "2026-10-08T13:30:00.000Z",
        bar_end: "2026-10-08T20:00:00.000Z", available_at: "2026-10-08T20:00:00.000Z",
      });
    expect(result.dxlink_auth).toMatchObject({
      status: "REFRESHED", refresh_attempted: true, retry_count: 1,
    });
    expect(result.provider_error).toEqual({ code: "UNAUTHORIZED", message: "Authentication failed" });
    expect(result.recovery_diagnostics).toMatchObject({
      attempts: 2, failures: [], recovered_session_dates: ["2026-10-08"],
      windows: [
        { failure_reason: "AUTH_FAILED", received_events: committed ? 1 : 0, provider_snapshot_complete: false },
        { failure_reason: null, received_events: 2, provider_snapshot_complete: true },
      ],
    });
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.getQuoteToken.mock.calls[1][1]).toEqual({ forceRefresh: true });
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(3);
    for (const socket of sockets.slice(1)) {
      expect(socket.sent.find((message) => message.add).add).toEqual([{
        type: "Candle", symbol: "SPY{=d,a=s,tho=true}", fromTime: rthSession("2026-10-08").open,
      }]);
    }
    expect(JSON.stringify(result)).not.toContain("synthetic-stale-token");
    expect(JSON.stringify(result)).not.toContain("synthetic-fresh-token");
  });

  test.each([false, true])("repeated recovery rejection with committed row=%s fails closed without erasing a completed peer", async (committed) => {
    const missing = dailyFixture.omissions.SPX;
    const initial = [
      ...dailyRows("SPX", dailyFixture.expected_session_dates.filter((date) => !missing.includes(date))),
      ...dailyRows("QQQ", dailyFixture.expected_session_dates),
    ];
    const { client, sockets, quoteTokens } = dailyClient([
      initial,
      { rows: committed ? dailyRows("SPX", [missing[0]], false) : [], unauthorized: true },
      { rows: committed ? dailyRows("SPX", [missing[1]], false) : [], unauthorized: true },
    ]);
    const [spx, qqq] = await client.getHistoricalCandlesBatch({
      ...dailyRequest("SPX"),
      instruments: [{ symbol: "SPX", instrument_type: "INDEX" }, { symbol: "QQQ", instrument_type: "EQUITY" }],
    });
    expect(spx.status).toBe("PARTIAL");
    expect(spx.candles).toHaveLength(committed ? 32 : 30);
    expect(spx.missing_session_dates).toEqual(committed ? missing.slice(2) : missing);
    expect(spx.failure_reasons).toContain("AUTH_FAILED");
    expect(spx.session_coverage.ma20_eligible).toBe(false);
    expect(spx.resource_usage.request).toMatchObject({
      received_events: committed ? 67 : 65, retained_rows: committed ? 65 : 63,
      returned_rows: committed ? 65 : 63,
    });
    expect(spx.resource_usage.symbol.received_events).toBe(committed ? 33 : 31);
    expect(spx.recovery_diagnostics).toMatchObject({
      attempts: 2, failures: ["AUTH_FAILED"],
      recovered_session_dates: committed ? missing.slice(0, 2) : [],
      stopped_reason: "AUTH_FAILED_PRESERVED_COMMITTED_BARS",
      windows: [
        { start: "2026-09-28T13:30:00.000Z", end: "2026-09-30T20:00:00.000Z",
          failure_reason: "AUTH_FAILED", received_events: committed ? 1 : 0 },
        { start: "2026-09-28T13:30:00.000Z", end: "2026-09-30T20:00:00.000Z",
          failure_reason: "AUTH_FAILED", received_events: committed ? 1 : 0 },
      ],
    });
    expect(qqq).toMatchObject({
      status: "AVAILABLE", snapshot_complete: true, provider_snapshot_complete: true,
      session_coverage_complete: true, failure_reasons: [],
      transport_diagnostics: { snapshot_end_seen: true, received_session_dates: dailyFixture.expected_session_dates },
    });
    expect(qqq.candles).toHaveLength(33);
    expect(qqq.resource_usage.symbol.received_events).toBe(34);
    for (const result of [spx, qqq]) {
      expect(result.dxlink_auth).toMatchObject({ status: "FAILED", retry_count: 1, refresh_attempted: true });
      expect(result.provider_error).toEqual({ code: "UNAUTHORIZED", message: "Authentication failed" });
    }
    expect(sockets).toHaveLength(3);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
  });

  test("initial auth refresh and recovery rejection share exactly one refresh allowance", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets, quoteTokens } = dailyClient([
      { rows: [], unauthorizedTokens: ["synthetic-stale-token"] },
      dailyRows("SPY", dates),
      { rows: dailyRows("SPY", ["2026-10-08"], false), unauthorized: true },
    ]);
    const result = await client.getHistoricalCandles(dailyRequest());
    expect(result.status).toBe("PARTIAL");
    expect(result.failure_reasons).toContain("AUTH_FAILED");
    expect(result.dxlink_auth.status).toBe("FAILED");
    expect(result.candles).toHaveLength(33);
    expect(result.resource_usage.request.received_events).toBe(34);
    expect(result.recovery_diagnostics.windows).toHaveLength(1);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(3);
  });

  test.each([false, true])("recovery handshake rejection, repeated=%s, records every attempted window", async (repeated) => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets, quoteTokens } = dailyClient([
      dailyRows("SPY", dates),
      { rows: [], unauthorizedTokens: ["synthetic-stale-token"] },
      { rows: dailyRows("SPY", ["2026-10-08"]),
        unauthorizedTokens: repeated ? ["synthetic-fresh-token"] : [] },
    ]);
    const result = await client.getHistoricalCandles(dailyRequest());
    expect(result.candles).toHaveLength(repeated ? 32 : 33);
    expect(result.resource_usage.request.received_events).toBe(repeated ? 33 : 35);
    expect(result.dxlink_auth).toMatchObject({
      status: repeated ? "FAILED" : "REFRESHED", refresh_attempted: true, retry_count: 1,
    });
    expect(result.provider_error).toEqual({ code: "UNAUTHORIZED", message: "Authentication failed" });
    expect(result.recovery_diagnostics.windows).toMatchObject([
      { failure_reason: "AUTH_FAILED", received_events: 0, provider_snapshot_complete: false },
      { failure_reason: repeated ? "AUTH_FAILED" : null,
        received_events: repeated ? 0 : 2, provider_snapshot_complete: !repeated },
    ]);
    expect(result.recovery_diagnostics.failures).toEqual(repeated ? ["AUTH_FAILED"] : []);
    expect(sockets).toHaveLength(3);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
  });

  test("a recovery auth reconnect consumes the four-attempt batch allowance, not an extra window", async () => {
    const symbols = ["SPX", "SPY", "QQQ", "IWM"];
    const initial = symbols.flatMap((symbol) => dailyRows(symbol,
      dailyFixture.expected_session_dates.filter((date) => !dailyFixture.omissions[symbol].includes(date))));
    const { client, sockets, quoteTokens } = dailyClient([
      initial, dailyRows("SPX", dailyFixture.omissions.SPX), dailyRows("SPY", dailyFixture.omissions.SPY),
      { rows: dailyRows("QQQ", dailyFixture.omissions.QQQ, false), unauthorized: true },
      dailyRows("QQQ", dailyFixture.omissions.QQQ),
    ]);
    const results = await client.getHistoricalCandlesBatch({
      ...dailyRequest(), instruments: symbols.map((symbol) => ({
        symbol, instrument_type: symbol === "SPX" ? "INDEX" : "EQUITY",
      })),
    });
    expect(results.map((result) => result.recovery_diagnostics.attempts)).toEqual([1, 1, 2, 0]);
    expect(results.map((result) => result.candles.length)).toEqual([33, 33, 33, 32]);
    expect(results.map((result) => result.status)).toEqual(["AVAILABLE", "AVAILABLE", "AVAILABLE", "PARTIAL"]);
    expect(results[3].recovery_diagnostics.stopped_reason).toBe("RECOVERY_ATTEMPT_LIMIT");
    expect(results[0].resource_usage.request).toMatchObject({ received_events: 139, returned_rows: 131 });
    expect(sockets).toHaveLength(5);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
  });

  test.each([34, 35])("auth refresh retains an exact %i-event request cap", async (limit) => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets, quoteTokens } = dailyClient([
      dailyRows("SPY", dates),
      { rows: dailyRows("SPY", ["2026-10-08"], false), unauthorized: true },
      dailyRows("SPY", ["2026-10-08"]),
    ]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", { max_received_events: limit }));
    expect(result.status).toBe("PARTIAL");
    expect(result.candles).toHaveLength(33);
    expect(result.resource_usage.request.received_events).toBe(limit);
    expect(result.recovery_diagnostics.windows.map((window) => window.received_events))
      .toEqual(limit === 34 ? [1] : [1, 1]);
    expect(result.failure_reasons).toContain(limit === 34 ? "AUTH_FAILED" : "LOCAL_RECEIVE_BUDGET_EXCEEDED");
    expect(result.dxlink_auth.status).toBe(limit === 34 ? "NOT_CONFIRMED" : "REFRESHED");
    expect(result.provider_error.code).toBe("UNAUTHORIZED");
    expect(sockets).toHaveLength(limit === 34 ? 2 : 3);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
  });

  test("auth refresh cannot replenish output capacity already spent by committed recovery rows", async () => {
    const missing = dailyFixture.omissions.SPX;
    const { client } = dailyClient([
      dailyRows("SPX", dailyFixture.expected_session_dates.filter((date) => !missing.includes(date))),
      { rows: dailyRows("SPX", [missing[0]], false), unauthorized: true },
      dailyRows("SPX", missing.slice(1)),
    ]);
    const result = await client.getHistoricalCandles(dailyRequest("SPX", { max_output_candles: 32 }));
    expect(result.candles).toHaveLength(32);
    expect(result.missing_session_dates).toEqual([missing[2]]);
    expect(result.resource_usage.request.received_events).toBe(35);
    expect(result.failure_reasons).toContain("LOCAL_OUTPUT_BUDGET_EXCEEDED");
    expect(result.recovery_diagnostics.windows.map((window) => window.received_events)).toEqual([1, 3]);
  });

  test("token refresh latency consumes the original request deadline without opening a fresh socket", async () => {
    let now = Date.parse("2026-12-31T23:00:00Z");
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets, quoteTokens } = dailyClient([
      dailyRows("SPY", dates),
      { rows: dailyRows("SPY", ["2026-10-08"], false), unauthorized: true },
      dailyRows("SPY", ["2026-10-08"]),
    ], () => now, async (signal, request) => {
      if (request?.forceRefresh) now += 100;
    });
    const result = await client.getHistoricalCandles(dailyRequest("SPY", { deadline_ms: 100 }));
    expect(result.candles).toHaveLength(33);
    expect(result.status).toBe("PARTIAL");
    expect(result.dxlink_auth.status).toBe("NOT_CONFIRMED");
    expect(result.recovery_diagnostics.stopped_reason).toBe("SHARED_RESOURCE_BUDGET_EXHAUSTED");
    expect(result.resource_usage.request.received_events).toBe(34);
    expect(result.resource_usage.limits.deadline_ms_per_request).toBe(100);
    expect(sockets).toHaveLength(2);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
  });

  test("cancellation during authentication refresh stays explicit", async () => {
    const controller = new AbortController();
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets } = dailyClient([
      dailyRows("SPY", dates), { rows: [], unauthorized: true },
    ], undefined, async (signal, request) => {
      if (request?.forceRefresh) controller.abort();
    });
    await expect(client.getHistoricalCandles(dailyRequest("SPY", { signal: controller.signal })))
      .rejects.toMatchObject({ name: "HistoricalCandlesAbortedError" });
    expect(sockets).toHaveLength(2);
  });

  test("refresh acquisition failure retains committed evidence and sanitized AUTH_FAILED provenance", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets, quoteTokens } = dailyClient([
      dailyRows("SPY", dates),
      { rows: dailyRows("SPY", ["2026-10-08"], false), unauthorized: true },
    ], undefined, async (signal, request) => {
      if (request?.forceRefresh) throw new Error("Synthetic acquisition failure");
    });
    const result = await client.getHistoricalCandles(dailyRequest());
    expect(result).toMatchObject({
      status: "PARTIAL", failure_reasons: ["AUTH_FAILED"],
      dxlink_auth: { status: "FAILED", refresh_attempted: true, retry_count: 1 },
      provider_error: { code: "UNAUTHORIZED", message: "Authentication failed" },
    });
    expect(result.candles).toHaveLength(33);
    expect(result.resource_usage.request.received_events).toBe(34);
    expect(result.recovery_diagnostics.windows).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
  });

  test("a recovery failure before feed rows still records its zero-event attempt window", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets, quoteTokens } = dailyClient([
      dailyRows("SPY", dates),
      { rows: [], feedConfig: { type: "ERROR", error: "TEMPORARY_FAILURE" } },
    ]);
    const result = await client.getHistoricalCandles(dailyRequest());
    expect(result.status).toBe("PARTIAL");
    expect(result.candles).toHaveLength(32);
    expect(result.resource_usage.request.received_events).toBe(33);
    expect(result.recovery_diagnostics).toMatchObject({
      attempts: 1, failures: ["PROVIDER_TEMPORARY_FAILURE"],
      windows: [{
        start: "2026-10-08T13:30:00.000Z", end: "2026-10-08T20:00:00.000Z",
        failure_reason: "PROVIDER_TEMPORARY_FAILURE", provider_snapshot_complete: false,
        received_events: 0,
      }],
    });
    expect(sockets).toHaveLength(2);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(1);
    expect(quoteTokens.invalidateQuoteToken).not.toHaveBeenCalled();
  });

  test("a recovery socket construction failure does not erase the initial snapshot or attempted window", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const { client, sockets } = dailyClient([
      dailyRows("SPY", dates), { constructionError: true },
    ]);
    const result = await client.getHistoricalCandles(dailyRequest());
    expect(result.status).toBe("PARTIAL");
    expect(result.candles).toHaveLength(32);
    expect(result.resource_usage.request.received_events).toBe(33);
    expect(result.recovery_diagnostics).toMatchObject({
      attempts: 1, failures: ["PROVIDER_TEMPORARY_FAILURE"],
      windows: [{ failure_reason: "PROVIDER_TEMPORARY_FAILURE", received_events: 0 }],
    });
    expect(sockets).toHaveLength(1);
  });

  test("a refreshed recovery uses only buffer allowance left by initial and rejected-attempt evidence", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const initial = dailyRows("SPY", dates);
    const rejected = { rows: dailyRows("SPY", ["2026-10-08"], false), unauthorized: true };
    const baseline = dailyClient([initial, rejected], undefined, async (signal, request) => {
      if (request?.forceRefresh) throw new Error("Synthetic acquisition failure");
    });
    const measured = await baseline.client.getHistoricalCandles(dailyRequest());
    const originalRetained = measured.resource_usage.request.retained_bytes;
    const limit = Math.max(measured.resource_usage.request.peak_buffer_bytes, originalRetained) + 100;
    const remainingBytes = limit - originalRetained;
    const native = "SPY{=d,a=s,tho=true}";
    const expensive = [row(rthSession("2026-10-08").open, 4,
      "1".repeat(Math.ceil(remainingBytes / 4)), native), marker(0, native)];
    const wireBytes = Buffer.byteLength(JSON.stringify({
      type: "FEED_DATA", channel: 3, data: ["Candle", expensive.flat()],
    }));
    expect(wireBytes).toBeGreaterThan(remainingBytes);
    expect(wireBytes).toBeLessThan(limit);
    const { client, sockets, quoteTokens } = dailyClient([initial, rejected, expensive]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", { max_buffer_bytes: limit }));
    expect(result.candles).toHaveLength(33);
    expect(result.status).toBe("PARTIAL");
    expect(result.failure_reasons).toContain("LOCAL_BUFFER_BUDGET_EXCEEDED");
    expect(result.resource_usage.request.received_events).toBe(34);
    expect(result.resource_usage.request.retained_bytes).toBe(originalRetained);
    const pendingConfigBytes = Buffer.byteLength(JSON.stringify({ type: "FEED_CONFIG", channel: 3 }));
    expect(result.resource_usage.request.peak_buffer_bytes).toBe(originalRetained + wireBytes + pendingConfigBytes);
    expect(result.resource_usage.request.peak_buffer_bytes).toBeGreaterThan(limit);
    expect(result.recovery_diagnostics.windows.map((window) => window.received_events)).toEqual([1, 0]);
    expect(sockets).toHaveLength(3);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
  });

  test("partial initial timeout preserves IWM daily rows without spending a fresh retry deadline", async () => {
    const { client, sockets } = dailyClient([dailyRows("IWM", ["2026-10-07"], false)]);
    const result = await client.getHistoricalCandles(dailyRequest("IWM", {
      start_time: "2026-10-07T00:00:00Z", end_time: "2026-10-09T23:00:00Z", deadline_ms: 5,
    }));
    expect(result.candles).toHaveLength(1);
    expect(result.status).toBe("PARTIAL");
    expect(result.failure_reasons).toContain("PROVIDER_TIMEOUT");
    expect(result.snapshot_complete).toBe(false);
    expect(result.session_coverage_complete).toBe(false);
    expect(result.session_coverage.ma20_eligible).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  test.each(["BID", "ASK"])("RTH daily %s stays price-specific and reference-only", async (priceType) => {
    const native = `SPY{=d,a=s,tho=true,price=${priceType.toLowerCase()}}`;
    const { client, sockets } = dailyClient([[
      row(rthSession("2026-10-08").open, 4, "100", native), marker(0, native),
    ]]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", {
      price_type: priceType, start_time: "2026-10-08T00:00:00Z", end_time: "2026-10-08T23:00:00Z",
    }));
    expect(result.status).toBe("AVAILABLE");
    expect(result.price_type).toBe(priceType);
    expect(result.evidence_class).toBe("VALUATION_ONLY");
    expect(result.resampled).toBe(false);
    expect(sockets[0].sent.find((message) => message.add).add[0].symbol)
      .toBe(`SPY{=d,price=${priceType.toLowerCase()},a=s,tho=true}`);
    expect(result.warnings).toContain("VALUATION_ONLY_NOT_EXECUTABLE");
  });

  test("legacy option REGULAR daily timing is not promoted to the cash calendar", async () => {
    const symbol = ".SPXW261009C7800";
    const native = `${symbol}{=d,a=s,tho=true}`;
    const { client } = dailyClient([[
      row(rthSession("2026-10-08").open, 4, "100", native), marker(0, native),
    ]]);
    const result = await client.getHistoricalCandles(dailyRequest("SPXW  261009C07800000", {
      streamer_symbol: symbol, instrument_type: "OPTION",
      start_time: "2026-10-08T00:00:00Z", end_time: "2026-10-08T23:00:00Z",
    }));
    expect(result.status).toBe("AVAILABLE");
    expect(result.session_coverage_complete).toBeNull();
    expect(result.candles[0].session_timing).toBeUndefined();
    expect(result.candles[0].bar_end).toBe("2026-10-09T13:30:00.000Z");
  });

  test("recovery cannot spend a fresh buffer budget after the initial retained snapshot", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const initial = dailyRows("SPY", dates);
    const baseline = dailyClient([initial, dailyRows("SPY", [])]);
    const measured = await baseline.client.getHistoricalCandles(dailyRequest());
    const limit = measured.resource_usage.request.peak_buffer_bytes + 100;
    const expensiveRetry = [row(rthSession("2026-10-08").open, 4, "1".repeat(2000),
      "SPY{=d,a=s,tho=true}"), marker(0, "SPY{=d,a=s,tho=true}")];
    const { client, sockets } = dailyClient([initial, expensiveRetry]);
    const result = await client.getHistoricalCandles(dailyRequest("SPY", { max_buffer_bytes: limit }));
    expect(result.status).toBe("PARTIAL");
    expect(result.candles).toHaveLength(32);
    expect(sockets).toHaveLength(2);
    expect(result.resource_usage.request.retained_bytes).toBeLessThanOrEqual(limit);
    expect(result.failure_reasons).toContain("LOCAL_BUFFER_BUDGET_EXCEEDED");
  });

  test("one batch deadline bounds all retries, even when the injected market clock is fixed", async () => {
    const dates = dailyFixture.expected_session_dates.filter((date) => date !== "2026-10-08");
    const first = ["SPY", "QQQ", "IWM"].flatMap((symbol) => dailyRows(symbol, dates));
    const { client, sockets } = dailyClient([first, null]);
    const before = performance.now();
    const results = await client.getHistoricalCandlesBatch({
      ...dailyRequest(), instruments: ["SPY", "QQQ", "IWM"].map((symbol) => ({
        symbol, instrument_type: "EQUITY",
      })), deadline_ms: 15,
    });
    expect(performance.now() - before).toBeLessThan(100);
    expect(sockets).toHaveLength(2);
    expect(results.map((result) => result.candles.length)).toEqual([32, 32, 32]);
    expect(results[0].recovery_diagnostics.failures).toContain("PROVIDER_TIMEOUT");
    expect(results[1].recovery_diagnostics.attempts).toBe(0);
    expect(results[2].recovery_diagnostics.attempts).toBe(0);
  });

  test("long-window initial timeout reserves bounded time for a five-session native retry", async () => {
    const { client, sockets } = dailyClient([
      null, dailyRows("IWM", dailyFixture.expected_session_dates.slice(0, 5)),
    ]);
    const before = performance.now();
    const result = await client.getHistoricalCandles(dailyRequest("IWM", { deadline_ms: 100 }));
    expect(performance.now() - before).toBeLessThan(150);
    expect(sockets).toHaveLength(2);
    expect(result.status).toBe("PARTIAL");
    expect(result.snapshot_complete).toBe(false);
    expect(result.provider_snapshot_complete).toBe(false);
    expect(result.candles).toHaveLength(5);
    expect(result.missing_session_dates).toHaveLength(28);
    expect(result.failure_reasons).toContain("PROVIDER_TIMEOUT");
    expect(result.recovery_diagnostics.windows[0]).toMatchObject({
      start: "2026-08-25T13:30:00.000Z", end: "2026-08-31T20:00:00.000Z",
      received_events: 6, provider_snapshot_complete: true, failure_reason: null,
    });
    expect(result.transport_diagnostics.oldest_received_timestamp).toBe("2026-08-25T13:30:00.000Z");
    expect(result.recovery_diagnostics.stopped_reason).toBe("RECOVERY_WINDOW_LIMIT");
  });

  test("four-symbol native retries are isolated and capped at four attempts per request", async () => {
    const symbols = ["SPX", "SPY", "QQQ", "IWM"];
    const initial = symbols.flatMap((symbol) => dailyRows(symbol,
      dailyFixture.expected_session_dates.filter((date) => !dailyFixture.omissions[symbol].includes(date))));
    const { client, sockets } = dailyClient([
      initial, ...symbols.map((symbol) => dailyRows(symbol, dailyFixture.omissions[symbol])),
    ]);
    const results = await client.getHistoricalCandlesBatch({
      ...dailyRequest(), instruments: symbols.map((symbol) => ({
        symbol, instrument_type: symbol === "SPX" ? "INDEX" : "EQUITY",
      })),
    });
    expect(sockets).toHaveLength(5);
    expect(results.every((result) => result.status === "AVAILABLE" &&
      result.candles.length === 33 && result.recovery_diagnostics.attempts === 1)).toBe(true);
    expect(results[0].resource_usage.request.received_events).toBe(140);
    expect(results[0].resource_usage.request.returned_rows).toBe(132);
    expect(results[0].resource_usage.request.retained_bytes).toBeLessThanOrEqual(1_000_000);
  });
});

describe("DXLink candle normalization", () => {
  test.each(["BID", "ASK"])(
    "requests explicit %s aggregates without claiming executable quotes",
    async (priceType) => {
      const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
      const symbol = `SPY{price=${priceType.toLowerCase()},=m}`;
      const { client, getSocket } = clientWithRows([
        row(timestamp, 4, "100", symbol),
        marker(timestamp - 1, symbol),
      ]);
      const result = await client.getHistoricalCandles({
        symbol: "SPY",
        instrument_type: "EQUITY",
        interval: "1m",
        price_type: priceType,
        start_time: "2026-09-24T14:00:00.000Z",
        end_time: "2026-09-24T14:01:00.000Z",
      });
      const subscription = getSocket().sent.find(
        (message) => message.type === "FEED_SUBSCRIPTION" && message.add,
      );
      expect(subscription.add[0].symbol).toBe(
        `SPY{=m,price=${priceType.toLowerCase()}}`,
      );
      expect(result).toMatchObject({
        status: "AVAILABLE",
        price_type: priceType,
        evidence_class: "VALUATION_ONLY",
        candles: [
          expect.objectContaining({
            close: "100",
            available_at: "2026-09-24T14:01:00.000Z",
          }),
        ],
        warnings: expect.arrayContaining([
          "BID_ASK_CANDLE_AGGREGATES_NOT_SYNCHRONIZED_QUOTES",
          "BID_ASK_CANDLE_SIZES_UNAVAILABLE",
          "VALUATION_ONLY_NOT_EXECUTABLE",
        ]),
      });
      expect(result.candles[0].provider_evidence).toBeUndefined();
    },
  );

  test("preserves BID identity under regular-session alignment", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const symbol = "SPY{tho=true,price=bid,=m,a=s}";
    const { client, getSocket } = clientWithRows([
      row(timestamp, 4, "100", symbol),
      marker(timestamp - 1, symbol),
    ]);
    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      price_type: "BID",
      session: { kind: "REGULAR", timezone: "America/New_York" },
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
    });
    expect(getSocket().sent.find(
      (message) => message.type === "FEED_SUBSCRIPTION" && message.add,
    ).add[0].symbol).toBe("SPY{=m,price=bid,a=s,tho=true}");
    expect(result).toMatchObject({ status: "AVAILABLE", price_type: "BID" });
  });

  test("keeps omitted and explicit LAST request identities unchanged", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const request = {
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
    };
    const run = async (priceType) => clientWithRows([
      row(timestamp, 4, "100", "SPY{=m}"),
      marker(timestamp - 1, "SPY{=m}"),
    ]).client.getHistoricalCandles({ ...request, price_type: priceType });
    const omitted = await run(undefined);
    const explicit = await run("LAST");
    expect(omitted.request_id).toBe(explicit.request_id);
    expect(omitted.price_type).toBe("LAST");
    expect(omitted.warnings).not.toContain(
      "BID_ASK_CANDLE_AGGREGATES_NOT_SYNCHRONIZED_QUOTES",
    );
  });

  test("rejects invalid price types before subscribing", async () => {
    const { client, getSocket } = clientWithRows([]);
    await expect(client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      price_type: "MARK",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
    })).rejects.toThrow("price_type must be LAST, BID, or ASK.");
    expect(getSocket()).toBeUndefined();
  });

  test("does not substitute LAST data for a missing BID snapshot", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client } = clientWithRows([
      row(timestamp, 4, "100", "SPY{=m}"),
      marker(timestamp - 1, "SPY{=m}"),
    ]);
    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      price_type: "BID",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
      deadline_ms: 50,
    });
    expect(result).toMatchObject({
      status: "NOT_AVAILABLE",
      price_type: "BID",
      candles: [],
      failure_reasons: expect.arrayContaining(["SNAPSHOT_TIMEOUT"]),
      transport_diagnostics: {
        unmatched_received_symbols: ["SPY{=m}"],
      },
    });
  });

  test("retains snipped ASK evidence as unavailable without price-type fallback", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client, getSocket } = clientWithRows([
      marker(timestamp, "SPY{=m,price=ask}", 20),
    ]);
    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      price_type: "ASK",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
    });
    expect(result).toMatchObject({
      status: "NOT_AVAILABLE",
      price_type: "ASK",
      snapshot_truncated: true,
      failure_reasons: expect.arrayContaining(["PROVIDER_SNAPSHOT_SNIPPED"]),
    });
    expect(getSocket().sent.filter(
      (message) => message.type === "FEED_SUBSCRIPTION" && message.add,
    )).toHaveLength(1);
  });

  test("canonicalizes only semantically equivalent CandleSymbol aliases", () => {
    expect(
      canonicalizeDxlinkCandleSymbol(
        "SPX{tho=TRUE,price=LAST,a=SESSION,=1H}",
      ),
    ).toBe("SPX{=h,a=s,tho=true}");
    expect(
      canonicalizeDxlinkCandleSymbol(
        "SPX{=h,a=s,tho=true}",
      ),
    ).toBe("SPX{=h,a=s,tho=true}");
    expect(
      canonicalizeDxlinkCandleSymbol(
        "SPX{=h,a=midnight,price=last,tho=false}",
      ),
    ).toBe("SPX{=h}");

    const nativeHour = canonicalizeDxlinkCandleSymbol("SPX{=h}");
    expect(canonicalizeDxlinkCandleSymbol("SPX{=60m}")).not.toBe(
      nativeHour,
    );
    expect(
      canonicalizeDxlinkCandleSymbol("SPX{=h,tho=true}"),
    ).not.toBe(nativeHour);
    expect(
      canonicalizeDxlinkCandleSymbol("SPX{=h,a=s}"),
    ).not.toBe(nativeHour);
    expect(
      canonicalizeDxlinkCandleSymbol("SPX{=h,price=bid}"),
    ).not.toBe(nativeHour);
    expect(canonicalizeDxlinkCandleSymbol("SPY{=h}")).not.toBe(
      nativeHour,
    );
  });

  test("maps the sanitized native-hour response alias and preserves transport diagnostics", async () => {
    const { client, getSocket } = clientWithRows(
      nativeHourRows,
      () => Date.parse("2026-09-25T12:00:00.000Z"),
      {
        feedConfig: nativeHourFixture.feed_config,
        useBlob: true,
      },
    );

    const result = await client.getHistoricalCandles({
      symbol: "SPX",
      streamer_symbol: "SPX",
      instrument_type: "INDEX",
      interval: "1h",
      start_time: "2026-08-25T13:30:00.000Z",
      end_time: "2026-08-25T15:00:00.000Z",
      deadline_ms: 100,
    });

    const subscription = getSocket().sent.find(
      (message) => message.type === "FEED_SUBSCRIPTION" && message.add,
    );
    expect(subscription.add[0].symbol).toBe("SPX{=h}");
    expect(result).toMatchObject({
      status: "AVAILABLE",
      snapshot_complete: true,
      provider_snapshot_complete: true,
      retrieved_at: "2026-09-25T12:00:00.000Z",
      resolution_profile: {
        profile_id: "DIRECT_CANDLE_REQUEST",
        requested_aggregation: "1h",
        native_aggregation: "h",
        effective_aggregation: "1h",
      },
      candles: [
        expect.objectContaining({
          source_time: "2026-08-25T14:00:00.000Z",
          bar_start: "2026-08-25T14:00:00.000Z",
          bar_end: "2026-08-25T15:00:00.000Z",
          available_at: "2026-08-25T15:00:00.000Z",
          retrieved_at: "2026-09-25T12:00:00.000Z",
          close: "100.5",
        }),
      ],
      transport_diagnostics: {
        requested_symbol: "SPX{=h}",
        canonical_requested_symbol: "SPX{=h}",
        received_symbols: ["SPX{=h}"],
        canonical_received_symbols: ["SPX{=h}"],
        oldest_received_timestamp: "2026-08-25T14:00:00.000Z",
        newest_received_timestamp: "2026-08-25T14:00:00.000Z",
        snapshot_begin_seen: true,
        snapshot_end_seen: true,
        snapshot_snip_seen: false,
        timeout_stage: null,
      },
    });
  });

  test("uses the explicit native-hour RTH profile and session alignment", async () => {
    const barStart = Date.parse("2026-03-09T13:30:00.000Z");
    const { client, getSocket } = clientWithRows([
      row(barStart, 0, "100", "SPX{=h,a=s,tho=true}"),
      marker(barStart - 1, "SPX{=h,a=s,tho=true}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPX",
      instrument_type: "INDEX",
      interval: "1h",
      start_time: "2026-03-09T13:30:00.000Z",
      end_time: "2026-03-09T14:30:00.000Z",
      resolution_profile: {
        profile_id: "HOURLY_VALUATION_RESEARCH",
        profile_version: "1.0.0",
      },
    });

    const subscription = getSocket().sent.find(
      (message) => message.type === "FEED_SUBSCRIPTION" && message.add,
    );
    expect(subscription.add[0].symbol).toBe("SPX{=h,a=s,tho=true}");
    expect(result).toMatchObject({
      timezone: "America/New_York",
      session: "REGULAR",
      resolution_profile: {
        profile_id: "HOURLY_VALUATION_RESEARCH",
        requested_aggregation: "1h",
        native_aggregation: "h",
        effective_aggregation: "1h",
        alignment: "SESSION",
      },
      candles: [
        expect.objectContaining({
          bar_start: "2026-03-09T13:30:00.000Z",
          bar_end: "2026-03-09T14:30:00.000Z",
          available_at: "2026-03-09T14:30:00.000Z",
        }),
      ],
    });
  });

  test("keeps native HOUR distinct from a 60-minute aggregation", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client, getSocket } = clientWithRows([
      row(timestamp, 0, "100", "SPY{=60m}"),
      marker(timestamp - 1, "SPY{=60m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "60m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T15:00:00.000Z",
    });

    const subscription = getSocket().sent.find(
      (message) => message.type === "FEED_SUBSCRIPTION" && message.add,
    );
    expect(subscription.add[0].symbol).toBe("SPY{=60m}");
    expect(result.status).toBe("AVAILABLE");
  });

  test("parses flat compact rows and snapshot markers", () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const parsed = parseDxlinkCandleData([
      "Candle",
      [...row(timestamp, 4), ...marker(timestamp - 1)],
    ]);

    expect(parsed.candles).toHaveLength(1);
    expect(parsed.snapshotComplete).toBe(true);
    expect(parsed.snapshotTruncated).toBe(false);
  });

  test("finishes an empty marker-only snapshot without waiting for OHLC", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client } = clientWithRows([
      marker(timestamp, "SPY{=m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
      deadline_ms: 100,
    });

    expect(result).toMatchObject({
      status: "NOT_AVAILABLE",
      snapshot_complete: true,
      provider_snapshot_complete: true,
      failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
      transport_diagnostics: {
        snapshot_end_seen: true,
        timeout_stage: null,
      },
    });
  });

  test("applies REMOVE_EVENT to the retained indexed snapshot", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client } = clientWithRows([
      row(timestamp, 4, "100", "SPY{=m}", "same-index"),
      marker(timestamp, "SPY{=m}", 2, "same-index"),
      marker(timestamp - 1, "SPY{=m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
    });

    expect(result.candles).toEqual([]);
    expect(result.resource_usage.symbol).toMatchObject({
      unique_observations: 1,
      retained_rows: 0,
      returned_rows: 0,
    });
    expect(result.snapshot_complete).toBe(true);
  });

  test("waits for TX_PENDING to clear before committing an END transaction", async () => {
    const earlier = Date.parse("2026-09-24T14:00:00.000Z");
    const later = Date.parse("2026-09-24T14:01:00.000Z");
    const { client } = clientWithRows([
      row(later, 5, "101", "SPY{=m}", "later"),
      marker(earlier - 1, "SPY{=m}", 9, "boundary"),
      row(earlier, 0, "99", "SPY{=m}", "earlier"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:02:00.000Z",
      deadline_ms: 100,
    });

    expect(result.candles.map((candle) => candle.close)).toEqual([
      "99",
      "101",
    ]);
    expect(result.snapshot_complete).toBe(true);
    expect(result.transport_diagnostics).toMatchObject({
      snapshot_begin_seen: true,
      snapshot_end_seen: true,
      timeout_stage: null,
    });
  });

  test("does not complete on an END marker while TX_PENDING remains set", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client } = clientWithRows([
      row(timestamp, 5, "100", "SPY{=m}", "pending"),
      marker(timestamp - 1, "SPY{=m}", 9, "boundary"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
      deadline_ms: 5,
    });

    expect(result).toMatchObject({
      status: "NOT_AVAILABLE",
      snapshot_complete: false,
      provider_snapshot_complete: false,
      failure_reasons: expect.arrayContaining(["SNAPSHOT_TIMEOUT"]),
      transport_diagnostics: {
        snapshot_begin_seen: true,
        snapshot_end_seen: true,
        timeout_stage: "SNAPSHOT",
      },
    });
  });

  test("preserves completed symbols when another symbol times out", async () => {
    const firstSymbol = ".SPXW260922C7900{=5m}";
    const secondSymbol = ".SPXW260922P7400{=5m}";
    const timestamp = Date.parse("2026-08-25T13:55:00.000Z");
    const { client } = clientWithRows([
      row(timestamp, 4, "24", firstSymbol),
      marker(timestamp - 1, firstSymbol),
      row(timestamp, 4, "35", secondSymbol),
    ]);

    const results = await client.getHistoricalCandlesBatch({
      instruments: [
        {
          symbol: "SPXW  260922C07900000",
          streamer_symbol: ".SPXW260922C7900",
          instrument_type: "OPTION",
        },
        {
          symbol: "SPXW  260922P07400000",
          streamer_symbol: ".SPXW260922P7400",
          instrument_type: "OPTION",
        },
      ],
      interval: "5m",
      start_time: "2026-08-25T13:50:00.000Z",
      end_time: "2026-08-25T14:00:00.000Z",
      deadline_ms: 5,
    });

    expect(results[0]).toMatchObject({
      status: "AVAILABLE",
      snapshot_complete: true,
      failure_reasons: [],
      transport_diagnostics: {
        timeout_stage: null,
      },
    });
    expect(results[1]).toMatchObject({
      status: "PARTIAL",
      snapshot_complete: false,
      failure_reasons: expect.arrayContaining(["SNAPSHOT_TIMEOUT"]),
      transport_diagnostics: {
        timeout_stage: "SNAPSHOT",
      },
    });
  });

  test("keeps END and SNIP outcomes separate in one batch", async () => {
    const firstSymbol = ".SPXW260922C7900{=5m}";
    const secondSymbol = ".SPXW260922P7400{=5m}";
    const timestamp = Date.parse("2026-08-25T13:55:00.000Z");
    const { client } = clientWithRows([
      row(timestamp, 4, "24", firstSymbol),
      marker(timestamp - 1, firstSymbol),
      row(timestamp, 4, "35", secondSymbol),
      marker(timestamp - 1, secondSymbol, 16),
    ]);

    const results = await client.getHistoricalCandlesBatch({
      instruments: [
        {
          symbol: "SPXW  260922C07900000",
          streamer_symbol: ".SPXW260922C7900",
          instrument_type: "OPTION",
        },
        {
          symbol: "SPXW  260922P07400000",
          streamer_symbol: ".SPXW260922P7400",
          instrument_type: "OPTION",
        },
      ],
      interval: "5m",
      start_time: "2026-08-25T13:50:00.000Z",
      end_time: "2026-08-25T14:00:00.000Z",
    });

    expect(results[0]).toMatchObject({
      status: "AVAILABLE",
      snapshot_complete: true,
      snapshot_truncated: false,
    });
    expect(results[1]).toMatchObject({
      status: "PARTIAL",
      snapshot_complete: false,
      snapshot_truncated: true,
      failure_reasons: expect.arrayContaining([
        "PROVIDER_SNAPSHOT_SNIPPED",
      ]),
    });
  });

  test("does not match a semantically different received aggregation", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client } = clientWithRows([
      row(timestamp, 4, "100", "SPY{=60m}"),
      marker(timestamp - 1, "SPY{=60m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1h",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T15:00:00.000Z",
      deadline_ms: 5,
    });

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.failure_reasons).toEqual(
      expect.arrayContaining([
        "SNAPSHOT_TIMEOUT",
        "MISSING_CONTRACT_EVIDENCE",
      ]),
    );
    expect(result.resource_usage.request).toMatchObject({
      unmatched_received_events: 2,
      unmatched_symbol_count: 1,
    });
    expect(result.transport_diagnostics).toMatchObject({
      requested_symbol: "SPY{=h}",
      canonical_requested_symbol: "SPY{=h}",
      received_symbols: [],
      unmatched_received_symbols: ["SPY{=60m}"],
      timeout_stage: "SNAPSHOT",
    });
  });

  test("surfaces a provider SNIP as a per-symbol partial result", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client } = clientWithRows([
      row(timestamp, 0, "100", "SPY{=1m}"),
      marker(timestamp - 1, "SPY{=1m}", 16),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
    });

    expect(result).toMatchObject({
      status: "PARTIAL",
      snapshot_complete: false,
      snapshot_truncated: true,
      provider_snapshot_complete: false,
      failure_reasons: expect.arrayContaining([
        "PROVIDER_SNAPSHOT_SNIPPED",
      ]),
    });
  });

  test("filters a regular-session window without resampling", async () => {
    const times = [
      "2026-09-24T12:00:00.000Z",
      "2026-09-24T14:00:00.000Z",
      "2026-09-24T19:00:00.000Z",
      "2026-09-24T20:00:00.000Z",
    ].map(Date.parse);
    const { client, getSocket } = clientWithRows([
      row(times[1], 0, "100", "SPY{=1h,a=s,tho=true}"),
      row(times[2], 0, "100", "SPY{=1h,a=s,tho=true}"),
      marker(times[0] - 1, "SPY{=1h,a=s,tho=true}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1h",
      start_time: "2026-09-24T12:00:00.000Z",
      end_time: "2026-09-24T21:00:00.000Z",
      session: { kind: "REGULAR" },
    });

    expect(result.candles.map((candle) => candle.source_time)).toEqual([
      "2026-09-24T14:00:00.000Z",
      "2026-09-24T19:00:00.000Z",
    ]);
    expect(result.timezone).toBe("America/New_York");
    expect(result.resampled).toBe(false);
    const subscription = getSocket().sent.find(
      (message) => message.type === "FEED_SUBSCRIPTION" && message.add,
    );
    expect(subscription.add[0].fromTime).toBe(
      Date.parse("2026-09-24T12:00:00.000Z"),
    );
    expect(subscription.add[0].symbol).toBe(
      "SPY{=h,a=s,tho=true}",
    );
  });

  test("retrieves multiple historical candle symbols in one snapshot", async () => {
    const firstSymbol = ".SPXW260922C7900{=5m}";
    const secondSymbol = ".SPXW260922P7400{=5m}";
    const firstTime = Date.parse("2026-08-25T13:55:00.000Z");
    const secondTime = Date.parse("2026-08-25T13:50:00.000Z");
    const { client, getSocket } = clientWithRows([
      row(firstTime, 4, "24.52", firstSymbol),
      marker(firstTime - 1, firstSymbol),
      row(secondTime, 4, "35.86", secondSymbol),
      marker(secondTime - 1, secondSymbol),
    ]);

    const results = await client.getHistoricalCandlesBatch({
      instruments: [
        {
          symbol: "SPXW  260922C07900000",
          streamer_symbol: ".SPXW260922C7900",
          instrument_type: "OPTION",
        },
        {
          symbol: "SPXW  260922P07400000",
          streamer_symbol: ".SPXW260922P7400",
          instrument_type: "OPTION",
        },
      ],
      interval: "5m",
      start_time: "2026-08-25T13:30:00.000Z",
      end_time: "2026-08-25T14:30:00.000Z",
      session: { kind: "ALL" },
    });

    expect(results).toHaveLength(2);
    expect(results[0].candles).toEqual([
      expect.objectContaining({
        source_time: "2026-08-25T13:55:00.000Z",
        close: "24.52",
      }),
    ]);
    expect(results[1].candles).toEqual([
      expect.objectContaining({
        source_time: "2026-08-25T13:50:00.000Z",
        close: "35.86",
      }),
    ]);
    const subscription = getSocket().sent.find(
      (message) => message.type === "FEED_SUBSCRIPTION" && message.add,
    );
    expect(subscription.add).toEqual([
      {
        type: "Candle",
        symbol: firstSymbol,
        fromTime: Date.parse("2026-08-25T13:30:00.000Z"),
      },
      {
        type: "Candle",
        symbol: secondSymbol,
        fromTime: Date.parse("2026-08-25T13:30:00.000Z"),
      },
    ]);
  });

  test("supports a non-standard overnight session", async () => {
    const times = [
      "2026-09-25T02:00:00.000Z",
      "2026-09-25T08:00:00.000Z",
      "2026-09-25T10:00:00.000Z",
    ].map(Date.parse);
    const { client } = clientWithRows([
      row(times[0], 4),
      row(times[1]),
      row(times[2]),
      marker(times[0] - 1),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1h",
      start_time: "2026-09-25T00:00:00.000Z",
      end_time: "2026-09-25T11:00:00.000Z",
      session: {
        kind: "CUSTOM",
        timezone: "America/New_York",
        start_time: "18:00",
        end_time: "05:00",
      },
    });

    expect(result.candles.map((candle) => candle.source_time)).toEqual([
      "2026-09-25T02:00:00.000Z",
      "2026-09-25T08:00:00.000Z",
    ]);
    expect(result.session).toBe("CUSTOM");
    expect(result.warnings).toContain(
      "CUSTOM_SESSION_FILTERS_COMPLETE_SOURCE_BARS_WITHOUT_REAGGREGATION",
    );
  });

  test("rejects a quote-token target outside dxfeed.com", async () => {
    const client = new TastytradeHistoricalCandlesClient(
      { getAccessToken: async () => "access-token" },
      {
        get: async () => ({
          data: {
            data: {
              token: "quote-token",
              "dxlink-url": "wss://attacker.example/realtime",
            },
          },
        }),
      },
      () => {
        throw new Error("socket must not be created");
      },
      () => Date.parse("2026-09-25T12:00:00.000Z"),
    );

    await expect(
      client.getHistoricalCandles({
        symbol: "SPY",
        instrument_type: "EQUITY",
        interval: "1h",
        start_time: "2026-09-24T14:00:00.000Z",
        end_time: "2026-09-24T15:00:00.000Z",
      }),
    ).rejects.toThrow("Expected a dxfeed.com host over wss");
  });

  test("refreshes credentials and reconnects once after UNAUTHORIZED", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client, quoteTokens, sockets } = clientWithAuthTokens(
      [
        row(timestamp, 4),
        marker(timestamp - 1),
      ],
      ["synthetic-stale-token", "synthetic-fresh-token"],
      ["synthetic-stale-token"],
    );

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1h",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T15:00:00.000Z",
      deadline_ms: 1000,
    });

    expect(result).toMatchObject({
      status: "AVAILABLE",
      snapshot_complete: true,
      dxlink_auth: {
        status: "REFRESHED",
        token_source: "QUOTE_TOKEN_PROVIDER",
        token_reused: false,
        refresh_attempted: true,
        retry_count: 1,
      },
      provider_error: {
        code: "UNAUTHORIZED",
        message: "Authentication failed",
      },
    });
    expect(result.candles).toHaveLength(1);
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(
      sockets.map(
        (socket) =>
          socket.sent.find((message) => message.type === "AUTH").token,
      ),
    ).toEqual([
      "synthetic-stale-token",
      "synthetic-fresh-token",
    ]);
  });

  test("fails with AUTH_FAILED after one candle reconnect retry", async () => {
    const timestamp = Date.parse("2026-09-24T14:00:00.000Z");
    const { client, quoteTokens, sockets } = clientWithAuthTokens(
      [
        row(timestamp, 4),
        marker(timestamp - 1),
      ],
      ["synthetic-stale-token", "synthetic-fresh-token"],
      ["synthetic-stale-token", "synthetic-fresh-token"],
    );

    let caught;
    try {
      await client.getHistoricalCandles({
        symbol: "SPY",
        instrument_type: "EQUITY",
        interval: "1h",
        start_time: "2026-09-24T14:00:00.000Z",
        end_time: "2026-09-24T15:00:00.000Z",
        deadline_ms: 1000,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "AUTH_FAILED",
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
    expect(caught.message).not.toContain("synthetic-stale-token");
    expect(caught.message).not.toContain("synthetic-fresh-token");
    expect(quoteTokens.invalidateQuoteToken).toHaveBeenCalledTimes(1);
    expect(quoteTokens.getQuoteToken).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  test("treats an old calendar replay estimate as advisory when actual events fit", async () => {
    const timestamp = Date.parse("2026-03-02T14:30:00.000Z");
    const { client, getSocket } = clientWithRows([
      row(timestamp, 0, "100", "SPY{=1m}"),
      marker(timestamp - 1, "SPY{=1m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-03-02T14:30:00.000Z",
      end_time: "2026-03-02T14:31:00.000Z",
      max_candles: 20,
    });

    expect(result.status).toBe("AVAILABLE");
    expect(result.candles).toHaveLength(1);
    expect(result.advisory.continuous_calendar_replay_slots_per_symbol).toBeGreaterThan(
      20,
    );
    expect(result.advisory.continuous_calendar_replay_is_provider_fact).toBe(
      false,
    );
    expect(result.resource_usage.limits).toMatchObject({
      max_output_candles_per_symbol: 20,
      max_received_events_per_request: 20,
      max_candles_compatibility_applied: true,
    });
    expect(getSocket()).toBeDefined();
  });

  test("fails closed with an explicit aggregate receive-budget reason and cleans up", async () => {
    const start = Date.parse("2026-09-24T14:00:00.000Z");
    const { client, getSocket } = clientWithRows([
      row(start, 0, "100", "SPY{=1m}"),
      row(start + 60_000, 0, "100", "SPY{=1m}"),
      marker(start - 1, "SPY{=1m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:02:00.000Z",
      max_output_candles: 10,
      max_received_events: 2,
      max_buffer_bytes: 1_000_000,
    });

    expect(result.status).toBe("PARTIAL");
    expect(result.snapshot_complete).toBe(false);
    expect(result.failure_reasons).toContain(
      "LOCAL_RECEIVE_BUDGET_EXCEEDED",
    );
    expect(result.resource_usage.request.received_events).toBe(3);
    expect(getSocket().sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "FEED_SUBSCRIPTION",
          remove: [{ type: "Candle", symbol: "SPY{=m}" }],
        }),
      ]),
    );
    expect(getSocket().closeCalls).toHaveLength(1);
  });

  test("fails closed with an explicit aggregate buffer-budget reason and cleans up", async () => {
    const start = Date.parse("2026-09-24T14:00:00.000Z");
    const { client, getSocket } = clientWithRows([
      row(start, 0, "100", "SPY{=1m}"),
      marker(start - 1, "SPY{=1m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
      max_output_candles: 10,
      max_received_events: 10,
      max_buffer_bytes: 64,
    });

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.snapshot_complete).toBe(false);
    expect(result.failure_reasons).toContain(
      "LOCAL_BUFFER_BUDGET_EXCEEDED",
    );
    expect(result.resource_usage.request.peak_buffer_bytes).toBeGreaterThan(
      result.resource_usage.limits.max_buffer_bytes_per_request,
    );
    expect(getSocket().closeCalls).toHaveLength(1);
  });

  test("isolates a per-symbol output-budget failure in a multi-symbol batch", async () => {
    const firstSymbol = ".SPXW260922C7900{=5m}";
    const secondSymbol = ".SPXW260922P7400{=5m}";
    const firstTime = Date.parse("2026-08-25T13:50:00.000Z");
    const secondTime = Date.parse("2026-08-25T13:55:00.000Z");
    const { client, getSocket } = clientWithRows([
      row(firstTime, 0, "24", firstSymbol),
      row(secondTime, 0, "25", firstSymbol),
      row(secondTime, 0, "35", secondSymbol),
      marker(firstTime - 1, firstSymbol),
      marker(firstTime - 1, secondSymbol),
    ]);

    const results = await client.getHistoricalCandlesBatch({
      instruments: [
        {
          symbol: "SPXW  260922C07900000",
          streamer_symbol: ".SPXW260922C7900",
          instrument_type: "OPTION",
        },
        {
          symbol: "SPXW  260922P07400000",
          streamer_symbol: ".SPXW260922P7400",
          instrument_type: "OPTION",
        },
      ],
      interval: "5m",
      start_time: "2026-08-25T13:50:00.000Z",
      end_time: "2026-08-25T14:00:00.000Z",
      max_output_candles: 1,
      max_received_events: 10,
      max_buffer_bytes: 1_000_000,
    });

    expect(results[0]).toMatchObject({
      status: "PARTIAL",
      snapshot_complete: false,
      provider_snapshot_complete: true,
      failure_reasons: expect.arrayContaining([
        "LOCAL_OUTPUT_BUDGET_EXCEEDED",
      ]),
    });
    expect(results[0].candles).toHaveLength(1);
    expect(results[1]).toMatchObject({
      status: "AVAILABLE",
      snapshot_complete: true,
      provider_snapshot_complete: true,
      failure_reasons: [],
    });
    expect(results[1].candles).toHaveLength(1);
    expect(results[1].resource_usage.request.returned_rows).toBe(2);
    expect(getSocket().closeCalls).toHaveLength(1);
  });

  test("deduplicates updates and sorts out-of-order observations without timestamp completion assumptions", async () => {
    const earlier = Date.parse("2026-09-24T14:00:00.000Z");
    const later = Date.parse("2026-09-24T14:01:00.000Z");
    const { client } = clientWithRows([
      row(later, 0, "101", "SPY{=1m}", "later"),
      row(earlier, 0, "99", "SPY{=1m}", "earlier"),
      row(later, 0, "102", "SPY{=1m}", "later"),
      marker(earlier - 1, "SPY{=1m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:02:00.000Z",
      max_output_candles: 10,
      max_received_events: 10,
      max_buffer_bytes: 1_000_000,
    });

    expect(result.candles.map((candle) => candle.source_time)).toEqual([
      "2026-09-24T14:00:00.000Z",
      "2026-09-24T14:01:00.000Z",
    ]);
    expect(result.candles.at(-1).close).toBe("102");
    expect(result.resource_usage.symbol).toMatchObject({
      received_events: 4,
      valid_candle_events: 3,
      unique_observations: 2,
      retained_rows: 2,
      returned_rows: 2,
    });
  });

  test("reports an uncovered requested window separately from protocol completion", async () => {
    const timestamp = Date.parse("2026-09-24T14:09:00.000Z");
    const { client } = clientWithRows([
      row(timestamp, 0, "100", "SPY{=1m}"),
      marker(timestamp - 1, "SPY{=1m}"),
    ]);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:10:00.000Z",
    });

    expect(result).toMatchObject({
      status: "PARTIAL",
      snapshot_complete: true,
      provider_snapshot_complete: true,
      failure_reasons: expect.arrayContaining([
        "REQUESTED_WINDOW_NOT_COVERED",
      ]),
    });
  });

  test("returns an explicit deadline result and releases the subscription", async () => {
    const { client, getSocket } = clientWithRows(null);

    const result = await client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
      deadline_ms: 5,
      max_buffer_bytes: 1_000_000,
    });

    expect(result).toMatchObject({
      status: "NOT_AVAILABLE",
      snapshot_complete: false,
      provider_snapshot_complete: false,
      failure_reasons: expect.arrayContaining([
        "SNAPSHOT_TIMEOUT",
        "MISSING_CONTRACT_EVIDENCE",
      ]),
    });
    expect(getSocket().sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "FEED_SUBSCRIPTION",
          remove: [{ type: "Candle", symbol: "SPY{=m}" }],
        }),
      ]),
    );
    expect(getSocket().closeCalls).toHaveLength(1);
  });

  test("aborts an active snapshot and releases the subscription", async () => {
    const { client, getSocket } = clientWithRows(null);
    const controller = new AbortController();
    const request = client.getHistoricalCandles({
      symbol: "SPY",
      instrument_type: "EQUITY",
      interval: "1m",
      start_time: "2026-09-24T14:00:00.000Z",
      end_time: "2026-09-24T14:01:00.000Z",
      deadline_ms: 1000,
      max_buffer_bytes: 1_000_000,
      signal: controller.signal,
    });
    const rejection = expect(request).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      retryable: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();

    await rejection;
    expect(getSocket().sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "FEED_SUBSCRIPTION",
          remove: [{ type: "Candle", symbol: "SPY{=m}" }],
        }),
      ]),
    );
    expect(getSocket().closeCalls).toHaveLength(1);
  });

  test("rejects ambiguous legacy and explicit budget combinations", async () => {
    const { client } = clientWithRows([]);

    await expect(
      client.getHistoricalCandles({
        symbol: "SPY",
        instrument_type: "EQUITY",
        interval: "1m",
        start_time: "2026-09-24T14:00:00.000Z",
        end_time: "2026-09-24T14:01:00.000Z",
        max_candles: 10,
        max_output_candles: 10,
      }),
    ).rejects.toThrow(
      "max_candles cannot be combined with max_output_candles or max_received_events",
    );
  });
});
