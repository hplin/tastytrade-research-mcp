import { describe, expect, test } from "@jest/globals";
import { replayManifest } from "../scripts/replay-live-option-quality.mjs";

// Observations remain private until redistribution authority is verified.
// Missing artifacts are an explicit skip, never synthetic "live" coverage.
const manifest = process.env.TASTYTRADE_CAPTURE_REPLAY_MANIFEST;
(manifest ? describe : describe.skip)("private actual-provider capture replay (offline)", () => {
  test("replays exact layouts, flags, native/local time provenance and derived missing-leg rejection", async () => {
    const result = await replayManifest(manifest);
    expect(result.provider_calls).toBe(0);
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes.every((outcome) => outcome.derived_missing_leg_reason)).toBe(true);
  });
});
