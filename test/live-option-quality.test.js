import { describe, expect, test } from "@jest/globals";
import { LIVE_OPTION_SNAPSHOT_INPUT_SCHEMA, mergeLiveOptionEvents, parseDxlinkLiveOptionData } from "../dist/live-option-snapshot.js";
import { evaluateExactLiveOptionPackage, validateExactLiveOptionPackage } from "../dist/live-option-quality.js";
import Ajv from "ajv";
import { mockLiveOptionPackage, NOW, POLICY } from "./fixtures/live-option-quality.mjs";

async function snapshot(options = {}) {
  const fixture = mockLiveOptionPackage(options);
  return { ...fixture, result: await fixture.client.getLiveOptionSnapshot(fixture.request) };
}

function greekFlagFrame(message, socket, flags) {
  const data = [];
  for (let index = 0; index < message.data.length; index += 2) {
    const type = message.data[index];
    const row = message.data[index + 1];
    if (type !== "Greeks") {
      data.push(type, row);
      continue;
    }
    for (const flag of flags) {
      const copy = [...row];
      copy[socket.fields.Greeks.indexOf("eventFlags")] = flag;
      data.push(type, copy);
    }
  }
  return { ...message, data };
}

describe("fixture/mock exact-package DXLink integration (not live provider validation)", () => {
  test.each([false, true])("stale Greeks cannot become READY with a swapped time/index layout (late=%s)", async (late) => {
    const { result, frames, sockets } = await snapshot({
      reorderFields: false,
      mutateEvent: (event) => { event.time = NOW - 9000; event.index = NOW; },
      dispatchFeedConfig: (message, socket) => {
        const fields = socket.fields.Greeks;
        const time = fields.indexOf("time"), index = fields.indexOf("index");
        [fields[time], fields[index]] = [fields[index], fields[time]];
        socket.emit({ ...message, eventFields: late ? {} : socket.fields });
      },
      dispatchFeedData: (message, socket) => {
        if (late) socket.emit({ type: "FEED_CONFIG", channel: 3, eventFields: { Greeks: socket.fields.Greeks } });
        socket.emit(message);
      },
    });
    expect(result.exact_package_quality.status).toBe("NOT_READY");
    expect(result.exact_package_quality.reasons).toEqual(expect.arrayContaining([
      "STALE_GREEKS", "STALE_IV", "QUOTE_GREEK_SKEW", "CROSS_LEG_SKEW",
    ]));
    expect(result.contracts.every((contract) =>
      Date.parse(contract.greeks.provider_event_timestamp) === NOW - 9000)).toBe(true);
    expect(frames.filter((frame) => frame.type === "FEED_SUBSCRIPTION" && frame.add)).toHaveLength(1);
    expect(sockets.every((socket) => socket.readyState === 3 && socket.timers.size === 0)).toBe(true);
  });

  test.each([
    [{}, "READY", []],
    [{ Quote: ["bidTime"] }, "NOT_READY", ["ABSENT_QUOTE_TIME"]],
    [{ Greeks: ["time"] }, "NOT_READY", ["ABSENT_GREEKS_TIME"]],
    [{ Greeks: ["theta"] }, "NOT_READY", ["PARTIAL_GREEKS"]],
  ])("late partial layouts preserve other categories and negotiated omissions: %j", async (omissions, status, reasons) => {
    const { result, frames, sockets } = await snapshot({
      omitFields: {
        Quote: ["eventType", ...(omissions.Quote ?? [])],
        Greeks: ["eventType", ...(omissions.Greeks ?? [])],
        Summary: ["eventType", "eventTime"],
      },
      dispatchFeedConfig: (message, socket) => socket.emit({ ...message, eventFields: {} }),
      dispatchFeedData: (message, socket) => {
        socket.emit({ type: "FEED_CONFIG", channel: 3, eventFields: { Quote: ["eventSymbol"] } });
        for (const type of ["Quote", "Summary", "Greeks"]) {
          socket.emit({ type: "FEED_CONFIG", channel: 3, eventFields: { [type]: socket.fields[type] } });
        }
        socket.emit({ type: "FEED_CONFIG", channel: 3, eventFields: { Unsupported: ["ignored"] } });
        socket.emit({ type: "FEED_CONFIG", channel: 5, eventFields: { Greeks: [] } });
        socket.emit({ ...message, data: ["Unsupported", ["ignored"], ...message.data] });
      },
    });
    expect(result.exact_package_quality).toMatchObject({
      status, transport_complete: true, reasons,
      order_authorized: false, production_gate_eligible: false, live_permission_backfill: false,
    });
    expect(result.contracts.every((contract) =>
      contract.quote.bid !== null && contract.quote.ask !== null &&
      contract.summary.open_interest !== null &&
      contract.summary.provider_event_timestamp === null &&
      contract.summary.provider_event_timestamp_source === "UNKNOWN")).toBe(true);
    if (omissions.Quote) expect(result.contracts.every((contract) => contract.quote.bid_time === null)).toBe(true);
    if (omissions.Greeks?.includes("time")) {
      expect(result.contracts.every((contract) =>
        contract.greeks.provider_event_timestamp === null &&
        contract.greeks.provider_event_timestamp_source === "UNKNOWN")).toBe(true);
    }
    if (omissions.Greeks?.includes("theta")) expect(result.contracts.every((contract) => contract.greeks.theta === null)).toBe(true);
    expect(result.gamma_concentration_proxy.status).toBe(omissions.Greeks?.includes("time") ? "NOT_AVAILABLE" : "COMPLETE");
    expect(frames.filter((frame) => frame.type === "FEED_SUBSCRIPTION" && frame.add)).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === "FEED_SUBSCRIPTION" && frame.remove)).toHaveLength(1);
    expect(sockets.every((socket) => socket.readyState === 3 && socket.timers.size === 0)).toBe(true);
  });

  test.each([
    { Greeks: [] }, { Greeks: ["eventSymbol", "time", "time"] },
    { Greeks: ["eventSymbol", 42] }, { Greeks: ["time", "index"] },
    { Greeks: "invalid" }, { Quote: [] }, { Summary: ["eventTime", "openInterest"] }, null, [],
  ])("invalid later layouts fail the actual collector closed: %j", async (eventFields) => {
    const { result, frames, sockets } = await snapshot({
      dispatchFeedData: (message, socket) => {
        socket.emit({ ...message, data: message.data.slice(0, 2) });
        socket.emit({ type: "FEED_CONFIG", channel: 3, eventFields });
        socket.emit(message);
      },
    });
    expect(result.exact_package_quality.status).toBe("NOT_READY");
    expect(result.exact_package_quality.transport_complete).toBe(false);
    expect(result.transport.failed_batches).toBe(1);
    expect(result.transport.batches[0].error).toMatch(/negotiated field layout|FEED_CONFIG.eventFields/);
    expect(frames.filter((frame) => frame.type === "FEED_SUBSCRIPTION" && frame.add)).toHaveLength(1);
    expect(sockets.every((socket) => socket.readyState === 3 && socket.timers.size === 0)).toBe(true);
  });

  test("late per-type layouts remain request-bound across chunks and authentication recovery", async () => {
    let invalidations = 0;
    const { result, frames, sockets } = await snapshot({
      legCount: 4,
      clientOptions: {
        maxDxlinkSubscriptionFrameBytes: 256, maxConcurrentDxlinkBatches: 1,
        quoteTokens: {
          getQuoteToken: async () => ({ token: "fixture-only", url: "wss://tasty-openapi-ws.dxfeed.com/realtime" }),
          invalidateQuoteToken: () => { invalidations += 1; },
        },
      },
      dispatchFeedConfig: (message, socket, attempt) => {
        if (attempt === 0 && socket.fields.Greeks) {
          socket.fields.Greeks = socket.fields.Greeks.filter((field) => field !== "time");
        }
        socket.emit({ ...message, eventFields: {} });
      },
      dispatchFeedData: (message, socket, attempt) => {
        for (const [type, fields] of Object.entries(socket.fields)) {
          socket.emit({ type: "FEED_CONFIG", channel: 3, eventFields: { [type]: fields } });
        }
        socket.emit(greekFlagFrame(message, socket, attempt === 0 ? [4 | 1, 2 | 1] : [0]));
        if (attempt === 0) socket.emit({ type: "AUTH_STATE", state: "UNAUTHORIZED" });
      },
    });
    expect(invalidations).toBe(1);
    expect(result.dxlink_auth.retry_count).toBe(1);
    expect(result.transport.batch_count).toBeGreaterThan(1);
    expect(result.exact_package_quality).toMatchObject({
      status: "READY", transport_complete: true, content_complete: true, reasons: [],
    });
    expect(frames.filter((frame) => frame.type === "FEED_SUBSCRIPTION" && frame.add)).toHaveLength(sockets.length);
    expect(sockets.every((socket) => socket.readyState === 3 && socket.timers.size === 0)).toBe(true);
  });

  test.each([
    [4, 2, 0], [4, 2, null, 0], [4, 8 | 1, 2 | 1, null],
    [4, 16 | 1, 2 | 1, null],
  ])("unfinished Greek state survives removal/unknown flags: %j", async (...flags) => {
    const { result, sockets } = await snapshot({
      dispatchFeedData: (message, socket) => socket.emit(greekFlagFrame(message, socket, flags)),
    });
    expect(result.exact_package_quality).toMatchObject({
      status: "NOT_READY", content_complete: false, transport_complete: true,
      reasons: ["PARTIAL_GREEKS"],
    });
    expect(result.contracts.every((contract) => !contract.greeks.content_complete)).toBe(true);
    expect(result.transport).toMatchObject({ complete_batches: 1, partial_batches: 0, timed_out_batches: 0 });
    expect(result.warnings).toContain("SNAPSHOT_DEADLINE_EXCEEDED");
    expect(result.gamma_concentration_proxy.status).toBe("COMPLETE");
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });

  test.each([
    [[4], [8]], [[4, 2, 0], [16]], [[1, 2 | 1], [0]],
    [[4, 8 | 1], [0]], [[4, 16 | 1], [0]],
  ])("strict collector waits for split-frame completion: %j -> %j", async (initial, completion) => {
    let endEmitted = false;
    const { result, sockets } = await snapshot({
      dispatchFeedData: (message, socket) => {
        socket.emit(greekFlagFrame(message, socket, initial));
        socket.schedule(() => {
          endEmitted = true;
          socket.emit(greekFlagFrame(message, socket, completion));
        }, 10);
      },
    });
    expect(endEmitted).toBe(true);
    expect(result.exact_package_quality).toMatchObject({
      status: "READY", content_complete: true, transport_complete: true, reasons: [],
      order_authorized: false, production_gate_eligible: false, live_permission_backfill: false,
    });
    expect(result.warnings).not.toContain("SNAPSHOT_DEADLINE_EXCEEDED");
    expect(sockets.every((socket) => socket.readyState === 3 && socket.timers.size === 0)).toBe(true);
  });

  test.each([4, 1, 8 | 1, 16 | 1])("pending flags %i remain partial at the bounded deadline", async (flags) => {
    const { result } = await snapshot({ mutateEvent: (event) => { event.eventFlags = flags; } });
    expect(result.exact_package_quality).toMatchObject({
      status: "NOT_READY", content_complete: false, transport_complete: true,
      reasons: ["PARTIAL_GREEKS"],
    });
    expect(result.warnings).toContain("SNAPSHOT_DEADLINE_EXCEEDED");
    expect(result.transport.batches[0]).toMatchObject({ status: "COMPLETE", affected_symbols: [], error: null });
    expect(result.gamma_concentration_proxy.status).toBe("COMPLETE");
  });

  test("legacy collection still stops on arrival rather than Greek content completion", async () => {
    let endEmitted = false;
    const { client, request, sockets } = mockLiveOptionPackage({
      dispatchFeedData: (message, socket) => {
        socket.emit(greekFlagFrame(message, socket, [4]));
        socket.schedule(() => {
          endEmitted = true;
          socket.emit(greekFlagFrame(message, socket, [8]));
        }, 10);
      },
    });
    delete request.exact_package;
    const result = await client.getLiveOptionSnapshot(request);
    expect(endEmitted).toBe(false);
    expect(result.exact_package_quality).toBeNull();
    expect(result.gamma_concentration_proxy.status).toBe("COMPLETE");
    expect(result.transport.complete_batches).toBe(1);
    expect(result.warnings).not.toContain("SNAPSHOT_DEADLINE_EXCEEDED");
    expect(sockets[0].timers.size).toBe(0);
  });

  test("chunked strict collection waits on each Greek subscription", async () => {
    let completedSockets = 0;
    let pendingSockets = 0;
    const { result, sockets } = await snapshot({
      clientOptions: { maxDxlinkSubscriptionFrameBytes: 256, maxConcurrentDxlinkBatches: 1 },
      dispatchFeedData: (message, socket) => {
        socket.emit(greekFlagFrame(message, socket, [4]));
        if (message.data.includes("Greeks")) {
          pendingSockets += 1;
          socket.schedule(() => {
            completedSockets += 1;
            socket.emit(greekFlagFrame(message, socket, [8]));
          }, 10);
        }
      },
    });
    expect(result.transport.batch_count).toBeGreaterThan(1);
    expect(pendingSockets).toBeGreaterThan(0);
    expect(completedSockets).toBe(pendingSockets);
    expect(result.exact_package_quality.status).toBe("READY");
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });

  test("auth recovery clears pending snapshot and transaction state before retry", async () => {
    let invalidations = 0;
    const { result, sockets } = await snapshot({
      clientOptions: {
        quoteTokens: {
          getQuoteToken: async () => ({ token: "fixture-only", url: "wss://tasty-openapi-ws.dxfeed.com/realtime" }),
          invalidateQuoteToken: () => { invalidations += 1; },
        },
      },
      dispatchFeedData: (message, socket, attempt) => {
        socket.emit(greekFlagFrame(message, socket, attempt === 0 ? [4 | 1, 2 | 1] : [0]));
        if (attempt === 0) socket.emit({ type: "AUTH_STATE", state: "UNAUTHORIZED" });
      },
    });
    expect(invalidations).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(result.dxlink_auth.retry_count).toBe(1);
    expect(result.exact_package_quality.status).toBe("READY");
    expect(result.warnings).not.toContain("SNAPSHOT_DEADLINE_EXCEEDED");
  });

  test.each([
    { legCount: 2 }, { legCount: 3 }, { legCount: 4 },
    { legCount: 2, calendar: true }, { legCount: 4, calendar: true },
    { legCount: 2, root: "SPX" }, { legCount: 4, root: "SPX", calendar: true },
  ])("synchronized exact legs reach FinPilot evidence gate: %j", async (options) => {
    const { result, request, frames } = await snapshot(options);
    const quality = result.exact_package_quality;
    expect(result.contracts).toHaveLength(options.legCount);
    expect(quality).toMatchObject({
      status: "READY", destination: "FINPILOT_GATE", order_authorized: false,
      research_only: true, production_gate_eligible: false, live_permission_backfill: false,
      content_complete: true, transport_complete: true, reasons: [],
      cross_leg_skew_ms: 0, oldest_age_ms: 0,
      policy: request.exact_package.policy,
    });
    expect(quality.legs.map(({ action, ratio, provider_symbol }) => ({ action, ratio, provider_symbol })))
      .toEqual(request.exact_package.legs.map(({ action, ratio, provider_symbol }) => ({ action, ratio, provider_symbol })));
    expect(result.market_data_handoff.exact_package_quality).toEqual(quality);
    expect(frames.filter((frame) => frame.add).flatMap((frame) => frame.add)).toHaveLength(options.legCount * 3);
    expect(result.gamma_concentration_proxy.status).toBe("COMPLETE");
    expect(result.event_timestamp_alignment.status).toBe("UNVERIFIABLE");
    expect(result.contracts[0].summary).toMatchObject({
      provider_event_timestamp: null, provider_event_timestamp_source: "UNKNOWN",
      as_of: null, timestamp_source: "LOCAL_RECEIVE_TIME", day_volume: null, day_volume_source: "UNKNOWN",
    });
    expect(result.contracts[0].greeks).toMatchObject({
      provider_event_timestamp: new Date(NOW).toISOString(),
      calculation_timestamp: null, calculation_timestamp_source: "UNKNOWN",
      source: "DXLink Greeks", iv_source: "DXLink Greeks.volatility",
    });
  });

  test.each([2, 3, 4])("one missing chain leg fails %i-leg content, despite complete transport", async (legCount) => {
    const { result } = await snapshot({ legCount, missingChainLeg: true });
    expect(result.exact_package_quality).toMatchObject({
      status: "NOT_READY", content_complete: false, transport_complete: true,
      reasons: ["MISSING_LEG"],
    });
    expect(result.exact_package_quality.legs).toHaveLength(legCount);
  });

  test("missing event leg distinguishes timed-out transport and content", async () => {
    const { result } = await snapshot({ missingEventLeg: true });
    expect(result.exact_package_quality.transport_complete).toBe(false);
    expect(result.exact_package_quality.content_complete).toBe(false);
    expect(result.exact_package_quality.reasons).toEqual(expect.arrayContaining([
      "TRANSPORT_INCOMPLETE", "MISSING_QUOTE", "PARTIAL_GREEKS", "PARTIAL_COHORT",
    ]));
  });

  test.each([
    ["ABSENT_QUOTE_TIME", (event) => { event.bidTime = 0; event.askTime = 0; }],
    ["CROSSED_QUOTE", (event) => { event.bidPrice = 3; }],
    ["INVALID_QUOTE", (event) => { event.bidPrice = 0; }],
    ["MISSING_QUOTE_SIZE", (event) => { event.bidSize = 0; }],
    ["PARTIAL_GREEKS", (event) => { event.theta = null; }],
    ["PARTIAL_GREEKS", (event) => { event.eventFlags = 1; }],
    ["PARTIAL_GREEKS", (event) => { event.eventFlags = 4; }],
    ["PARTIAL_GREEKS", (event) => { event.eventFlags = null; }],
    ["PARTIAL_GREEKS", (event) => { event.eventFlags = false; }],
    ["ABSENT_GREEKS_TIME", (event) => { event.time = 0; }],
    ["MISSING_IV", (event) => { event.volatility = null; }],
    ["MISSING_OPEN_INTEREST", (event) => { event.openInterest = null; }],
    ["STALE_QUOTE", (event) => { event.bidTime = NOW - 6000; }],
    ["STALE_GREEKS", (event) => { event.time = NOW - 6000; }],
    ["STALE_IV", (event) => { event.time = NOW - 6000; }],
    ["QUOTE_GREEK_SKEW", (event) => { event.time = NOW - 2000; }],
    ["CROSS_LEG_SKEW", (event, type, symbol) => {
      if (symbol.endsWith("6005")) { event.time = NOW - 2000; event.bidTime = NOW - 2000; event.askTime = NOW - 2000; }
    }],
    ["FUTURE_TIMESTAMP", (event) => { event.askTime = NOW + 1; }],
    ["FUTURE_TIMESTAMP", (event) => { event.eventTime = NOW + 1; }],
    ["SESSION_ANOMALY", (event) => { event.bidTime = Date.parse("2026-10-13T14:00:00Z"); }],
  ])("%s is explicit and fails readiness", async (reason, mutateEvent) => {
    const { result } = await snapshot({ mutateEvent });
    expect(result.exact_package_quality.status).toBe("NOT_READY");
    expect(result.exact_package_quality.reasons).toContain(reason);
  });

  test("local receipt never masquerades as provider or calculation time", async () => {
    const { result } = await snapshot({
      mutateEvent: (event) => { event.bidTime = 0; event.askTime = 0; event.time = 0; },
    });
    for (const contract of result.contracts) {
      for (const event of [contract.quote, contract.greeks, contract.summary]) {
        expect(event.provider_event_timestamp).toBeNull();
        expect(event.as_of).toBeNull();
        expect(event.provider_event_timestamp_source).toBe("UNKNOWN");
        expect(event.timestamp_provenance.provider_event_timestamp).toBe("UNKNOWN");
        expect(event.timestamp_source).toBe("LOCAL_RECEIVE_TIME");
        expect(event.received_at).toBe(new Date(NOW).toISOString());
        expect(event.timestamp_provenance.received_at).toBe("LOCAL_RECEIVE_TIME");
        expect(event.timestamp_provenance.available_at).toBe("LOCAL_RECEIVE_TIME");
        expect(event.timestamp_provenance.retrieved_at).toBe("LOCAL_COLLECTION_TIME");
      }
    }
  });

  test("negotiated field omissions stay unknown rather than shifting positions", async () => {
    const { result } = await snapshot({ omitFields: { Quote: ["bidTime"], Greeks: ["theta"] } });
    expect(result.contracts[0].quote.bid).toBe("2");
    expect(result.contracts[0].quote.bid_time).toBeNull();
    expect(result.contracts[0].greeks.gamma).toBe("0.01");
    expect(result.contracts[0].greeks.theta).toBeNull();
    expect(result.exact_package_quality.reasons).toEqual(expect.arrayContaining(["ABSENT_QUOTE_TIME", "PARTIAL_GREEKS"]));
  });

  test.each([
    ["INCOMPATIBLE_SETTLEMENT", (items) => { items[0].expirations[0]["settlement-type"] = "AM"; }],
    ["INCOMPATIBLE_CONTRACT", (items) => { items[0]["shares-per-contract"] = 10; }],
    ["PROVIDER_SYMBOL_MISMATCH", (items) => { items[0].expirations[0].strikes[0]["call-streamer-symbol"] = ".WRONG"; }],
  ])("chain identity/metadata mismatch: %s", async (reason, mutateChain) => {
    const { result } = await snapshot({ mutateChain });
    expect(result.exact_package_quality.reasons).toContain(reason);
  });

  test("unknown volume is not zero and a volume-requiring policy fails closed", async () => {
    const { result } = await snapshot({ policy: { ...POLICY, require_volume: true } });
    expect(result.exact_package_quality.reasons).toContain("MISSING_VOLUME");
  });

  test.each([
    ["DST_ANOMALY", { ...POLICY.session, utc_offset_minutes: -300 }],
    ["SESSION_ANOMALY", { ...POLICY.session, end_at: "2026-10-14T13:45:00Z" }],
  ])("explicit session policy checks %s", async (reason, session) => {
    const { result } = await snapshot({ policy: { ...POLICY, session } });
    expect(result.exact_package_quality.reasons).toContain(reason);
  });

  test("caller age and skew thresholds control result; no legacy elevation", async () => {
    const mutateEvent = (event) => { event.time = NOW - 2000; };
    const strict = await snapshot({ mutateEvent });
    const lenient = await snapshot({
      mutateEvent, policy: { ...POLICY, max_quote_greek_skew_ms: 2000, max_cross_leg_skew_ms: 2000 },
    });
    expect(strict.result.exact_package_quality.status).toBe("NOT_READY");
    expect(lenient.result.exact_package_quality.status).toBe("READY");
    expect(strict.result.snapshot_complete).toBe(true);
  });

  test("IV freshness is independently stricter than Greek freshness by caller policy", async () => {
    const { result } = await snapshot({
      mutateEvent: (event) => { event.time = NOW - 2000; },
      policy: {
        ...POLICY, max_iv_age_ms: 1000,
        max_quote_greek_skew_ms: 2000, max_cross_leg_skew_ms: 2000,
      },
    });
    expect(result.exact_package_quality.reasons).toEqual(["STALE_IV"]);
    expect(result.exact_package_quality.status).toBe("NOT_READY");
  });

  test("receipt freshness/cohort cannot be borrowed from another request", async () => {
    const { result, request } = await snapshot();
    const contracts = structuredClone(result.contracts);
    contracts[0].quote.received_at = new Date(NOW - 1).toISOString();
    const quality = evaluateExactLiveOptionPackage(request.exact_package, contracts, result.retrieved_at, true, result.chain_retrieved_at);
    expect(quality.reasons).toContain("PARTIAL_COHORT");
  });

  test("quote size is optional only by explicit caller policy", async () => {
    const { result } = await snapshot({
      omitFields: { Quote: ["bidSize", "askSize"] },
      policy: { ...POLICY, require_quote_size: false },
    });
    expect(result.exact_package_quality.status).toBe("READY");
    expect(result.snapshot_complete).toBe(false);
    expect(result.contracts[0].quote.bid_size).toBeNull();
  });

  test("legacy requests do not receive default exact-package readiness", async () => {
    const { client, request } = mockLiveOptionPackage();
    delete request.exact_package;
    const result = await client.getLiveOptionSnapshot(request);
    expect(result.exact_package_quality).toBeNull();
    expect(result.market_data_handoff.exact_package_quality).toBeNull();
  });

  test("receive skew is independently bounded across legs", async () => {
    const { result, request } = await snapshot();
    const contracts = structuredClone(result.contracts);
    contracts[0].quote.received_at = new Date(NOW - 2000).toISOString();
    const quality = evaluateExactLiveOptionPackage(request.exact_package, contracts, result.retrieved_at, true, new Date(NOW - 3000).toISOString());
    expect(quality.receive_skew_ms).toBe(2000);
    expect(quality.reasons).toContain("PARTIAL_COHORT");
  });

  test("fingerprints retain exact input but ignore object property insertion order", async () => {
    const { result, request } = await snapshot();
    const reordered = {
      policy: Object.fromEntries(Object.entries(request.exact_package.policy).reverse()),
      legs: request.exact_package.legs.map((leg) => Object.fromEntries(Object.entries(leg).reverse())),
    };
    const quality = evaluateExactLiveOptionPackage(reordered, result.contracts, result.retrieved_at, true, result.chain_retrieved_at);
    expect(quality.fingerprint).toBe(result.exact_package_quality.fingerprint);
    reordered.legs[0].ratio = 2;
    expect(evaluateExactLiveOptionPackage(reordered, result.contracts, result.retrieved_at, true, result.chain_retrieved_at).fingerprint)
      .not.toBe(quality.fingerprint);
  });

  test("mixed SPX AM / SPXW PM packages fail closed instead of being interchangeable", async () => {
    const weekly = await snapshot();
    const standard = await snapshot({ root: "SPX" });
    const request = {
      legs: [weekly.request.exact_package.legs[0], standard.request.exact_package.legs[0]],
      policy: POLICY,
    };
    const contracts = [weekly.result.contracts[0], standard.result.contracts[0]];
    const quality = evaluateExactLiveOptionPackage(request, contracts, weekly.result.retrieved_at, true, weekly.result.chain_retrieved_at);
    expect(quality.status).toBe("NOT_READY");
    expect(quality.reasons).toEqual(expect.arrayContaining(["INCOMPATIBLE_CONTRACT", "INCOMPATIBLE_SETTLEMENT"]));
  });

  test("expired exact contract cannot gain live permission from fresh receipt", async () => {
    const { result, request } = await snapshot();
    const contracts = structuredClone(result.contracts);
    const expired = structuredClone(request.exact_package);
    expired.legs[0].provider_symbol = expired.legs[0].provider_symbol.replace("261014", "261013");
    contracts[0].provider_symbol = expired.legs[0].provider_symbol;
    contracts[0].occ_symbol = expired.legs[0].provider_symbol;
    contracts[0].expiration = "2026-10-13";
    contracts[0].streamer_symbol = contracts[0].streamer_symbol.replace("261014", "261013");
    for (const event of [contracts[0].quote, contracts[0].greeks, contracts[0].summary]) {
      event.provider_symbol = contracts[0].streamer_symbol;
    }
    const quality = evaluateExactLiveOptionPackage(expired, contracts, result.retrieved_at, true, result.chain_retrieved_at);
    expect(quality.reasons).toContain("INCOMPATIBLE_CONTRACT");
    expect(quality.order_authorized).toBe(false);
    expect(quality.live_permission_backfill).toBe(false);
  });

  test("required policy, OCC and ratio checked both at schema and runtime", () => {
    const { request } = mockLiveOptionPackage();
    const validate = new Ajv({ strict: false }).compile(LIVE_OPTION_SNAPSHOT_INPUT_SCHEMA);
    expect(validate({ request })).toBe(true);
    delete request.exact_package.policy.max_iv_age_ms;
    expect(validate({ request })).toBe(false);
    expect(() => validateExactLiveOptionPackage(request.exact_package)).toThrow("max_iv_age_ms");
    const good = mockLiveOptionPackage().request.exact_package;
    good.legs[0].provider_symbol = good.legs[0].provider_symbol.replace("  ", "");
    expect(() => validateExactLiveOptionPackage(good)).toThrow("21-character OCC");
    good.legs[0].provider_symbol = good.legs[1].provider_symbol;
    expect(() => validateExactLiveOptionPackage(good)).toThrow("Duplicate");
  });

  test("provider units are milliseconds, never guessed from numeric magnitude", () => {
    const [event] = parseDxlinkLiveOptionData(["Quote", ["Quote", ".SPXW", 1234567890, 0, 2, 3, 1, 1]], NOW);
    expect(event.bidTimeMs).toBe(1234567890);
    expect(event.askTimeMs).toBeNull();
  });

  test("Greek snapshot begin remains incomplete until explicit end, independent of transport", () => {
    const states = new Map([[".SPXW", { quote: null, greeks: null, summary: null }]]);
    for (const flags of [4, 0, 8]) {
      const events = parseDxlinkLiveOptionData(["Greeks", ["Greeks", ".SPXW", flags, 1, NOW, 0, 2, 0.2, 0.5, 0.01, -1, 0.1, 1]], NOW);
      mergeLiveOptionEvents(states, events);
      expect(states.get(".SPXW").greeks.contentComplete).toBe(flags === 8);
    }
  });

  test.each([
    [[4, 2, 0], true, false],
    [[4, 2, null], true, false],
    [[1, 3, null], false, true],
    [[4, 9, null], false, true],
    [[4, 17, null], false, true],
    [[4, 10, 0], false, false],
    [[4, 18, 0], false, false],
    [[1, 2, 0], false, false],
    [[4, 9, 0], false, false],
    [[4, 17, 0], false, false],
    [[4, 8, 4, 0], true, false],
    [[4, 8, 1], false, true],
    [[4, 12], false, false],
    [[4, 20], false, false],
  ])("Greek flag reset semantics: %j", (flags, snapshotPending, transactionPending) => {
    const state = { quote: null, greeks: null, summary: null };
    const states = new Map([[".SPXW", state]]);
    for (const flag of flags) {
      const events = parseDxlinkLiveOptionData(["Greeks", ["Greeks", ".SPXW", flag, 1, NOW, 0, 2, 0.2, 0.5, 0.01, -1, 0.1, 1]], NOW);
      mergeLiveOptionEvents(states, events);
      if (flag !== null && (flag & 2) !== 0) expect(state.greeks).toBeNull();
    }
    expect(state.greeksSnapshotPending ?? false).toBe(snapshotPending);
    expect(state.greeksTransactionPending ?? false).toBe(transactionPending);
    expect(state.greeks.contentComplete).toBe(
      flags.at(-1) !== null && !snapshotPending && !transactionPending,
    );
  });
});
