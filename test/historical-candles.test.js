import { describe, expect, test } from "@jest/globals";
import {
  TastytradeHistoricalCandlesClient,
  parseDxlinkCandleData,
} from "../dist/historical-candles.js";

const FIELDS_PER_ROW = 17;

function row(time, flags = 0, price = "100") {
  return [
    "Candle",
    "SPY{=1h}",
    flags,
    String(time),
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

function marker(time) {
  const value = row(time, 10);
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

  constructor(rows) {
    this.rows = rows;
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
        this.emit({ type: "FEED_CONFIG", channel: 3 });
      } else if (message.type === "FEED_SUBSCRIPTION" && message.add) {
        this.emit({
          type: "FEED_DATA",
          channel: 3,
          data: ["Candle", this.rows.flat()],
        });
      }
    });
  }

  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

function clientWithRows(rows) {
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
      socket = new FakeSocket(rows);
      return socket;
    },
    () => Date.parse("2026-09-25T12:00:00.000Z"),
  );
  return { client, getSocket: () => socket };
}

describe("DXLink candle normalization", () => {
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

  test("filters a regular-session window without resampling", async () => {
    const times = [
      "2026-09-24T12:00:00.000Z",
      "2026-09-24T14:00:00.000Z",
      "2026-09-24T19:00:00.000Z",
      "2026-09-24T20:00:00.000Z",
    ].map(Date.parse);
    const { client, getSocket } = clientWithRows([
      row(times[1]),
      row(times[2]),
      marker(times[0] - 1),
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
      "SPY{=1h,a=s,tho=true}",
    );
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

  test("bounds the raw DXLink replay before opening a socket", async () => {
    const client = new TastytradeHistoricalCandlesClient(
      { getAccessToken: async () => "access-token" },
      {
        get: async () => {
          throw new Error("quote token must not be requested");
        },
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
        interval: "1m",
        start_time: "2026-09-24T12:00:00.000Z",
        end_time: "2026-09-24T12:10:00.000Z",
        max_candles: 20,
      }),
    ).rejects.toThrow("replays from start_time through the present");
  });
});
