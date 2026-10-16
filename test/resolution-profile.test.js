import { describe, expect, test } from "@jest/globals";
import {
  historicalBarMatchesResolutionProfile,
  normalizeResolutionProfile,
  resolveHistoricalBarTiming,
  withEffectiveAggregation,
} from "../dist/resolution-profile.js";
import { resolveCheckpoint } from "../dist/time.js";

describe("research resolution profiles", () => {
  test("calendar timing is opt-in, exact, and cannot reinterpret legacy daily rows", () => {
    const source_time = "2026-11-27T14:30:00.000Z";
    const verified = {
      source_time, bar_end: "2026-11-27T18:00:00.000Z",
      session_timing: { calendar_id: "us-cash-rth-2026/1", session_date: "2026-11-27" },
    };
    expect(resolveHistoricalBarTiming(verified, "1d").available_at).toBe(verified.bar_end);
    expect(resolveHistoricalBarTiming({ source_time }, "1d").bar_end)
      .toBe("2026-11-28T14:30:00.000Z");
    expect(() => resolveHistoricalBarTiming({ source_time, bar_end: verified.bar_end }, "1d"))
      .toThrow("bar_end must equal bar_start + 1d");
    for (const session_timing of [
      { calendar_id: "legacy", session_date: "2026-11-27" },
      { calendar_id: "us-cash-rth-2026/1", session_date: "2026-11-26" },
      { calendar_id: "us-cash-rth-2026/1", session_date: "2026-02-30" },
    ]) {
      expect(() => resolveHistoricalBarTiming({ ...verified, session_timing }, "1d"))
        .toThrow("Invalid verified RTH daily session timing");
    }
    expect(() => resolveHistoricalBarTiming({ ...verified,
      available_at: "2026-11-27T17:00:00Z" }, "1d"))
      .toThrow("available_at must be at or after bar_end");
  });
  test("preserves the omitted-profile five-minute compatibility policy", () => {
    const profile = normalizeResolutionProfile(undefined, {
      default_requested_aggregation: "5m",
      default_max_observation_age_minutes: 60,
      default_max_temporal_skew_minutes: 0,
      default_fallback_aggregations: [],
    });

    expect(profile).toMatchObject({
      contract_version: "1.0.0",
      profile_id: "DEFAULT_5M",
      profile_version: "1.0.0",
      provider_id: "tastytrade-dxlink",
      requested_aggregation: "5m",
      native_aggregation: "5m",
      effective_aggregation: null,
      effective_cohort_id: null,
      session: {
        kind: "ALL",
        timezone: "UTC",
        start_time: null,
        end_time: null,
      },
      alignment: "MIDNIGHT",
      max_observation_age_minutes: 60,
      max_temporal_skew_minutes: 0,
      fallback_policy: {
        allowed: false,
        aggregations: [],
        selection_rule: "FIRST_AVAILABLE_IN_DECLARED_ORDER",
      },
    });
    expect(profile.cohort_id).toMatch(/^[a-f0-9]{64}$/);
  });

  test("keeps provider-clock hourly bars in a distinct research cohort", () => {
    const defaults = {
      default_requested_aggregation: "5m",
      default_max_observation_age_minutes: 60,
      default_max_temporal_skew_minutes: 0,
      default_fallback_aggregations: [],
    };
    const providerAligned = withEffectiveAggregation(
      normalizeResolutionProfile(
        {
          profile_id: "HOURLY_PROVIDER_ALIGNED_RESEARCH",
          profile_version: "1.0.0",
        },
        defaults,
      ),
      "1h",
    );
    expect(providerAligned).toMatchObject({
      profile_id: "HOURLY_PROVIDER_ALIGNED_RESEARCH",
      requested_aggregation: "1h",
      native_aggregation: "h",
      effective_aggregation: "1h",
      session: {
        kind: "REGULAR",
        timezone: "America/New_York",
        start_time: "09:30",
        end_time: "16:00",
      },
      alignment: "MIDNIGHT",
      fallback_policy: { allowed: false, aggregations: [] },
    });
    const providerBar = resolveHistoricalBarTiming(
      { source_time: "2026-08-27T13:00:00.000Z" },
      "1h",
    );
    expect(
      historicalBarMatchesResolutionProfile(
        providerBar,
        "1h",
        providerAligned,
      ),
    ).toBe(true);
  });

  test("requires explicit native-hour RTH opt-in and keeps cohorts distinct", () => {
    const defaults = {
      default_requested_aggregation: "5m",
      default_max_observation_age_minutes: 60,
      default_max_temporal_skew_minutes: 0,
      default_fallback_aggregations: [],
    };
    const fiveMinute = withEffectiveAggregation(
      normalizeResolutionProfile(undefined, defaults),
      "5m",
    );
    const hourly = withEffectiveAggregation(
      normalizeResolutionProfile(
        {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
        },
        defaults,
      ),
      "1h",
    );
    const alternateProvider = withEffectiveAggregation(
      normalizeResolutionProfile(
        {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
          provider_id: "licensed-provider-b",
        },
        defaults,
      ),
      "1h",
    );

    expect(hourly).toMatchObject({
      profile_id: "HOURLY_VALUATION_RESEARCH",
      requested_aggregation: "1h",
      native_aggregation: "h",
      effective_aggregation: "1h",
      session: {
        kind: "REGULAR",
        timezone: "America/New_York",
        start_time: "09:30",
        end_time: "16:00",
      },
      alignment: "SESSION",
      fallback_policy: {
        allowed: false,
        aggregations: [],
      },
    });
    expect(fiveMinute.cohort_id).not.toBe(hourly.cohort_id);
    expect(fiveMinute.effective_cohort_id).not.toBe(
      hourly.effective_cohort_id,
    );
    expect(alternateProvider.cohort_id).not.toBe(hourly.cohort_id);
    expect(alternateProvider.effective_cohort_id).not.toBe(
      hourly.effective_cohort_id,
    );
  });

  test("parses Pacific local checkpoints across the 2026 DST transition", () => {
    expect(
      resolveCheckpoint(undefined, {
        local_date: "2026-03-02",
        local_time: "07:30",
        timezone: "America/Los_Angeles",
      }),
    ).toEqual({
      kind: "IANA_LOCAL",
      instant: "2026-03-02T15:30:00.000Z",
      timezone: "America/Los_Angeles",
      local_date: "2026-03-02",
      local_time: "07:30:00",
    });
    expect(
      resolveCheckpoint(undefined, {
        local_date: "2026-03-09",
        local_time: "07:30",
        timezone: "America/Los_Angeles",
      }),
    ).toEqual({
      kind: "IANA_LOCAL",
      instant: "2026-03-09T14:30:00.000Z",
      timezone: "America/Los_Angeles",
      local_date: "2026-03-09",
      local_time: "07:30:00",
    });
  });

  test("rejects ambiguous and nonexistent local checkpoint instants", () => {
    expect(() =>
      resolveCheckpoint(undefined, {
        local_date: "2026-03-08",
        local_time: "02:30",
        timezone: "America/Los_Angeles",
      }),
    ).toThrow("does not exist");
    expect(() =>
      resolveCheckpoint(undefined, {
        local_date: "2026-11-01",
        local_time: "01:30",
        timezone: "America/Los_Angeles",
      }),
    ).toThrow("is ambiguous");
  });

  test("rejects provider bars that do not match the declared session grid", () => {
    const profile = withEffectiveAggregation(
      normalizeResolutionProfile(
        {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
        },
        {
          default_requested_aggregation: "5m",
          default_max_observation_age_minutes: 60,
          default_max_temporal_skew_minutes: 0,
          default_fallback_aggregations: [],
        },
      ),
      "1h",
    );
    const aligned = resolveHistoricalBarTiming(
      { source_time: "2026-04-01T13:30:00.000Z" },
      "1h",
    );
    const providerMisaligned = resolveHistoricalBarTiming(
      { source_time: "2026-04-01T13:00:00.000Z" },
      "1h",
    );

    expect(
      historicalBarMatchesResolutionProfile(aligned, "1h", profile),
    ).toBe(true);
    expect(
      historicalBarMatchesResolutionProfile(
        providerMisaligned,
        "1h",
        profile,
      ),
    ).toBe(false);
  });
});
