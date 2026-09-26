import { describe, expect, test } from "@jest/globals";
import {
  normalizeResolutionProfile,
  withEffectiveAggregation,
} from "../dist/resolution-profile.js";
import { resolveCheckpoint } from "../dist/time.js";

describe("research resolution profiles", () => {
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
});
