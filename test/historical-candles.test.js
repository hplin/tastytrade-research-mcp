import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";
import {
  TastytradeHistoricalCandlesClient,
  canonicalizeDxlinkCandleSymbol,
  parseDxlinkCandleData,
} from "../dist/historical-candles.js";

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
        this.emit({ type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" });
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

describe("DXLink candle normalization", () => {
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
      candles: [
        expect.objectContaining({
          source_time: "2026-08-25T14:00:00.000Z",
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
