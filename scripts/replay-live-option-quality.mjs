import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { TastytradeLiveOptionSnapshotClient, parseDxlinkLiveOptionData, mergeLiveOptionEvents } from "../dist/live-option-snapshot.js";
import { hash } from "./capture-live-option-quality.mjs";

const jsonEqual = (left, right) => isDeepStrictEqual(
  JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)),
);

function parsePrivateJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error("Invalid private replay JSON (market values suppressed)."); }
}

export async function replayObservedFixture(fixture, { derivedMissingLeg = false } = {}) {
  assert.ok(fixture.evidence_kind === "SANITIZED_ACTUAL_LIVE_OBSERVATION",
    "Invalid observed evidence kind (market values suppressed).");
  const omitted = derivedMissingLeg ? fixture.request.exact_package.legs.at(-1).provider_symbol : null;
  const chain = structuredClone(fixture.chain);
  for (const item of chain.data.items) for (const expiry of item.expirations) {
    for (const strike of expiry.strikes) for (const side of ["call", "put"]) {
      if (strike[side] === omitted) {
        delete strike[side];
        delete strike[`${side}-streamer-symbol`];
      }
    }
  }
  let now = Date.parse(fixture.chain_retrieved_at);
  let fields = {};
  const states = new Map(fixture.contracts.map((contract) => [
    contract.streamer_symbol, { quote: null, greeks: null, summary: null },
  ]));
  for (const frame of fixture.frames) {
    if (frame.message.type === "FEED_CONFIG") fields = { ...fields, ...frame.message.eventFields };
    else mergeLiveOptionEvents(states, parseDxlinkLiveOptionData(
      frame.message.data, Date.parse(frame.observer_received_at), fields,
    ));
  }
  for (const contract of fixture.contracts) {
    const state = states.get(contract.streamer_symbol);
    assert.ok((state.quote?.bidTimeMs ?? null) === (contract.quote?.bid_time ? Date.parse(contract.quote.bid_time) : null),
      "Observed native quote time replay mismatch (market values suppressed).");
    assert.ok((state.quote?.askTimeMs ?? null) === (contract.quote?.ask_time ? Date.parse(contract.quote.ask_time) : null),
      "Observed native quote time replay mismatch (market values suppressed).");
    assert.ok((state.greeks?.eventFlags ?? null) === (contract.greeks?.event_flags ?? null),
      "Observed Greek flags replay mismatch (market values suppressed).");
    assert.ok((state.greeks?.timeMs ?? null) === (contract.greeks?.provider_event_timestamp ? Date.parse(contract.greeks.provider_event_timestamp) : null),
      "Observed native Greek time replay mismatch (market values suppressed).");
    assert.ok((state.summary?.eventTimeMs ?? null) === (contract.summary?.provider_event_timestamp ? Date.parse(contract.summary.provider_event_timestamp) : null),
      "Observed native Summary time replay mismatch (market values suppressed).");
  }
  const sockets = [];
  class ReplaySocket {
    readyState = 0;
    fields = {};
    subscribed = new Set();
    handles = new Set();
    constructor() {
      this.schedule(() => { this.readyState = 1; this.onopen?.(); });
    }
    schedule(callback) {
      const handle = setImmediate(() => { this.handles.delete(handle); callback(); });
      this.handles.add(handle);
    }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    send(text) {
      const frame = JSON.parse(text);
      if (frame.type === "SETUP") this.schedule(() => this.emit({ type: "AUTH_STATE", state: "UNAUTHORIZED" }));
      if (frame.type === "AUTH") this.schedule(() => this.emit({ type: "AUTH_STATE", state: "AUTHORIZED" }));
      if (frame.type === "CHANNEL_REQUEST") this.schedule(() => this.emit({ type: "CHANNEL_OPENED", channel: 3 }));
      if (frame.type === "FEED_SUBSCRIPTION" && frame.add) this.subscribed = new Set(frame.add.map((entry) => entry.symbol));
      if (frame.type === "FEED_SETUP") {
        const frames = structuredClone(fixture.frames);
        const next = () => {
          if (this.readyState !== 1 || !frames.length) return;
          const { message } = frames.shift();
          if (message.type === "FEED_CONFIG") this.fields = { ...this.fields, ...message.eventFields };
          else {
            const data = [];
            for (let i = 0; i < message.data.length; i += 2) {
              const type = message.data[i], layout = this.fields[type], values = message.data[i + 1];
              const nested = Array.isArray(values[0]);
              const rows = nested ? values : Array.from({ length: values.length / layout.length }, (_, index) =>
                values.slice(index * layout.length, (index + 1) * layout.length));
              const retained = rows.filter((row) => this.subscribed.has(row[layout.indexOf("eventSymbol")]));
              if (retained.length) data.push(type, nested ? retained : retained.flat());
              const observation = fixture.contracts.find((contract) =>
                contract.streamer_symbol === rows[0]?.[layout.indexOf("eventSymbol")])?.[type.toLowerCase()];
              // Preserve the client's original collection clock, not the independent transport observer clock.
              if (observation) now = Date.parse(observation.received_at);
            }
            message.data = data;
          }
          this.emit(message);
          this.schedule(next);
        };
        this.schedule(next);
      }
    }
    close() {
      this.readyState = 3;
      for (const handle of this.handles) clearImmediate(handle);
      this.handles.clear();
      now = Date.parse(fixture.retrieved_at);
    }
  }
  const client = new TastytradeLiveOptionSnapshotClient({
    oauth: { getAccessToken: async () => "offline-replay-no-provider-token" },
    http: { get: async () => ({ data: chain }) },
    quoteTokens: { getQuoteToken: async () => ({ token: "offline-replay", url: "wss://tasty-openapi-ws.dxfeed.com/realtime" }) },
    socketFactory: () => { const socket = new ReplaySocket(); sockets.push(socket); return socket; },
    clock: () => now,
  });
  const result = await client.getLiveOptionSnapshot({ ...fixture.request, deadline_ms: 100 });
  assert.ok(sockets.every((socket) => socket.readyState === 3 && socket.handles.size === 0));
  if (derivedMissingLeg) {
    assert.equal(result.exact_package_quality.status, "NOT_READY");
    assert.equal(result.exact_package_quality.content_complete, false);
    assert.equal(result.exact_package_quality.transport_complete, true);
    assert.ok(result.exact_package_quality.reasons.includes("MISSING_LEG"));
  } else {
    const quality = structuredClone(result.exact_package_quality);
    for (const leg of quality.legs) {
      const observed = fixture.contracts.find((item) => item.provider_symbol === leg.provider_symbol);
      leg.observation = Object.fromEntries(Object.keys(observed).map((key) => [key, leg.observation[key]]));
    }
    assert.ok(jsonEqual(quality, fixture.quality), "Observed quality replay mismatch (market values suppressed).");
    for (const contract of result.contracts) {
      const observed = fixture.contracts.find((item) => item.provider_symbol === contract.provider_symbol);
      for (const [key, value] of Object.entries(observed)) {
        assert.ok(jsonEqual(contract[key], value), "Observed contract replay mismatch (market values suppressed).");
      }
    }
  }
  return result;
}

export async function replayManifest(path) {
  const manifest = parsePrivateJson(readFileSync(path, "utf8"));
  assert.ok(manifest.evidence_kind === "PRIVATE_SANITIZED_LIVE_CAPTURE_MANIFEST",
    "Invalid private manifest evidence kind (market values suppressed).");
  const outcomes = [];
  for (const entry of manifest.fixtures) {
    const text = readFileSync(entry.path, "utf8");
    assert.ok(hash(text) === entry.sha256, "Observed fixture hash mismatch (market values suppressed).");
    const fixture = parsePrivateJson(text);
    const frameText = readFileSync(entry.frames_path, "utf8");
    assert.ok(hash(frameText) === entry.frames_sha256, "Observed frame hash mismatch (market values suppressed).");
    assert.ok(jsonEqual(parsePrivateJson(frameText).frames, fixture.frames),
      "Observed frame replay mismatch (market values suppressed).");
    const observed = await replayObservedFixture(fixture);
    const missing = await replayObservedFixture(fixture, { derivedMissingLeg: true });
    outcomes.push({
      legs: fixture.request.exact_package.legs.length,
      observed_replay: observed.exact_package_quality.status,
      reasons: observed.exact_package_quality.reasons,
      derived_missing_chain_leg: missing.exact_package_quality.status,
      derived_missing_leg_reason: missing.exact_package_quality.reasons.includes("MISSING_LEG"),
    });
  }
  assert.deepEqual(outcomes.map((entry) => entry.legs), [2, 3, 4]);
  return { validation_kind: "OFFLINE_REPLAY_OF_PRIVATE_OBSERVED_CAPTURE_PLUS_DERIVED_NEGATIVE", provider_calls: 0, outcomes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Explicit private capture manifest required; no live fallback.");
  console.log(JSON.stringify(await replayManifest(process.argv[2]), null, 2));
}
