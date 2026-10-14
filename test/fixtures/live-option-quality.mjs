import { TastytradeLiveOptionSnapshotClient } from "../../dist/live-option-snapshot.js";

// Synthetic LIVE_SUPPORT events only; no captured provider payloads or network access.
export const NOW = Date.parse("2026-10-14T14:00:00.000Z");
export const POLICY = {
  max_quote_age_ms: 5000,
  max_greeks_age_ms: 5000,
  max_iv_age_ms: 5000,
  max_quote_greek_skew_ms: 1000,
  max_cross_leg_skew_ms: 1000,
  max_receive_skew_ms: 1000,
  require_quote_size: true,
  require_open_interest: true,
  require_volume: false,
  session: {
    start_at: "2026-10-14T13:30:00.000Z",
    end_at: "2026-10-14T20:00:00.000Z",
    time_zone: "America/New_York",
    utc_offset_minutes: -240,
  },
};

export function mockLiveOptionPackage({
  legCount = 2,
  calendar = false,
  missingChainLeg = false,
  mutateEvent = () => {},
  mutateChain = () => {},
  policy = POLICY,
  reorderFields = true,
  omitFields = {},
  missingEventLeg = false,
  root = "SPXW",
  dispatchFeedData = (message, socket) => socket.emit(message),
  clientOptions = {},
} = {}) {
  const legs = Array.from({ length: legCount }, (_, index) => {
    const expiration = root === "SPX"
      ? (calendar && index >= legCount / 2 ? "2026-11-20" : "2026-10-16")
      : (calendar && index >= legCount / 2 ? "2026-10-15" : "2026-10-14");
    const compact = expiration.replaceAll("-", "").slice(2);
    const strike = 6000 + index * 5;
    return {
      provider_symbol: `${root.padEnd(6)}${compact}C${String(strike * 1000).padStart(8, "0")}`,
      action: index % 2 ? "SELL_TO_OPEN" : "BUY_TO_OPEN",
      ratio: legCount === 3 && index === 1 ? 2 : 1,
      settlement: root === "SPXW" ? "PM" : "AM",
      multiplier: "100",
      exercise_style: "EUROPEAN",
    };
  });
  const expirations = [...new Set(legs.map((leg) =>
    `20${leg.provider_symbol.slice(6, 8)}-${leg.provider_symbol.slice(8, 10)}-${leg.provider_symbol.slice(10, 12)}`,
  ))];
  const items = [{
    "underlying-symbol": "SPX",
    "root-symbol": root,
    "shares-per-contract": 100,
    expirations: expirations.map((expiration) => ({
      "expiration-date": expiration,
      "days-to-expiration": expiration.endsWith("14") ? 0 : 1,
      "settlement-type": root === "SPXW" ? "PM" : "AM",
      strikes: legs.filter((leg) => leg.provider_symbol.slice(6, 12) === expiration.replaceAll("-", "").slice(2))
        .filter((leg) => !missingChainLeg || leg !== legs.at(-1))
        .map((leg) => ({
          "strike-price": String(Number(leg.provider_symbol.slice(13)) / 1000),
          call: leg.provider_symbol,
          "call-streamer-symbol": `.${root}${leg.provider_symbol.slice(6, 13)}${Number(leg.provider_symbol.slice(13)) / 1000}`,
        })),
    })),
  }];
  mutateChain(items);
  const frames = [];
  const sockets = [];
  class FixtureSocket {
    readyState = 0;
    fields = {};
    timers = new Set();
    constructor() {
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    schedule(callback, delayMs) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.readyState === 1) callback();
      }, delayMs);
      this.timers.add(timer);
    }
    send(text) {
      const frame = JSON.parse(text);
      frames.push(frame);
      queueMicrotask(() => {
        if (frame.type === "SETUP") this.emit({ type: "AUTH_STATE", state: "UNAUTHORIZED" });
        else if (frame.type === "AUTH") this.emit({ type: "AUTH_STATE", state: "AUTHORIZED" });
        else if (frame.type === "CHANNEL_REQUEST") this.emit({ type: "CHANNEL_OPENED", channel: 3 });
        else if (frame.type === "FEED_SETUP") {
          this.fields = Object.fromEntries(Object.entries(frame.acceptEventFields).map(([type, fields]) => [
            type, (reorderFields ? [...fields].reverse() : fields).filter((field) => !omitFields[type]?.includes(field)),
          ]));
          this.emit({ type: "FEED_CONFIG", channel: 3, eventFields: this.fields });
        } else if (frame.type === "FEED_SUBSCRIPTION" && frame.add) {
          const data = [];
          for (const { type, symbol } of frame.add) {
            if (missingEventLeg && symbol.endsWith(String(6000 + (legCount - 1) * 5))) continue;
            const event = {
              eventType: type, eventSymbol: symbol,
              bidTime: NOW, askTime: NOW, bidPrice: 2, askPrice: 2.2, bidSize: 10, askSize: 12,
              eventFlags: 0, index: 1, time: NOW, sequence: 0,
              price: 2.1, volatility: 0.2, delta: 0.5, gamma: 0.01, theta: -1, rho: 0.1, vega: 1.2,
              eventTime: 0, openInterest: 100,
            };
            mutateEvent(event, type, symbol);
            data.push(type, this.fields[type].map((field) => event[field]));
          }
          dispatchFeedData({ type: "FEED_DATA", channel: 3, data }, this, sockets.indexOf(this));
        }
      });
    }
    close() {
      this.readyState = 3;
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
    }
  }
  const client = new TastytradeLiveOptionSnapshotClient({
    oauth: { getAccessToken: async () => "fixture-only" },
    http: { get: async () => ({ data: { data: { items } } }) },
    quoteTokens: { getQuoteToken: async () => ({
      token: "fixture-only", url: "wss://tasty-openapi-ws.dxfeed.com/realtime",
    }) },
    socketFactory: () => {
      const socket = new FixtureSocket();
      sockets.push(socket);
      return socket;
    },
    clock: () => NOW,
    ...clientOptions,
  });
  const request = {
    underlying: root, expirations, around_price: "9999", strike_count: 1,
    include_quotes: true, include_greeks: true, include_summary: true,
    phase: "LIVE_SUPPORT", deadline_ms: 100, max_temporal_skew_ms: 1000,
    exact_package: { legs, policy: structuredClone(policy) },
  };
  return { client, request, frames, sockets };
}
