import { describe, expect, jest, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import * as fs from "node:fs";

const memoryFiles = new Map();
jest.unstable_mockModule("node:fs", () => ({
  ...fs,
  readFileSync: (path, ...args) => memoryFiles.has(path) ? memoryFiles.get(path) : fs.readFileSync(path, ...args),
}));
const { replayManifest, replayObservedFixture } = await import("../scripts/replay-live-option-quality.mjs");
const digest = (text) => createHash("sha256").update(text).digest("hex");

async function assertSanitizedFailure(operation, sentinels, message) {
  let error;
  try { await operation(); } catch (caught) { error = caught; }
  expect(typeof error?.message === "string").toBe(true);
  if (!error) return;
  const diagnostic = `${String(error)}\n${error.stack}\n${inspect(error, { depth: null })}`;
  expect(sentinels.every((sentinel) => !diagnostic.includes(String(sentinel)))).toBe(true);
  expect(error.message === message).toBe(true);
  expect(error.actual === true || error.actual === false || error.actual === undefined).toBe(true);
  expect(error.expected === true || error.expected === false || error.expected === undefined).toBe(true);
}

describe("private replay failure diagnostics (in-memory synthetic evidence only)", () => {
  test("independently valid hashes cannot expose mismatched frame payloads", async () => {
    const sentinels = [987654321.12345, 876543210.54321];
    const frames = (value) => [{ message: { type: "FEED_DATA", channel: 3, data: ["Greeks", [value]] } }];
    const fixtureText = JSON.stringify({ frames: frames(sentinels[0]) });
    const frameText = JSON.stringify({ frames: frames(sentinels[1]) });
    const manifestPath = new URL("./synthetic-private-manifest.json", import.meta.url).pathname;
    const fixturePath = `${manifestPath}.fixture`, framesPath = `${manifestPath}.frames`;
    memoryFiles.set(fixturePath, fixtureText);
    memoryFiles.set(framesPath, frameText);
    memoryFiles.set(manifestPath, JSON.stringify({
      evidence_kind: "PRIVATE_SANITIZED_LIVE_CAPTURE_MANIFEST",
      fixtures: [{ path: fixturePath, sha256: digest(fixtureText), frames_path: framesPath, frames_sha256: digest(frameText) }],
    }));
    try {
      await assertSanitizedFailure(() => replayManifest(manifestPath), sentinels,
        "Observed frame replay mismatch (market values suppressed).");
    } finally { memoryFiles.clear(); }
  });

  test.each([
    ["Quote", "bid_time", "bidTime", "Observed native quote time replay mismatch (market values suppressed)."],
    ["Quote", "ask_time", "askTime", "Observed native quote time replay mismatch (market values suppressed)."],
    ["Greeks", "event_flags", "eventFlags", "Observed Greek flags replay mismatch (market values suppressed)."],
    ["Greeks", "provider_event_timestamp", "time", "Observed native Greek time replay mismatch (market values suppressed)."],
    ["Summary", "provider_event_timestamp", "eventTime", "Observed native Summary time replay mismatch (market values suppressed)."],
  ])("native %s %s failures suppress actual/expected values", async (type, key, field, message) => {
    const sentinels = [Date.parse("2026-10-14T14:00:00Z"), Date.parse("2026-10-14T14:00:01Z")];
    const native = { eventType: type, eventSymbol: "synthetic", [field]: sentinels[0] };
    const fields = Object.keys(native);
    const fixture = {
      evidence_kind: "SANITIZED_ACTUAL_LIVE_OBSERVATION",
      chain: { data: { items: [] } }, chain_retrieved_at: new Date(sentinels[0]).toISOString(),
      contracts: [{
        streamer_symbol: "synthetic",
        [type.toLowerCase()]: { [key]: key === "event_flags" ? sentinels[1] : new Date(sentinels[1]).toISOString() },
      }],
      frames: [
        { message: { type: "FEED_CONFIG", eventFields: { [type]: fields } } },
        {
          observer_received_at: new Date(sentinels[0]).toISOString(),
          message: { type: "FEED_DATA", data: [type, fields.map((name) => native[name])] },
        },
      ],
    };
    await assertSanitizedFailure(() => replayObservedFixture(fixture), sentinels, message);
  });

  test("invalid JSON diagnostics do not quote private source text", async () => {
    const sentinel = "synthetic-private-json-sentinel";
    const path = new URL("./synthetic-invalid-manifest.json", import.meta.url).pathname;
    memoryFiles.set(path, `{"invalid": ${sentinel}}`);
    try {
      await assertSanitizedFailure(() => replayManifest(path), [sentinel],
        "Invalid private replay JSON (market values suppressed).");
    } finally { memoryFiles.clear(); }
  });
});
