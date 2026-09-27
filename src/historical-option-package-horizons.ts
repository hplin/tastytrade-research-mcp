import { createHash } from "node:crypto";
import { ExactDecimal, type DecimalInput } from "./decimal.js";
import {
  EvidenceCacheError,
  stableEvidenceContentId,
  type EvidenceCacheRequest,
  type EvidenceRole,
} from "./evidence-cache.js";
import type { ExecutionReferences } from "./execution-evidence.js";
import type {
  HistoricalExecutionEvidenceInput,
  HistoricalReferenceInput,
} from "./historical-execution-evidence.js";
import type { HistoricalExecutionSourceContract } from "./historical-execution-model.js";
import {
  calculateHistoricalOptionPackageValue,
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
import { blackScholesSpotPrice } from "./option-model.js";
import type { SpreadFamily } from "./package-pricing.js";
import {
  normalizeCandidateConstructionProfile,
  type CandidateConstructionProfile,
  type ResolutionProfile,
  type ResolutionProfileInput,
} from "./resolution-profile.js";
import {
  normalizeDate,
  normalizeRfc3339,
  resolveCheckpoint,
} from "./time.js";

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

export type HistoricalModelSourceInput = {
  observed_at: string;
  available_at: string;
  retrieved_at: string;
  source: string;
  dataset_id: string;
  license_scope_id: string;
  source_revision: string;
  manifest_ids?: string[];
  normalized_content_ids?: string[];
};

export type HistoricalOptionModelUnderlyingInput =
  HistoricalModelSourceInput & {
    value: DecimalInput;
  };

export type HistoricalOptionModelLegInput =
  HistoricalModelSourceInput & {
    provider_symbol: string;
    implied_volatility: DecimalInput;
    iv_origin: "DIRECT_OPTION_IV" | "INTERPOLATED_SURFACE";
    surface_id?: string | null;
    source_symbols?: string[];
  };

export type HistoricalOptionModelCheckpointInput = {
  session_date: string;
  underlying: HistoricalOptionModelUnderlyingInput;
  leg_inputs: HistoricalOptionModelLegInput[];
};

export type HistoricalOptionPackageValuationFallbackInput = {
  mode: "MODEL_IF_LEG_MISSING";
  pricing_model: "BLACK_SCHOLES_SPOT";
  model_version: string;
  source_contract: HistoricalExecutionSourceContract;
  annualized_risk_free_rate: DecimalInput;
  annualized_dividend_yield: DecimalInput;
  volatility_shift_fraction: DecimalInput;
  max_input_age_minutes?: number;
  checkpoints: HistoricalOptionModelCheckpointInput[];
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
  valuation_fallback?: HistoricalOptionPackageValuationFallbackInput;
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

export type HistoricalOptionPackageValuationBasis =
  | "EXACT_PACKAGE_REFERENCE"
  | "MIXED_OBSERVED_MODELED"
  | "MODEL_SURFACE";

export type HistoricalOptionPackageModelSource = {
  observed_at: string;
  available_at: string;
  retrieved_at: string;
  source: string;
  dataset_id: string;
  license_scope_id: string;
  source_revision: string;
  manifest_ids: string[];
  normalized_content_ids: string[];
  input_age_minutes: number;
};

export type HistoricalOptionPackageModelProvenance = {
  pricing_model: "BLACK_SCHOLES_SPOT";
  model_version: string;
  checkpoint: string;
  underlying_value: string;
  strike: string;
  expiration: string;
  expiration_timestamp: string;
  dte_at_checkpoint: number;
  years_to_expiration: string;
  option_side: "CALL" | "PUT";
  implied_volatility: string;
  iv_origin: "DIRECT_OPTION_IV" | "INTERPOLATED_SURFACE";
  surface_id: string | null;
  source_symbols: string[];
  annualized_risk_free_rate: string;
  annualized_dividend_yield: string;
  multiplier: "100";
  settlement: "AM" | "PM";
  underlying_input: HistoricalOptionPackageModelSource;
  iv_input: HistoricalOptionPackageModelSource;
  manifest_ids: string[];
  normalized_content_ids: string[];
};

export type HistoricalOptionPackageHorizonValuationLeg = {
  role: string;
  provider_symbol: string;
  action: HistoricalOptionPackageLegInput["action"];
  quantity: number;
  lifecycle: NonNullable<HistoricalOptionPackageLegInput["lifecycle"]>;
  expiration: string;
  dte_at_entry: number;
  dte_at_checkpoint: number;
  valuation_source: "OBSERVED" | "MODELED" | "UNAVAILABLE";
  valuation_basis: "CANDLE_REFERENCE" | "MODEL_SURFACE" | null;
  value: string | null;
  source_failure_reason: HistoricalOptionPackageLegFailureReason | null;
  model_failure_reason:
    | "MODEL_CHECKPOINT_UNAVAILABLE"
    | "MODEL_LEG_INPUT_UNAVAILABLE"
    | "STRICT_RECONSTRUCTION_NOT_MODELABLE"
    | "OPTION_EXPIRED_AT_CHECKPOINT"
    | null;
  model_provenance: HistoricalOptionPackageModelProvenance | null;
  uncertainty: {
    method: "IV_SHIFT";
    volatility_shift_fraction: string;
    value_low: string;
    value_high: string;
  } | null;
};

export type HistoricalOptionPackageHorizonValuation = {
  status: "AVAILABLE" | "NOT_AVAILABLE";
  valuation_basis: HistoricalOptionPackageValuationBasis | null;
  quality: "HIGH" | "MEDIUM" | "LOW" | null;
  evidence_class: "VALUATION_ONLY";
  reference_type: "CANDLE_REFERENCE" | "MODEL_REFERENCE" | null;
  guaranteed_executable: false;
  observed_leg_count: number;
  modeled_leg_count: number;
  unavailable_leg_count: number;
  failure_reasons: string[];
  legs: HistoricalOptionPackageHorizonValuationLeg[];
  reference_value: {
    value: string;
    price_effect: "DEBIT" | "CREDIT" | "EVEN";
    evidence_type:
      | "HISTORICAL_OPTION_PACKAGE_REFERENCE"
      | "HISTORICAL_OPTION_PACKAGE_MODEL_VALUATION";
    reference_type: "CANDLE_REFERENCE" | "MODEL_REFERENCE";
    evidence_class: "VALUATION_ONLY";
    guaranteed_executable: false;
  } | null;
  uncertainty: {
    method: "PARALLEL_IV_SHIFT";
    volatility_shift_fraction: string;
    signed_value_low: string;
    signed_value_high: string;
  } | null;
  source_manifest_ids: string[];
  normalized_content_ids: string[];
  regression_reference: HistoricalReferenceInput | null;
  execution_evidence_input: HistoricalExecutionEvidenceInput | null;
  warnings: string[];
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
  valuation?: HistoricalOptionPackageHorizonValuation;
  error: {
    category: "CACHE_ERROR" | "PROVIDER_ERROR";
    message: string;
  } | null;
};

export type HistoricalOptionPackageHorizonsResult = {
  contract_version: "1.0.0";
  request_id: string;
  status: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  valuation_status?: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
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
    valued_entry_packages?: number;
    valued_outcome_3_trading_days_packages?: number;
    valued_outcome_5_trading_days_packages?: number;
    valued_packages?: number;
    valuation_basis_counts?: Array<{
      valuation_basis: HistoricalOptionPackageValuationBasis;
      count: number;
    }>;
    valuation_quality_counts?: Array<{
      quality: "HIGH" | "MEDIUM" | "LOW";
      count: number;
    }>;
    modeled_leg_count_by_role?: Array<{
      role: string;
      count: number;
    }>;
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

type NormalizedModelSource = HistoricalOptionPackageModelSource;

type NormalizedModelCheckpoint = {
  session_date: string;
  scheduled_checkpoint: string;
  underlying: NormalizedModelSource & {
    value: string;
  };
  leg_inputs: Map<
    string,
    NormalizedModelSource & {
      provider_symbol: string;
      implied_volatility: string;
      iv_origin: "DIRECT_OPTION_IV" | "INTERPOLATED_SURFACE";
      surface_id: string | null;
      source_symbols: string[];
    }
  >;
};

type NormalizedValuationFallback = {
  mode: "MODEL_IF_LEG_MISSING";
  pricing_model: "BLACK_SCHOLES_SPOT";
  model_version: string;
  source_contract: HistoricalExecutionSourceContract;
  annualized_risk_free_rate: string;
  annualized_dividend_yield: string;
  volatility_shift_fraction: string;
  max_input_age_minutes: number;
  checkpoints: Map<string, NormalizedModelCheckpoint>;
};

const MAX_CANDIDATES = 50;
const MAX_CALENDAR_SESSIONS = 400;
const MAX_MODEL_INPUTS = 200;
const DEFAULT_MAX_MODEL_INPUT_AGE_MINUTES = 120;
const CONTENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
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

function normalizedDecimal(
  value: DecimalInput,
  field: string,
  options: {
    minimum?: number;
    exclusiveMinimum?: number;
    maximum?: number;
  } = {},
): string {
  const normalized = ExactDecimal.parse(value, field).toString();
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${field} must be a finite decimal.`);
  }
  if (
    options.minimum !== undefined &&
    numeric < options.minimum
  ) {
    throw new Error(`${field} must be at least ${options.minimum}.`);
  }
  if (
    options.exclusiveMinimum !== undefined &&
    numeric <= options.exclusiveMinimum
  ) {
    throw new Error(
      `${field} must be greater than ${options.exclusiveMinimum}.`,
    );
  }
  if (
    options.maximum !== undefined &&
    numeric > options.maximum
  ) {
    throw new Error(`${field} must be at most ${options.maximum}.`);
  }
  return normalized;
}

function uniqueStrings(
  values: string[],
  field: string,
  options: { minItems?: number; maxItems?: number } = {},
): string[] {
  const minItems = options.minItems ?? 0;
  const maxItems = options.maxItems ?? MAX_MODEL_INPUTS;
  if (
    !Array.isArray(values) ||
    values.length < minItems ||
    values.length > maxItems
  ) {
    throw new Error(
      `${field} must contain between ${minItems} and ${maxItems} values.`,
    );
  }
  const normalized = values.map((value, index) =>
    nonEmptyString(value, `${field}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates.`);
  }
  return normalized;
}

function contentIds(
  values: string[],
  field: string,
  minItems = 0,
): string[] {
  return uniqueStrings(values, field, { minItems }).map(
    (value, index) => {
      if (!CONTENT_ID_PATTERN.test(value)) {
        throw new Error(`${field}[${index}] must be a sha256 content ID.`);
      }
      return value;
    },
  );
}

function normalizeModelSource(
  input: HistoricalModelSourceInput,
  field: string,
  scheduledCheckpoint: string,
  maxInputAgeMinutes: number,
): NormalizedModelSource {
  const observedAt = normalizeRfc3339(
    input.observed_at,
    `${field}.observed_at`,
  );
  const availableAt = normalizeRfc3339(
    input.available_at,
    `${field}.available_at`,
  );
  const retrievedAt = normalizeRfc3339(
    input.retrieved_at,
    `${field}.retrieved_at`,
  );
  const observedMs = Date.parse(observedAt);
  const availableMs = Date.parse(availableAt);
  const retrievedMs = Date.parse(retrievedAt);
  const checkpointMs = Date.parse(scheduledCheckpoint);
  if (observedMs > availableMs) {
    throw new Error(
      `${field}.observed_at must not be after ${field}.available_at.`,
    );
  }
  if (availableMs > retrievedMs) {
    throw new Error(
      `${field}.available_at must not be after ${field}.retrieved_at.`,
    );
  }
  if (observedMs > checkpointMs) {
    throw new Error(
      `${field}.observed_at must not be after the scheduled checkpoint.`,
    );
  }
  if (availableMs > checkpointMs) {
    throw new Error(
      `${field}.available_at must not be after the scheduled checkpoint.`,
    );
  }
  if (retrievedMs < checkpointMs) {
    throw new Error(
      `${field}.retrieved_at must not be before the scheduled checkpoint.`,
    );
  }
  if (
    checkpointMs - observedMs >
    maxInputAgeMinutes * 60_000
  ) {
    throw new Error(
      `${field}.observed_at exceeds valuation_fallback.max_input_age_minutes.`,
    );
  }
  if (
    checkpointMs - availableMs >
    maxInputAgeMinutes * 60_000
  ) {
    throw new Error(
      `${field}.available_at exceeds valuation_fallback.max_input_age_minutes.`,
    );
  }
  return {
    observed_at: observedAt,
    available_at: availableAt,
    retrieved_at: retrievedAt,
    source: nonEmptyString(input.source, `${field}.source`),
    dataset_id: nonEmptyString(
      input.dataset_id,
      `${field}.dataset_id`,
    ),
    license_scope_id: nonEmptyString(
      input.license_scope_id,
      `${field}.license_scope_id`,
    ),
    source_revision: nonEmptyString(
      input.source_revision,
      `${field}.source_revision`,
    ),
    manifest_ids: contentIds(
      input.manifest_ids ?? [],
      `${field}.manifest_ids`,
    ),
    normalized_content_ids: contentIds(
      input.normalized_content_ids ?? [],
      `${field}.normalized_content_ids`,
    ),
    input_age_minutes: Number(
      ((checkpointMs - observedMs) / 60_000).toFixed(6),
    ),
  };
}

function normalizeModelSourceContract(
  input: HistoricalExecutionSourceContract | undefined,
): HistoricalExecutionSourceContract {
  if (!input || typeof input !== "object") {
    throw new Error(
      "valuation_fallback.source_contract is required.",
    );
  }
  return {
    provider_id: nonEmptyString(
      input.provider_id,
      "valuation_fallback.source_contract.provider_id",
    ),
    dataset_id: nonEmptyString(
      input.dataset_id,
      "valuation_fallback.source_contract.dataset_id",
    ),
    license_scope_id: nonEmptyString(
      input.license_scope_id,
      "valuation_fallback.source_contract.license_scope_id",
    ),
    resolution_profile: {
      profile_id: nonEmptyString(
        input.resolution_profile.profile_id,
        "valuation_fallback.source_contract.resolution_profile.profile_id",
      ),
      profile_version: nonEmptyString(
        input.resolution_profile.profile_version,
        "valuation_fallback.source_contract.resolution_profile.profile_version",
      ),
      native_resolution: nonEmptyString(
        input.resolution_profile.native_resolution,
        "valuation_fallback.source_contract.resolution_profile.native_resolution",
      ),
      effective_resolution: nonEmptyString(
        input.resolution_profile.effective_resolution,
        "valuation_fallback.source_contract.resolution_profile.effective_resolution",
      ),
    },
    source_revision: nonEmptyString(
      input.source_revision,
      "valuation_fallback.source_contract.source_revision",
    ),
  };
}

function normalizeValuationFallback(
  input: HistoricalOptionPackageValuationFallbackInput | undefined,
  checkpointBySessionDate: Map<string, string>,
  candidates: NormalizedCandidate[],
): NormalizedValuationFallback | undefined {
  if (input === undefined) return undefined;
  if (input.mode !== "MODEL_IF_LEG_MISSING") {
    throw new Error(
      "valuation_fallback.mode must be MODEL_IF_LEG_MISSING.",
    );
  }
  if (input.pricing_model !== "BLACK_SCHOLES_SPOT") {
    throw new Error(
      "valuation_fallback.pricing_model must be BLACK_SCHOLES_SPOT.",
    );
  }
  const maxInputAgeMinutes =
    input.max_input_age_minutes ??
    DEFAULT_MAX_MODEL_INPUT_AGE_MINUTES;
  if (
    !Number.isSafeInteger(maxInputAgeMinutes) ||
    maxInputAgeMinutes < 0 ||
    maxInputAgeMinutes > 1_440
  ) {
    throw new Error(
      "valuation_fallback.max_input_age_minutes must be an integer between 0 and 1440.",
    );
  }
  if (
    !Array.isArray(input.checkpoints) ||
    input.checkpoints.length > MAX_CALENDAR_SESSIONS
  ) {
    throw new Error(
      `valuation_fallback.checkpoints must contain at most ${MAX_CALENDAR_SESSIONS} values.`,
    );
  }
  const candidateSymbols = new Set(
    candidates.flatMap((candidate) =>
      candidate.legs.map((leg) => leg.provider_symbol),
    ),
  );
  const checkpoints = new Map<string, NormalizedModelCheckpoint>();
  for (const [checkpointIndex, checkpoint] of input.checkpoints.entries()) {
    const field = `valuation_fallback.checkpoints[${checkpointIndex}]`;
    const sessionDate = normalizeDate(
      checkpoint.session_date,
      `${field}.session_date`,
    );
    if (checkpoints.has(sessionDate)) {
      throw new Error(
        `valuation_fallback.checkpoints contains duplicate session_date ${sessionDate}.`,
      );
    }
    const scheduledCheckpoint =
      checkpointBySessionDate.get(sessionDate);
    if (!scheduledCheckpoint) {
      throw new Error(
        `${field}.session_date does not match a requested candidate horizon.`,
      );
    }
    const underlyingSource = normalizeModelSource(
      checkpoint.underlying,
      `${field}.underlying`,
      scheduledCheckpoint,
      maxInputAgeMinutes,
    );
    if (
      !Array.isArray(checkpoint.leg_inputs) ||
      checkpoint.leg_inputs.length > MAX_MODEL_INPUTS
    ) {
      throw new Error(
        `${field}.leg_inputs must contain at most ${MAX_MODEL_INPUTS} values.`,
      );
    }
    const legInputs = new Map<
      string,
      NormalizedModelCheckpoint["leg_inputs"] extends Map<
        string,
        infer TValue
      >
        ? TValue
        : never
    >();
    for (const [legIndex, legInput] of checkpoint.leg_inputs.entries()) {
      const legField = `${field}.leg_inputs[${legIndex}]`;
      const providerSymbol = legInput.provider_symbol;
      parseHistoricalOptionSymbol(providerSymbol);
      if (!candidateSymbols.has(providerSymbol)) {
        throw new Error(
          `${legField}.provider_symbol is absent from the frozen candidates.`,
        );
      }
      if (legInputs.has(providerSymbol)) {
        throw new Error(
          `${field}.leg_inputs contains duplicate provider_symbol ${providerSymbol}.`,
        );
      }
      if (
        legInput.iv_origin !== "DIRECT_OPTION_IV" &&
        legInput.iv_origin !== "INTERPOLATED_SURFACE"
      ) {
        throw new Error(
          `${legField}.iv_origin must be DIRECT_OPTION_IV or INTERPOLATED_SURFACE.`,
        );
      }
      const surfaceId =
        legInput.surface_id === undefined ||
        legInput.surface_id === null
          ? null
          : nonEmptyString(
              legInput.surface_id,
              `${legField}.surface_id`,
            );
      const sourceSymbols = uniqueStrings(
        legInput.source_symbols ?? [],
        `${legField}.source_symbols`,
      );
      if (
        legInput.iv_origin === "INTERPOLATED_SURFACE" &&
        (surfaceId === null || sourceSymbols.length === 0)
      ) {
        throw new Error(
          `${legField} requires surface_id and source_symbols for INTERPOLATED_SURFACE.`,
        );
      }
      legInputs.set(providerSymbol, {
        provider_symbol: providerSymbol,
        implied_volatility: normalizedDecimal(
          legInput.implied_volatility,
          `${legField}.implied_volatility`,
          { exclusiveMinimum: 0, maximum: 10 },
        ),
        iv_origin: legInput.iv_origin,
        surface_id: surfaceId,
        source_symbols: sourceSymbols,
        ...normalizeModelSource(
          legInput,
          legField,
          scheduledCheckpoint,
          maxInputAgeMinutes,
        ),
      });
    }
    checkpoints.set(sessionDate, {
      session_date: sessionDate,
      scheduled_checkpoint: scheduledCheckpoint,
      underlying: {
        value: normalizedDecimal(
          checkpoint.underlying.value,
          `${field}.underlying.value`,
          { exclusiveMinimum: 0 },
        ),
        ...underlyingSource,
      },
      leg_inputs: legInputs,
    });
  }
  return {
    mode: "MODEL_IF_LEG_MISSING",
    pricing_model: "BLACK_SCHOLES_SPOT",
    model_version: nonEmptyString(
      input.model_version,
      "valuation_fallback.model_version",
    ),
    source_contract: normalizeModelSourceContract(
      input.source_contract,
    ),
    annualized_risk_free_rate: normalizedDecimal(
      input.annualized_risk_free_rate,
      "valuation_fallback.annualized_risk_free_rate",
      { minimum: -1, maximum: 1 },
    ),
    annualized_dividend_yield: normalizedDecimal(
      input.annualized_dividend_yield,
      "valuation_fallback.annualized_dividend_yield",
      { minimum: -1, maximum: 1 },
    ),
    volatility_shift_fraction: normalizedDecimal(
      input.volatility_shift_fraction,
      "valuation_fallback.volatility_shift_fraction",
      { exclusiveMinimum: 0, maximum: 1 },
    ),
    max_input_age_minutes: maxInputAgeMinutes,
    checkpoints,
  };
}

function valuationFallbackIdentity(
  fallback: NormalizedValuationFallback | undefined,
): unknown {
  if (!fallback) return null;
  return {
    mode: fallback.mode,
    pricing_model: fallback.pricing_model,
    model_version: fallback.model_version,
    source_contract: fallback.source_contract,
    annualized_risk_free_rate:
      fallback.annualized_risk_free_rate,
    annualized_dividend_yield:
      fallback.annualized_dividend_yield,
    volatility_shift_fraction:
      fallback.volatility_shift_fraction,
    max_input_age_minutes: fallback.max_input_age_minutes,
    checkpoints: [...fallback.checkpoints.values()]
      .sort((left, right) =>
        left.session_date.localeCompare(right.session_date),
      )
      .map((checkpoint) => ({
        ...checkpoint,
        leg_inputs: [...checkpoint.leg_inputs.values()].sort(
          (left, right) =>
            left.provider_symbol.localeCompare(right.provider_symbol),
        ),
      })),
  };
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

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function latestTimestamp(values: Array<string | null>): string | null {
  const timestamps = values.filter(
    (value): value is string => value !== null,
  );
  if (timestamps.length === 0) return null;
  return timestamps.sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  ).at(-1)!;
}

function modelDecimal(value: number, field: string): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} produced an invalid modeled value.`);
  }
  return ExactDecimal.parse(value.toFixed(6), field).toString();
}

function optionSettlement(
  providerSymbol: string,
  expiration: string,
): {
  settlement: "AM" | "PM";
  expiration_timestamp: string;
} {
  const settlement =
    providerSymbol.slice(0, 6).trim() === "SPXW" ? "PM" : "AM";
  return {
    settlement,
    expiration_timestamp: resolveCheckpoint(undefined, {
      local_date: expiration,
      local_time: settlement === "PM" ? "16:00:00" : "09:30:00",
      timezone: "America/New_York",
    }).instant,
  };
}

function modelableFailure(
  reason: HistoricalOptionPackageLegFailureReason | null,
): boolean {
  return (
    reason === "HISTORICAL_CANDLE_UNAVAILABLE" ||
    reason === "CONTRACT_ABSENT_FROM_RECONSTRUCTED_UNIVERSE"
  );
}

function valuationLegBase(
  leg: HistoricalOptionPackageHorizonLegResult,
): Pick<
  HistoricalOptionPackageHorizonValuationLeg,
  | "role"
  | "provider_symbol"
  | "action"
  | "quantity"
  | "lifecycle"
  | "expiration"
  | "dte_at_entry"
  | "dte_at_checkpoint"
  | "source_failure_reason"
> {
  return {
    role: leg.role,
    provider_symbol: leg.provider_symbol,
    action: leg.action,
    quantity: leg.quantity,
    lifecycle: leg.lifecycle,
    expiration: leg.expiration,
    dte_at_entry: leg.dte_at_entry,
    dte_at_checkpoint: leg.dte_at_checkpoint,
    source_failure_reason: leg.failure_reason,
  };
}

function unavailableValuationLeg(
  leg: HistoricalOptionPackageHorizonLegResult,
  reason:
    | "MODEL_CHECKPOINT_UNAVAILABLE"
    | "MODEL_LEG_INPUT_UNAVAILABLE"
    | "STRICT_RECONSTRUCTION_NOT_MODELABLE"
    | "OPTION_EXPIRED_AT_CHECKPOINT",
): HistoricalOptionPackageHorizonValuationLeg {
  return {
    ...valuationLegBase(leg),
    valuation_source: "UNAVAILABLE",
    valuation_basis: null,
    value: null,
    model_failure_reason: reason,
    model_provenance: null,
    uncertainty: null,
  };
}

function observedValuationLeg(
  leg: HistoricalOptionPackageHorizonLegResult,
): HistoricalOptionPackageHorizonValuationLeg {
  return {
    ...valuationLegBase(leg),
    valuation_source: "OBSERVED",
    valuation_basis: "CANDLE_REFERENCE",
    value: leg.observation!.reference_value!,
    model_failure_reason: null,
    model_provenance: null,
    uncertainty: null,
  };
}

function modeledValuationLeg(
  leg: HistoricalOptionPackageHorizonLegResult,
  checkpoint: NormalizedModelCheckpoint,
  fallback: NormalizedValuationFallback,
): HistoricalOptionPackageHorizonValuationLeg {
  const input = checkpoint.leg_inputs.get(leg.provider_symbol);
  if (!input) {
    return unavailableValuationLeg(
      leg,
      "MODEL_LEG_INPUT_UNAVAILABLE",
    );
  }
  const parsed = parseHistoricalOptionSymbol(leg.provider_symbol);
  const settlement = optionSettlement(
    leg.provider_symbol,
    parsed.expiration,
  );
  const timeToExpirationMs =
    Date.parse(settlement.expiration_timestamp) -
    Date.parse(checkpoint.scheduled_checkpoint);
  if (timeToExpirationMs <= 0) {
    return unavailableValuationLeg(
      leg,
      "OPTION_EXPIRED_AT_CHECKPOINT",
    );
  }
  const yearsToExpiration =
    timeToExpirationMs / (365.25 * 24 * 60 * 60_000);
  const spot = Number(checkpoint.underlying.value);
  const strike = Number(parsed.strike);
  const volatility = Number(input.implied_volatility);
  const rate = Number(fallback.annualized_risk_free_rate);
  const dividend = Number(fallback.annualized_dividend_yield);
  const shift = Number(fallback.volatility_shift_fraction);
  const price = blackScholesSpotPrice({
    spot,
    strike,
    years_to_expiration: yearsToExpiration,
    annualized_volatility: volatility,
    annualized_risk_free_rate: rate,
    annualized_dividend_yield: dividend,
    option_side: parsed.option_side,
  });
  const shiftedLow = blackScholesSpotPrice({
    spot,
    strike,
    years_to_expiration: yearsToExpiration,
    annualized_volatility: volatility * (1 - shift),
    annualized_risk_free_rate: rate,
    annualized_dividend_yield: dividend,
    option_side: parsed.option_side,
  });
  const shiftedHigh = blackScholesSpotPrice({
    spot,
    strike,
    years_to_expiration: yearsToExpiration,
    annualized_volatility: volatility * (1 + shift),
    annualized_risk_free_rate: rate,
    annualized_dividend_yield: dividend,
    option_side: parsed.option_side,
  });
  const valueLow = Math.min(shiftedLow, shiftedHigh);
  const valueHigh = Math.max(shiftedLow, shiftedHigh);
  const manifestIds = unique([
    ...checkpoint.underlying.manifest_ids,
    ...input.manifest_ids,
  ]).sort();
  const normalizedContentIds = unique([
    ...checkpoint.underlying.normalized_content_ids,
    ...input.normalized_content_ids,
  ]).sort();
  return {
    ...valuationLegBase(leg),
    valuation_source: "MODELED",
    valuation_basis: "MODEL_SURFACE",
    value: modelDecimal(
      price,
      `${leg.provider_symbol}.modeled_value`,
    ),
    model_failure_reason: null,
    model_provenance: {
      pricing_model: fallback.pricing_model,
      model_version: fallback.model_version,
      checkpoint: checkpoint.scheduled_checkpoint,
      underlying_value: checkpoint.underlying.value,
      strike: parsed.strike,
      expiration: parsed.expiration,
      expiration_timestamp: settlement.expiration_timestamp,
      dte_at_checkpoint: leg.dte_at_checkpoint,
      years_to_expiration: ExactDecimal.parse(
        yearsToExpiration.toFixed(10),
      ).toString(),
      option_side: parsed.option_side,
      implied_volatility: input.implied_volatility,
      iv_origin: input.iv_origin,
      surface_id: input.surface_id,
      source_symbols: input.source_symbols,
      annualized_risk_free_rate:
        fallback.annualized_risk_free_rate,
      annualized_dividend_yield:
        fallback.annualized_dividend_yield,
      multiplier: "100",
      settlement: settlement.settlement,
      underlying_input: {
        observed_at: checkpoint.underlying.observed_at,
        available_at: checkpoint.underlying.available_at,
        retrieved_at: checkpoint.underlying.retrieved_at,
        source: checkpoint.underlying.source,
        dataset_id: checkpoint.underlying.dataset_id,
        license_scope_id: checkpoint.underlying.license_scope_id,
        source_revision: checkpoint.underlying.source_revision,
        manifest_ids: checkpoint.underlying.manifest_ids,
        normalized_content_ids:
          checkpoint.underlying.normalized_content_ids,
        input_age_minutes: checkpoint.underlying.input_age_minutes,
      },
      iv_input: {
        observed_at: input.observed_at,
        available_at: input.available_at,
        retrieved_at: input.retrieved_at,
        source: input.source,
        dataset_id: input.dataset_id,
        license_scope_id: input.license_scope_id,
        source_revision: input.source_revision,
        manifest_ids: input.manifest_ids,
        normalized_content_ids: input.normalized_content_ids,
        input_age_minutes: input.input_age_minutes,
      },
      manifest_ids: manifestIds,
      normalized_content_ids: normalizedContentIds,
    },
    uncertainty: {
      method: "IV_SHIFT",
      volatility_shift_fraction:
        fallback.volatility_shift_fraction,
      value_low: modelDecimal(
        valueLow,
        `${leg.provider_symbol}.modeled_value_low`,
      ),
      value_high: modelDecimal(
        valueHigh,
        `${leg.provider_symbol}.modeled_value_high`,
      ),
    },
  };
}

function packageSignedBounds(
  candidate: NormalizedCandidate,
  legs: HistoricalOptionPackageHorizonValuationLeg[],
): { low: string; high: string } {
  const downShift = calculateHistoricalOptionPackageValue(
    candidate.family,
    candidate.legs,
    legs.map(
      (leg) => leg.uncertainty?.value_low ?? leg.value!,
    ),
  ).signed_value;
  const upShift = calculateHistoricalOptionPackageValue(
    candidate.family,
    candidate.legs,
    legs.map(
      (leg) => leg.uncertainty?.value_high ?? leg.value!,
    ),
  ).signed_value;
  const central = calculateHistoricalOptionPackageValue(
    candidate.family,
    candidate.legs,
    legs.map((leg) => leg.value!),
  ).signed_value;
  const values = [downShift, central, upShift].sort((left, right) =>
    ExactDecimal.parse(left).compare(ExactDecimal.parse(right)),
  );
  return { low: values[0], high: values.at(-1)! };
}

function valuationReferenceSource(
  candidate: NormalizedCandidate,
  horizon: HistoricalOptionPackageHorizonResult,
  valuationBasis: HistoricalOptionPackageValuationBasis,
  signedValue: string,
  valuationLegs: HistoricalOptionPackageHorizonValuationLeg[],
  sourceManifestIds: string[],
  normalizedContentIds: string[],
  fallback: NormalizedValuationFallback,
): Pick<
  HistoricalReferenceInput,
  | "source_id"
  | "provider_id"
  | "dataset_id"
  | "license_scope_id"
  | "resolution_profile"
  | "source_revision"
  | "revision"
  | "manifest_id"
  | "normalized_content_id"
> {
  const modeled =
    valuationBasis !== "EXACT_PACKAGE_REFERENCE";
  const manifestId = stableEvidenceContentId({
    evidence_type: "HISTORICAL_OPTION_PACKAGE_MODEL_VALUATION_MANIFEST",
    candidate_id: candidate.candidate_id,
    horizon_id: horizon.horizon_id,
    scheduled_checkpoint: horizon.scheduled_checkpoint,
    valuation_basis: valuationBasis,
    signed_value: signedValue,
    legs: valuationLegs.map((leg) => ({
      provider_symbol: leg.provider_symbol,
      action: leg.action,
      quantity: leg.quantity,
      valuation_source: leg.valuation_source,
      value: leg.value,
      source_manifest_ids:
        leg.model_provenance?.manifest_ids ?? [],
    })),
    source_manifest_ids: sourceManifestIds,
  });
  const normalizedContentId = stableEvidenceContentId({
    manifest_id: manifestId,
    signed_value: signedValue,
    normalized_content_ids: normalizedContentIds,
  });
  return {
    source_id: stableEvidenceContentId({
      candidate_id: candidate.candidate_id,
      horizon_id: horizon.horizon_id,
      valuation_basis: valuationBasis,
    }),
    provider_id: modeled
      ? fallback.source_contract.provider_id
      : "tastytrade-dxlink",
    dataset_id: modeled
      ? fallback.source_contract.dataset_id
      : "historical-option-package-candles",
    license_scope_id: modeled
      ? fallback.source_contract.license_scope_id
      : "research-only",
    resolution_profile: modeled
      ? fallback.source_contract.resolution_profile
      : {
          profile_id: horizon.resolution_profile.profile_id,
          profile_version:
            horizon.resolution_profile.profile_version,
          native_resolution:
            horizon.resolution_profile.native_aggregation,
          effective_resolution:
            horizon.resolution_profile.effective_aggregation ??
            horizon.resolution_profile.requested_aggregation,
        },
    source_revision: modeled
      ? fallback.source_contract.source_revision
      : "historical-option-package/1.0.0",
    revision: 1,
    manifest_id: manifestId,
    normalized_content_id: normalizedContentId,
  };
}

function executionEvidenceInput(
  candidate: NormalizedCandidate,
  horizon: HistoricalOptionPackageHorizonResult,
  reference: HistoricalReferenceInput,
): HistoricalExecutionEvidenceInput | null {
  if (
    candidate.legs.some(
      (leg) =>
        leg.action !== "BUY_TO_OPEN" &&
        leg.action !== "SELL_TO_OPEN",
    )
  ) {
    return null;
  }
  return {
    scope: "WINDOW",
    family: candidate.family,
    underlying: "SPX",
    candidate_fingerprint: stableEvidenceContentId({
      candidate_id: candidate.candidate_id,
      family: candidate.family,
      legs: candidate.legs.map((leg) => ({
        provider_symbol: leg.provider_symbol,
        action: leg.action,
        quantity: leg.quantity,
      })),
    }),
    quote_policy: {
      max_quote_age_ms: 0,
      max_temporal_skew_ms: 0,
      require_sizes: true,
    },
    expected_observation_times: [horizon.scheduled_checkpoint],
    legs: candidate.legs.map((leg) => {
      const settlement = optionSettlement(
        leg.provider_symbol,
        leg.expiration,
      );
      return {
        provider_symbol: leg.provider_symbol,
        action: leg.action as "BUY_TO_OPEN" | "SELL_TO_OPEN",
        ratio: leg.quantity,
        expiration: leg.expiration,
        settlement: settlement.settlement,
        multiplier: "100",
      };
    }),
    observations: [
      {
        observed_at: horizon.scheduled_checkpoint,
        leg_quotes: [],
        native_package_quote: null,
        references: [reference],
      },
    ],
  };
}

function buildHorizonValuation(
  candidate: NormalizedCandidate,
  horizon: HistoricalOptionPackageHorizonResult,
  fallback: NormalizedValuationFallback,
): HistoricalOptionPackageHorizonValuation {
  const checkpoint = fallback.checkpoints.get(horizon.session_date);
  const hasNonModelableFailure =
    horizon.status === "ERROR" ||
    horizon.failure_reasons.some(
      (reason) => !modelableFailure(reason),
    );
  const legs = horizon.legs.map((leg) => {
    if (hasNonModelableFailure) {
      return unavailableValuationLeg(
        leg,
        "STRICT_RECONSTRUCTION_NOT_MODELABLE",
      );
    }
    if (
      leg.reconstruction_status === "AVAILABLE" &&
      leg.observation?.reference_value !== null &&
      leg.observation?.reference_value !== undefined
    ) {
      return observedValuationLeg(leg);
    }
    if (!modelableFailure(leg.failure_reason)) {
      return unavailableValuationLeg(
        leg,
        "STRICT_RECONSTRUCTION_NOT_MODELABLE",
      );
    }
    if (!checkpoint) {
      return unavailableValuationLeg(
        leg,
        "MODEL_CHECKPOINT_UNAVAILABLE",
      );
    }
    return modeledValuationLeg(leg, checkpoint, fallback);
  });
  const observedLegCount = legs.filter(
    (leg) => leg.valuation_source === "OBSERVED",
  ).length;
  const modeledLegCount = legs.filter(
    (leg) => leg.valuation_source === "MODELED",
  ).length;
  const unavailableLegCount = legs.length -
    observedLegCount -
    modeledLegCount;
  const failureReasons = unique(
    legs
      .map((leg) => leg.model_failure_reason)
      .filter((reason): reason is NonNullable<typeof reason> =>
        reason !== null,
      ),
  );
  if (unavailableLegCount > 0) {
    return {
      status: "NOT_AVAILABLE",
      valuation_basis: null,
      quality: null,
      evidence_class: "VALUATION_ONLY",
      reference_type: null,
      guaranteed_executable: false,
      observed_leg_count: observedLegCount,
      modeled_leg_count: modeledLegCount,
      unavailable_leg_count: unavailableLegCount,
      failure_reasons: failureReasons,
      legs,
      reference_value: null,
      uncertainty: null,
      source_manifest_ids: unique(
        legs.flatMap(
          (leg) => leg.model_provenance?.manifest_ids ?? [],
        ),
      ).sort(),
      normalized_content_ids: unique(
        legs.flatMap(
          (leg) =>
            leg.model_provenance?.normalized_content_ids ?? [],
        ),
      ).sort(),
      regression_reference: null,
      execution_evidence_input: null,
      warnings: [
        "MODEL_VALUATION_NOT_AVAILABLE",
        "STRICT_RECONSTRUCTION_RESULT_PRESERVED",
      ],
    };
  }

  const valuationBasis: HistoricalOptionPackageValuationBasis =
    modeledLegCount === 0
      ? "EXACT_PACKAGE_REFERENCE"
      : observedLegCount === 0
        ? "MODEL_SURFACE"
        : "MIXED_OBSERVED_MODELED";
  const referenceType =
    modeledLegCount === 0
      ? ("CANDLE_REFERENCE" as const)
      : ("MODEL_REFERENCE" as const);
  const calculated = calculateHistoricalOptionPackageValue(
    candidate.family,
    candidate.legs,
    legs.map((leg) => leg.value!),
  );
  const sourceManifestIds = unique([
    ...legs.flatMap(
      (leg) => leg.model_provenance?.manifest_ids ?? [],
    ),
    ...horizon.legs.flatMap((leg) => {
      const manifestId =
        leg.observation?.provenance.evidence_cache?.manifest_id;
      return manifestId ? [manifestId] : [];
    }),
  ]).sort();
  const normalizedContentIds = unique([
    ...legs.flatMap(
      (leg) =>
        leg.model_provenance?.normalized_content_ids ?? [],
    ),
    ...horizon.legs.flatMap((leg) => {
      const normalizedContentId =
        leg.observation?.provenance.evidence_cache
          ?.normalized_content_id;
      return normalizedContentId ? [normalizedContentId] : [];
    }),
  ]).sort();
  const sourceTimestamp = latestTimestamp([
    ...horizon.legs.map(
      (leg) => leg.observation?.source_timestamp ?? null,
    ),
    ...legs.flatMap((leg) =>
      leg.model_provenance
        ? [
            leg.model_provenance.underlying_input.observed_at,
            leg.model_provenance.iv_input.observed_at,
          ]
        : [],
    ),
  ]);
  const availableAt = latestTimestamp([
    ...horizon.legs.map(
      (leg) => leg.observation?.available_at ?? null,
    ),
    ...legs.flatMap((leg) =>
      leg.model_provenance
        ? [
            leg.model_provenance.underlying_input.available_at,
            leg.model_provenance.iv_input.available_at,
          ]
        : [],
    ),
  ]);
  const retrievedAt = latestTimestamp([
    ...horizon.legs.map(
      (leg) => leg.observation?.retrieved_at ?? null,
    ),
    ...legs.flatMap((leg) =>
      leg.model_provenance
        ? [
            leg.model_provenance.underlying_input.retrieved_at,
            leg.model_provenance.iv_input.retrieved_at,
          ]
        : [],
    ),
  ]);
  const referenceSource = valuationReferenceSource(
    candidate,
    horizon,
    valuationBasis,
    calculated.signed_value,
    legs,
    sourceManifestIds,
    normalizedContentIds,
    fallback,
  );
  const regressionReference: HistoricalReferenceInput | null =
    sourceTimestamp && availableAt && retrievedAt
      ? {
          evidence_type: referenceType,
          signed_value: calculated.signed_value,
          price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
          source_timestamp: sourceTimestamp,
          available_at: availableAt,
          bar_end:
            modeledLegCount === 0
              ? latestTimestamp(
                  horizon.legs.map(
                    (leg) => leg.observation?.bar_end ?? null,
                  ),
                )
              : null,
          retrieved_at: retrievedAt,
          model_version:
            modeledLegCount === 0
              ? null
              : `${fallback.pricing_model}/${fallback.model_version}`,
          ...referenceSource,
        }
      : null;
  const bounds =
    modeledLegCount > 0
      ? packageSignedBounds(candidate, legs)
      : null;
  const valuation: HistoricalOptionPackageHorizonValuation = {
    status: "AVAILABLE",
    valuation_basis: valuationBasis,
    quality:
      modeledLegCount === 0
        ? "HIGH"
        : observedLegCount === 0
          ? "LOW"
          : "MEDIUM",
    evidence_class: "VALUATION_ONLY",
    reference_type: referenceType,
    guaranteed_executable: false,
    observed_leg_count: observedLegCount,
    modeled_leg_count: modeledLegCount,
    unavailable_leg_count: 0,
    failure_reasons: [],
    legs,
    reference_value: {
      value: calculated.value,
      price_effect: calculated.price_effect,
      evidence_type:
        modeledLegCount === 0
          ? "HISTORICAL_OPTION_PACKAGE_REFERENCE"
          : "HISTORICAL_OPTION_PACKAGE_MODEL_VALUATION",
      reference_type: referenceType,
      evidence_class: "VALUATION_ONLY",
      guaranteed_executable: false,
    },
    uncertainty:
      bounds === null
        ? null
        : {
            method: "PARALLEL_IV_SHIFT",
            volatility_shift_fraction:
              fallback.volatility_shift_fraction,
            signed_value_low: bounds.low,
            signed_value_high: bounds.high,
          },
    source_manifest_ids: sourceManifestIds,
    normalized_content_ids: normalizedContentIds,
    regression_reference: regressionReference,
    execution_evidence_input: null,
    warnings: [
      ...(modeledLegCount === 0
        ? ["EXACT_PACKAGE_REFERENCE_PRESERVED"]
        : [
            "MODEL_VALUATION_RESEARCH_ONLY",
            "MODEL_UNCERTAINTY_IV_SHIFT",
            "NOT_BID_ASK_NBBO_MIDPOINT_TOUCH_OR_FILL",
          ]),
      ...(observedLegCount > 0 && modeledLegCount > 0
        ? ["OBSERVED_LEG_VALUES_PRESERVED"]
        : []),
      ...(!calculated.price_effect_matches_family
        ? [
            `FAMILY_PRICE_EFFECT_MISMATCH:${calculated.expected_price_effect}_EXPECTED`,
          ]
        : []),
      ...(regressionReference === null
        ? ["REGRESSION_REFERENCE_TIMESTAMP_INCOMPLETE"]
        : []),
    ],
  };
  valuation.execution_evidence_input =
    regressionReference === null
      ? null
      : executionEvidenceInput(
          candidate,
          horizon,
          regressionReference,
        );
  if (
    regressionReference !== null &&
    valuation.execution_evidence_input === null
  ) {
    valuation.warnings.push(
      "REGRESSION_HANDOFF_REQUIRES_OPENING_ACTIONS",
    );
  }
  return valuation;
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
  const valuationBasisCounts = new Map<
    HistoricalOptionPackageValuationBasis,
    number
  >();
  const valuationQualityCounts = new Map<
    "HIGH" | "MEDIUM" | "LOW",
    number
  >();
  const modeledByRole = new Map<string, number>();
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

    if (
      horizon.valuation?.status === "AVAILABLE" &&
      horizon.valuation.valuation_basis !== null &&
      horizon.valuation.quality !== null
    ) {
      addCount(
        valuationBasisCounts,
        horizon.valuation.valuation_basis,
      );
      addCount(
        valuationQualityCounts,
        horizon.valuation.quality,
      );
      for (const leg of horizon.valuation.legs) {
        if (leg.valuation_source === "MODELED") {
          addCount(modeledByRole, leg.role);
        }
      }
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
  const valuationEnabled = allHorizons.some(
    ({ horizon }) => horizon.valuation !== undefined,
  );
  const valuedPackages = allHorizons.filter(
    ({ horizon }) => horizon.valuation?.status === "AVAILABLE",
  ).length;
  const valuedByHorizon = (
    horizonId: HistoricalOptionPackageHorizonId,
  ) =>
    allHorizons.filter(
      ({ horizon }) =>
        horizon.horizon_id === horizonId &&
        horizon.valuation?.status === "AVAILABLE",
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
    ...(valuationEnabled
      ? {
          valued_entry_packages: valuedByHorizon("ENTRY"),
          valued_outcome_3_trading_days_packages: valuedByHorizon(
            "OUTCOME_3_TRADING_DAYS",
          ),
          valued_outcome_5_trading_days_packages: valuedByHorizon(
            "OUTCOME_5_TRADING_DAYS",
          ),
          valued_packages: valuedPackages,
          valuation_basis_counts: [...valuationBasisCounts.entries()]
            .map(([valuation_basis, count]) => ({
              valuation_basis,
              count,
            }))
            .sort((left, right) =>
              left.valuation_basis.localeCompare(
                right.valuation_basis,
              ),
            ),
          valuation_quality_counts: [
            ...valuationQualityCounts.entries(),
          ]
            .map(([quality, count]) => ({ quality, count }))
            .sort((left, right) =>
              left.quality.localeCompare(right.quality),
            ),
          modeled_leg_count_by_role: [...modeledByRole.entries()]
            .map(([role, count]) => ({ role, count }))
            .sort((left, right) => left.role.localeCompare(right.role)),
        }
      : {}),
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
  const valuationFallback = normalizeValuationFallback(
    input.valuation_fallback,
    checkpointBySessionDate,
    candidates,
  );
  const requestId = stableRequestId({
    underlying: input.underlying,
    trading_calendar: tradingCalendar,
    horizons,
    candidates,
    resolution_profile: resolutionProfile,
    candidate_construction_profile: candidateConstructionProfile,
    ...(valuationFallback
      ? {
          valuation_fallback:
            valuationFallbackIdentity(valuationFallback),
        }
      : {}),
  });

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
      let horizonResult: HistoricalOptionPackageHorizonResult;
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
        horizonResult = {
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
        };
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
        horizonResult = {
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
        };
      }
      if (valuationFallback) {
        horizonResult.valuation = buildHorizonValuation(
          candidate,
          horizonResult,
          valuationFallback,
        );
      }
      horizonResults.push(horizonResult);
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
  const unavailableValuations =
    valuationFallback === undefined
      ? null
      : coverage.requested_package_checkpoints -
        (coverage.valued_packages ?? 0);
  return {
    contract_version: "1.0.0",
    request_id: requestId,
    status:
      unavailablePackages === 0
        ? "COMPLETE"
        : coverage.complete_packages > 0
          ? "PARTIAL"
          : "NOT_AVAILABLE",
    ...(valuationFallback
      ? {
          valuation_status:
            unavailableValuations === 0
              ? ("COMPLETE" as const)
              : (coverage.valued_packages ?? 0) > 0
                ? ("PARTIAL" as const)
                : ("NOT_AVAILABLE" as const),
        }
      : {}),
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
      ...(valuationFallback
        ? [
            "MODEL_VALUATION_FALLBACK_OPT_IN",
            "MODEL_REFERENCES_ARE_RESEARCH_ONLY",
            "MODEL_REFERENCES_ARE_NOT_QUOTES_OR_EXECUTION_EVIDENCE",
          ]
        : []),
      ...(unavailablePackages > 0
        ? [`PACKAGE_CHECKPOINTS_NOT_AVAILABLE:${unavailablePackages}`]
        : []),
      ...(unavailableValuations !== null &&
      unavailableValuations > 0
        ? [`PACKAGE_VALUATIONS_NOT_AVAILABLE:${unavailableValuations}`]
        : []),
    ],
  };
}
