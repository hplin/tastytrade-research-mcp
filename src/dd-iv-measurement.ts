import { createHash } from "node:crypto";
import { ExactDecimal, type DecimalInput } from "./decimal.js";
import { normalizeRfc3339 } from "./time.js";

export const DD_IV_MEASUREMENT_CONTRACT_VERSION = "1.0.0" as const;
export const DD_IV_MEASUREMENT_PROFILE_VERSION = "1.0.0" as const;
export const DD_IV_HANDOFF_DATASET_VERSION = "1.0.0" as const;
export const DD_IV_LEGACY_MIGRATION_VERSION = "1.0.0" as const;

export type DdIvOptionSide = "CALL" | "PUT";

export type DdIvSelectedLegRole =
  | "FRONT_PUT_SHORT"
  | "FRONT_CALL_SHORT"
  | "BACK_PUT_LONG"
  | "BACK_CALL_LONG";

export type DdIvDeltaConvention =
  | "SIGNED_FORWARD_DELTA_PERCENT"
  | "ABSOLUTE_FORWARD_DELTA_PERCENT";

export type DdIvMoneynessConvention = "LN_STRIKE_OVER_FORWARD";

export type DdIvCoordinateDefinition =
  | DdIvDeltaConvention
  | DdIvMoneynessConvention;

export type DdIvValueOrigin = "PROVIDER_OBSERVATION" | "DERIVED";

export type DdIvSelectedLegReferenceInput = {
  role: DdIvSelectedLegRole;
  source_symbol: string;
  expiration: string;
  option_side: DdIvOptionSide;
  strike: DecimalInput;
};

export type DdIvDeltaInterpolationProfileInput = {
  allowed: true;
  method: "LINEAR_BY_DELTA";
  max_bracket_width: DecimalInput;
  max_bracket_skew_ms: number;
};

export type DdIvForwardMoneynessInterpolationProfileInput = {
  allowed: true;
  method: "LINEAR_BY_LOG_MONEYNESS";
  max_bracket_width: DecimalInput;
  max_bracket_skew_ms: number;
};

export type DdIvInterpolationProfileInput =
  | DdIvDeltaInterpolationProfileInput
  | DdIvForwardMoneynessInterpolationProfileInput;

type DdIvMatchedCoordinateProfileBaseInput = {
  measurement_id: string;
  front_expiration: string;
  back_expiration: string;
  option_side: DdIvOptionSide;
  tolerance: DecimalInput;
  missing_policy: "NOT_AVAILABLE";
  max_front_back_skew_ms: number;
};

export type DdIvMatchedDeltaCoordinateProfileInput =
  DdIvMatchedCoordinateProfileBaseInput & {
    measurement_basis: "MATCHED_DELTA";
    target_delta: DecimalInput;
    delta_convention: DdIvDeltaConvention;
    interpolation?: DdIvDeltaInterpolationProfileInput | null;
  };

export type DdIvMatchedForwardMoneynessCoordinateProfileInput =
  DdIvMatchedCoordinateProfileBaseInput & {
    measurement_basis: "MATCHED_FORWARD_MONEYNESS";
    target_log_moneyness: DecimalInput;
    moneyness_convention: DdIvMoneynessConvention;
    interpolation?: DdIvForwardMoneynessInterpolationProfileInput | null;
  };

export type DdIvMatchedCoordinateProfileInput =
  | DdIvMatchedDeltaCoordinateProfileInput
  | DdIvMatchedForwardMoneynessCoordinateProfileInput;

export type DdIvMeasurementProfileInput = {
  profile_version: typeof DD_IV_MEASUREMENT_PROFILE_VERSION;
  selected_leg: {
    max_front_back_skew_ms: number;
    combined?: {
      aggregation: "WEIGHTED_ARITHMETIC_MEAN";
      put_weight: DecimalInput;
      call_weight: DecimalInput;
    } | null;
  };
  matched_coordinates: DdIvMatchedCoordinateProfileInput[];
};

export type DdIvMeasurementRequestInput = {
  contract_version: typeof DD_IV_MEASUREMENT_CONTRACT_VERSION;
  candidate_id: string;
  selected_legs: DdIvSelectedLegReferenceInput[];
  measurement_profile: DdIvMeasurementProfileInput;
};

export type DdIvLineageInput = {
  source: string;
  source_timestamp: string;
  fields: string[];
  origin: DdIvValueOrigin;
};

export type DdIvObservationModelInput = {
  iv_model: string | null;
  delta_model: string | null;
  forward_model: string | null;
  assumptions: string[];
};

export type DdIvObservationInput = {
  source_symbol: string;
  expiration: string;
  option_side: DdIvOptionSide;
  strike: DecimalInput;
  iv: DecimalInput | null;
  delta: DecimalInput | null;
  delta_convention: "SIGNED_FORWARD_DELTA_PERCENT" | null;
  iv_origin: DdIvValueOrigin;
  delta_origin: DdIvValueOrigin | null;
  model: DdIvObservationModelInput;
  forward: {
    value: DecimalInput;
    origin: DdIvValueOrigin;
    source_timestamp: string;
  } | null;
  bar_start: string | null;
  bar_end: string | null;
  available_at: string | null;
  retrieved_at: string | null;
  bar_status: "COMPLETE" | "INCOMPLETE" | "MISSING";
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  provider: string;
  dataset: string;
  resolution: string;
  alignment: string;
  source_cohort_id: string;
  lineage: DdIvLineageInput[];
  warnings?: string[];
};

export type DdIvMeasurementNormalizerInput = {
  checkpoint: string;
  request: DdIvMeasurementRequestInput | DdIvMeasurementRequest;
  observations: DdIvObservationInput[];
  source_evidence?: DdIvSourceEvidenceInput;
};

export type DdIvSourceEvidenceInput = {
  manifest_contract_version: string;
  manifest_ids: string[];
  normalized_content_ids: string[];
  provider_payload_content_ids: string[];
};

export type DdIvSourceEvidence = {
  manifest_contract_version: string;
  manifest_ids: string[];
  normalized_content_ids: string[];
  provider_payload_content_ids: string[];
};

export type DdIvSelectedLegReference = {
  role: DdIvSelectedLegRole;
  source_symbol: string;
  expiration: string;
  option_side: DdIvOptionSide;
  strike: string;
};

export type DdIvDeltaInterpolationProfile = {
  allowed: true;
  method: "LINEAR_BY_DELTA";
  max_bracket_width: string;
  max_bracket_skew_ms: number;
};

export type DdIvForwardMoneynessInterpolationProfile = {
  allowed: true;
  method: "LINEAR_BY_LOG_MONEYNESS";
  max_bracket_width: string;
  max_bracket_skew_ms: number;
};

export type DdIvInterpolationProfile =
  | DdIvDeltaInterpolationProfile
  | DdIvForwardMoneynessInterpolationProfile;

type DdIvMatchedCoordinateProfileBase = {
  measurement_id: string;
  front_expiration: string;
  back_expiration: string;
  option_side: DdIvOptionSide;
  tolerance: string;
  missing_policy: "NOT_AVAILABLE";
  max_front_back_skew_ms: number;
};

export type DdIvMatchedDeltaCoordinateProfile =
  DdIvMatchedCoordinateProfileBase & {
    measurement_basis: "MATCHED_DELTA";
    target_delta: string;
    delta_convention: DdIvDeltaConvention;
    interpolation: DdIvDeltaInterpolationProfile | null;
  };

export type DdIvMatchedForwardMoneynessCoordinateProfile =
  DdIvMatchedCoordinateProfileBase & {
    measurement_basis: "MATCHED_FORWARD_MONEYNESS";
    target_log_moneyness: string;
    moneyness_convention: DdIvMoneynessConvention;
    interpolation: DdIvForwardMoneynessInterpolationProfile | null;
  };

export type DdIvMatchedCoordinateProfile =
  | DdIvMatchedDeltaCoordinateProfile
  | DdIvMatchedForwardMoneynessCoordinateProfile;

export type DdIvMeasurementProfile = {
  profile_version: typeof DD_IV_MEASUREMENT_PROFILE_VERSION;
  selected_leg: {
    max_front_back_skew_ms: number;
    combined: {
      aggregation: "WEIGHTED_ARITHMETIC_MEAN";
      put_weight: string;
      call_weight: string;
    } | null;
  };
  matched_coordinates: DdIvMatchedCoordinateProfile[];
};

export type DdIvMeasurementRequest = {
  contract_version: typeof DD_IV_MEASUREMENT_CONTRACT_VERSION;
  candidate_id: string;
  selected_legs: DdIvSelectedLegReference[];
  measurement_profile: DdIvMeasurementProfile;
};

export type DdIvLineage = {
  source: string;
  source_timestamp: string;
  fields: string[];
  origin: DdIvValueOrigin;
};

export type DdIvObservation = {
  source_symbol: string;
  expiration: string;
  option_side: DdIvOptionSide;
  strike: string;
  iv: string | null;
  delta: string | null;
  delta_convention: "SIGNED_FORWARD_DELTA_PERCENT" | null;
  iv_origin: DdIvValueOrigin;
  delta_origin: DdIvValueOrigin | null;
  model: {
    iv_model: string | null;
    delta_model: string | null;
    forward_model: string | null;
    assumptions: string[];
  };
  forward: {
    value: string;
    origin: DdIvValueOrigin;
    source_timestamp: string;
  } | null;
  bar_start: string | null;
  bar_end: string | null;
  available_at: string | null;
  retrieved_at: string | null;
  bar_status: "COMPLETE" | "INCOMPLETE" | "MISSING";
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  provider: string;
  dataset: string;
  resolution: string;
  alignment: string;
  source_cohort_id: string;
  lineage: DdIvLineage[];
  warnings: string[];
};

export type DdIvFrozenLeg = DdIvObservation & {
  candidate_id: string;
  role: DdIvSelectedLegRole;
  eligibility_warnings: string[];
};

export type DdIvSelectedSideMeasurement = {
  option_side: DdIvOptionSide;
  status: "AVAILABLE" | "NOT_AVAILABLE";
  front_role: DdIvSelectedLegRole;
  back_role: DdIvSelectedLegRole;
  front_iv_decimal: string | null;
  back_iv_decimal: string | null;
  iv_unit: "DECIMAL";
  spread_decimal: string | null;
  spread_vol_points: string | null;
  temporal_skew_ms: number | null;
  source_cohort_ids: string[];
  quality: "COMPLETE" | "NOT_AVAILABLE";
  warnings: string[];
};

export type DdIvSelectedLegMeasurement = {
  contract_version: typeof DD_IV_MEASUREMENT_CONTRACT_VERSION;
  measurement_basis: "SELECTED_LEG_IV_DIFFERENCE";
  measurement_profile_version: typeof DD_IV_MEASUREMENT_PROFILE_VERSION;
  grading_role: "RESEARCH_ONLY";
  candidate_id: string;
  cohort_id: string;
  status: "AVAILABLE" | "PARTIAL" | "NOT_AVAILABLE";
  iv_unit: "DECIMAL";
  frozen_legs: DdIvFrozenLeg[];
  sides: Record<DdIvOptionSide, DdIvSelectedSideMeasurement>;
  combined: {
    status: "AVAILABLE" | "NOT_AVAILABLE";
    aggregation: "WEIGHTED_ARITHMETIC_MEAN";
    weights: Record<DdIvOptionSide, string>;
    component_spreads: Record<DdIvOptionSide, string | null>;
    spread_decimal: string | null;
    spread_vol_points: string | null;
    iv_unit: "DECIMAL";
    warnings: string[];
  } | null;
  quality: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  warnings: string[];
};

export type DdIvMatchInput = {
  source_symbol: string;
  strike: string;
  coordinate: string;
  coordinate_definition: DdIvCoordinateDefinition;
  delta: string | null;
  delta_convention: "SIGNED_FORWARD_DELTA_PERCENT" | null;
  delta_origin: DdIvValueOrigin | null;
  iv_decimal: string;
  weight: string;
  available_at: string;
  iv_origin: DdIvValueOrigin;
  model: DdIvObservation["model"];
  forward: DdIvObservation["forward"];
  lineage: DdIvLineage[];
};

export type DdIvCoordinateMatch = {
  status: "AVAILABLE" | "NOT_AVAILABLE";
  expiration: string;
  option_side: DdIvOptionSide;
  target_coordinate: string;
  achieved_coordinate: string | null;
  coordinate_definition: DdIvCoordinateDefinition;
  coordinate_error: string | null;
  delta_error?: string | null;
  moneyness_error?: string | null;
  coverage_gap: string | null;
  iv_decimal: string | null;
  iv_unit: "DECIMAL";
  value_origin: DdIvValueOrigin | null;
  method:
    | "DIRECT_WITHIN_TOLERANCE"
    | "LINEAR_BY_DELTA"
    | "LINEAR_BY_LOG_MONEYNESS"
    | null;
  source_symbols: string[];
  source_strikes: string[];
  source_cohort_ids: string[];
  effective_available_at: string | null;
  interpolation: {
    method: "LINEAR_BY_DELTA" | "LINEAR_BY_LOG_MONEYNESS";
    lower_coordinate: string;
    upper_coordinate: string;
    lower_weight: string;
    upper_weight: string;
    inputs: DdIvMatchInput[];
  } | null;
  inputs: DdIvMatchInput[];
  quality: "COMPLETE" | "NOT_AVAILABLE";
  warnings: string[];
};

export type DdIvMatchedMeasurement = {
  contract_version: typeof DD_IV_MEASUREMENT_CONTRACT_VERSION;
  measurement_basis: "MATCHED_DELTA" | "MATCHED_FORWARD_MONEYNESS";
  measurement_id: string;
  measurement_profile_version: typeof DD_IV_MEASUREMENT_PROFILE_VERSION;
  grading_role: "RESEARCH_ONLY";
  cohort_id: string;
  option_side: DdIvOptionSide;
  front_expiration: string;
  back_expiration: string;
  coordinate_definition: DdIvCoordinateDefinition;
  target_coordinate: string;
  target_delta?: string;
  delta_convention?: DdIvDeltaConvention;
  target_log_moneyness?: string;
  moneyness_convention?: DdIvMoneynessConvention;
  tolerance: string;
  missing_policy: "NOT_AVAILABLE";
  status: "AVAILABLE" | "NOT_AVAILABLE";
  iv_unit: "DECIMAL";
  front: DdIvCoordinateMatch;
  back: DdIvCoordinateMatch;
  spread_decimal: string | null;
  spread_vol_points: string | null;
  temporal_skew_ms: number | null;
  source_cohort_ids: string[];
  quality: "COMPLETE" | "NOT_AVAILABLE";
  warnings: string[];
};

export type DdIvMeasurementHandoff = {
  contract_version: typeof DD_IV_MEASUREMENT_CONTRACT_VERSION;
  handoff_dataset_version: typeof DD_IV_HANDOFF_DATASET_VERSION;
  handoff_id: string;
  grading_role: "RESEARCH_ONLY";
  checkpoint: string;
  candidate_id: string;
  measurement_profile_version: typeof DD_IV_MEASUREMENT_PROFILE_VERSION;
  measurement_profile: DdIvMeasurementProfile;
  legacy_term_structure_replaced: false;
  selected_leg_measurement: DdIvSelectedLegMeasurement;
  matched_measurements: DdIvMatchedMeasurement[];
  cohort_identity: {
    selected_leg: string;
    matched: string[];
    source_cohort_ids: string[];
  };
  source_evidence?: DdIvSourceEvidence;
  quality: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  warnings: string[];
};

const SELECTED_ROLES: DdIvSelectedLegRole[] = [
  "FRONT_PUT_SHORT",
  "FRONT_CALL_SHORT",
  "BACK_PUT_LONG",
  "BACK_CALL_LONG",
];

const MAX_SKEW_MS = 7 * 24 * 60 * 60_000;
const ONE_HUNDRED = ExactDecimal.parse("100");
const CONTENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

function stableId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizedContentIds(
  values: string[],
  field: string,
): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${field} must contain at least one content ID.`);
  }
  const normalized = unique(
    values.map((value, index) => {
      if (typeof value !== "string" || !CONTENT_ID_PATTERN.test(value)) {
        throw new Error(
          `${field}[${index}] must be a sha256 content ID.`,
        );
      }
      return value;
    }),
  );
  return normalized.sort();
}

function normalizeSourceEvidence(
  input: DdIvSourceEvidenceInput | undefined,
): DdIvSourceEvidence | undefined {
  if (input === undefined) return undefined;
  return {
    manifest_contract_version: normalizedText(
      input.manifest_contract_version,
      "source_evidence.manifest_contract_version",
      50,
    ),
    manifest_ids: normalizedContentIds(
      input.manifest_ids,
      "source_evidence.manifest_ids",
    ),
    normalized_content_ids: normalizedContentIds(
      input.normalized_content_ids,
      "source_evidence.normalized_content_ids",
    ),
    provider_payload_content_ids: normalizedContentIds(
      input.provider_payload_content_ids,
      "source_evidence.provider_payload_content_ids",
    ),
  };
}

function normalizedText(value: string, field: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${field} must be 1-${maximum} characters.`);
  }
  return normalized;
}

function normalizedSkew(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SKEW_MS) {
    throw new Error(
      `${field} must be an integer between 0 and ${MAX_SKEW_MS}.`,
    );
  }
  return value;
}

function requiredDecimal(
  value: DecimalInput,
  field: string,
): ExactDecimal {
  return ExactDecimal.parse(value, field);
}

function positiveDecimal(value: DecimalInput, field: string): string {
  const normalized = requiredDecimal(value, field);
  if (normalized.compare(ExactDecimal.zero()) <= 0) {
    throw new Error(`${field} must be greater than zero.`);
  }
  return normalized.toString();
}

function nonnegativeDecimal(value: DecimalInput, field: string): string {
  const normalized = requiredDecimal(value, field);
  if (normalized.compare(ExactDecimal.zero()) < 0) {
    throw new Error(`${field} must be zero or greater.`);
  }
  return normalized.toString();
}

function nullableDecimal(
  value: DecimalInput | null,
  field: string,
  invalidWarning: string,
  warnings: string[],
): string | null {
  if (value === null) return null;
  try {
    return ExactDecimal.parse(value, field).toString();
  } catch {
    warnings.push(invalidWarning);
    return null;
  }
}

function minimumScale(value: string, scale: number): string {
  const [integer, fraction = ""] = value.split(".");
  if (fraction.length >= scale) return value;
  return `${integer}.${fraction.padEnd(scale, "0")}`;
}

function volPoints(spread: ExactDecimal): string {
  return minimumScale(spread.multiplyInteger(100).toString(), 2);
}

function normalizedCombined(
  input: DdIvMeasurementProfileInput["selected_leg"]["combined"],
): DdIvMeasurementProfile["selected_leg"]["combined"] {
  if (input == null) return null;
  const putWeight = positiveDecimal(
    input.put_weight,
    "measurement_profile.selected_leg.combined.put_weight",
  );
  const callWeight = positiveDecimal(
    input.call_weight,
    "measurement_profile.selected_leg.combined.call_weight",
  );
  return {
    aggregation: "WEIGHTED_ARITHMETIC_MEAN",
    put_weight: putWeight,
    call_weight: callWeight,
  };
}

function normalizeMatchedProfile(
  input: DdIvMatchedCoordinateProfileInput,
  index: number,
): DdIvMatchedCoordinateProfile {
  if (
    input.measurement_basis !== "MATCHED_DELTA" &&
    input.measurement_basis !== "MATCHED_FORWARD_MONEYNESS"
  ) {
    throw new Error(
      `measurement_profile.matched_coordinates[${index}].measurement_basis must be MATCHED_DELTA or MATCHED_FORWARD_MONEYNESS.`,
    );
  }
  if (input.missing_policy !== "NOT_AVAILABLE") {
    throw new Error(
      `measurement_profile.matched_coordinates[${index}].missing_policy must be NOT_AVAILABLE.`,
    );
  }
  const frontExpiration = normalizeRfc3339(
    input.front_expiration,
    `measurement_profile.matched_coordinates[${index}].front_expiration`,
  );
  const backExpiration = normalizeRfc3339(
    input.back_expiration,
    `measurement_profile.matched_coordinates[${index}].back_expiration`,
  );
  if (Date.parse(frontExpiration) >= Date.parse(backExpiration)) {
    throw new Error(
      `measurement_profile.matched_coordinates[${index}] requires front_expiration before back_expiration.`,
    );
  }
  const tolerance = nonnegativeDecimal(
    input.tolerance,
    `measurement_profile.matched_coordinates[${index}].tolerance`,
  );
  const common = {
    measurement_id: normalizedText(
      input.measurement_id,
      `measurement_profile.matched_coordinates[${index}].measurement_id`,
    ),
    front_expiration: frontExpiration,
    back_expiration: backExpiration,
    option_side: input.option_side,
    tolerance,
    missing_policy: "NOT_AVAILABLE" as const,
    max_front_back_skew_ms: normalizedSkew(
      input.max_front_back_skew_ms,
      `measurement_profile.matched_coordinates[${index}].max_front_back_skew_ms`,
    ),
  };
  if (input.measurement_basis === "MATCHED_DELTA") {
    if (
      input.delta_convention !== "SIGNED_FORWARD_DELTA_PERCENT" &&
      input.delta_convention !== "ABSOLUTE_FORWARD_DELTA_PERCENT"
    ) {
      throw new Error(
        `measurement_profile.matched_coordinates[${index}].delta_convention is invalid.`,
      );
    }
    const target = requiredDecimal(
      input.target_delta,
      `measurement_profile.matched_coordinates[${index}].target_delta`,
    );
    if (
      input.delta_convention === "ABSOLUTE_FORWARD_DELTA_PERCENT" &&
      (target.compare(ExactDecimal.zero()) <= 0 ||
        target.compare(ONE_HUNDRED) >= 0)
    ) {
      throw new Error(
        `measurement_profile.matched_coordinates[${index}].target_delta must be between 0 and 100 for absolute delta.`,
      );
    }
    if (
      input.delta_convention === "SIGNED_FORWARD_DELTA_PERCENT" &&
      (target.compare(ONE_HUNDRED.negate()) <= 0 ||
        target.compare(ONE_HUNDRED) >= 0 ||
        target.isZero())
    ) {
      throw new Error(
        `measurement_profile.matched_coordinates[${index}].target_delta must be between -100 and 100 and non-zero for signed delta.`,
      );
    }
    if (
      input.delta_convention === "SIGNED_FORWARD_DELTA_PERCENT" &&
      ((input.option_side === "PUT" &&
        target.compare(ExactDecimal.zero()) >= 0) ||
        (input.option_side === "CALL" &&
          target.compare(ExactDecimal.zero()) <= 0))
    ) {
      throw new Error(
        `measurement_profile.matched_coordinates[${index}].target_delta sign must match option_side for signed delta.`,
      );
    }
    if (
      input.interpolation != null &&
      input.interpolation.method !== "LINEAR_BY_DELTA"
    ) {
      throw new Error(
        `measurement_profile.matched_coordinates[${index}].interpolation.method must be LINEAR_BY_DELTA for MATCHED_DELTA.`,
      );
    }
    return {
      ...common,
      measurement_basis: "MATCHED_DELTA",
      target_delta: target.toString(),
      delta_convention: input.delta_convention,
      interpolation:
        input.interpolation == null
          ? null
          : {
              allowed: true,
              method: "LINEAR_BY_DELTA",
              max_bracket_width: positiveDecimal(
                input.interpolation.max_bracket_width,
                `measurement_profile.matched_coordinates[${index}].interpolation.max_bracket_width`,
              ),
              max_bracket_skew_ms: normalizedSkew(
                input.interpolation.max_bracket_skew_ms,
                `measurement_profile.matched_coordinates[${index}].interpolation.max_bracket_skew_ms`,
              ),
            },
    };
  }

  if (input.moneyness_convention !== "LN_STRIKE_OVER_FORWARD") {
    throw new Error(
      `measurement_profile.matched_coordinates[${index}].moneyness_convention must be LN_STRIKE_OVER_FORWARD.`,
    );
  }
  if (
    input.interpolation != null &&
    input.interpolation.method !== "LINEAR_BY_LOG_MONEYNESS"
  ) {
    throw new Error(
      `measurement_profile.matched_coordinates[${index}].interpolation.method must be LINEAR_BY_LOG_MONEYNESS for MATCHED_FORWARD_MONEYNESS.`,
    );
  }
  return {
    ...common,
    measurement_basis: "MATCHED_FORWARD_MONEYNESS",
    target_log_moneyness: requiredDecimal(
      input.target_log_moneyness,
      `measurement_profile.matched_coordinates[${index}].target_log_moneyness`,
    ).toString(),
    moneyness_convention: "LN_STRIKE_OVER_FORWARD",
    interpolation:
      input.interpolation == null
        ? null
        : {
            allowed: true,
            method: "LINEAR_BY_LOG_MONEYNESS",
            max_bracket_width: positiveDecimal(
              input.interpolation.max_bracket_width,
              `measurement_profile.matched_coordinates[${index}].interpolation.max_bracket_width`,
            ),
            max_bracket_skew_ms: normalizedSkew(
              input.interpolation.max_bracket_skew_ms,
              `measurement_profile.matched_coordinates[${index}].interpolation.max_bracket_skew_ms`,
            ),
          },
  };
}

export function normalizeDdIvMeasurementRequest(
  input: DdIvMeasurementRequestInput | DdIvMeasurementRequest,
): DdIvMeasurementRequest {
  if (input.contract_version !== DD_IV_MEASUREMENT_CONTRACT_VERSION) {
    throw new Error(
      `dd_iv_measurement.contract_version must be ${DD_IV_MEASUREMENT_CONTRACT_VERSION}.`,
    );
  }
  if (input.measurement_profile.profile_version !== DD_IV_MEASUREMENT_PROFILE_VERSION) {
    throw new Error(
      `dd_iv_measurement.measurement_profile.profile_version must be ${DD_IV_MEASUREMENT_PROFILE_VERSION}.`,
    );
  }
  if (!Array.isArray(input.selected_legs) || input.selected_legs.length !== 4) {
    throw new Error("dd_iv_measurement.selected_legs must contain exactly four legs.");
  }
  const selectedLegs = input.selected_legs.map((leg, index) => ({
    role: leg.role,
    source_symbol: normalizedText(
      leg.source_symbol,
      `dd_iv_measurement.selected_legs[${index}].source_symbol`,
    ),
    expiration: normalizeRfc3339(
      leg.expiration,
      `dd_iv_measurement.selected_legs[${index}].expiration`,
    ),
    option_side: leg.option_side,
    strike: positiveDecimal(
      leg.strike,
      `dd_iv_measurement.selected_legs[${index}].strike`,
    ),
  }));
  if (
    new Set(selectedLegs.map((leg) => leg.role)).size !== SELECTED_ROLES.length ||
    SELECTED_ROLES.some(
      (role) => !selectedLegs.some((leg) => leg.role === role),
    )
  ) {
    throw new Error(
      "dd_iv_measurement.selected_legs must contain each Double Diagonal leg role exactly once.",
    );
  }
  if (
    new Set(selectedLegs.map((leg) => leg.source_symbol)).size !==
    selectedLegs.length
  ) {
    throw new Error(
      "dd_iv_measurement.selected_legs source_symbol values must be unique.",
    );
  }
  for (const leg of selectedLegs) {
    const expectedSide = leg.role.includes("PUT") ? "PUT" : "CALL";
    if (leg.option_side !== expectedSide) {
      throw new Error(
        `dd_iv_measurement selected leg ${leg.role} must use option_side ${expectedSide}.`,
      );
    }
  }
  const frontExpirations = unique(
    selectedLegs
      .filter((leg) => leg.role.startsWith("FRONT_"))
      .map((leg) => leg.expiration),
  );
  const backExpirations = unique(
    selectedLegs
      .filter((leg) => leg.role.startsWith("BACK_"))
      .map((leg) => leg.expiration),
  );
  if (
    frontExpirations.length !== 1 ||
    backExpirations.length !== 1 ||
    Date.parse(frontExpirations[0]) >= Date.parse(backExpirations[0])
  ) {
    throw new Error(
      "dd_iv_measurement selected legs require one shared front expiration before one shared back expiration.",
    );
  }
  if (
    !Array.isArray(input.measurement_profile.matched_coordinates) ||
    input.measurement_profile.matched_coordinates.length === 0
  ) {
    throw new Error(
      "dd_iv_measurement.measurement_profile.matched_coordinates must contain at least one rule.",
    );
  }
  const matchedCoordinates =
    input.measurement_profile.matched_coordinates.map(normalizeMatchedProfile);
  if (
    new Set(matchedCoordinates.map((profile) => profile.measurement_id)).size !==
    matchedCoordinates.length
  ) {
    throw new Error(
      "dd_iv_measurement measurement_id values must be unique.",
    );
  }
  return {
    contract_version: DD_IV_MEASUREMENT_CONTRACT_VERSION,
    candidate_id: normalizedText(
      input.candidate_id,
      "dd_iv_measurement.candidate_id",
    ),
    selected_legs: selectedLegs,
    measurement_profile: {
      profile_version: DD_IV_MEASUREMENT_PROFILE_VERSION,
      selected_leg: {
        max_front_back_skew_ms: normalizedSkew(
          input.measurement_profile.selected_leg.max_front_back_skew_ms,
          "dd_iv_measurement.measurement_profile.selected_leg.max_front_back_skew_ms",
        ),
        combined: normalizedCombined(
          input.measurement_profile.selected_leg.combined,
        ),
      },
      matched_coordinates: matchedCoordinates,
    },
  };
}

function normalizeLineage(
  input: DdIvLineageInput,
  observationIndex: number,
  lineageIndex: number,
): DdIvLineage {
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    throw new Error(
      `observations[${observationIndex}].lineage[${lineageIndex}].fields must not be empty.`,
    );
  }
  return {
    source: normalizedText(
      input.source,
      `observations[${observationIndex}].lineage[${lineageIndex}].source`,
    ),
    source_timestamp: normalizeRfc3339(
      input.source_timestamp,
      `observations[${observationIndex}].lineage[${lineageIndex}].source_timestamp`,
    ),
    fields: unique(
      input.fields.map((field, fieldIndex) =>
        normalizedText(
          field,
          `observations[${observationIndex}].lineage[${lineageIndex}].fields[${fieldIndex}]`,
        ),
      ),
    ),
    origin: input.origin,
  };
}

function optionalTimestamp(
  value: string | null,
  field: string,
): string | null {
  return value === null ? null : normalizeRfc3339(value, field);
}

function normalizeObservation(
  input: DdIvObservationInput,
  index: number,
): DdIvObservation {
  const symbol = normalizedText(
    input.source_symbol,
    `observations[${index}].source_symbol`,
  );
  const warnings = [...(input.warnings ?? [])];
  const iv = nullableDecimal(
    input.iv,
    `observations[${index}].iv`,
    `INVALID_IV_EXCLUDED:${symbol}`,
    warnings,
  );
  const delta = nullableDecimal(
    input.delta,
    `observations[${index}].delta`,
    `INVALID_DELTA_EXCLUDED:${symbol}`,
    warnings,
  );
  if (delta !== null && input.delta_convention === null) {
    throw new Error(
      `observations[${index}].delta_convention is required when delta is present.`,
    );
  }
  if (delta !== null && input.delta_origin === null) {
    throw new Error(
      `observations[${index}].delta_origin is required when delta is present.`,
    );
  }
  if (delta === null && input.delta_origin !== null) {
    warnings.push(`DELTA_ORIGIN_IGNORED_WITHOUT_DELTA:${symbol}`);
  }
  if (iv !== null && input.model.iv_model === null) {
    throw new Error(
      `observations[${index}].model.iv_model is required when IV is present.`,
    );
  }
  if (
    delta !== null &&
    input.delta_origin === "DERIVED" &&
    (input.model.delta_model === null ||
      input.model.forward_model === null ||
      input.forward === null)
  ) {
    throw new Error(
      `observations[${index}] derived delta requires delta, forward model, and forward provenance.`,
    );
  }
  const forward =
    input.forward === null
      ? null
      : {
          value: positiveDecimal(
            input.forward.value,
            `observations[${index}].forward.value`,
          ),
          origin: input.forward.origin,
          source_timestamp: normalizeRfc3339(
            input.forward.source_timestamp,
            `observations[${index}].forward.source_timestamp`,
          ),
        };
  return {
    source_symbol: symbol,
    expiration: normalizeRfc3339(
      input.expiration,
      `observations[${index}].expiration`,
    ),
    option_side: input.option_side,
    strike: positiveDecimal(input.strike, `observations[${index}].strike`),
    iv,
    delta,
    delta_convention:
      delta === null ? null : input.delta_convention,
    iv_origin: input.iv_origin,
    delta_origin: delta === null ? null : input.delta_origin,
    model: {
      iv_model:
        input.model.iv_model === null
          ? null
          : normalizedText(
              input.model.iv_model,
              `observations[${index}].model.iv_model`,
            ),
      delta_model:
        input.model.delta_model === null
          ? null
          : normalizedText(
              input.model.delta_model,
              `observations[${index}].model.delta_model`,
            ),
      forward_model:
        input.model.forward_model === null
          ? null
          : normalizedText(
              input.model.forward_model,
              `observations[${index}].model.forward_model`,
            ),
      assumptions: unique(
        input.model.assumptions.map((assumption, assumptionIndex) =>
          normalizedText(
            assumption,
            `observations[${index}].model.assumptions[${assumptionIndex}]`,
          ),
        ),
      ),
    },
    forward,
    bar_start: optionalTimestamp(
      input.bar_start,
      `observations[${index}].bar_start`,
    ),
    bar_end: optionalTimestamp(
      input.bar_end,
      `observations[${index}].bar_end`,
    ),
    available_at: optionalTimestamp(
      input.available_at,
      `observations[${index}].available_at`,
    ),
    retrieved_at: optionalTimestamp(
      input.retrieved_at,
      `observations[${index}].retrieved_at`,
    ),
    bar_status: input.bar_status,
    freshness: input.freshness,
    provider: normalizedText(
      input.provider,
      `observations[${index}].provider`,
    ),
    dataset: normalizedText(
      input.dataset,
      `observations[${index}].dataset`,
    ),
    resolution: normalizedText(
      input.resolution,
      `observations[${index}].resolution`,
    ),
    alignment: normalizedText(
      input.alignment,
      `observations[${index}].alignment`,
    ),
    source_cohort_id: normalizedText(
      input.source_cohort_id,
      `observations[${index}].source_cohort_id`,
    ),
    lineage: input.lineage.map((item, lineageIndex) =>
      normalizeLineage(item, index, lineageIndex),
    ),
    warnings: unique(warnings),
  };
}

function contextKey(observation: DdIvObservation): string {
  return [
    observation.provider,
    observation.dataset,
    observation.resolution,
    observation.alignment,
    observation.source_cohort_id,
  ].join("|");
}

function eligibilityWarnings(
  observation: DdIvObservation,
  checkpoint: string,
  requireDelta: boolean,
  requireForward = false,
): string[] {
  const warnings: string[] = [];
  const symbol = observation.source_symbol;
  if (observation.iv === null) warnings.push(`MISSING_IV:${symbol}`);
  if (requireDelta && observation.delta === null) {
    warnings.push(`MISSING_DELTA:${symbol}`);
  }
  if (requireForward && observation.forward === null) {
    warnings.push(`MISSING_FORWARD:${symbol}`);
  }
  if (
    requireForward &&
    observation.forward !== null &&
    observation.model.forward_model === null
  ) {
    warnings.push(`MISSING_FORWARD_MODEL:${symbol}`);
  }
  if (observation.bar_status === "INCOMPLETE") {
    warnings.push(`INCOMPLETE_BAR_EXCLUDED:${symbol}`);
  } else if (observation.bar_status === "MISSING") {
    warnings.push(`MISSING_BAR_EXCLUDED:${symbol}`);
  }
  if (
    observation.bar_start === null ||
    observation.bar_end === null ||
    observation.available_at === null
  ) {
    warnings.push(`MISSING_BAR_TIMING_EXCLUDED:${symbol}`);
  } else {
    if (Date.parse(observation.available_at) < Date.parse(observation.bar_end)) {
      warnings.push(`BAR_AVAILABLE_BEFORE_END_EXCLUDED:${symbol}`);
    }
    if (Date.parse(observation.available_at) > Date.parse(checkpoint)) {
      warnings.push(`POST_CHECKPOINT_OBSERVATION_EXCLUDED:${symbol}`);
    }
  }
  if (observation.freshness === "STALE") {
    warnings.push(`STALE_OBSERVATION_EXCLUDED:${symbol}`);
  } else if (observation.freshness !== "FRESH") {
    warnings.push(`UNKNOWN_FRESHNESS_EXCLUDED:${symbol}`);
  }
  if (
    observation.forward !== null &&
    Date.parse(observation.forward.source_timestamp) > Date.parse(checkpoint)
  ) {
    warnings.push(`POST_CHECKPOINT_FORWARD_EXCLUDED:${symbol}`);
  }
  if (
    observation.lineage.some(
      (item) => Date.parse(item.source_timestamp) > Date.parse(checkpoint),
    )
  ) {
    warnings.push(`POST_CHECKPOINT_LINEAGE_EXCLUDED:${symbol}`);
  }
  return unique(warnings);
}

function rolePair(
  side: DdIvOptionSide,
): [DdIvSelectedLegRole, DdIvSelectedLegRole] {
  return side === "PUT"
    ? ["FRONT_PUT_SHORT", "BACK_PUT_LONG"]
    : ["FRONT_CALL_SHORT", "BACK_CALL_LONG"];
}

function unavailableObservation(
  reference: DdIvSelectedLegReference,
): DdIvObservation {
  return {
    source_symbol: reference.source_symbol,
    expiration: reference.expiration,
    option_side: reference.option_side,
    strike: reference.strike,
    iv: null,
    delta: null,
    delta_convention: null,
    iv_origin: "PROVIDER_OBSERVATION",
    delta_origin: null,
    model: {
      iv_model: null,
      delta_model: null,
      forward_model: null,
      assumptions: [],
    },
    forward: null,
    bar_start: null,
    bar_end: null,
    available_at: null,
    retrieved_at: null,
    bar_status: "MISSING",
    freshness: "UNKNOWN",
    provider: "NOT_AVAILABLE",
    dataset: "NOT_AVAILABLE",
    resolution: "NOT_AVAILABLE",
    alignment: "NOT_AVAILABLE",
    source_cohort_id: "NOT_AVAILABLE",
    lineage: [],
    warnings: [`SELECTED_LEG_OBSERVATION_NOT_AVAILABLE:${reference.source_symbol}`],
  };
}

function selectedSideMeasurement(
  side: DdIvOptionSide,
  frozenLegs: DdIvFrozenLeg[],
  maximumSkewMs: number,
): DdIvSelectedSideMeasurement {
  const [frontRole, backRole] = rolePair(side);
  const front = frozenLegs.find((leg) => leg.role === frontRole)!;
  const back = frozenLegs.find((leg) => leg.role === backRole)!;
  const warnings = unique([
    ...front.warnings,
    ...back.warnings,
    ...front.eligibility_warnings,
    ...back.eligibility_warnings,
  ]);
  let temporalSkewMs: number | null = null;
  if (front.available_at !== null && back.available_at !== null) {
    temporalSkewMs = Math.abs(
      Date.parse(front.available_at) - Date.parse(back.available_at),
    );
    if (temporalSkewMs > maximumSkewMs) {
      warnings.push(`SELECTED_LEG_TEMPORAL_SKEW_EXCEEDED:${side}`);
    }
  }
  if (contextKey(front) !== contextKey(back)) {
    warnings.push(`SELECTED_LEG_SOURCE_COHORT_MISMATCH:${side}`);
  }
  const available =
    front.eligibility_warnings.length === 0 &&
    back.eligibility_warnings.length === 0 &&
    front.iv !== null &&
    back.iv !== null &&
    temporalSkewMs !== null &&
    temporalSkewMs <= maximumSkewMs &&
    contextKey(front) === contextKey(back);
  const spread =
    available && front.iv !== null && back.iv !== null
      ? ExactDecimal.parse(back.iv).subtract(ExactDecimal.parse(front.iv))
      : null;
  return {
    option_side: side,
    status: available ? "AVAILABLE" : "NOT_AVAILABLE",
    front_role: frontRole,
    back_role: backRole,
    front_iv_decimal: front.iv,
    back_iv_decimal: back.iv,
    iv_unit: "DECIMAL",
    spread_decimal: spread?.toString() ?? null,
    spread_vol_points: spread === null ? null : volPoints(spread),
    temporal_skew_ms: temporalSkewMs,
    source_cohort_ids: unique([
      front.source_cohort_id,
      back.source_cohort_id,
    ]),
    quality: available ? "COMPLETE" : "NOT_AVAILABLE",
    warnings: unique(warnings),
  };
}

function weightedMean(
  put: ExactDecimal,
  call: ExactDecimal,
  putWeight: ExactDecimal,
  callWeight: ExactDecimal,
): ExactDecimal {
  return put
    .multiply(putWeight)
    .add(call.multiply(callWeight))
    .divide(putWeight.add(callWeight));
}

function selectedMeasurement(
  request: DdIvMeasurementRequest,
  checkpoint: string,
  observations: Map<string, DdIvObservation>,
): DdIvSelectedLegMeasurement {
  const frozenLegs = request.selected_legs.map((reference) => {
    const candidate =
      observations.get(reference.source_symbol) ??
      unavailableObservation(reference);
    const identityMatches =
      candidate.expiration === reference.expiration &&
      candidate.option_side === reference.option_side &&
      candidate.strike === reference.strike;
    const observation = identityMatches
      ? candidate
      : unavailableObservation(reference);
    const identityWarning = identityMatches
      ? []
      : [`SELECTED_LEG_IDENTITY_MISMATCH:${reference.source_symbol}`];
    return {
      ...observation,
      candidate_id: request.candidate_id,
      role: reference.role,
      eligibility_warnings: unique([
        ...eligibilityWarnings(observation, checkpoint, false),
        ...identityWarning,
      ]),
    };
  });
  const put = selectedSideMeasurement(
    "PUT",
    frozenLegs,
    request.measurement_profile.selected_leg.max_front_back_skew_ms,
  );
  const call = selectedSideMeasurement(
    "CALL",
    frozenLegs,
    request.measurement_profile.selected_leg.max_front_back_skew_ms,
  );
  const warnings = unique([
    ...put.warnings,
    ...call.warnings,
  ]);
  const putSpread =
    put.spread_decimal === null
      ? null
      : ExactDecimal.parse(put.spread_decimal);
  const callSpread =
    call.spread_decimal === null
      ? null
      : ExactDecimal.parse(call.spread_decimal);
  if (
    putSpread !== null &&
    callSpread !== null &&
    putSpread.compare(ExactDecimal.zero()) !== 0 &&
    callSpread.compare(ExactDecimal.zero()) !== 0 &&
    putSpread.compare(ExactDecimal.zero()) !==
      callSpread.compare(ExactDecimal.zero())
  ) {
    warnings.push("SELECTED_LEG_SIDE_SPREADS_HAVE_OPPOSING_SIGNS");
  }
  const combinedProfile =
    request.measurement_profile.selected_leg.combined;
  let combined: DdIvSelectedLegMeasurement["combined"] = null;
  if (combinedProfile !== null) {
    const combinedWarnings: string[] = [];
    const available = putSpread !== null && callSpread !== null;
    const spread =
      available && putSpread !== null && callSpread !== null
        ? weightedMean(
            putSpread,
            callSpread,
            ExactDecimal.parse(combinedProfile.put_weight),
            ExactDecimal.parse(combinedProfile.call_weight),
          )
        : null;
    if (!available) {
      combinedWarnings.push(
        "COMBINED_SELECTED_LEG_SPREAD_NOT_AVAILABLE_WITHOUT_BOTH_SIDES",
      );
    }
    if (warnings.includes("SELECTED_LEG_SIDE_SPREADS_HAVE_OPPOSING_SIGNS")) {
      combinedWarnings.push(
        "COMBINED_VALUE_RETAINS_EXPLICIT_OPPOSING_SIDE_COMPONENTS",
      );
    }
    combined = {
      status: available ? "AVAILABLE" : "NOT_AVAILABLE",
      aggregation: "WEIGHTED_ARITHMETIC_MEAN",
      weights: {
        PUT: combinedProfile.put_weight,
        CALL: combinedProfile.call_weight,
      },
      component_spreads: {
        PUT: put.spread_decimal,
        CALL: call.spread_decimal,
      },
      spread_decimal: spread?.toString() ?? null,
      spread_vol_points: spread === null ? null : volPoints(spread),
      iv_unit: "DECIMAL",
      warnings: combinedWarnings,
    };
    warnings.push(...combinedWarnings);
  }
  const availableSides = [put, call].filter(
    (side) => side.status === "AVAILABLE",
  ).length;
  const status =
    availableSides === 2
      ? "AVAILABLE"
      : availableSides === 1
        ? "PARTIAL"
        : "NOT_AVAILABLE";
  const sourceCohorts = unique(
    frozenLegs.map((leg) => leg.source_cohort_id),
  );
  const cohortId = stableId({
    measurement_basis: "SELECTED_LEG_IV_DIFFERENCE",
    candidate_id: request.candidate_id,
    profile_version: request.measurement_profile.profile_version,
    source_cohort_ids: sourceCohorts,
    selected_legs: request.selected_legs,
  });
  return {
    contract_version: DD_IV_MEASUREMENT_CONTRACT_VERSION,
    measurement_basis: "SELECTED_LEG_IV_DIFFERENCE",
    measurement_profile_version: DD_IV_MEASUREMENT_PROFILE_VERSION,
    grading_role: "RESEARCH_ONLY",
    candidate_id: request.candidate_id,
    cohort_id: cohortId,
    status,
    iv_unit: "DECIMAL",
    frozen_legs: frozenLegs,
    sides: { PUT: put, CALL: call },
    combined,
    quality:
      status === "AVAILABLE"
        ? "COMPLETE"
        : status === "PARTIAL"
          ? "PARTIAL"
          : "NOT_AVAILABLE",
    warnings: unique(warnings),
  };
}

type CoordinateCandidate = {
  observation: DdIvObservation;
  coordinate: ExactDecimal;
  error: ExactDecimal;
};

const LOG_MONEYNESS_DECIMAL_PLACES = 12;

function targetCoordinate(
  profile: DdIvMatchedCoordinateProfile,
): ExactDecimal {
  return ExactDecimal.parse(
    profile.measurement_basis === "MATCHED_DELTA"
      ? profile.target_delta
      : profile.target_log_moneyness,
  );
}

function coordinateDefinition(
  profile: DdIvMatchedCoordinateProfile,
): DdIvCoordinateDefinition {
  return profile.measurement_basis === "MATCHED_DELTA"
    ? profile.delta_convention
    : profile.moneyness_convention;
}

function coordinateFor(
  observation: DdIvObservation,
  profile: DdIvMatchedCoordinateProfile,
): ExactDecimal | null {
  if (profile.measurement_basis === "MATCHED_DELTA") {
    if (
      observation.delta === null ||
      observation.delta_convention !== "SIGNED_FORWARD_DELTA_PERCENT"
    ) {
      return null;
    }
    const delta = ExactDecimal.parse(observation.delta);
    return profile.delta_convention === "ABSOLUTE_FORWARD_DELTA_PERCENT"
      ? delta.abs()
      : delta;
  }
  if (observation.forward === null) return null;
  const strike = Number(observation.strike);
  const forward = Number(observation.forward.value);
  const logMoneyness = Math.log(strike / forward);
  if (!Number.isFinite(logMoneyness)) return null;
  return ExactDecimal.parse(
    logMoneyness.toFixed(LOG_MONEYNESS_DECIMAL_PLACES),
  );
}

function coordinateErrorFields(
  profile: DdIvMatchedCoordinateProfile,
  error: string | null,
): Pick<DdIvCoordinateMatch, "delta_error" | "moneyness_error"> {
  return profile.measurement_basis === "MATCHED_DELTA"
    ? { delta_error: error }
    : { moneyness_error: error };
}

function matchInput(
  candidate: CoordinateCandidate,
  weight: string,
  profile: DdIvMatchedCoordinateProfile,
): DdIvMatchInput {
  const observation = candidate.observation;
  return {
    source_symbol: observation.source_symbol,
    strike: observation.strike,
    coordinate: candidate.coordinate.toString(),
    coordinate_definition: coordinateDefinition(profile),
    delta: observation.delta,
    delta_convention: observation.delta_convention,
    delta_origin: observation.delta_origin,
    iv_decimal: observation.iv!,
    weight,
    available_at: observation.available_at!,
    iv_origin: observation.iv_origin,
    model: observation.model,
    forward: observation.forward,
    lineage: observation.lineage,
  };
}

function unavailableMatch(
  profile: DdIvMatchedCoordinateProfile,
  expiration: string,
  nearest: CoordinateCandidate | null,
  warnings: string[],
): DdIvCoordinateMatch {
  const target = targetCoordinate(profile);
  const tolerance = ExactDecimal.parse(profile.tolerance);
  const coverageGap =
    nearest === null
      ? null
      : nearest.error.subtract(tolerance).compare(ExactDecimal.zero()) > 0
        ? nearest.error.subtract(tolerance).toString()
        : "0";
  return {
    status: "NOT_AVAILABLE",
    expiration,
    option_side: profile.option_side,
    target_coordinate: target.toString(),
    achieved_coordinate: nearest?.coordinate.toString() ?? null,
    coordinate_definition: coordinateDefinition(profile),
    coordinate_error: nearest?.error.toString() ?? null,
    ...coordinateErrorFields(
      profile,
      nearest?.error.toString() ?? null,
    ),
    coverage_gap: coverageGap,
    iv_decimal: null,
    iv_unit: "DECIMAL",
    value_origin: null,
    method: null,
    source_symbols:
      nearest === null ? [] : [nearest.observation.source_symbol],
    source_strikes:
      nearest === null ? [] : [nearest.observation.strike],
    source_cohort_ids:
      nearest === null ? [] : [nearest.observation.source_cohort_id],
    effective_available_at: nearest?.observation.available_at ?? null,
    interpolation: null,
    inputs: [],
    quality: "NOT_AVAILABLE",
    warnings: unique(warnings),
  };
}

function matchedCoordinate(
  profile: DdIvMatchedCoordinateProfile,
  expiration: string,
  checkpoint: string,
  observations: DdIvObservation[],
): DdIvCoordinateMatch {
  const target = targetCoordinate(profile);
  const tolerance = ExactDecimal.parse(profile.tolerance);
  const eligibility: string[] = [];
  const candidates = observations
    .filter(
      (observation) =>
        observation.expiration === expiration &&
        observation.option_side === profile.option_side,
    )
    .map((observation) => {
      const warnings = eligibilityWarnings(
        observation,
        checkpoint,
        profile.measurement_basis === "MATCHED_DELTA",
        profile.measurement_basis === "MATCHED_FORWARD_MONEYNESS",
      );
      eligibility.push(...observation.warnings, ...warnings);
      if (warnings.length > 0 || observation.iv === null) return null;
      const coordinate = coordinateFor(observation, profile);
      if (coordinate === null) {
        eligibility.push(
          profile.measurement_basis === "MATCHED_DELTA"
            ? `DELTA_CONVENTION_NOT_COMPARABLE:${observation.source_symbol}`
            : `FORWARD_MONEYNESS_NOT_AVAILABLE:${observation.source_symbol}`,
        );
        return null;
      }
      return {
        observation,
        coordinate,
        error: coordinate.subtract(target).abs(),
      };
    })
    .filter(
      (candidate): candidate is CoordinateCandidate => candidate !== null,
    )
    .sort(
      (left, right) =>
        left.error.compare(right.error) ||
        left.observation.source_symbol.localeCompare(
          right.observation.source_symbol,
        ),
    );
  const direct = candidates.find(
    (candidate) => candidate.error.compare(tolerance) <= 0,
  );
  if (direct) {
    const input = matchInput(direct, "1", profile);
    return {
      status: "AVAILABLE",
      expiration,
      option_side: profile.option_side,
      target_coordinate: target.toString(),
      achieved_coordinate: direct.coordinate.toString(),
      coordinate_definition: coordinateDefinition(profile),
      coordinate_error: direct.error.toString(),
      ...coordinateErrorFields(profile, direct.error.toString()),
      coverage_gap: "0",
      iv_decimal: direct.observation.iv,
      iv_unit: "DECIMAL",
      value_origin: direct.observation.iv_origin,
      method: "DIRECT_WITHIN_TOLERANCE",
      source_symbols: [direct.observation.source_symbol],
      source_strikes: [direct.observation.strike],
      source_cohort_ids: [direct.observation.source_cohort_id],
      effective_available_at: direct.observation.available_at,
      interpolation: null,
      inputs: [input],
      quality: "COMPLETE",
      warnings: unique([
        ...eligibility,
        ...direct.observation.warnings,
      ]),
    };
  }

  const nearest = candidates[0] ?? null;
  if (profile.interpolation === null) {
    return unavailableMatch(profile, expiration, nearest, [
      ...eligibility,
      "MATCH_TOLERANCE_NOT_MET",
    ]);
  }
  const lower = candidates
    .filter((candidate) => candidate.coordinate.compare(target) < 0)
    .sort((left, right) => right.coordinate.compare(left.coordinate))[0];
  const upper = candidates
    .filter((candidate) => candidate.coordinate.compare(target) > 0)
    .sort((left, right) => left.coordinate.compare(right.coordinate))[0];
  if (!lower || !upper) {
    return unavailableMatch(profile, expiration, nearest, [
      ...eligibility,
      "INTERPOLATION_BRACKET_NOT_AVAILABLE_NO_EXTRAPOLATION",
    ]);
  }
  const width = upper.coordinate.subtract(lower.coordinate);
  if (
    width.compare(
      ExactDecimal.parse(profile.interpolation.max_bracket_width),
    ) > 0
  ) {
    return unavailableMatch(profile, expiration, nearest, [
      ...eligibility,
      "INTERPOLATION_BRACKET_EXCEEDS_DECLARED_WIDTH",
    ]);
  }
  const lowerAvailable = Date.parse(lower.observation.available_at!);
  const upperAvailable = Date.parse(upper.observation.available_at!);
  if (
    Math.abs(lowerAvailable - upperAvailable) >
    profile.interpolation.max_bracket_skew_ms
  ) {
    return unavailableMatch(profile, expiration, nearest, [
      ...eligibility,
      "INTERPOLATION_BRACKET_TEMPORAL_SKEW_EXCEEDED",
    ]);
  }
  if (contextKey(lower.observation) !== contextKey(upper.observation)) {
    return unavailableMatch(profile, expiration, nearest, [
      ...eligibility,
      "INTERPOLATION_BRACKET_SOURCE_COHORT_MISMATCH",
    ]);
  }
  const upperWeight = target.subtract(lower.coordinate).divide(width);
  const lowerWeight = upper.coordinate.subtract(target).divide(width);
  const interpolatedIv = ExactDecimal.parse(lower.observation.iv!)
    .multiply(lowerWeight)
    .add(ExactDecimal.parse(upper.observation.iv!).multiply(upperWeight));
  const inputs = [
    matchInput(lower, lowerWeight.toString(), profile),
    matchInput(upper, upperWeight.toString(), profile),
  ];
  const interpolationMethod =
    profile.measurement_basis === "MATCHED_DELTA"
      ? "LINEAR_BY_DELTA"
      : "LINEAR_BY_LOG_MONEYNESS";
  return {
    status: "AVAILABLE",
    expiration,
    option_side: profile.option_side,
    target_coordinate: target.toString(),
    achieved_coordinate: target.toString(),
    coordinate_definition: coordinateDefinition(profile),
    coordinate_error: "0",
    ...coordinateErrorFields(profile, "0"),
    coverage_gap: "0",
    iv_decimal: interpolatedIv.toString(),
    iv_unit: "DECIMAL",
    value_origin: "DERIVED",
    method: interpolationMethod,
    source_symbols: inputs.map((input) => input.source_symbol),
    source_strikes: inputs.map((input) => input.strike),
    source_cohort_ids: unique([
      lower.observation.source_cohort_id,
      upper.observation.source_cohort_id,
    ]),
    effective_available_at: new Date(
      Math.max(lowerAvailable, upperAvailable),
    ).toISOString(),
    interpolation: {
      method: interpolationMethod,
      lower_coordinate: lower.coordinate.toString(),
      upper_coordinate: upper.coordinate.toString(),
      lower_weight: lowerWeight.toString(),
      upper_weight: upperWeight.toString(),
      inputs,
    },
    inputs,
    quality: "COMPLETE",
    warnings: unique([
      ...eligibility,
      "MATCHED_IV_DERIVED_BY_PREDECLARED_BRACKET_INTERPOLATION",
    ]),
  };
}

function matchedMeasurement(
  profile: DdIvMatchedCoordinateProfile,
  checkpoint: string,
  observations: DdIvObservation[],
): DdIvMatchedMeasurement {
  const front = matchedCoordinate(
    profile,
    profile.front_expiration,
    checkpoint,
    observations,
  );
  const back = matchedCoordinate(
    profile,
    profile.back_expiration,
    checkpoint,
    observations,
  );
  const warnings = unique([...front.warnings, ...back.warnings]);
  let temporalSkewMs: number | null = null;
  if (
    front.effective_available_at !== null &&
    back.effective_available_at !== null
  ) {
    temporalSkewMs = Math.abs(
      Date.parse(front.effective_available_at) -
        Date.parse(back.effective_available_at),
    );
    if (temporalSkewMs > profile.max_front_back_skew_ms) {
      warnings.push("MATCHED_FRONT_BACK_TEMPORAL_SKEW_EXCEEDED");
    }
  }
  const sourceContextCompatible =
    front.inputs.length > 0 &&
    back.inputs.length > 0 &&
    contextKey(
      observations.find(
        (observation) =>
          observation.source_symbol === front.inputs[0].source_symbol,
      )!,
    ) ===
      contextKey(
        observations.find(
          (observation) =>
            observation.source_symbol === back.inputs[0].source_symbol,
        )!,
      );
  if (
    front.status === "AVAILABLE" &&
    back.status === "AVAILABLE" &&
    !sourceContextCompatible
  ) {
    warnings.push("MATCHED_FRONT_BACK_SOURCE_COHORT_MISMATCH");
  }
  const available =
    front.status === "AVAILABLE" &&
    back.status === "AVAILABLE" &&
    front.iv_decimal !== null &&
    back.iv_decimal !== null &&
    temporalSkewMs !== null &&
    temporalSkewMs <= profile.max_front_back_skew_ms &&
    sourceContextCompatible;
  const spread =
    available && front.iv_decimal !== null && back.iv_decimal !== null
      ? ExactDecimal.parse(back.iv_decimal).subtract(
          ExactDecimal.parse(front.iv_decimal),
        )
      : null;
  if (!available) {
    warnings.push(
      "MATCH_TOLERANCE_NOT_MET_DEFAULTED_TO_NOT_AVAILABLE",
    );
  }
  const sourceCohortIds = unique([
    ...front.source_cohort_ids,
    ...back.source_cohort_ids,
  ]);
  const cohortId = stableId({
    measurement_basis: profile.measurement_basis,
    measurement_id: profile.measurement_id,
    profile_version: DD_IV_MEASUREMENT_PROFILE_VERSION,
    profile,
    source_cohort_ids: sourceCohortIds,
  });
  return {
    contract_version: DD_IV_MEASUREMENT_CONTRACT_VERSION,
    measurement_basis: profile.measurement_basis,
    measurement_id: profile.measurement_id,
    measurement_profile_version: DD_IV_MEASUREMENT_PROFILE_VERSION,
    grading_role: "RESEARCH_ONLY",
    cohort_id: cohortId,
    option_side: profile.option_side,
    front_expiration: profile.front_expiration,
    back_expiration: profile.back_expiration,
    coordinate_definition: coordinateDefinition(profile),
    target_coordinate: targetCoordinate(profile).toString(),
    ...(profile.measurement_basis === "MATCHED_DELTA"
      ? {
          target_delta: profile.target_delta,
          delta_convention: profile.delta_convention,
        }
      : {
          target_log_moneyness: profile.target_log_moneyness,
          moneyness_convention: profile.moneyness_convention,
        }),
    tolerance: profile.tolerance,
    missing_policy: "NOT_AVAILABLE",
    status: available ? "AVAILABLE" : "NOT_AVAILABLE",
    iv_unit: "DECIMAL",
    front,
    back,
    spread_decimal: spread?.toString() ?? null,
    spread_vol_points: spread === null ? null : volPoints(spread),
    temporal_skew_ms: temporalSkewMs,
    source_cohort_ids: sourceCohortIds,
    quality: available ? "COMPLETE" : "NOT_AVAILABLE",
    warnings: unique(warnings),
  };
}

export function normalizeDdIvMeasurements(
  input: DdIvMeasurementNormalizerInput,
): DdIvMeasurementHandoff {
  const checkpoint = normalizeRfc3339(input.checkpoint, "checkpoint");
  const request = normalizeDdIvMeasurementRequest(input.request);
  const observations = input.observations.map(normalizeObservation);
  const sourceEvidence = normalizeSourceEvidence(input.source_evidence);
  if (
    new Set(observations.map((observation) => observation.source_symbol)).size !==
    observations.length
  ) {
    throw new Error("observations must contain unique source_symbol values.");
  }
  const observationsBySymbol = new Map(
    observations.map((observation) => [
      observation.source_symbol,
      observation,
    ]),
  );
  const selected = selectedMeasurement(
    request,
    checkpoint,
    observationsBySymbol,
  );
  const matched = request.measurement_profile.matched_coordinates.map(
    (profile) => matchedMeasurement(profile, checkpoint, observations),
  );
  const warnings = unique([
    ...observations.flatMap((observation) => observation.warnings),
    ...selected.warnings,
    ...matched.flatMap((measurement) => measurement.warnings),
    "RESEARCH_ONLY_DOES_NOT_REPLACE_PRODUCTION_TERM_STRUCTURE",
    "NO_GRADING_ROUTING_FILL_OR_PNL_POLICY_APPLIED",
  ]);
  const completeMeasurements =
    (selected.status === "AVAILABLE" ? 1 : 0) +
    matched.filter((measurement) => measurement.status === "AVAILABLE").length;
  const totalMeasurements = 1 + matched.length;
  const quality =
    completeMeasurements === totalMeasurements
      ? "COMPLETE"
      : completeMeasurements === 0
        ? "NOT_AVAILABLE"
        : "PARTIAL";
  const sourceCohortIds = unique(
    observations.map((observation) => observation.source_cohort_id),
  );
  const handoffIdentity = {
    contract_version: DD_IV_MEASUREMENT_CONTRACT_VERSION,
    handoff_dataset_version: DD_IV_HANDOFF_DATASET_VERSION,
    checkpoint,
    request,
    observations,
    ...(sourceEvidence === undefined
      ? {}
      : { source_evidence: sourceEvidence }),
  };
  return {
    contract_version: DD_IV_MEASUREMENT_CONTRACT_VERSION,
    handoff_dataset_version: DD_IV_HANDOFF_DATASET_VERSION,
    handoff_id: stableId(handoffIdentity),
    grading_role: "RESEARCH_ONLY",
    checkpoint,
    candidate_id: request.candidate_id,
    measurement_profile_version: DD_IV_MEASUREMENT_PROFILE_VERSION,
    measurement_profile: request.measurement_profile,
    legacy_term_structure_replaced: false,
    selected_leg_measurement: selected,
    matched_measurements: matched,
    cohort_identity: {
      selected_leg: selected.cohort_id,
      matched: matched.map((measurement) => measurement.cohort_id),
      source_cohort_ids: sourceCohortIds,
    },
    ...(sourceEvidence === undefined
      ? {}
      : { source_evidence: sourceEvidence }),
    quality,
    warnings,
  };
}

export type LegacyDdIvMigrationInput = {
  source_file: string;
  source_schema_version: string | null;
  raw_file: string;
  record: Record<string, unknown>;
};

export type LegacyDdIvMigrationResult = {
  migration_contract_version: typeof DD_IV_LEGACY_MIGRATION_VERSION;
  status:
    | "ALREADY_VERSIONED_PRESERVED"
    | "PRESERVED_AMBIGUOUS_LEGACY"
    | "NO_LEGACY_FIELD_PRESENT";
  source_file: string;
  source_schema_version: string | null;
  source_sha256: string;
  raw_file: string;
  raw_record: Record<string, unknown>;
  raw_term_spread_vol_points: unknown;
  normalized_measurement: null;
  warnings: string[];
};

export function migrateLegacyDdIvRecord(
  input: LegacyDdIvMigrationInput,
): LegacyDdIvMigrationResult {
  const sourceFile = normalizedText(input.source_file, "source_file", 500);
  const sourceSchemaVersion =
    input.source_schema_version === null
      ? null
      : normalizedText(
          input.source_schema_version,
          "source_schema_version",
          100,
        );
  const rawRecord = structuredClone(input.record);
  const hasLegacyField = Object.prototype.hasOwnProperty.call(
    rawRecord,
    "term_spread_vol_points",
  );
  const alreadyVersioned =
    sourceSchemaVersion === DD_IV_MEASUREMENT_CONTRACT_VERSION &&
    rawRecord.contract_version === DD_IV_MEASUREMENT_CONTRACT_VERSION;
  const status = alreadyVersioned
    ? "ALREADY_VERSIONED_PRESERVED"
    : hasLegacyField
      ? "PRESERVED_AMBIGUOUS_LEGACY"
      : "NO_LEGACY_FIELD_PRESENT";
  const warnings =
    status === "PRESERVED_AMBIGUOUS_LEGACY"
      ? [
          "AMBIGUOUS_LEGACY_TERM_SPREAD_VOL_POINTS_PRESERVED_WITHOUT_CONVERSION",
          "SOURCE_FILE_PRESERVED_WITHOUT_OVERWRITE",
        ]
      : ["SOURCE_FILE_PRESERVED_WITHOUT_OVERWRITE"];
  return {
    migration_contract_version: DD_IV_LEGACY_MIGRATION_VERSION,
    status,
    source_file: sourceFile,
    source_schema_version: sourceSchemaVersion,
    source_sha256: createHash("sha256").update(input.raw_file).digest("hex"),
    raw_file: input.raw_file,
    raw_record: rawRecord,
    raw_term_spread_vol_points: hasLegacyField
      ? rawRecord.term_spread_vol_points
      : null,
    normalized_measurement: null,
    warnings,
  };
}
