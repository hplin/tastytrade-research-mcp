import { createHash } from "node:crypto";
import {
  normalizeRfc3339,
  resolveCheckpoint,
  type LocalCheckpointInput,
} from "./time.js";

export const RESOLUTION_PROFILE_VERSION = "1.0.0" as const;
export const DEFAULT_RESOLUTION_PROVIDER = "tastytrade-dxlink";

export type ResolutionProfileId =
  | "DEFAULT_5M"
  | "HOURLY_VALUATION_RESEARCH"
  | "DIRECT_CANDLE_REQUEST";

export type ResolutionProfileInput = {
  profile_id: Exclude<ResolutionProfileId, "DIRECT_CANDLE_REQUEST">;
  profile_version: typeof RESOLUTION_PROFILE_VERSION;
  provider_id?: string;
  max_observation_age_minutes?: number;
  max_temporal_skew_minutes?: number;
  allowed_fallback_aggregations?: string[];
};

export type ResolutionProfileSession =
  | {
      kind: "ALL";
      timezone: string;
      start_time: null;
      end_time: null;
    }
  | {
      kind: "REGULAR" | "CUSTOM";
      timezone: string;
      start_time: string;
      end_time: string;
    };

export type ResolutionProfile = {
  contract_version: typeof RESOLUTION_PROFILE_VERSION;
  profile_id: ResolutionProfileId;
  profile_version: typeof RESOLUTION_PROFILE_VERSION;
  provider_id: string;
  cohort_id: string;
  effective_cohort_id: string | null;
  requested_aggregation: string;
  native_aggregation: string;
  effective_aggregation: string | null;
  session: ResolutionProfileSession;
  alignment: "MIDNIGHT" | "SESSION";
  max_observation_age_minutes: number;
  max_temporal_skew_minutes: number;
  fallback_policy: {
    allowed: boolean;
    aggregations: string[];
    selection_rule: "FIRST_AVAILABLE_IN_DECLARED_ORDER";
  };
};

export type ResolutionProfileDefaults = {
  default_requested_aggregation: string;
  default_max_observation_age_minutes: number;
  default_max_temporal_skew_minutes: number;
  default_fallback_aggregations: string[];
  default_profile_id?: ResolutionProfileId;
  direct_session?: ResolutionProfileSession;
  direct_alignment?: "MIDNIGHT" | "SESSION";
};

export type CandidateConstructionProfile = Readonly<
  Record<string, unknown> & { version: string }
>;

export type HistoricalBarTimingInput = {
  source_time: string;
  bar_start?: string;
  bar_end?: string;
  available_at?: string;
  retrieved_at?: string;
};

export type HistoricalBarTiming = {
  bar_start: string;
  bar_end: string;
  available_at: string;
  retrieved_at: string | null;
};

const AGGREGATION_PATTERN = /^[1-9][0-9]*(s|m|h|d|w)$/;

function stableId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function minuteLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_440) {
    throw new Error(`${field} must be an integer between 0 and 1440.`);
  }
  return value;
}

function normalizeProviderId(value: string | undefined): string {
  const provider = value?.trim() || DEFAULT_RESOLUTION_PROVIDER;
  if (
    provider.length > 100 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(provider)
  ) {
    throw new Error(
      "resolution_profile.provider_id must be a 1-100 character provider identifier.",
    );
  }
  return provider;
}

export function nativeAggregation(aggregation: string): string {
  const normalized = aggregation.trim().toLowerCase();
  const match = AGGREGATION_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(
      "aggregation must use a positive integer followed by s, m, h, d, or w.",
    );
  }
  const amount = Number.parseInt(normalized, 10);
  return amount === 1 ? match[1] : normalized;
}

export function resolutionMilliseconds(aggregation: string): number {
  const normalized = aggregation.trim().toLowerCase();
  const match = AGGREGATION_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(
      "aggregation must use a positive integer followed by s, m, h, d, or w.",
    );
  }
  const amount = Number.parseInt(normalized, 10);
  const multiplier =
    match[1] === "s"
      ? 1_000
      : match[1] === "m"
        ? 60_000
        : match[1] === "h"
          ? 60 * 60_000
          : match[1] === "d"
            ? 24 * 60 * 60_000
            : 7 * 24 * 60 * 60_000;
  return amount * multiplier;
}

function profileSession(
  profileId: ResolutionProfileId,
  defaults: ResolutionProfileDefaults,
): {
  session: ResolutionProfileSession;
  alignment: "MIDNIGHT" | "SESSION";
} {
  if (profileId === "HOURLY_VALUATION_RESEARCH") {
    return {
      session: {
        kind: "REGULAR",
        timezone: "America/New_York",
        start_time: "09:30",
        end_time: "16:00",
      },
      alignment: "SESSION",
    };
  }
  if (profileId === "DIRECT_CANDLE_REQUEST") {
    return {
      session:
        defaults.direct_session ?? {
          kind: "ALL",
          timezone: "UTC",
          start_time: null,
          end_time: null,
        },
      alignment: defaults.direct_alignment ?? "MIDNIGHT",
    };
  }
  return {
    session: {
      kind: "ALL",
      timezone: "UTC",
      start_time: null,
      end_time: null,
    },
    alignment: "MIDNIGHT",
  };
}

function profileCohortIdentity(
  profile: Omit<
    ResolutionProfile,
    "cohort_id" | "effective_cohort_id" | "effective_aggregation"
  >,
): string {
  return stableId(profile);
}

export function normalizeResolutionProfile(
  input: ResolutionProfileInput | undefined,
  defaults: ResolutionProfileDefaults,
): ResolutionProfile {
  const defaultAggregation =
    defaults.default_requested_aggregation.trim().toLowerCase();
  nativeAggregation(defaultAggregation);
  for (const aggregation of defaults.default_fallback_aggregations) {
    nativeAggregation(aggregation);
  }
  const profileId: ResolutionProfileId =
    input?.profile_id ??
    defaults.default_profile_id ??
    (defaultAggregation === "5m"
      ? "DEFAULT_5M"
      : "DIRECT_CANDLE_REQUEST");
  if (
    input &&
    input.profile_version !== RESOLUTION_PROFILE_VERSION
  ) {
    throw new Error(
      `resolution_profile.profile_version must be ${RESOLUTION_PROFILE_VERSION}.`,
    );
  }
  const requestedAggregation =
    profileId === "HOURLY_VALUATION_RESEARCH"
      ? "1h"
      : profileId === "DEFAULT_5M"
        ? "5m"
        : defaultAggregation;
  const maxObservationAgeMinutes = minuteLimit(
    input?.max_observation_age_minutes ??
      defaults.default_max_observation_age_minutes,
    "resolution_profile.max_observation_age_minutes",
  );
  const maxTemporalSkewMinutes = minuteLimit(
    input?.max_temporal_skew_minutes ??
      defaults.default_max_temporal_skew_minutes,
    "resolution_profile.max_temporal_skew_minutes",
  );
  const fallbackAggregations = [
    ...(input?.allowed_fallback_aggregations ??
      (profileId === "HOURLY_VALUATION_RESEARCH"
        ? []
        : defaults.default_fallback_aggregations)),
  ];
  if (new Set(fallbackAggregations).size !== fallbackAggregations.length) {
    throw new Error(
      "resolution_profile.allowed_fallback_aggregations must not contain duplicates.",
    );
  }
  for (const aggregation of fallbackAggregations) {
    nativeAggregation(aggregation);
    if (aggregation === requestedAggregation) {
      throw new Error(
        "resolution_profile.allowed_fallback_aggregations must not repeat the requested aggregation.",
      );
    }
    if (
      resolutionMilliseconds(aggregation) <=
      resolutionMilliseconds(requestedAggregation)
    ) {
      throw new Error(
        "resolution_profile.allowed_fallback_aggregations must be coarser than the requested aggregation.",
      );
    }
  }
  const { session, alignment } = profileSession(profileId, defaults);
  const identity = {
    contract_version: RESOLUTION_PROFILE_VERSION,
    profile_id: profileId,
    profile_version: RESOLUTION_PROFILE_VERSION,
    provider_id: normalizeProviderId(input?.provider_id),
    requested_aggregation: requestedAggregation,
    native_aggregation: nativeAggregation(requestedAggregation),
    session,
    alignment,
    max_observation_age_minutes: maxObservationAgeMinutes,
    max_temporal_skew_minutes: maxTemporalSkewMinutes,
    fallback_policy: {
      allowed: fallbackAggregations.length > 0,
      aggregations: fallbackAggregations,
      selection_rule:
        "FIRST_AVAILABLE_IN_DECLARED_ORDER" as const,
    },
  };
  return {
    ...identity,
    cohort_id: profileCohortIdentity(identity),
    effective_cohort_id: null,
    effective_aggregation: null,
  };
}

export function withEffectiveAggregation(
  profile: ResolutionProfile,
  aggregation: string | null,
): ResolutionProfile {
  if (
    aggregation !== null &&
    aggregation !== profile.requested_aggregation &&
    !profile.fallback_policy.aggregations.includes(aggregation)
  ) {
    throw new Error(
      `Effective aggregation ${aggregation} is not allowed by resolution profile ${profile.profile_id}.`,
    );
  }
  return {
    ...profile,
    effective_aggregation: aggregation,
    effective_cohort_id:
      aggregation === null
        ? null
        : stableId({
            cohort_id: profile.cohort_id,
            effective_aggregation: aggregation,
          }),
  };
}

export function resolutionCandidates(
  profile: ResolutionProfile,
): string[] {
  return [
    profile.requested_aggregation,
    ...profile.fallback_policy.aggregations,
  ];
}

export function resolutionProfileInput(
  profile: ResolutionProfile,
): ResolutionProfileInput | undefined {
  if (profile.profile_id === "DIRECT_CANDLE_REQUEST") return undefined;
  return {
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    provider_id: profile.provider_id,
    max_observation_age_minutes: profile.max_observation_age_minutes,
    max_temporal_skew_minutes: profile.max_temporal_skew_minutes,
    allowed_fallback_aggregations: [
      ...profile.fallback_policy.aggregations,
    ],
  };
}

export function candleSessionForResolutionProfile(
  profile: ResolutionProfile,
):
  | { kind: "ALL"; timezone: string }
  | { kind: "REGULAR"; timezone: string }
  | {
      kind: "CUSTOM";
      timezone: string;
      start_time: string;
      end_time: string;
    } {
  if (profile.session.kind === "ALL") {
    return {
      kind: "ALL",
      timezone: profile.session.timezone,
    };
  }
  if (profile.session.kind === "REGULAR") {
    return {
      kind: "REGULAR",
      timezone: profile.session.timezone,
    };
  }
  return {
    kind: "CUSTOM",
    timezone: profile.session.timezone,
    start_time: profile.session.start_time,
    end_time: profile.session.end_time,
  };
}

export function resolutionCandleSource(
  profile: ResolutionProfile,
  streamerSymbol: string,
): string {
  const attributes = [`=${profile.native_aggregation}`];
  if (
    profile.session.kind === "REGULAR" &&
    profile.alignment === "SESSION"
  ) {
    attributes.push("a=s", "tho=true");
  }
  return `${profile.provider_id}:${streamerSymbol}{${attributes.join(",")}}`;
}

export function normalizeCandidateConstructionProfile(
  input: Record<string, unknown> | undefined,
): CandidateConstructionProfile | null {
  if (input === undefined) return null;
  if (!input || Array.isArray(input)) {
    throw new Error("candidate_construction_profile must be an object.");
  }
  const version = input.version;
  if (
    typeof version !== "string" ||
    version.trim().length === 0 ||
    version.length > 100
  ) {
    throw new Error(
      "candidate_construction_profile.version must be 1-100 characters.",
    );
  }
  try {
    JSON.stringify(input);
  } catch {
    throw new Error("candidate_construction_profile must be JSON-serializable.");
  }
  return input as CandidateConstructionProfile;
}

export function resolveHistoricalBarTiming(
  candle: HistoricalBarTimingInput,
  aggregation: string,
  resultRetrievedAt?: string | null,
): HistoricalBarTiming {
  const sourceTime = normalizeRfc3339(candle.source_time, "source_time");
  const barStart = normalizeRfc3339(
    candle.bar_start ?? sourceTime,
    "bar_start",
  );
  if (barStart !== sourceTime) {
    throw new Error("bar_start must equal the legacy source_time field.");
  }
  const expectedBarEnd = new Date(
    Date.parse(barStart) + resolutionMilliseconds(aggregation),
  ).toISOString();
  const barEnd = normalizeRfc3339(
    candle.bar_end ?? expectedBarEnd,
    "bar_end",
  );
  if (barEnd !== expectedBarEnd) {
    throw new Error(
      `bar_end must equal bar_start + ${aggregation}.`,
    );
  }
  const availableAt = normalizeRfc3339(
    candle.available_at ?? barEnd,
    "available_at",
  );
  if (Date.parse(availableAt) < Date.parse(barEnd)) {
    throw new Error("available_at must be at or after bar_end.");
  }
  const retrievedAtValue = candle.retrieved_at ?? resultRetrievedAt ?? null;
  return {
    bar_start: barStart,
    bar_end: barEnd,
    available_at: availableAt,
    retrieved_at:
      retrievedAtValue === null
        ? null
        : normalizeRfc3339(retrievedAtValue, "retrieved_at"),
  };
}

function dateInTimezone(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function alignedBarStarts(
  startMs: number,
  endMs: number,
  profile: ResolutionProfile,
): number[] {
  const intervalMs = resolutionMilliseconds(
    profile.effective_aggregation ?? profile.requested_aggregation,
  );
  if (profile.alignment === "MIDNIGHT") {
    const first = Math.ceil(startMs / intervalMs) * intervalMs;
    const times: number[] = [];
    for (
      let sourceTime = first;
      sourceTime + intervalMs <= endMs;
      sourceTime += intervalMs
    ) {
      times.push(sourceTime);
    }
    return times;
  }

  if (
    profile.session.start_time === null ||
    profile.session.end_time === null
  ) {
    throw new Error("Session alignment requires explicit session hours.");
  }
  const firstDate = dateInTimezone(
    startMs - 24 * 60 * 60_000,
    profile.session.timezone,
  );
  const lastDate = dateInTimezone(
    endMs + 24 * 60 * 60_000,
    profile.session.timezone,
  );
  const times: number[] = [];
  for (
    let localDate = firstDate;
    localDate <= lastDate;
    localDate = shiftDate(localDate, 1)
  ) {
    const sessionStart = Date.parse(
      resolveCheckpoint(undefined, {
        local_date: localDate,
        local_time: profile.session.start_time,
        timezone: profile.session.timezone,
      } satisfies LocalCheckpointInput).instant,
    );
    let sessionEndDate = localDate;
    if (profile.session.end_time <= profile.session.start_time) {
      sessionEndDate = shiftDate(localDate, 1);
    }
    const sessionEnd = Date.parse(
      resolveCheckpoint(undefined, {
        local_date: sessionEndDate,
        local_time: profile.session.end_time,
        timezone: profile.session.timezone,
      } satisfies LocalCheckpointInput).instant,
    );
    for (
      let sourceTime = sessionStart;
      sourceTime + intervalMs <= sessionEnd;
      sourceTime += intervalMs
    ) {
      if (
        sourceTime >= startMs &&
        sourceTime + intervalMs <= endMs
      ) {
        times.push(sourceTime);
      }
    }
  }
  return [...new Set(times)].sort((left, right) => left - right);
}
