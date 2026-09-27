import { createHash } from "node:crypto";
import {
  EvidenceCacheError,
  type EvidenceCacheRequest,
  type EvidenceRole,
} from "./evidence-cache.js";
import type { ExecutionReferences } from "./execution-evidence.js";
import {
  getHistoricalOptionPackageAtCheckpoint,
  normalizeHistoricalOptionPackageCheckpointProfile,
  parseHistoricalOptionSymbol,
  validateHistoricalOptionPackageLegs,
  type HistoricalOptionPackageCandlesService,
  type HistoricalOptionPackageCheckpointResult,
  type HistoricalOptionPackageLegFailureReason,
  type HistoricalOptionPackageLegInput,
  type HistoricalOptionPackageLegObservation,
} from "./historical-option-package.js";
import type { SpreadFamily } from "./package-pricing.js";
import {
  normalizeCandidateConstructionProfile,
  type CandidateConstructionProfile,
  type ResolutionProfile,
  type ResolutionProfileInput,
} from "./resolution-profile.js";
import { normalizeDate, resolveCheckpoint } from "./time.js";

export type HistoricalOptionPackageHorizonId =
  | "ENTRY"
  | "OUTCOME_3_TRADING_DAYS"
  | "OUTCOME_5_TRADING_DAYS";

export type HistoricalOptionPackageHorizonLegInput =
  HistoricalOptionPackageLegInput & {
    role: string;
  };

export type HistoricalOptionPackageHorizonCandidateInput = {
  candidate_id: string;
  family: SpreadFamily;
  entry_date: string;
  legs: HistoricalOptionPackageHorizonLegInput[];
  references?: ExecutionReferences;
};

export type HistoricalTradingCalendarInput = {
  timezone: string;
  local_time: string;
  session_dates: string[];
};

export type HistoricalOptionPackageHorizonsInput = {
  underlying: "SPX";
  trading_calendar: HistoricalTradingCalendarInput;
  horizons?: HistoricalOptionPackageHorizonId[];
  candidates: HistoricalOptionPackageHorizonCandidateInput[];
  max_observation_age_minutes?: number;
  max_temporal_skew_minutes?: number;
  resolution_profile?: ResolutionProfileInput;
  candidate_construction_profile?: Record<string, unknown>;
  phase: "REGRESSION_RESEARCH";
  evidence_cache?: EvidenceCacheRequest;
};

export type HistoricalOptionPackageHorizonLegResult = {
  role: string;
  provider_symbol: string;
  action: HistoricalOptionPackageLegInput["action"];
  quantity: number;
  lifecycle: NonNullable<HistoricalOptionPackageLegInput["lifecycle"]>;
  expiration: string;
  dte_at_entry: number;
  dte_at_checkpoint: number;
  reconstruction_status: "AVAILABLE" | "NOT_AVAILABLE";
  failure_reason: HistoricalOptionPackageLegFailureReason | null;
  observation: HistoricalOptionPackageLegObservation | null;
};

export type HistoricalOptionPackageHorizonResult = {
  horizon_id: HistoricalOptionPackageHorizonId;
  trading_days: 0 | 3 | 5;
  session_date: string;
  scheduled_checkpoint: string;
  status: "AVAILABLE" | "NOT_AVAILABLE" | "ERROR";
  evidence_class: "VALUATION_ONLY";
  reference_type: "CANDLE_REFERENCE";
  resolution_profile: ResolutionProfile;
  failure_reasons: HistoricalOptionPackageLegFailureReason[];
  legs: HistoricalOptionPackageHorizonLegResult[];
  package: HistoricalOptionPackageCheckpointResult | null;
  error: {
    category: "CACHE_ERROR" | "PROVIDER_ERROR";
    message: string;
  } | null;
};

export type HistoricalOptionPackageHorizonsResult = {
  contract_version: "1.0.0";
  request_id: string;
  status: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  evidence_type: "HISTORICAL_OPTION_PACKAGE_HORIZONS";
  evidence_phase: "REGRESSION_RESEARCH";
  evidence_class: "VALUATION_ONLY";
  reference_type: "CANDLE_REFERENCE";
  underlying: "SPX";
  trading_calendar: {
    source: "CALLER_SUPPLIED";
    timezone: string;
    local_time: string;
    session_dates: string[];
  };
  horizons: Array<{
    horizon_id: HistoricalOptionPackageHorizonId;
    trading_days: 0 | 3 | 5;
  }>;
  resolution_profile: ResolutionProfile;
  candidate_construction_profile: CandidateConstructionProfile | null;
  candidates: Array<{
    candidate_id: string;
    family: SpreadFamily;
    entry_date: string;
    frozen_legs: Array<{
      role: string;
      provider_symbol: string;
      action: HistoricalOptionPackageLegInput["action"];
      quantity: number;
      lifecycle: NonNullable<HistoricalOptionPackageLegInput["lifecycle"]>;
      expiration: string;
      dte_at_entry: number;
    }>;
    horizons: HistoricalOptionPackageHorizonResult[];
  }>;
  coverage: {
    requested_candidates: number;
    requested_package_checkpoints: number;
    complete_entry_packages: number;
    complete_outcome_3_trading_days_packages: number;
    complete_outcome_5_trading_days_packages: number;
    complete_packages: number;
    missing_leg_count_by_role: Array<{
      role: string;
      count: number;
    }>;
    missing_reason_counts: Array<{
      reason: HistoricalOptionPackageLegFailureReason;
      count: number;
    }>;
    by_strategy: Array<{
      strategy: SpreadFamily;
      requested_packages: number;
      complete_packages: number;
      unavailable_packages: number;
    }>;
    by_expiration: Array<{
      expiration: string;
      requested_leg_observations: number;
      available_leg_observations: number;
      missing_leg_observations: number;
    }>;
    by_dte_at_entry: Array<{
      dte_at_entry: number;
      requested_leg_observations: number;
      available_leg_observations: number;
      missing_leg_observations: number;
    }>;
    by_resolution_profile: Array<{
      profile_id: string;
      profile_version: string;
      requested_aggregation: string;
      effective_aggregation: string | null;
      requested_packages: number;
      complete_packages: number;
      unavailable_packages: number;
    }>;
  };
  warnings: string[];
};

type HorizonDefinition = {
  horizon_id: HistoricalOptionPackageHorizonId;
  trading_days: 0 | 3 | 5;
  evidence_role: EvidenceRole;
};

type NormalizedCandidate = {
  candidate_id: string;
  family: SpreadFamily;
  entry_date: string;
  entry_index: number;
  references: ExecutionReferences;
  legs: Array<
    HistoricalOptionPackageHorizonLegInput & {
      quantity: number;
      lifecycle: NonNullable<HistoricalOptionPackageLegInput["lifecycle"]>;
      expiration: string;
      dte_at_entry: number;
    }
  >;
};

const MAX_CANDIDATES = 50;
const MAX_CALENDAR_SESSIONS = 400;
const HORIZONS: HorizonDefinition[] = [
  {
    horizon_id: "ENTRY",
    trading_days: 0,
    evidence_role: "ENTRY",
  },
  {
    horizon_id: "OUTCOME_3_TRADING_DAYS",
    trading_days: 3,
    evidence_role: "OUTCOME_3_TRADING_DAYS",
  },
  {
    horizon_id: "OUTCOME_5_TRADING_DAYS",
    trading_days: 5,
    evidence_role: "OUTCOME_5_TRADING_DAYS",
  },
];

function stableRequestId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nonEmptyString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error(`${field} must be 1-200 characters.`);
  }
  return normalized;
}

function normalizeReferences(
  references: ExecutionReferences | undefined,
  field: string,
): ExecutionReferences {
  const normalized: ExecutionReferences = {};
  for (const name of [
    "checkpoint_id",
    "paper_order_id",
    "position_id",
  ] as const) {
    const value = references?.[name];
    if (value === undefined) continue;
    normalized[name] = nonEmptyString(value, `${field}.${name}`);
  }
  return normalized;
}

function calendarDaysBetween(start: string, end: string): number {
  return Math.floor(
    (Date.parse(`${end}T00:00:00.000Z`) -
      Date.parse(`${start}T00:00:00.000Z`)) /
      86_400_000,
  );
}

function normalizeTradingCalendar(
  input: HistoricalTradingCalendarInput,
): HistoricalOptionPackageHorizonsResult["trading_calendar"] {
  if (
    !Array.isArray(input.session_dates) ||
    input.session_dates.length < 1 ||
    input.session_dates.length > MAX_CALENDAR_SESSIONS
  ) {
    throw new Error(
      `trading_calendar.session_dates must contain between 1 and ${MAX_CALENDAR_SESSIONS} dates.`,
    );
  }
  const sessionDates = input.session_dates.map((value, index) =>
    normalizeDate(value, `trading_calendar.session_dates[${index}]`),
  );
  for (let index = 1; index < sessionDates.length; index += 1) {
    if (sessionDates[index] <= sessionDates[index - 1]) {
      throw new Error(
        "trading_calendar.session_dates must be unique and strictly increasing.",
      );
    }
  }
  const firstCheckpoint = resolveCheckpoint(undefined, {
    local_date: sessionDates[0],
    local_time: input.local_time,
    timezone: input.timezone,
  });
  return {
    source: "CALLER_SUPPLIED",
    timezone: firstCheckpoint.timezone!,
    local_time: firstCheckpoint.local_time!,
    session_dates: sessionDates,
  };
}

function normalizeHorizons(
  values: HistoricalOptionPackageHorizonId[] | undefined,
): HorizonDefinition[] {
  const requested = values ?? HORIZONS.map((item) => item.horizon_id);
  if (
    !Array.isArray(requested) ||
    requested.length < 1 ||
    requested.length > HORIZONS.length
  ) {
    throw new Error("horizons must contain between 1 and 3 values.");
  }
  const requestedSet = new Set(requested);
  if (requestedSet.size !== requested.length) {
    throw new Error("horizons must not contain duplicates.");
  }
  if (
    requested.some(
      (value) => !HORIZONS.some((item) => item.horizon_id === value),
    )
  ) {
    throw new Error(
      "horizons may contain only ENTRY, OUTCOME_3_TRADING_DAYS, and OUTCOME_5_TRADING_DAYS.",
    );
  }
  return HORIZONS.filter((item) => requestedSet.has(item.horizon_id));
}

function normalizeCandidates(
  candidates: HistoricalOptionPackageHorizonCandidateInput[],
  calendar: HistoricalOptionPackageHorizonsResult["trading_calendar"],
  horizons: HorizonDefinition[],
  fallbackReferences: ExecutionReferences | undefined,
): NormalizedCandidate[] {
  if (
    !Array.isArray(candidates) ||
    candidates.length < 1 ||
    candidates.length > MAX_CANDIDATES
  ) {
    throw new Error(
      `candidates must contain between 1 and ${MAX_CANDIDATES} frozen candidates.`,
    );
  }
  const candidateIds = new Set<string>();
  return candidates.map((candidate, candidateIndex) => {
    const candidateId = nonEmptyString(
      candidate.candidate_id,
      `candidates[${candidateIndex}].candidate_id`,
    );
    if (candidateIds.has(candidateId)) {
      throw new Error(`Duplicate candidate_id: ${candidateId}.`);
    }
    candidateIds.add(candidateId);
    const entryDate = normalizeDate(
      candidate.entry_date,
      `candidates[${candidateIndex}].entry_date`,
    );
    const entryIndex = calendar.session_dates.indexOf(entryDate);
    if (entryIndex < 0) {
      throw new Error(
        `Candidate ${candidateId} entry_date is absent from the caller-supplied trading calendar.`,
      );
    }
    for (const horizon of horizons) {
      if (
        calendar.session_dates[entryIndex + horizon.trading_days] ===
        undefined
      ) {
        throw new Error(
          `Candidate ${candidateId} lacks a caller-supplied trading session for ${horizon.horizon_id}.`,
        );
      }
    }
    validateHistoricalOptionPackageLegs(candidate.family, candidate.legs);
    const roles = new Set<string>();
    const legs = candidate.legs.map((leg, legIndex) => {
      const role = nonEmptyString(
        leg.role,
        `candidates[${candidateIndex}].legs[${legIndex}].role`,
      );
      if (roles.has(role)) {
        throw new Error(
          `Candidate ${candidateId} contains duplicate leg role ${role}.`,
        );
      }
      roles.add(role);
      const parsed = parseHistoricalOptionSymbol(leg.provider_symbol);
      return {
        ...leg,
        role,
        quantity: leg.quantity ?? 1,
        lifecycle: leg.lifecycle ?? "UNKNOWN",
        expiration: parsed.expiration,
        dte_at_entry: calendarDaysBetween(
          entryDate,
          parsed.expiration,
        ),
      };
    });
    return {
      candidate_id: candidateId,
      family: candidate.family,
      entry_date: entryDate,
      entry_index: entryIndex,
      references: normalizeReferences(
        candidate.references ?? fallbackReferences,
        `candidates[${candidateIndex}].references`,
      ),
      legs,
    };
  });
}

function addCount<K>(map: Map<K, number>, key: K, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

function isProviderOriginatedCacheError(
  error: EvidenceCacheError,
): boolean {
  return (
    error.code === "EVIDENCE_CACHE_PROVIDER_ERROR" ||
    error.code === "EVIDENCE_CACHE_RECORDED_FAILURE"
  );
}

function evidenceCacheForHorizon(
  request: EvidenceCacheRequest | undefined,
  horizon: HorizonDefinition,
  asOf: string,
  references: ExecutionReferences,
): EvidenceCacheRequest | undefined {
  if (!request) return undefined;
  return {
    ...request,
    as_of: asOf,
    evidence_role: horizon.evidence_role,
    references,
  };
}

function errorHorizonLegs(
  candidate: NormalizedCandidate,
  sessionDate: string,
  reason: "CACHE_ERROR" | "PROVIDER_ERROR",
): HistoricalOptionPackageHorizonLegResult[] {
  return candidate.legs.map((leg) => ({
    role: leg.role,
    provider_symbol: leg.provider_symbol,
    action: leg.action,
    quantity: leg.quantity,
    lifecycle: leg.lifecycle,
    expiration: leg.expiration,
    dte_at_entry: leg.dte_at_entry,
    dte_at_checkpoint: calendarDaysBetween(
      sessionDate,
      leg.expiration,
    ),
    reconstruction_status: "NOT_AVAILABLE",
    failure_reason: reason,
    observation: null,
  }));
}

function packageHorizonLegs(
  candidate: NormalizedCandidate,
  sessionDate: string,
  result: HistoricalOptionPackageCheckpointResult,
): HistoricalOptionPackageHorizonLegResult[] {
  const observations = new Map(
    result.legs.map((leg) => [leg.provider_symbol, leg]),
  );
  return candidate.legs.map((leg) => {
    const observation = observations.get(leg.provider_symbol);
    if (!observation) {
      return {
        role: leg.role,
        provider_symbol: leg.provider_symbol,
        action: leg.action,
        quantity: leg.quantity,
        lifecycle: leg.lifecycle,
        expiration: leg.expiration,
        dte_at_entry: leg.dte_at_entry,
        dte_at_checkpoint: calendarDaysBetween(
          sessionDate,
          leg.expiration,
        ),
        reconstruction_status: "NOT_AVAILABLE" as const,
        failure_reason: "PROVIDER_ERROR" as const,
        observation: null,
      };
    }
    return {
      role: leg.role,
      provider_symbol: leg.provider_symbol,
      action: leg.action,
      quantity: leg.quantity,
      lifecycle: leg.lifecycle,
      expiration: leg.expiration,
      dte_at_entry: leg.dte_at_entry,
      dte_at_checkpoint: calendarDaysBetween(
        sessionDate,
        leg.expiration,
      ),
      reconstruction_status: observation.reconstruction_status,
      failure_reason: observation.failure_reason,
      observation,
    };
  });
}

function buildCoverage(
  candidates: HistoricalOptionPackageHorizonsResult["candidates"],
): HistoricalOptionPackageHorizonsResult["coverage"] {
  const allHorizons = candidates.flatMap((candidate) =>
    candidate.horizons.map((horizon) => ({
      family: candidate.family,
      horizon,
    })),
  );
  const missingByRole = new Map<string, number>();
  const missingByReason = new Map<
    HistoricalOptionPackageLegFailureReason,
    number
  >();
  const strategyCoverage = new Map<
    SpreadFamily,
    {
      requested_packages: number;
      complete_packages: number;
    }
  >();
  const expirationCoverage = new Map<
    string,
    { requested: number; available: number }
  >();
  const dteCoverage = new Map<
    number,
    { requested: number; available: number }
  >();
  const resolutionCoverage = new Map<
    string,
    {
      profile_id: string;
      profile_version: string;
      requested_aggregation: string;
      effective_aggregation: string | null;
      requested_packages: number;
      complete_packages: number;
    }
  >();

  for (const { family, horizon } of allHorizons) {
    const strategy = strategyCoverage.get(family) ?? {
      requested_packages: 0,
      complete_packages: 0,
    };
    strategy.requested_packages += 1;
    if (horizon.status === "AVAILABLE") strategy.complete_packages += 1;
    strategyCoverage.set(family, strategy);

    const profile = horizon.resolution_profile;
    const profileId = profile.profile_id;
    const profileVersion = profile.profile_version;
    const requestedAggregation = profile.requested_aggregation;
    const effectiveAggregation = profile.effective_aggregation;
    const profileKey = [
      profileId,
      profileVersion,
      requestedAggregation,
      effectiveAggregation ?? "NONE",
    ].join(":");
    const resolution = resolutionCoverage.get(profileKey) ?? {
      profile_id: profileId,
      profile_version: profileVersion,
      requested_aggregation: requestedAggregation,
      effective_aggregation: effectiveAggregation,
      requested_packages: 0,
      complete_packages: 0,
    };
    resolution.requested_packages += 1;
    if (horizon.status === "AVAILABLE") resolution.complete_packages += 1;
    resolutionCoverage.set(profileKey, resolution);

    const legReasons = new Set<HistoricalOptionPackageLegFailureReason>();
    for (const leg of horizon.legs) {
      const expiration = expirationCoverage.get(leg.expiration) ?? {
        requested: 0,
        available: 0,
      };
      expiration.requested += 1;
      if (leg.reconstruction_status === "AVAILABLE") {
        expiration.available += 1;
      } else {
        addCount(missingByRole, leg.role);
      }
      expirationCoverage.set(leg.expiration, expiration);

      const dte = dteCoverage.get(leg.dte_at_entry) ?? {
        requested: 0,
        available: 0,
      };
      dte.requested += 1;
      if (leg.reconstruction_status === "AVAILABLE") {
        dte.available += 1;
      }
      dteCoverage.set(leg.dte_at_entry, dte);

      if (leg.failure_reason !== null) {
        addCount(missingByReason, leg.failure_reason);
        legReasons.add(leg.failure_reason);
      }
    }
    for (const reason of horizon.failure_reasons) {
      if (!legReasons.has(reason)) addCount(missingByReason, reason);
    }
  }

  const completePackages = allHorizons.filter(
    ({ horizon }) => horizon.status === "AVAILABLE",
  ).length;
  const completeByHorizon = (
    horizonId: HistoricalOptionPackageHorizonId,
  ) =>
    allHorizons.filter(
      ({ horizon }) =>
        horizon.horizon_id === horizonId &&
        horizon.status === "AVAILABLE",
    ).length;
  return {
    requested_candidates: candidates.length,
    requested_package_checkpoints: allHorizons.length,
    complete_entry_packages: completeByHorizon("ENTRY"),
    complete_outcome_3_trading_days_packages: completeByHorizon(
      "OUTCOME_3_TRADING_DAYS",
    ),
    complete_outcome_5_trading_days_packages: completeByHorizon(
      "OUTCOME_5_TRADING_DAYS",
    ),
    complete_packages: completePackages,
    missing_leg_count_by_role: [...missingByRole.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((left, right) => left.role.localeCompare(right.role)),
    missing_reason_counts: [...missingByReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => left.reason.localeCompare(right.reason)),
    by_strategy: [...strategyCoverage.entries()]
      .map(([strategy, coverage]) => ({
        strategy,
        ...coverage,
        unavailable_packages:
          coverage.requested_packages - coverage.complete_packages,
      }))
      .sort((left, right) => left.strategy.localeCompare(right.strategy)),
    by_expiration: [...expirationCoverage.entries()]
      .map(([expiration, coverage]) => ({
        expiration,
        requested_leg_observations: coverage.requested,
        available_leg_observations: coverage.available,
        missing_leg_observations:
          coverage.requested - coverage.available,
      }))
      .sort((left, right) => left.expiration.localeCompare(right.expiration)),
    by_dte_at_entry: [...dteCoverage.entries()]
      .map(([dte_at_entry, coverage]) => ({
        dte_at_entry,
        requested_leg_observations: coverage.requested,
        available_leg_observations: coverage.available,
        missing_leg_observations:
          coverage.requested - coverage.available,
      }))
      .sort((left, right) => left.dte_at_entry - right.dte_at_entry),
    by_resolution_profile: [...resolutionCoverage.values()]
      .map((coverage) => ({
        ...coverage,
        unavailable_packages:
          coverage.requested_packages - coverage.complete_packages,
      }))
      .sort(
        (left, right) =>
          left.profile_id.localeCompare(right.profile_id) ||
          String(left.effective_aggregation).localeCompare(
            String(right.effective_aggregation),
          ),
      ),
  };
}

export async function getHistoricalOptionPackageHorizons(
  service: HistoricalOptionPackageCandlesService,
  input: HistoricalOptionPackageHorizonsInput,
): Promise<HistoricalOptionPackageHorizonsResult> {
  if (input.underlying !== "SPX") {
    throw new Error("Historical option package horizons support SPX only.");
  }
  if (input.phase !== "REGRESSION_RESEARCH") {
    throw new Error("phase must be REGRESSION_RESEARCH.");
  }
  if (
    input.evidence_cache?.as_of !== undefined ||
    input.evidence_cache?.evidence_role !== undefined
  ) {
    throw new Error(
      "Horizon workflows assign evidence_cache.as_of and evidence_cache.evidence_role per checkpoint; omit both fields.",
    );
  }
  const tradingCalendar = normalizeTradingCalendar(
    input.trading_calendar,
  );
  const horizons = normalizeHorizons(input.horizons);
  const resolutionProfile =
    normalizeHistoricalOptionPackageCheckpointProfile(input);
  const candidateConstructionProfile =
    normalizeCandidateConstructionProfile(
      input.candidate_construction_profile,
    );
  const candidates = normalizeCandidates(
    input.candidates,
    tradingCalendar,
    horizons,
    input.evidence_cache?.references,
  );
  const requestId = stableRequestId({
    underlying: input.underlying,
    trading_calendar: tradingCalendar,
    horizons,
    candidates,
    resolution_profile: resolutionProfile,
    candidate_construction_profile: candidateConstructionProfile,
  });
  const checkpointBySessionDate = new Map<string, string>();
  for (const candidate of candidates) {
    for (const horizon of horizons) {
      const sessionDate =
        tradingCalendar.session_dates[
          candidate.entry_index + horizon.trading_days
        ];
      if (!checkpointBySessionDate.has(sessionDate)) {
        checkpointBySessionDate.set(
          sessionDate,
          resolveCheckpoint(
            undefined,
            {
              local_date: sessionDate,
              local_time: tradingCalendar.local_time,
              timezone: tradingCalendar.timezone,
            },
            `trading_calendar.${sessionDate}`,
          ).instant,
        );
      }
    }
  }

  const candidateResults: HistoricalOptionPackageHorizonsResult["candidates"] =
    [];
  for (const candidate of candidates) {
    const horizonResults: HistoricalOptionPackageHorizonResult[] = [];
    for (const horizon of horizons) {
      const sessionDate =
        tradingCalendar.session_dates[
          candidate.entry_index + horizon.trading_days
        ];
      const scheduledCheckpoint = checkpointBySessionDate.get(sessionDate)!;
      try {
        const packageResult =
          await getHistoricalOptionPackageAtCheckpoint(service, {
            family: candidate.family,
            underlying: "SPX",
            as_of: scheduledCheckpoint,
            legs: candidate.legs.map((leg) => ({
              provider_symbol: leg.provider_symbol,
              action: leg.action,
              quantity: leg.quantity,
              lifecycle: leg.lifecycle,
            })),
            max_observation_age_minutes:
              input.max_observation_age_minutes,
            max_temporal_skew_minutes:
              input.max_temporal_skew_minutes,
            resolution_profile: input.resolution_profile,
            candidate_construction_profile:
              input.candidate_construction_profile,
            phase: "REGRESSION_RESEARCH",
            references: candidate.references,
            evidence_cache: evidenceCacheForHorizon(
              input.evidence_cache,
              horizon,
              scheduledCheckpoint,
              candidate.references,
            ),
          });
        const legs = packageHorizonLegs(
          candidate,
          sessionDate,
          packageResult,
        );
        horizonResults.push({
          horizon_id: horizon.horizon_id,
          trading_days: horizon.trading_days,
          session_date: sessionDate,
          scheduled_checkpoint: scheduledCheckpoint,
          status: packageResult.status,
          evidence_class: "VALUATION_ONLY",
          reference_type: "CANDLE_REFERENCE",
          resolution_profile: packageResult.resolution_profile,
          failure_reasons: [...packageResult.failure_reasons],
          legs,
          package: packageResult,
          error: null,
        });
      } catch (error) {
        const providerOriginatedCacheError =
          error instanceof EvidenceCacheError &&
          isProviderOriginatedCacheError(error);
        if (
          error instanceof EvidenceCacheError &&
          input.evidence_cache?.mode === "CACHE_ONLY" &&
          !providerOriginatedCacheError
        ) {
          throw error;
        }
        const category =
          error instanceof EvidenceCacheError &&
          !providerOriginatedCacheError
            ? "CACHE_ERROR"
            : "PROVIDER_ERROR";
        horizonResults.push({
          horizon_id: horizon.horizon_id,
          trading_days: horizon.trading_days,
          session_date: sessionDate,
          scheduled_checkpoint: scheduledCheckpoint,
          status: "ERROR",
          evidence_class: "VALUATION_ONLY",
          reference_type: "CANDLE_REFERENCE",
          resolution_profile: resolutionProfile,
          failure_reasons: [category],
          legs: errorHorizonLegs(candidate, sessionDate, category),
          package: null,
          error: {
            category,
            message: errorMessage(error),
          },
        });
      }
    }
    candidateResults.push({
      candidate_id: candidate.candidate_id,
      family: candidate.family,
      entry_date: candidate.entry_date,
      frozen_legs: candidate.legs.map((leg) => ({
        role: leg.role,
        provider_symbol: leg.provider_symbol,
        action: leg.action,
        quantity: leg.quantity,
        lifecycle: leg.lifecycle,
        expiration: leg.expiration,
        dte_at_entry: leg.dte_at_entry,
      })),
      horizons: horizonResults,
    });
  }

  const coverage = buildCoverage(candidateResults);
  const unavailablePackages =
    coverage.requested_package_checkpoints - coverage.complete_packages;
  return {
    contract_version: "1.0.0",
    request_id: requestId,
    status:
      unavailablePackages === 0
        ? "COMPLETE"
        : coverage.complete_packages > 0
          ? "PARTIAL"
          : "NOT_AVAILABLE",
    evidence_type: "HISTORICAL_OPTION_PACKAGE_HORIZONS",
    evidence_phase: "REGRESSION_RESEARCH",
    evidence_class: "VALUATION_ONLY",
    reference_type: "CANDLE_REFERENCE",
    underlying: "SPX",
    trading_calendar: tradingCalendar,
    horizons: horizons.map(({ horizon_id, trading_days }) => ({
      horizon_id,
      trading_days,
    })),
    resolution_profile: resolutionProfile,
    candidate_construction_profile: candidateConstructionProfile,
    candidates: candidateResults,
    coverage,
    warnings: [
      "TRADING_CALENDAR_CALLER_SUPPLIED_NO_WEEKDAY_INFERENCE",
      "EXACT_FROZEN_LEGS_NO_SUBSTITUTION",
      "HISTORICAL_BID_ASK_NOT_AVAILABLE",
      "CANDLE_REFERENCES_ARE_VALUATION_ONLY",
      "VALUATION_ONLY_NOT_EXECUTABLE",
      ...(unavailablePackages > 0
        ? [`PACKAGE_CHECKPOINTS_NOT_AVAILABLE:${unavailablePackages}`]
        : []),
    ],
  };
}
