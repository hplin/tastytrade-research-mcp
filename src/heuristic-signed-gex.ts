import { createHash } from "node:crypto";
import { ExactDecimal, type DecimalInput } from "./decimal.js";
import {
  LIVE_OPTION_SNAPSHOT_INPUT_SCHEMA,
  type LiveOptionSnapshotContract,
  type LiveOptionSnapshotInput,
  type LiveOptionSnapshotResult,
} from "./live-option-snapshot.js";
import { blackScholesSpotGamma } from "./option-model.js";

export const HEURISTIC_SIGNED_GEX_CONTRACT_VERSION = "1.0.0";
export const HEURISTIC_SIGNED_GEX_METHODOLOGY =
  "MODEL_BASED_SIGNED_GEX";
export const CURRENT_GAMMA_SIGNED_GEX_METHODOLOGY =
  "CURRENT_GAMMA_SIGNED_GEX";
export const SPOT_REPRICED_SIGNED_GEX_METHODOLOGY =
  "SPOT_REPRICED_SIGNED_GEX";
export const BASELINE_SIGNING_MODEL_ID =
  "CALL_SHORT_PUT_LONG_BASELINE";
export const BASELINE_SIGNING_MODEL_VERSION = "1.0.0";
export const BLACK_SCHOLES_GAMMA_MODEL_VERSION = "1.0.0";

const MAX_SPOT_SCENARIOS = 1_001;
const GEX_OUTPUT_DECIMAL_PLACES = 6;
const GEX_FACTOR = ExactDecimal.parse("0.01");
const ZERO = ExactDecimal.zero();

const POSITIVE_DECIMAL_SCHEMA = {
  anyOf: [
    {
      type: "string",
      pattern:
        "^(?:0*[1-9][0-9]*(?:\\.[0-9]+)?|0*\\.[0-9]*[1-9][0-9]*)$",
    },
    { type: "number", exclusiveMinimum: 0 },
  ],
} as const;

const SIGNED_DECIMAL_SCHEMA = {
  anyOf: [
    {
      type: "string",
      pattern: "^[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)$",
    },
    { type: "number" },
  ],
} as const;

const HEURISTIC_SNAPSHOT_REQUEST_SCHEMA = {
  ...LIVE_OPTION_SNAPSHOT_INPUT_SCHEMA.properties.request,
  properties: {
    ...LIVE_OPTION_SNAPSHOT_INPUT_SCHEMA.properties.request.properties,
    include_greeks: {
      type: "boolean",
      const: true,
      default: true,
    },
    include_summary: {
      type: "boolean",
      const: true,
      default: true,
    },
  },
} as const;

export type HeuristicSigningModelInput = {
  model_id: typeof BASELINE_SIGNING_MODEL_ID;
  model_version: typeof BASELINE_SIGNING_MODEL_VERSION;
};

export type HeuristicSpotRepricingInput = {
  pricing_model: "BLACK_SCHOLES_GAMMA";
  model_version: typeof BLACK_SCHOLES_GAMMA_MODEL_VERSION;
  annualized_risk_free_rate: DecimalInput;
  annualized_dividend_yield: DecimalInput;
  minimum_years_to_expiration: DecimalInput;
  spot_range: {
    minimum: DecimalInput;
    maximum: DecimalInput;
    step: DecimalInput;
    root_tolerance: DecimalInput;
  };
};

export type HeuristicSignedGexInput = {
  snapshot_request: LiveOptionSnapshotInput;
  phase: "REGRESSION_RESEARCH";
  signing_model: HeuristicSigningModelInput;
  spot_repricing?: HeuristicSpotRepricingInput;
};

export const HEURISTIC_SIGNED_GEX_INPUT_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        snapshot_request:
          HEURISTIC_SNAPSHOT_REQUEST_SCHEMA,
        phase: {
          type: "string",
          const: "REGRESSION_RESEARCH",
        },
        signing_model: {
          type: "object",
          properties: {
            model_id: {
              type: "string",
              const: BASELINE_SIGNING_MODEL_ID,
            },
            model_version: {
              type: "string",
              const: BASELINE_SIGNING_MODEL_VERSION,
            },
          },
          required: ["model_id", "model_version"],
          additionalProperties: false,
        },
        spot_repricing: {
          type: "object",
          properties: {
            pricing_model: {
              type: "string",
              const: "BLACK_SCHOLES_GAMMA",
            },
            model_version: {
              type: "string",
              const: BLACK_SCHOLES_GAMMA_MODEL_VERSION,
            },
            annualized_risk_free_rate: SIGNED_DECIMAL_SCHEMA,
            annualized_dividend_yield: SIGNED_DECIMAL_SCHEMA,
            minimum_years_to_expiration: POSITIVE_DECIMAL_SCHEMA,
            spot_range: {
              type: "object",
              properties: {
                minimum: POSITIVE_DECIMAL_SCHEMA,
                maximum: POSITIVE_DECIMAL_SCHEMA,
                step: POSITIVE_DECIMAL_SCHEMA,
                root_tolerance: POSITIVE_DECIMAL_SCHEMA,
              },
              required: [
                "minimum",
                "maximum",
                "step",
                "root_tolerance",
              ],
              additionalProperties: false,
            },
          },
          required: [
            "pricing_model",
            "model_version",
            "annualized_risk_free_rate",
            "annualized_dividend_yield",
            "minimum_years_to_expiration",
            "spot_range",
          ],
          additionalProperties: false,
        },
      },
      required: ["snapshot_request", "phase", "signing_model"],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

type SigningRule = {
  option_type: "CALL" | "PUT";
  assigned_sign: "-1" | "1";
  assumption: string;
};

type NormalizedSpotRepricing = {
  pricingModel: "BLACK_SCHOLES_GAMMA";
  modelVersion: typeof BLACK_SCHOLES_GAMMA_MODEL_VERSION;
  annualizedRiskFreeRate: string;
  annualizedDividendYield: string;
  minimumYearsToExpiration: string;
  spotMinimum: string;
  spotMaximum: string;
  spotStep: string;
  rootTolerance: string;
  scenarioSpots: string[];
};

type NormalizedHeuristicSignedGexInput = {
  snapshotRequest: LiveOptionSnapshotInput;
  phase: "REGRESSION_RESEARCH";
  signingModel: HeuristicSigningModelInput;
  spotRepricing: NormalizedSpotRepricing | null;
};

export type HeuristicSignedGexGroup = {
  key: string;
  signed_gex: string;
  absolute_gex: string;
  contract_count: number;
  absolute_share_of_total: string;
};

type SignedGexCompleteness = {
  total_contracts: number;
  eligible_contracts: number;
  excluded_contracts: number;
  missing_gamma: number;
  missing_open_interest: number;
  missing_multiplier: number;
  cohort_alignment_not_confirmed: number;
  oi_freshness_not_confirmed: number;
  greeks_freshness_not_confirmed: number;
  missing_implied_volatility: number;
  missing_dte: number;
  coverage_ratio: string;
};

type SignedGexAggregation = {
  spot: string;
  total_signed_gex: string;
  total_absolute_gex: string;
  sign_regime: "POSITIVE" | "NEGATIVE" | "FLAT";
  by_strike: HeuristicSignedGexGroup[];
  by_expiration: HeuristicSignedGexGroup[];
  by_option_type: HeuristicSignedGexGroup[];
  by_dte_bucket: HeuristicSignedGexGroup[];
  top_signed_concentration_strikes: HeuristicSignedGexGroup[];
};

type SignedGexScenario = {
  spot: string;
  total_signed_gex: string;
  total_absolute_gex: string;
  sign_regime: "POSITIVE" | "NEGATIVE" | "FLAT";
};

export type HeuristicSignedGexResult = {
  contract_version: typeof HEURISTIC_SIGNED_GEX_CONTRACT_VERSION;
  result_id: string;
  status: "AVAILABLE" | "PARTIAL" | "NOT_COMPUTABLE";
  gamma_evidence_scope: "HEURISTIC_SIGNED_MODEL";
  methodology: typeof HEURISTIC_SIGNED_GEX_METHODOLOGY;
  phase: "REGRESSION_RESEARCH";
  evidence_role: "RESEARCH_ONLY";
  research_only: true;
  production_gate_eligible: false;
  snapshot: {
    request_id: string;
    snapshot_id: string;
    contract_version: string;
    provider: "tastytrade-dxlink";
    underlying: "SPX" | "SPXW";
    current_spot_value: string;
    as_of: string;
    snapshot_complete: boolean;
    level_2_unsigned_methodology: string;
    level_2_unsigned_methodology_version: string;
    level_2_unsigned_status: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  };
  source_snapshot: LiveOptionSnapshotResult;
  signing_model: {
    model_id: typeof BASELINE_SIGNING_MODEL_ID;
    model_version: typeof BASELINE_SIGNING_MODEL_VERSION;
    model_hash: string;
    hypothesis: string;
    rules: [SigningRule, SigningRule];
  };
  heuristic_signed_gex: {
    status: "AVAILABLE" | "PARTIAL" | "NOT_COMPUTABLE";
    methodology: typeof CURRENT_GAMMA_SIGNED_GEX_METHODOLOGY;
    approximation: "SNAPSHOT_GAMMA_AT_CURRENT_SPOT";
    formula: string;
    aggregation: SignedGexAggregation | null;
    data_completeness: SignedGexCompleteness;
    warnings: string[];
  };
  spot_repriced_signed_gex: {
    status:
      | "AVAILABLE"
      | "PARTIAL"
      | "NOT_REQUESTED"
      | "NOT_COMPUTABLE";
    methodology: typeof SPOT_REPRICED_SIGNED_GEX_METHODOLOGY;
    pricing_model: "BLACK_SCHOLES_GAMMA";
    model_version: typeof BLACK_SCHOLES_GAMMA_MODEL_VERSION;
    gamma_rounding_significant_digits: 15;
    gex_rounding_decimal_places: 6;
    assumptions: {
      annualized_risk_free_rate: string | null;
      annualized_dividend_yield: string | null;
      time_to_expiration_method:
        "SNAPSHOT_DTE_DIVIDED_BY_365_WITH_CALLER_MINIMUM";
      minimum_years_to_expiration: string | null;
      no_extrapolation: true;
    };
    current_spot_reconciliation: {
      snapshot_gamma_total_signed_gex: string | null;
      repriced_total_signed_gex: string | null;
      repriced_to_snapshot_ratio: string | null;
      signed_gex_difference: string | null;
    };
    current_spot_aggregation: SignedGexAggregation | null;
    scenarios: Array<SignedGexScenario & {
      eligible_contracts: number;
    }>;
    data_completeness: SignedGexCompleteness;
    warnings: string[];
  };
  heuristic_gamma_flip: {
    status:
      | "AVAILABLE"
      | "NOT_FOUND_IN_RANGE"
      | "PARTIAL"
      | "NOT_COMPUTABLE";
    level: string | null;
    candidate_levels: string[];
    crossing_count: number;
    model_id: typeof BASELINE_SIGNING_MODEL_ID;
    model_version: typeof BASELINE_SIGNING_MODEL_VERSION;
    method:
      | "BOUNDED_GRID_BRACKET_BISECTION"
      | "NOT_COMPUTED";
    spot_range: {
      minimum: string;
      maximum: string;
      step: string;
      root_tolerance: string;
    } | null;
    current_spot_distance: string | null;
    current_spot_distance_percent: string | null;
    confidence: "UNKNOWN";
    evidence_role: "RESEARCH_ONLY";
    production_gate_eligible: false;
    reason: string | null;
  };
  semantic_boundaries: [
    "HEURISTIC_SIGNED_GEX_IS_NOT_DEALER_GEX",
    "HEURISTIC_GAMMA_FLIP_IS_NOT_OBSERVED_DEALER_ZERO_GAMMA",
    "OPEN_INTEREST_DOES_NOT_IDENTIFY_PARTICIPANT_SIDE",
    "AGGRESSOR_SIDE_DOES_NOT_IDENTIFY_DEALER_OR_CUSTOMER",
    "OPTION_FLOW_DOES_NOT_ESTABLISH_DEALER_INVENTORY",
  ];
  regression_record: {
    record_type: "HEURISTIC_SIGNED_GEX";
    record_version: typeof HEURISTIC_SIGNED_GEX_CONTRACT_VERSION;
    result_id: string;
    snapshot_id: string;
    model_id: typeof BASELINE_SIGNING_MODEL_ID;
    model_version: typeof BASELINE_SIGNING_MODEL_VERSION;
    model_hash: string;
    as_of: string;
  };
  warnings: string[];
};

export type LiveOptionSnapshotService = {
  getLiveOptionSnapshot(
    request: LiveOptionSnapshotInput,
  ): Promise<LiveOptionSnapshotResult>;
};

type SignedContribution = {
  contract: LiveOptionSnapshotContract;
  signedGex: ExactDecimal;
  absoluteGex: ExactDecimal;
};

type RepricedContract = {
  contract: LiveOptionSnapshotContract;
  assignedSign: -1 | 1;
  openInterest: ExactDecimal;
  multiplier: ExactDecimal;
  strike: number;
  annualizedVolatility: number;
  yearsToExpiration: number;
};

const SIGNING_RULES: [SigningRule, SigningRule] = [
  {
    option_type: "CALL",
    assigned_sign: "-1",
    assumption:
      "Research hypothesis: call open interest is assigned negative dealer gamma exposure.",
  },
  {
    option_type: "PUT",
    assigned_sign: "1",
    assumption:
      "Research hypothesis: put open interest is assigned positive dealer gamma exposure.",
  },
];

const SIGNING_MODEL_DEFINITION = {
  model_id: BASELINE_SIGNING_MODEL_ID,
  model_version: BASELINE_SIGNING_MODEL_VERSION,
  hypothesis:
    "Calls are assigned negative sign and puts are assigned positive sign solely as a research hypothesis.",
  rules: SIGNING_RULES,
  formula:
    "assigned_sign * abs(gamma) * open_interest * multiplier * spot^2 * 0.01",
  evidence_role: "RESEARCH_ONLY",
  production_gate_eligible: false,
} as const;

function stableId(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

function decimalInRange(
  value: DecimalInput,
  field: string,
  minimum: string,
  maximum: string,
): string {
  const normalized = ExactDecimal.parse(value, field);
  if (
    normalized.compare(ExactDecimal.parse(minimum)) < 0 ||
    normalized.compare(ExactDecimal.parse(maximum)) > 0
  ) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return normalized.toString();
}

function positiveDecimal(
  value: DecimalInput,
  field: string,
  maximum = "1000000",
): string {
  const normalized = ExactDecimal.parse(value, field);
  if (
    normalized.compare(ZERO) <= 0 ||
    normalized.compare(ExactDecimal.parse(maximum)) > 0
  ) {
    throw new Error(`${field} must be positive and no greater than ${maximum}.`);
  }
  return normalized.toString();
}

function buildScenarioSpots(
  minimumValue: string,
  maximumValue: string,
  stepValue: string,
): string[] {
  const minimum = ExactDecimal.parse(minimumValue);
  const maximum = ExactDecimal.parse(maximumValue);
  const step = ExactDecimal.parse(stepValue);
  if (minimum.compare(maximum) >= 0) {
    throw new Error("spot_repricing.spot_range.minimum must be less than maximum.");
  }
  const spots: string[] = [];
  let current = minimum;
  while (current.compare(maximum) <= 0) {
    spots.push(current.toString());
    if (spots.length > MAX_SPOT_SCENARIOS) {
      throw new Error(
        `spot_repricing.spot_range produces more than ${MAX_SPOT_SCENARIOS} scenarios.`,
      );
    }
    current = current.add(step);
  }
  if (spots.at(-1) !== maximum.toString()) {
    spots.push(maximum.toString());
  }
  if (spots.length > MAX_SPOT_SCENARIOS) {
    throw new Error(
      `spot_repricing.spot_range produces more than ${MAX_SPOT_SCENARIOS} scenarios.`,
    );
  }
  return spots;
}

function normalizeInput(
  input: HeuristicSignedGexInput,
): NormalizedHeuristicSignedGexInput {
  if (input.phase !== "REGRESSION_RESEARCH") {
    throw new Error("phase must be REGRESSION_RESEARCH.");
  }
  if (
    input.signing_model?.model_id !== BASELINE_SIGNING_MODEL_ID ||
    input.signing_model?.model_version !== BASELINE_SIGNING_MODEL_VERSION
  ) {
    throw new Error(
      `signing_model must be ${BASELINE_SIGNING_MODEL_ID}/${BASELINE_SIGNING_MODEL_VERSION}.`,
    );
  }
  if (!input.snapshot_request) {
    throw new Error("snapshot_request is required.");
  }
  if (input.snapshot_request.include_greeks === false) {
    throw new Error("snapshot_request.include_greeks must not be false.");
  }
  if (input.snapshot_request.include_summary === false) {
    throw new Error("snapshot_request.include_summary must not be false.");
  }

  let spotRepricing: NormalizedSpotRepricing | null = null;
  if (input.spot_repricing) {
    if (
      input.spot_repricing.pricing_model !== "BLACK_SCHOLES_GAMMA" ||
      input.spot_repricing.model_version !==
        BLACK_SCHOLES_GAMMA_MODEL_VERSION
    ) {
      throw new Error(
        `spot_repricing must use BLACK_SCHOLES_GAMMA/${BLACK_SCHOLES_GAMMA_MODEL_VERSION}.`,
      );
    }
    const annualizedRiskFreeRate = decimalInRange(
      input.spot_repricing.annualized_risk_free_rate,
      "spot_repricing.annualized_risk_free_rate",
      "-1",
      "1",
    );
    const annualizedDividendYield = decimalInRange(
      input.spot_repricing.annualized_dividend_yield,
      "spot_repricing.annualized_dividend_yield",
      "-1",
      "1",
    );
    const minimumYearsToExpiration = positiveDecimal(
      input.spot_repricing.minimum_years_to_expiration,
      "spot_repricing.minimum_years_to_expiration",
      "1",
    );
    const spotMinimum = positiveDecimal(
      input.spot_repricing.spot_range.minimum,
      "spot_repricing.spot_range.minimum",
    );
    const spotMaximum = positiveDecimal(
      input.spot_repricing.spot_range.maximum,
      "spot_repricing.spot_range.maximum",
    );
    const spotStep = positiveDecimal(
      input.spot_repricing.spot_range.step,
      "spot_repricing.spot_range.step",
    );
    const rootTolerance = positiveDecimal(
      input.spot_repricing.spot_range.root_tolerance,
      "spot_repricing.spot_range.root_tolerance",
    );
    if (
      ExactDecimal.parse(rootTolerance).compare(
        ExactDecimal.parse(spotStep),
      ) > 0
    ) {
      throw new Error(
        "spot_repricing.spot_range.root_tolerance must not exceed step.",
      );
    }
    spotRepricing = {
      pricingModel: "BLACK_SCHOLES_GAMMA",
      modelVersion: BLACK_SCHOLES_GAMMA_MODEL_VERSION,
      annualizedRiskFreeRate,
      annualizedDividendYield,
      minimumYearsToExpiration,
      spotMinimum,
      spotMaximum,
      spotStep,
      rootTolerance,
      scenarioSpots: buildScenarioSpots(
        spotMinimum,
        spotMaximum,
        spotStep,
      ),
    };
  }
  return {
    snapshotRequest: input.snapshot_request,
    phase: input.phase,
    signingModel: input.signing_model,
    spotRepricing,
  };
}

function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return "0";
  return ExactDecimal.parse(String(numerator))
    .divide(ExactDecimal.parse(String(denominator)))
    .toString();
}

function absoluteShare(value: ExactDecimal, total: ExactDecimal): string {
  return total.isZero() ? "0" : value.divide(total).toString();
}

function assignedSign(contract: LiveOptionSnapshotContract): -1 | 1 {
  return contract.option_type === "CALL" ? -1 : 1;
}

function dteBucket(dte: number | null): string {
  if (dte === null) return "UNKNOWN";
  if (dte === 0) return "0_DTE";
  if (dte <= 7) return "1_TO_7_DTE";
  if (dte <= 30) return "8_TO_30_DTE";
  if (dte <= 60) return "31_TO_60_DTE";
  return "61_PLUS_DTE";
}

function signRegime(
  value: ExactDecimal,
): "POSITIVE" | "NEGATIVE" | "FLAT" {
  const comparison = value.compare(ZERO);
  return comparison > 0 ? "POSITIVE" : comparison < 0 ? "NEGATIVE" : "FLAT";
}

function numberFromDecimal(value: string, field: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${field} must be representable as a finite number.`);
  }
  return numeric;
}

function roundedModelDecimal(value: number, field: string): ExactDecimal {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} produced a non-finite value.`);
  }
  return ExactDecimal.parse(value.toPrecision(15), field);
}

function roundedGex(value: ExactDecimal): string {
  return value
    .divide(ExactDecimal.parse("1"), GEX_OUTPUT_DECIMAL_PLACES)
    .toString();
}

function roundToIncrement(
  value: ExactDecimal,
  increment: ExactDecimal,
): ExactDecimal {
  const lower = value.floorToIncrement(increment);
  const upper = value.ceilToIncrement(increment);
  return value.subtract(lower).compare(upper.subtract(value)) <= 0
    ? lower
    : upper;
}

function contributionValue(
  assigned: -1 | 1,
  gamma: ExactDecimal,
  openInterest: ExactDecimal,
  multiplier: ExactDecimal,
  spot: ExactDecimal,
): ExactDecimal {
  const unsigned = gamma
    .abs()
    .multiply(openInterest)
    .multiply(multiplier)
    .multiply(spot)
    .multiply(spot)
    .multiply(GEX_FACTOR);
  return assigned === -1 ? unsigned.negate() : unsigned;
}

function baseCompleteness(
  contracts: LiveOptionSnapshotContract[],
): SignedGexCompleteness {
  return {
    total_contracts: contracts.length,
    eligible_contracts: 0,
    excluded_contracts: contracts.length,
    missing_gamma: 0,
    missing_open_interest: 0,
    missing_multiplier: 0,
    cohort_alignment_not_confirmed: 0,
    oi_freshness_not_confirmed: 0,
    greeks_freshness_not_confirmed: 0,
    missing_implied_volatility: 0,
    missing_dte: 0,
    coverage_ratio: "0",
  };
}

function currentGammaContributions(
  contracts: LiveOptionSnapshotContract[],
  spot: ExactDecimal,
): {
  contributions: SignedContribution[];
  completeness: SignedGexCompleteness;
} {
  const completeness = baseCompleteness(contracts);
  const contributions: SignedContribution[] = [];
  for (const contract of contracts) {
    let excluded = false;
    if (contract.greeks?.gamma === null || !contract.greeks) {
      completeness.missing_gamma += 1;
      excluded = true;
    }
    if (contract.summary?.open_interest === null || !contract.summary) {
      completeness.missing_open_interest += 1;
      excluded = true;
    }
    if (contract.multiplier === null) {
      completeness.missing_multiplier += 1;
      excluded = true;
    }
    if (contract.cohort_alignment.status !== "CONFIRMED") {
      completeness.cohort_alignment_not_confirmed += 1;
      excluded = true;
    }
    if (contract.oi_freshness.status !== "CONFIRMED") {
      completeness.oi_freshness_not_confirmed += 1;
      excluded = true;
    }
    if (contract.greeks_freshness.status !== "CONFIRMED") {
      completeness.greeks_freshness_not_confirmed += 1;
      excluded = true;
    }
    if (excluded) continue;
    const signedGex = contributionValue(
      assignedSign(contract),
      ExactDecimal.parse(contract.greeks!.gamma!),
      ExactDecimal.parse(contract.summary!.open_interest!),
      ExactDecimal.parse(contract.multiplier!),
      spot,
    );
    contributions.push({
      contract,
      signedGex,
      absoluteGex: signedGex.abs(),
    });
  }
  completeness.eligible_contracts = contributions.length;
  completeness.excluded_contracts =
    contracts.length - contributions.length;
  completeness.coverage_ratio = ratio(
    contributions.length,
    contracts.length,
  );
  return { contributions, completeness };
}

function repricedContracts(
  contracts: LiveOptionSnapshotContract[],
  input: NormalizedSpotRepricing,
): {
  contracts: RepricedContract[];
  completeness: SignedGexCompleteness;
} {
  const completeness = baseCompleteness(contracts);
  const eligible: RepricedContract[] = [];
  const minimumYears = numberFromDecimal(
    input.minimumYearsToExpiration,
    "spot_repricing.minimum_years_to_expiration",
  );
  for (const contract of contracts) {
    let excluded = false;
    if (contract.summary?.open_interest === null || !contract.summary) {
      completeness.missing_open_interest += 1;
      excluded = true;
    }
    if (contract.multiplier === null) {
      completeness.missing_multiplier += 1;
      excluded = true;
    }
    if (
      contract.greeks?.implied_volatility === null ||
      !contract.greeks ||
      Number(contract.greeks.implied_volatility) <= 0
    ) {
      completeness.missing_implied_volatility += 1;
      excluded = true;
    }
    if (contract.dte === null) {
      completeness.missing_dte += 1;
      excluded = true;
    }
    if (contract.cohort_alignment.status !== "CONFIRMED") {
      completeness.cohort_alignment_not_confirmed += 1;
      excluded = true;
    }
    if (contract.oi_freshness.status !== "CONFIRMED") {
      completeness.oi_freshness_not_confirmed += 1;
      excluded = true;
    }
    if (contract.greeks_freshness.status !== "CONFIRMED") {
      completeness.greeks_freshness_not_confirmed += 1;
      excluded = true;
    }
    if (excluded) continue;
    eligible.push({
      contract,
      assignedSign: assignedSign(contract),
      openInterest: ExactDecimal.parse(
        contract.summary!.open_interest!,
      ),
      multiplier: ExactDecimal.parse(contract.multiplier!),
      strike: numberFromDecimal(contract.strike, "contract.strike"),
      annualizedVolatility: numberFromDecimal(
        contract.greeks!.implied_volatility!,
        "contract.greeks.implied_volatility",
      ),
      yearsToExpiration: Math.max(contract.dte! / 365, minimumYears),
    });
  }
  completeness.eligible_contracts = eligible.length;
  completeness.excluded_contracts = contracts.length - eligible.length;
  completeness.coverage_ratio = ratio(eligible.length, contracts.length);
  return { contracts: eligible, completeness };
}

function groupContributions(
  contributions: SignedContribution[],
  absoluteTotal: ExactDecimal,
  key: (contribution: SignedContribution) => string,
  compareKeys: (left: string, right: string) => number = (left, right) =>
    left.localeCompare(right),
): HeuristicSignedGexGroup[] {
  const groups = new Map<
    string,
    {
      signedGex: ExactDecimal;
      absoluteGex: ExactDecimal;
      contractCount: number;
    }
  >();
  for (const contribution of contributions) {
    const groupKey = key(contribution);
    const group = groups.get(groupKey) ?? {
      signedGex: ZERO,
      absoluteGex: ZERO,
      contractCount: 0,
    };
    group.signedGex = group.signedGex.add(contribution.signedGex);
    group.absoluteGex = group.absoluteGex.add(contribution.absoluteGex);
    group.contractCount += 1;
    groups.set(groupKey, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([groupKey, group]) => ({
      key: groupKey,
      signed_gex: roundedGex(group.signedGex),
      absolute_gex: roundedGex(group.absoluteGex),
      contract_count: group.contractCount,
      absolute_share_of_total: absoluteShare(
        group.absoluteGex,
        absoluteTotal,
      ),
    }));
}

function aggregateContributions(
  spot: string,
  contributions: SignedContribution[],
): SignedGexAggregation {
  const totalSigned = contributions.reduce(
    (sum, contribution) => sum.add(contribution.signedGex),
    ZERO,
  );
  const totalAbsolute = contributions.reduce(
    (sum, contribution) => sum.add(contribution.absoluteGex),
    ZERO,
  );
  const roundedTotalSigned = roundedGex(totalSigned);
  const roundedTotalAbsolute = roundedGex(totalAbsolute);
  const numericKeyComparison = (left: string, right: string) =>
    ExactDecimal.parse(left).compare(ExactDecimal.parse(right));
  const byStrike = groupContributions(
    contributions,
    totalAbsolute,
    (contribution) => contribution.contract.strike,
    numericKeyComparison,
  );
  return {
    spot,
    total_signed_gex: roundedTotalSigned,
    total_absolute_gex: roundedTotalAbsolute,
    sign_regime: signRegime(ExactDecimal.parse(roundedTotalSigned)),
    by_strike: byStrike,
    by_expiration: groupContributions(
      contributions,
      totalAbsolute,
      (contribution) => contribution.contract.expiration,
    ),
    by_option_type: groupContributions(
      contributions,
      totalAbsolute,
      (contribution) => contribution.contract.option_type,
    ),
    by_dte_bucket: groupContributions(
      contributions,
      totalAbsolute,
      (contribution) => dteBucket(contribution.contract.dte),
      (left, right) => {
        const order = [
          "0_DTE",
          "1_TO_7_DTE",
          "8_TO_30_DTE",
          "31_TO_60_DTE",
          "61_PLUS_DTE",
          "UNKNOWN",
        ];
        return order.indexOf(left) - order.indexOf(right);
      },
    ),
    top_signed_concentration_strikes: [...byStrike]
      .sort(
        (left, right) =>
          ExactDecimal.parse(right.absolute_gex).compare(
            ExactDecimal.parse(left.absolute_gex),
          ) || numericKeyComparison(left.key, right.key),
      )
      .slice(0, 10),
  };
}

function summarizeContributions(
  spot: string,
  contributions: SignedContribution[],
): SignedGexScenario {
  const totalSigned = contributions.reduce(
    (sum, contribution) => sum.add(contribution.signedGex),
    ZERO,
  );
  const totalAbsolute = contributions.reduce(
    (sum, contribution) => sum.add(contribution.absoluteGex),
    ZERO,
  );
  const roundedTotalSigned = roundedGex(totalSigned);
  return {
    spot,
    total_signed_gex: roundedTotalSigned,
    total_absolute_gex: roundedGex(totalAbsolute),
    sign_regime: signRegime(ExactDecimal.parse(roundedTotalSigned)),
  };
}

function completenessWarnings(
  completeness: SignedGexCompleteness,
  sourceComplete: boolean,
  repriced: boolean,
): string[] {
  const warnings: string[] = [];
  if (completeness.missing_gamma > 0) {
    warnings.push("MISSING_GAMMA_EXCLUDED");
  }
  if (completeness.missing_open_interest > 0) {
    warnings.push("MISSING_OPEN_INTEREST_EXCLUDED_NOT_ZERO_FILLED");
  }
  if (completeness.missing_multiplier > 0) {
    warnings.push("MISSING_MULTIPLIER_EXCLUDED");
  }
  if (completeness.cohort_alignment_not_confirmed > 0) {
    warnings.push("GAMMA_OI_COHORT_ALIGNMENT_NOT_CONFIRMED");
  }
  if (completeness.oi_freshness_not_confirmed > 0) {
    warnings.push("OI_FRESHNESS_NOT_CONFIRMED");
  }
  if (completeness.greeks_freshness_not_confirmed > 0) {
    warnings.push("GREEKS_FRESHNESS_NOT_CONFIRMED");
  }
  if (repriced && completeness.missing_implied_volatility > 0) {
    warnings.push("MISSING_OR_NON_POSITIVE_IMPLIED_VOLATILITY_EXCLUDED");
  }
  if (repriced && completeness.missing_dte > 0) {
    warnings.push("MISSING_DTE_EXCLUDED_FROM_SPOT_REPRICING");
  }
  if (!sourceComplete) warnings.push("SOURCE_SNAPSHOT_INCOMPLETE");
  return warnings;
}

function evaluateRepricedContracts(
  contracts: RepricedContract[],
  spotValue: string,
  input: NormalizedSpotRepricing,
): SignedContribution[] {
  const spot = ExactDecimal.parse(spotValue);
  const numericSpot = numberFromDecimal(spotValue, "spot");
  const rate = numberFromDecimal(
    input.annualizedRiskFreeRate,
    "spot_repricing.annualized_risk_free_rate",
  );
  const dividend = numberFromDecimal(
    input.annualizedDividendYield,
    "spot_repricing.annualized_dividend_yield",
  );
  return contracts.map((item) => {
    const gamma = roundedModelDecimal(
      blackScholesSpotGamma({
        spot: numericSpot,
        strike: item.strike,
        years_to_expiration: item.yearsToExpiration,
        annualized_volatility: item.annualizedVolatility,
        annualized_risk_free_rate: rate,
        annualized_dividend_yield: dividend,
      }),
      "black_scholes_gamma",
    );
    const signedGex = contributionValue(
      item.assignedSign,
      gamma,
      item.openInterest,
      item.multiplier,
      spot,
    );
    return {
      contract: item.contract,
      signedGex,
      absoluteGex: signedGex.abs(),
    };
  });
}

function bisectRoot(
  contracts: RepricedContract[],
  input: NormalizedSpotRepricing,
  leftSpot: string,
  rightSpot: string,
  leftValue: ExactDecimal,
): string | null {
  let left = numberFromDecimal(leftSpot, "left_spot");
  let right = numberFromDecimal(rightSpot, "right_spot");
  let leftSign = leftValue.compare(ZERO);
  const tolerance = numberFromDecimal(
    input.rootTolerance,
    "spot_repricing.spot_range.root_tolerance",
  );
  for (let iteration = 0; iteration < 100 && right - left > tolerance; iteration += 1) {
    const midpoint = (left + right) / 2;
    const midpointText = roundedModelDecimal(
      midpoint,
      "gamma_flip_midpoint",
    ).toString();
    const midpointContributions = evaluateRepricedContracts(
      contracts,
      midpointText,
      input,
    );
    const midpointValue = midpointContributions.reduce(
      (sum, contribution) => sum.add(contribution.signedGex),
      ZERO,
    );
    const midpointAbsolute = midpointContributions.reduce(
      (sum, contribution) => sum.add(contribution.absoluteGex),
      ZERO,
    );
    const midpointSign = midpointValue.compare(ZERO);
    if (midpointSign === 0) {
      return roundedGex(midpointAbsolute) === "0"
        ? null
        : roundToIncrement(
            ExactDecimal.parse(midpointText),
            ExactDecimal.parse(input.rootTolerance),
          ).toString();
    }
    if (midpointSign === leftSign) {
      left = midpoint;
      leftSign = midpointSign;
    } else {
      right = midpoint;
    }
  }
  return roundToIncrement(
    roundedModelDecimal((left + right) / 2, "gamma_flip_level"),
    ExactDecimal.parse(input.rootTolerance),
  ).toString();
}

function gammaFlipResult(
  repriced: NormalizedSpotRepricing | null,
  repricedContractsValue: RepricedContract[],
  scenarioAggregations: SignedGexScenario[],
  completeness: SignedGexCompleteness,
  sourceComplete: boolean,
  currentSpot: string,
): HeuristicSignedGexResult["heuristic_gamma_flip"] {
  const base = {
    model_id: BASELINE_SIGNING_MODEL_ID,
    model_version: BASELINE_SIGNING_MODEL_VERSION,
    confidence: "UNKNOWN" as const,
    evidence_role: "RESEARCH_ONLY" as const,
    production_gate_eligible: false as const,
  } as const;
  if (!repriced) {
    return {
      ...base,
      status: "NOT_COMPUTABLE",
      level: null,
      candidate_levels: [],
      crossing_count: 0,
      method: "NOT_COMPUTED",
      spot_range: null,
      current_spot_distance: null,
      current_spot_distance_percent: null,
      reason: "SPOT_REPRICING_NOT_REQUESTED",
    };
  }
  const spotRange = {
    minimum: repriced.spotMinimum,
    maximum: repriced.spotMaximum,
    step: repriced.spotStep,
    root_tolerance: repriced.rootTolerance,
  };
  if (repricedContractsValue.length === 0) {
    return {
      ...base,
      status: "NOT_COMPUTABLE",
      level: null,
      candidate_levels: [],
      crossing_count: 0,
      method: "NOT_COMPUTED",
      spot_range: spotRange,
      current_spot_distance: null,
      current_spot_distance_percent: null,
      reason: "NO_ELIGIBLE_REPRICED_CONTRACTS",
    };
  }
  if (
    scenarioAggregations.length > 0 &&
    scenarioAggregations.every(
      (scenario) => scenario.sign_regime === "FLAT",
    )
  ) {
    return {
      ...base,
      status: "NOT_COMPUTABLE",
      level: null,
      candidate_levels: [],
      crossing_count: 0,
      method: "NOT_COMPUTED",
      spot_range: spotRange,
      current_spot_distance: null,
      current_spot_distance_percent: null,
      reason: "SIGNED_GEX_IS_ZERO_ACROSS_REQUESTED_RANGE",
    };
  }

  const candidates: string[] = [];
  for (let index = 0; index < scenarioAggregations.length; ) {
    const current = scenarioAggregations[index];
    const currentValue = ExactDecimal.parse(current.total_signed_gex);
    if (currentValue.isZero()) {
      const zeroRunStart = index;
      let zeroRunEnd = index;
      while (
        zeroRunEnd + 1 < scenarioAggregations.length &&
        ExactDecimal.parse(
          scenarioAggregations[zeroRunEnd + 1].total_signed_gex,
        ).isZero()
      ) {
        zeroRunEnd += 1;
      }
      const zeroRunHasExposure = scenarioAggregations
        .slice(zeroRunStart, zeroRunEnd + 1)
        .some(
          (scenario) =>
            !ExactDecimal.parse(scenario.total_absolute_gex).isZero(),
        );
      const left =
        zeroRunStart > 0
          ? scenarioAggregations[zeroRunStart - 1]
          : null;
      const right =
        zeroRunEnd + 1 < scenarioAggregations.length
          ? scenarioAggregations[zeroRunEnd + 1]
          : null;
      if (
        zeroRunHasExposure &&
        left &&
        right &&
        ExactDecimal.parse(left.total_signed_gex).compare(ZERO) !==
          ExactDecimal.parse(right.total_signed_gex).compare(ZERO)
      ) {
        const midpoint = ExactDecimal.parse(
          scenarioAggregations[zeroRunStart].spot,
        )
          .add(
            ExactDecimal.parse(
              scenarioAggregations[zeroRunEnd].spot,
            ),
          )
          .half();
        candidates.push(
          roundToIncrement(
            midpoint,
            ExactDecimal.parse(repriced.rootTolerance),
          ).toString(),
        );
      }
      index = zeroRunEnd + 1;
      continue;
    }
    const next = scenarioAggregations[index + 1];
    if (!next) {
      index += 1;
      continue;
    }
    const nextValue = ExactDecimal.parse(next.total_signed_gex);
    if (
      nextValue.isZero() ||
      currentValue.compare(ZERO) === nextValue.compare(ZERO)
    ) {
      index += 1;
      continue;
    }
    const candidate = bisectRoot(
      repricedContractsValue,
      repriced,
      current.spot,
      next.spot,
      currentValue,
    );
    if (candidate !== null) candidates.push(candidate);
    index += 1;
  }
  const uniqueCandidates = candidates
    .filter((candidate, index) => candidates.indexOf(candidate) === index)
    .sort((left, right) =>
      ExactDecimal.parse(left).compare(ExactDecimal.parse(right)),
    );
  const coverageComplete =
    sourceComplete &&
    completeness.eligible_contracts === completeness.total_contracts;
  if (uniqueCandidates.length === 0) {
    return {
      ...base,
      status: coverageComplete ? "NOT_FOUND_IN_RANGE" : "PARTIAL",
      level: null,
      candidate_levels: [],
      crossing_count: 0,
      method: "BOUNDED_GRID_BRACKET_BISECTION",
      spot_range: spotRange,
      current_spot_distance: null,
      current_spot_distance_percent: null,
      reason:
        coverageComplete
          ? "NO_ZERO_CROSSING_IN_REQUESTED_RANGE"
          : "NO_ZERO_CROSSING_IN_PARTIAL_COHORT",
    };
  }
  const current = ExactDecimal.parse(currentSpot);
  const level = [...uniqueCandidates].sort((left, right) => {
    const distanceComparison = ExactDecimal.parse(left)
      .subtract(current)
      .abs()
      .compare(
        ExactDecimal.parse(right).subtract(current).abs(),
      );
    return (
      distanceComparison ||
      ExactDecimal.parse(left).compare(ExactDecimal.parse(right))
    );
  })[0];
  const distance = ExactDecimal.parse(level).subtract(current);
  return {
    ...base,
    status: coverageComplete ? "AVAILABLE" : "PARTIAL",
    level,
    candidate_levels: uniqueCandidates,
    crossing_count: uniqueCandidates.length,
    method: "BOUNDED_GRID_BRACKET_BISECTION",
    spot_range: spotRange,
    current_spot_distance: distance.toString(),
    current_spot_distance_percent: distance
      .divide(current)
      .multiply(ExactDecimal.parse("100"))
      .divide(ExactDecimal.parse("1"), 6)
      .toString(),
    reason:
      uniqueCandidates.length > 1
        ? "MULTIPLE_ZERO_CROSSINGS_NEAREST_CURRENT_SPOT_IS_PRIMARY"
        : null,
  };
}

export function computeHeuristicSignedGexFromSnapshot(
  snapshot: LiveOptionSnapshotResult,
  request: HeuristicSignedGexInput,
): HeuristicSignedGexResult {
  const input = normalizeInput(request);
  const currentSpot = ExactDecimal.parse(
    snapshot.underlying_price,
    "snapshot.underlying_price",
  );
  if (currentSpot.compare(ZERO) <= 0) {
    throw new Error("snapshot.underlying_price must be positive.");
  }
  if (
    input.spotRepricing &&
    (currentSpot.compare(
      ExactDecimal.parse(input.spotRepricing.spotMinimum),
    ) < 0 ||
      currentSpot.compare(
        ExactDecimal.parse(input.spotRepricing.spotMaximum),
      ) > 0)
  ) {
    throw new Error(
      "spot_repricing.spot_range must include snapshot.underlying_price.",
    );
  }
  const modelHash = stableId(SIGNING_MODEL_DEFINITION);
  const current = currentGammaContributions(
    snapshot.contracts,
    currentSpot,
  );
  const currentSourceComplete =
    snapshot.gamma_concentration_proxy.status === "COMPLETE";
  const currentWarnings = completenessWarnings(
    current.completeness,
    currentSourceComplete,
    false,
  );
  const currentStatus =
    current.contributions.length === 0
      ? "NOT_COMPUTABLE"
      : currentSourceComplete &&
          current.contributions.length === snapshot.contracts.length
        ? "AVAILABLE"
        : "PARTIAL";
  const currentAggregation =
    current.contributions.length === 0
      ? null
      : aggregateContributions(
          currentSpot.toString(),
          current.contributions,
        );

  let repricedStatus:
    | "AVAILABLE"
    | "PARTIAL"
    | "NOT_REQUESTED"
    | "NOT_COMPUTABLE" = "NOT_REQUESTED";
  let repricedCompleteness = baseCompleteness(snapshot.contracts);
  let repricedWarnings: string[] = [];
  let repricedCurrentAggregation: SignedGexAggregation | null = null;
  let repricedScenarios: SignedGexScenario[] = [];
  let repricedEligibleContracts: RepricedContract[] = [];
  let repricedSourceComplete = false;
  if (input.spotRepricing) {
    const prepared = repricedContracts(
      snapshot.contracts,
      input.spotRepricing,
    );
    repricedEligibleContracts = prepared.contracts;
    repricedCompleteness = prepared.completeness;
    repricedSourceComplete =
      snapshot.snapshot_complete &&
      snapshot.cohort_alignment.status === "CONFIRMED" &&
      snapshot.oi_freshness.status === "CONFIRMED" &&
      snapshot.greeks_freshness.status === "CONFIRMED";
    repricedWarnings = completenessWarnings(
      repricedCompleteness,
      repricedSourceComplete,
      true,
    );
    if (prepared.contracts.length === 0) {
      repricedStatus = "NOT_COMPUTABLE";
    } else {
      repricedStatus =
        repricedSourceComplete &&
        prepared.contracts.length === snapshot.contracts.length
          ? "AVAILABLE"
          : "PARTIAL";
      repricedCurrentAggregation = aggregateContributions(
        currentSpot.toString(),
        evaluateRepricedContracts(
          prepared.contracts,
          currentSpot.toString(),
          input.spotRepricing,
        ),
      );
      repricedScenarios = input.spotRepricing.scenarioSpots.map((spot) =>
        summarizeContributions(
          spot,
          evaluateRepricedContracts(
            prepared.contracts,
            spot,
            input.spotRepricing!,
          ),
        ),
      );
    }
  }

  const gammaFlip = gammaFlipResult(
    input.spotRepricing,
    repricedEligibleContracts,
    repricedScenarios,
    repricedCompleteness,
    repricedSourceComplete,
    currentSpot.toString(),
  );
  const zeroExposureScenarios = repricedScenarios.filter(
    (scenario) =>
      ExactDecimal.parse(scenario.total_absolute_gex).isZero(),
  ).length;
  const warnings = [
    "HEURISTIC_SIGNING_MODEL_DOES_NOT_OBSERVE_DEALER_INVENTORY",
    ...currentWarnings,
    ...repricedWarnings,
    ...(zeroExposureScenarios > 0
      ? ["SPOT_RANGE_CONTAINS_ZERO_EXPOSURE_REGION"]
      : []),
    ...(gammaFlip.crossing_count > 1
      ? ["MULTIPLE_HEURISTIC_GAMMA_FLIPS_FOUND"]
      : []),
  ].filter((warning, index, values) => values.indexOf(warning) === index);
  const resultIdentity = {
    snapshot_id: snapshot.snapshot_id,
    model_hash: modelHash,
    phase: input.phase,
    spot_repricing: input.spotRepricing
      ? {
          pricing_model: input.spotRepricing.pricingModel,
          model_version: input.spotRepricing.modelVersion,
          annualized_risk_free_rate:
            input.spotRepricing.annualizedRiskFreeRate,
          annualized_dividend_yield:
            input.spotRepricing.annualizedDividendYield,
          minimum_years_to_expiration:
            input.spotRepricing.minimumYearsToExpiration,
          spot_range: {
            minimum: input.spotRepricing.spotMinimum,
            maximum: input.spotRepricing.spotMaximum,
            step: input.spotRepricing.spotStep,
            root_tolerance: input.spotRepricing.rootTolerance,
          },
        }
      : null,
  };
  const resultId = stableId(resultIdentity);
  const resultStatus =
    currentStatus === "AVAILABLE"
      ? "AVAILABLE"
      : currentStatus === "PARTIAL" ||
          repricedStatus === "AVAILABLE" ||
          repricedStatus === "PARTIAL"
        ? "PARTIAL"
        : "NOT_COMPUTABLE";
  const snapshotGammaTotal =
    currentAggregation?.total_signed_gex ?? null;
  const repricedGammaTotal =
    repricedCurrentAggregation?.total_signed_gex ?? null;
  const repricedToSnapshotRatio =
    snapshotGammaTotal !== null &&
    repricedGammaTotal !== null &&
    !ExactDecimal.parse(snapshotGammaTotal).isZero()
      ? ExactDecimal.parse(repricedGammaTotal)
          .divide(ExactDecimal.parse(snapshotGammaTotal), 6)
          .toString()
      : null;
  const signedGexDifference =
    snapshotGammaTotal !== null && repricedGammaTotal !== null
      ? roundedGex(
          ExactDecimal.parse(repricedGammaTotal).subtract(
            ExactDecimal.parse(snapshotGammaTotal),
          ),
        )
      : null;
  return {
    contract_version: HEURISTIC_SIGNED_GEX_CONTRACT_VERSION,
    result_id: resultId,
    status: resultStatus,
    gamma_evidence_scope: "HEURISTIC_SIGNED_MODEL",
    methodology: HEURISTIC_SIGNED_GEX_METHODOLOGY,
    phase: "REGRESSION_RESEARCH",
    evidence_role: "RESEARCH_ONLY",
    research_only: true,
    production_gate_eligible: false,
    snapshot: {
      request_id: snapshot.request_id,
      snapshot_id: snapshot.snapshot_id,
      contract_version: snapshot.contract_version,
      provider: snapshot.provider,
      underlying: snapshot.underlying,
      current_spot_value: currentSpot.toString(),
      as_of: snapshot.retrieved_at,
      snapshot_complete: snapshot.snapshot_complete,
      level_2_unsigned_methodology:
        snapshot.gamma_concentration_proxy.methodology,
      level_2_unsigned_methodology_version:
        snapshot.gamma_concentration_proxy.methodology_version,
      level_2_unsigned_status:
        snapshot.gamma_concentration_proxy.status,
    },
    source_snapshot: snapshot,
    signing_model: {
      model_id: BASELINE_SIGNING_MODEL_ID,
      model_version: BASELINE_SIGNING_MODEL_VERSION,
      model_hash: modelHash,
      hypothesis: SIGNING_MODEL_DEFINITION.hypothesis,
      rules: SIGNING_RULES,
    },
    heuristic_signed_gex: {
      status: currentStatus,
      methodology: CURRENT_GAMMA_SIGNED_GEX_METHODOLOGY,
      approximation: "SNAPSHOT_GAMMA_AT_CURRENT_SPOT",
      formula:
        "assigned_sign * abs(snapshot_gamma) * open_interest * multiplier * current_spot^2 * 0.01",
      aggregation: currentAggregation,
      data_completeness: current.completeness,
      warnings: currentWarnings,
    },
    spot_repriced_signed_gex: {
      status: repricedStatus,
      methodology: SPOT_REPRICED_SIGNED_GEX_METHODOLOGY,
      pricing_model: "BLACK_SCHOLES_GAMMA",
      model_version: BLACK_SCHOLES_GAMMA_MODEL_VERSION,
      gamma_rounding_significant_digits: 15,
      gex_rounding_decimal_places: GEX_OUTPUT_DECIMAL_PLACES,
      assumptions: {
        annualized_risk_free_rate:
          input.spotRepricing?.annualizedRiskFreeRate ?? null,
        annualized_dividend_yield:
          input.spotRepricing?.annualizedDividendYield ?? null,
        time_to_expiration_method:
          "SNAPSHOT_DTE_DIVIDED_BY_365_WITH_CALLER_MINIMUM",
        minimum_years_to_expiration:
          input.spotRepricing?.minimumYearsToExpiration ?? null,
        no_extrapolation: true,
      },
      current_spot_reconciliation: {
        snapshot_gamma_total_signed_gex: snapshotGammaTotal,
        repriced_total_signed_gex: repricedGammaTotal,
        repriced_to_snapshot_ratio: repricedToSnapshotRatio,
        signed_gex_difference: signedGexDifference,
      },
      current_spot_aggregation: repricedCurrentAggregation,
      scenarios: repricedScenarios.map((scenario) => ({
        spot: scenario.spot,
        total_signed_gex: scenario.total_signed_gex,
        total_absolute_gex: scenario.total_absolute_gex,
        sign_regime: scenario.sign_regime,
        eligible_contracts:
          repricedCompleteness.eligible_contracts,
      })),
      data_completeness: repricedCompleteness,
      warnings: repricedWarnings,
    },
    heuristic_gamma_flip: gammaFlip,
    semantic_boundaries: [
      "HEURISTIC_SIGNED_GEX_IS_NOT_DEALER_GEX",
      "HEURISTIC_GAMMA_FLIP_IS_NOT_OBSERVED_DEALER_ZERO_GAMMA",
      "OPEN_INTEREST_DOES_NOT_IDENTIFY_PARTICIPANT_SIDE",
      "AGGRESSOR_SIDE_DOES_NOT_IDENTIFY_DEALER_OR_CUSTOMER",
      "OPTION_FLOW_DOES_NOT_ESTABLISH_DEALER_INVENTORY",
    ],
    regression_record: {
      record_type: "HEURISTIC_SIGNED_GEX",
      record_version: HEURISTIC_SIGNED_GEX_CONTRACT_VERSION,
      result_id: resultId,
      snapshot_id: snapshot.snapshot_id,
      model_id: BASELINE_SIGNING_MODEL_ID,
      model_version: BASELINE_SIGNING_MODEL_VERSION,
      model_hash: modelHash,
      as_of: snapshot.retrieved_at,
    },
    warnings,
  };
}

export async function computeLiveHeuristicSignedGex(
  liveOptions: LiveOptionSnapshotService,
  request: HeuristicSignedGexInput,
): Promise<HeuristicSignedGexResult> {
  const input = normalizeInput(request);
  const snapshot = await liveOptions.getLiveOptionSnapshot(
    input.snapshotRequest,
  );
  return computeHeuristicSignedGexFromSnapshot(snapshot, request);
}
