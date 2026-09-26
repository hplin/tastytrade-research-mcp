import { ExactDecimal } from "./decimal.js";
import { stableEvidenceContentId } from "./evidence-cache.js";
import {
  historicalExecutionProfileHash,
  historicalFeeModelHash,
  type HistoricalExecutionProfileInput,
  type HistoricalExecutionSimulationResult,
  type HistoricalExecutionSourceContract,
  type HistoricalFeeModelInput,
} from "./historical-execution-model.js";
import type {
  HistoricalExecutionInventoryLegInput,
} from "./historical-execution-evidence.js";
import type { SpreadFamily } from "./package-pricing.js";
import { normalizeRfc3339, resolveCheckpoint } from "./time.js";

export const HISTORICAL_REPLAY_CONTRACT_VERSION = "1.0.0" as const;

export type HistoricalReplayPolicyRole = "BASELINE" | "RESEARCH";
export type HistoricalReplayScenarioRole =
  | "OPTIMISTIC"
  | "BASELINE"
  | "STRESS"
  | "REFERENCE";
export type HistoricalReplayDataStatus =
  | "AVAILABLE"
  | "MISSING"
  | "REJECTED";
export type HistoricalReplayDecisionStatus =
  | "ACCEPTED"
  | "REJECTED"
  | "NOT_EVALUATED_MISSING_DATA";
export type HistoricalReplayRecordClass =
  | "SIMULATED_EXECUTION"
  | "VALUATION_ONLY"
  | "MISSING_EVIDENCE";

export type HistoricalReplayCandidateInput = {
  candidate_id: string;
  candidate_fingerprint: string;
  trade_date: string;
  family: SpreadFamily;
  exact_legs: HistoricalExecutionInventoryLegInput[];
  data_status: HistoricalReplayDataStatus;
  reason_codes: string[];
  scheduled_exits: Array<{
    horizon_id: string;
    scheduled_exit_at: string;
  }>;
};

export type HistoricalReplayPolicyInput = {
  role: HistoricalReplayPolicyRole;
  policy_id: string;
  policy_version:
    | "SPX-SPREAD-V1"
    | "DD_MILD_BACK_RICH_V1"
    | "DD_RELAXED_SURFACE_V1"
    | string;
  policy_hash: string;
  effect_scope:
    | "BASELINE"
    | "MILD_BACK_RICH_ONLY"
    | "BACK_RICH_AND_FALLING_IV";
  frozen_at: string;
  decisions: Array<{
    candidate_id: string;
    status: HistoricalReplayDecisionStatus;
    reason_codes: string[];
  }>;
};

export type HistoricalReplayScenarioInput = {
  scenario_id: string;
  role: HistoricalReplayScenarioRole;
  evidence_strength: "QUOTE_BACKED" | "REFERENCE_MODEL";
  source_contract: HistoricalExecutionSourceContract;
  execution_profile: HistoricalExecutionProfileInput;
  fee_model: HistoricalFeeModelInput | null;
};

export type HistoricalReplayExecutionRecordInput = {
  record_id: string;
  candidate_id: string;
  scenario_id: string;
  horizon_id: string;
  exact_symbols: string[];
  source_manifest_ids: string[];
  evidence_class: HistoricalReplayRecordClass;
  simulation: HistoricalExecutionSimulationResult | null;
  valuation_evidence_id: string | null;
  reason_codes: string[];
};

export type HistoricalReplayInput = {
  run_id: string;
  experiment_version: string;
  experiment_frozen_at: string;
  outcome_accessed_at: string;
  study_stage: "IN_SAMPLE" | "OUT_OF_SAMPLE";
  window: {
    start_date: string;
    end_date: string;
    checkpoint_local_time: string;
    timezone: string;
  };
  candidate_selection_source: "FROZEN_POLICY_OUTPUT";
  later_selector_fallback_used: false;
  candidate_construction_profile: {
    version: string;
    hash: string;
  };
  measurement_basis: {
    basis_id: string;
    version: string;
    hash: string;
  };
  horizon_policy: {
    policy_id: string;
    version: string;
    hash: string;
  };
  horizons: Array<{
    horizon_id: string;
    trading_days: 3 | 5 | number;
  }>;
  policies: HistoricalReplayPolicyInput[];
  scenarios: HistoricalReplayScenarioInput[];
  candidates: HistoricalReplayCandidateInput[];
  execution_records: HistoricalReplayExecutionRecordInput[];
};

export type HistoricalReplayMetricSummary = {
  closed_position_denominator: number;
  win_count: number;
  loss_count: number;
  breakeven_count: number;
  win_rate: string | null;
  expectancy: string | null;
  profit_factor: string | null;
  profit_factor_status:
    | "AVAILABLE"
    | "NO_LOSSES"
    | "NO_GAINS"
    | "NO_CLOSED_POSITIONS";
  independent_trade_pnl_sum: string | null;
};

export type HistoricalReplayGroup = {
  group_id: string;
  policy_id: string;
  policy_role: HistoricalReplayPolicyRole;
  policy_version: string;
  scenario_id: string;
  scenario_role: HistoricalReplayScenarioRole;
  profile_id: string;
  profile_version: string;
  profile_hash: string;
  fee_model_hash: string | null;
  horizon_id: string;
  trading_days: number;
  source_group_id: string;
  evidence_strength: "QUOTE_BACKED" | "REFERENCE_MODEL";
  accepted_candidate_count: number;
  record_count: number;
  simulated_filled_count: number;
  no_fill_count: number;
  not_assessable_count: number;
  open_exit_count: number;
  valuation_only_count: number;
  missing_evidence_count: number;
  closed_position_denominator: number;
  gross: HistoricalReplayMetricSummary;
  net: HistoricalReplayMetricSummary;
  drawdown: {
    metric: "CLOSE_SEQUENCE_DRAWDOWN";
    portfolio_mtm: false;
    gross: string | null;
    net: string | null;
  };
  account_return: null;
  account_return_reason:
    "CAPITAL_CONCURRENCY_SIZING_POLICY_NOT_PROVIDED";
};

export type HistoricalReplayResult = {
  contract_version: typeof HISTORICAL_REPLAY_CONTRACT_VERSION;
  replay_id: string;
  report_type: "HISTORICAL_REPLAY_ACCEPTANCE";
  status: "COMPLETE" | "PARTIAL" | "NOT_ASSESSABLE";
  complete_performance_acceptance: boolean;
  run_id: string;
  experiment_version: string;
  experiment_frozen_at: string;
  outcome_accessed_at: string;
  study_stage: "IN_SAMPLE" | "OUT_OF_SAMPLE";
  window: HistoricalReplayInput["window"];
  candidate_selection_source: "FROZEN_POLICY_OUTPUT";
  later_selector_fallback_used: false;
  candidate_construction_profile:
    HistoricalReplayInput["candidate_construction_profile"];
  measurement_basis: HistoricalReplayInput["measurement_basis"];
  horizon_policy: HistoricalReplayInput["horizon_policy"];
  horizons: HistoricalReplayInput["horizons"];
  policies: HistoricalReplayPolicyInput[];
  scenarios: Array<
    HistoricalReplayScenarioInput & {
      source_group_id: string;
    }
  >;
  candidates: HistoricalReplayCandidateInput[];
  execution_records: HistoricalReplayExecutionRecordInput[];
  policy_comparison: {
    baseline_policy_id: string;
    research_policy_id: string;
    common_candidate_ids: string[];
    added_by_research_candidate_ids: string[];
    removed_by_research_candidate_ids: string[];
    accepted_union_candidate_ids: string[];
  };
  groups: HistoricalReplayGroup[];
  missing_data: {
    total_candidate_count: number;
    available_candidate_count: number;
    missing_candidate_count: number;
    rejected_candidate_count: number;
    missing_or_rejected_candidate_count: number;
    missing_data_rate: string | null;
    missing_execution_record_count: number;
    valuation_only_record_count: number;
    not_assessable_simulation_count: number;
    open_exit_simulation_count: number;
  };
  execution_sensitivity: Array<{
    policy_id: string;
    policy_role: HistoricalReplayPolicyRole;
    horizon_id: string;
    source_group_id: string;
    evidence_strength: "QUOTE_BACKED" | "REFERENCE_MODEL";
    scenario_conclusions: Array<{
      scenario_id: string;
      scenario_role: HistoricalReplayScenarioRole;
      conclusion:
        | "POSITIVE_EXPECTANCY"
        | "NON_POSITIVE_EXPECTANCY"
        | "NO_CLOSED_POSITIONS";
    }>;
    execution_sensitive: boolean;
    selected_winner: null;
    grading_adjusted: false;
  }>;
  drawdown_label: "CLOSE_SEQUENCE_DRAWDOWN";
  portfolio_mtm_drawdown_available: false;
  account_return: null;
  account_return_reason:
    "CAPITAL_CONCURRENCY_SIZING_POLICY_NOT_PROVIDED";
  selected_winner: null;
  grading_adjusted: false;
  writes_forward_paper_state: false;
  writes_monthly_paper_file: false;
  warnings: string[];
};

type NormalizedCandidate = HistoricalReplayCandidateInput;
type NormalizedScenario = HistoricalReplayScenarioInput & {
  source_group_id: string;
};

const CONTENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INPUT_CONTENT_ID_SCHEMA = {
  type: "string",
  pattern: "^sha256:[a-f0-9]{64}$",
} as const;
const INPUT_STRING_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
} as const;
const INPUT_TIMESTAMP_SCHEMA = {
  type: "string",
  pattern:
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
} as const;
const INPUT_VERSIONED_HASH_SCHEMA = {
  type: "object",
  properties: {
    version: INPUT_STRING_SCHEMA,
    hash: INPUT_CONTENT_ID_SCHEMA,
  },
  required: ["version", "hash"],
  additionalProperties: false,
} as const;
const INPUT_RESOLUTION_SCHEMA = {
  type: "object",
  properties: {
    profile_id: INPUT_STRING_SCHEMA,
    profile_version: INPUT_STRING_SCHEMA,
    native_resolution: INPUT_STRING_SCHEMA,
    effective_resolution: INPUT_STRING_SCHEMA,
  },
  required: [
    "profile_id",
    "profile_version",
    "native_resolution",
    "effective_resolution",
  ],
  additionalProperties: false,
} as const;
const INPUT_SOURCE_CONTRACT_SCHEMA = {
  type: "object",
  properties: {
    provider_id: INPUT_STRING_SCHEMA,
    dataset_id: INPUT_STRING_SCHEMA,
    license_scope_id: INPUT_STRING_SCHEMA,
    resolution_profile: INPUT_RESOLUTION_SCHEMA,
    source_revision: INPUT_STRING_SCHEMA,
  },
  required: [
    "provider_id",
    "dataset_id",
    "license_scope_id",
    "resolution_profile",
    "source_revision",
  ],
  additionalProperties: false,
} as const;
const INPUT_PROFILE_SCHEMA = {
  type: "object",
  properties: {
    profile_id: INPUT_STRING_SCHEMA,
    profile_version: INPUT_STRING_SCHEMA,
    profile_hash: INPUT_CONTENT_ID_SCHEMA,
    model: {
      type: "string",
      enum: [
        "QUOTE_LIMIT_TOUCH",
        "QUOTE_CROSS",
        "QUOTE_PRICE_IMPROVEMENT",
        "REFERENCE_COST",
      ],
    },
    quote_source: {
      anyOf: [
        {
          type: "string",
          enum: ["NATIVE_PACKAGE", "ALIGNED_LEG_QUOTES"],
        },
        { type: "null" },
      ],
    },
    reference_type: {
      anyOf: [
        {
          type: "string",
          enum: [
            "TRADE_REFERENCE",
            "CANDLE_REFERENCE",
            "MODEL_REFERENCE",
          ],
        },
        { type: "null" },
      ],
    },
    latency_ms: { type: "integer", minimum: 0, maximum: 86400000 },
    minimum_package_size: {
      type: "integer",
      minimum: 1,
      maximum: 1000000,
    },
    tick_size: {
      anyOf: [{ type: "string" }, { type: "number" }],
    },
    midpoint_to_adverse_fraction: {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "null" },
      ],
    },
    additional_cost_per_package: {
      anyOf: [{ type: "string" }, { type: "number" }],
    },
    queue_model: { const: "NOT_MODELED" },
    market_impact_model: { const: "NOT_MODELED" },
    atomic_package: { const: true },
  },
  required: [
    "profile_id",
    "profile_version",
    "profile_hash",
    "model",
    "quote_source",
    "reference_type",
    "latency_ms",
    "minimum_package_size",
    "tick_size",
    "midpoint_to_adverse_fraction",
    "additional_cost_per_package",
    "queue_model",
    "market_impact_model",
    "atomic_package",
  ],
  additionalProperties: false,
} as const;
const INPUT_FEE_MODEL_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        fee_model_id: INPUT_STRING_SCHEMA,
        fee_model_version: INPUT_STRING_SCHEMA,
        fee_model_hash: INPUT_CONTENT_ID_SCHEMA,
        scope: { const: "PER_CONTRACT_PER_LEG_PER_SIDE" },
        amount_per_contract_per_leg_side: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
      required: [
        "fee_model_id",
        "fee_model_version",
        "fee_model_hash",
        "scope",
        "amount_per_contract_per_leg_side",
      ],
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

export const HISTORICAL_REPLAY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        run_id: INPUT_STRING_SCHEMA,
        experiment_version: INPUT_STRING_SCHEMA,
        experiment_frozen_at: INPUT_TIMESTAMP_SCHEMA,
        outcome_accessed_at: INPUT_TIMESTAMP_SCHEMA,
        study_stage: {
          type: "string",
          enum: ["IN_SAMPLE", "OUT_OF_SAMPLE"],
        },
        window: {
          type: "object",
          properties: {
            start_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            end_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            checkpoint_local_time: {
              const: "07:30",
            },
            timezone: { const: "America/Los_Angeles" },
          },
          required: [
            "start_date",
            "end_date",
            "checkpoint_local_time",
            "timezone",
          ],
          additionalProperties: false,
        },
        candidate_selection_source: {
          const: "FROZEN_POLICY_OUTPUT",
        },
        later_selector_fallback_used: { const: false },
        candidate_construction_profile:
          INPUT_VERSIONED_HASH_SCHEMA,
        measurement_basis: {
          type: "object",
          properties: {
            basis_id: INPUT_STRING_SCHEMA,
            version: INPUT_STRING_SCHEMA,
            hash: INPUT_CONTENT_ID_SCHEMA,
          },
          required: ["basis_id", "version", "hash"],
          additionalProperties: false,
        },
        horizon_policy: {
          type: "object",
          properties: {
            policy_id: INPUT_STRING_SCHEMA,
            version: INPUT_STRING_SCHEMA,
            hash: INPUT_CONTENT_ID_SCHEMA,
          },
          required: ["policy_id", "version", "hash"],
          additionalProperties: false,
        },
        horizons: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              horizon_id: INPUT_STRING_SCHEMA,
              trading_days: { type: "integer", enum: [3, 5] },
            },
            required: ["horizon_id", "trading_days"],
            additionalProperties: false,
          },
        },
        policies: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              role: {
                type: "string",
                enum: ["BASELINE", "RESEARCH"],
              },
              policy_id: INPUT_STRING_SCHEMA,
              policy_version: INPUT_STRING_SCHEMA,
              policy_hash: INPUT_CONTENT_ID_SCHEMA,
              effect_scope: {
                type: "string",
                enum: [
                  "BASELINE",
                  "MILD_BACK_RICH_ONLY",
                  "BACK_RICH_AND_FALLING_IV",
                ],
              },
              frozen_at: INPUT_TIMESTAMP_SCHEMA,
              decisions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    candidate_id: INPUT_STRING_SCHEMA,
                    status: {
                      type: "string",
                      enum: [
                        "ACCEPTED",
                        "REJECTED",
                        "NOT_EVALUATED_MISSING_DATA",
                      ],
                    },
                    reason_codes: {
                      type: "array",
                      items: INPUT_STRING_SCHEMA,
                    },
                  },
                  required: [
                    "candidate_id",
                    "status",
                    "reason_codes",
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: [
              "role",
              "policy_id",
              "policy_version",
              "policy_hash",
              "effect_scope",
              "frozen_at",
              "decisions",
            ],
            additionalProperties: false,
          },
        },
        scenarios: {
          type: "array",
          minItems: 3,
          items: {
            type: "object",
            properties: {
              scenario_id: INPUT_STRING_SCHEMA,
              role: {
                type: "string",
                enum: [
                  "OPTIMISTIC",
                  "BASELINE",
                  "STRESS",
                  "REFERENCE",
                ],
              },
              evidence_strength: {
                type: "string",
                enum: ["QUOTE_BACKED", "REFERENCE_MODEL"],
              },
              source_contract: INPUT_SOURCE_CONTRACT_SCHEMA,
              execution_profile: INPUT_PROFILE_SCHEMA,
              fee_model: INPUT_FEE_MODEL_SCHEMA,
            },
            required: [
              "scenario_id",
              "role",
              "evidence_strength",
              "source_contract",
              "execution_profile",
              "fee_model",
            ],
            additionalProperties: false,
          },
        },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              candidate_id: INPUT_STRING_SCHEMA,
              candidate_fingerprint: INPUT_STRING_SCHEMA,
              trade_date: {
                type: "string",
                pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              },
              family: {
                type: "string",
                enum: [
                  "DEBIT_VERTICAL",
                  "CREDIT_VERTICAL",
                  "IRON_CONDOR",
                  "DOUBLE_DIAGONAL",
                ],
              },
              exact_legs: {
                type: "array",
                minItems: 0,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    provider_symbol: INPUT_STRING_SCHEMA,
                    action: {
                      type: "string",
                      enum: ["BUY_TO_OPEN", "SELL_TO_OPEN"],
                    },
                    ratio: {
                      type: "integer",
                      minimum: 1,
                      maximum: 1000000,
                    },
                    expiration: {
                      type: "string",
                      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                    },
                    settlement: {
                      type: "string",
                      enum: ["AM", "PM"],
                    },
                    multiplier: {
                      anyOf: [
                        { type: "string" },
                        { type: "number" },
                      ],
                    },
                  },
                  required: [
                    "provider_symbol",
                    "action",
                    "ratio",
                    "expiration",
                    "settlement",
                    "multiplier",
                  ],
                  additionalProperties: false,
                },
              },
              data_status: {
                type: "string",
                enum: ["AVAILABLE", "MISSING", "REJECTED"],
              },
              reason_codes: {
                type: "array",
                items: INPUT_STRING_SCHEMA,
              },
              scheduled_exits: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    horizon_id: INPUT_STRING_SCHEMA,
                    scheduled_exit_at: INPUT_TIMESTAMP_SCHEMA,
                  },
                  required: ["horizon_id", "scheduled_exit_at"],
                  additionalProperties: false,
                },
              },
            },
            required: [
              "candidate_id",
              "candidate_fingerprint",
              "trade_date",
              "family",
              "exact_legs",
              "data_status",
              "reason_codes",
              "scheduled_exits",
            ],
            additionalProperties: false,
          },
        },
        execution_records: {
          type: "array",
          items: {
            type: "object",
            properties: {
              record_id: INPUT_CONTENT_ID_SCHEMA,
              candidate_id: INPUT_STRING_SCHEMA,
              scenario_id: INPUT_STRING_SCHEMA,
              horizon_id: INPUT_STRING_SCHEMA,
              exact_symbols: {
                type: "array",
                items: INPUT_STRING_SCHEMA,
              },
              source_manifest_ids: {
                type: "array",
                uniqueItems: true,
                items: INPUT_CONTENT_ID_SCHEMA,
              },
              evidence_class: {
                type: "string",
                enum: [
                  "SIMULATED_EXECUTION",
                  "VALUATION_ONLY",
                  "MISSING_EVIDENCE",
                ],
              },
              simulation: {
                anyOf: [
                  { type: "object" },
                  { type: "null" },
                ],
              },
              valuation_evidence_id: {
                anyOf: [
                  INPUT_CONTENT_ID_SCHEMA,
                  { type: "null" },
                ],
              },
              reason_codes: {
                type: "array",
                items: INPUT_STRING_SCHEMA,
              },
            },
            required: [
              "record_id",
              "candidate_id",
              "scenario_id",
              "horizon_id",
              "exact_symbols",
              "source_manifest_ids",
              "evidence_class",
              "simulation",
              "valuation_evidence_id",
              "reason_codes",
            ],
            additionalProperties: false,
          },
        },
      },
      required: [
        "run_id",
        "experiment_version",
        "experiment_frozen_at",
        "outcome_accessed_at",
        "study_stage",
        "window",
        "candidate_selection_source",
        "later_selector_fallback_used",
        "candidate_construction_profile",
        "measurement_basis",
        "horizon_policy",
        "horizons",
        "policies",
        "scenarios",
        "candidates",
        "execution_records",
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty.`);
  if (normalized.length > 200) {
    throw new Error(`${field} must be at most 200 characters.`);
  }
  return normalized;
}

function contentId(value: string, field: string): string {
  if (!CONTENT_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a sha256 content ID.`);
  }
  return value;
}

function date(value: string, field: string): string {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} must be a valid calendar date.`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  return normalizeRfc3339(value, field);
}

function stringArray(values: string[], field: string): string[] {
  return unique(
    values.map((value, index) =>
      nonEmpty(value, `${field}[${index}]`),
    ),
  );
}

function versionedHash(
  value: { version: string; hash: string },
  field: string,
): { version: string; hash: string } {
  return {
    version: nonEmpty(value.version, `${field}.version`),
    hash: contentId(value.hash, `${field}.hash`),
  };
}

function sourceContract(
  value: HistoricalExecutionSourceContract,
  field: string,
): HistoricalExecutionSourceContract {
  return {
    provider_id: nonEmpty(value.provider_id, `${field}.provider_id`),
    dataset_id: nonEmpty(value.dataset_id, `${field}.dataset_id`),
    license_scope_id: nonEmpty(
      value.license_scope_id,
      `${field}.license_scope_id`,
    ),
    resolution_profile: {
      profile_id: nonEmpty(
        value.resolution_profile.profile_id,
        `${field}.resolution_profile.profile_id`,
      ),
      profile_version: nonEmpty(
        value.resolution_profile.profile_version,
        `${field}.resolution_profile.profile_version`,
      ),
      native_resolution: nonEmpty(
        value.resolution_profile.native_resolution,
        `${field}.resolution_profile.native_resolution`,
      ),
      effective_resolution: nonEmpty(
        value.resolution_profile.effective_resolution,
        `${field}.resolution_profile.effective_resolution`,
      ),
    },
    source_revision: nonEmpty(
      value.source_revision,
      `${field}.source_revision`,
    ),
  };
}

export function historicalReplayRecordId(input: {
  candidate_id: string;
  scenario_id: string;
  horizon_id: string;
}): string {
  return stableEvidenceContentId({
    candidate_id: nonEmpty(input.candidate_id, "candidate_id"),
    scenario_id: nonEmpty(input.scenario_id, "scenario_id"),
    horizon_id: nonEmpty(input.horizon_id, "horizon_id"),
  });
}

function normalizeCandidate(
  input: HistoricalReplayCandidateInput,
  index: number,
  horizons: HistoricalReplayInput["horizons"],
  startDate: string,
  endDate: string,
  checkpointLocalTime: string,
  timezone: string,
): NormalizedCandidate {
  const field = `candidates[${index}]`;
  const candidateId = nonEmpty(input.candidate_id, `${field}.candidate_id`);
  const fingerprint = nonEmpty(
    input.candidate_fingerprint,
    `${field}.candidate_fingerprint`,
  );
  const tradeDate = date(input.trade_date, `${field}.trade_date`);
  if (
    input.data_status !== "AVAILABLE" &&
    input.data_status !== "MISSING" &&
    input.data_status !== "REJECTED"
  ) {
    throw new Error(
      `${field}.data_status must be AVAILABLE, MISSING, or REJECTED.`,
    );
  }
  const entryCheckpoint = resolveCheckpoint(
    undefined,
    {
      local_date: tradeDate,
      local_time: checkpointLocalTime,
      timezone,
    },
    `${field}.checkpoint`,
  ).instant;
  if (tradeDate < startDate || tradeDate > endDate) {
    throw new Error(`${field}.trade_date is outside the frozen window.`);
  }
  const expectedLegCount =
    input.family === "DEBIT_VERTICAL" ||
    input.family === "CREDIT_VERTICAL"
      ? 2
      : 4;
  if (
    input.data_status === "AVAILABLE" &&
    input.exact_legs.length !== expectedLegCount
  ) {
    throw new Error(
      `${field} AVAILABLE candidate requires ${expectedLegCount} exact legs.`,
    );
  }
  if (
    input.data_status !== "AVAILABLE" &&
    input.reason_codes.length === 0
  ) {
    throw new Error(
      `${field} missing/rejected candidate requires reason_codes.`,
    );
  }
  const symbols = input.exact_legs.map((leg) =>
    nonEmpty(leg.provider_symbol, `${field}.exact_legs.provider_symbol`),
  );
  if (new Set(symbols).size !== symbols.length) {
    throw new Error(`${field} contains duplicate exact leg symbols.`);
  }
  const scheduled = new Map<string, string>();
  const horizonIds = new Set(
    horizons.map((horizon) => horizon.horizon_id),
  );
  for (const [exitIndex, exit] of input.scheduled_exits.entries()) {
    const horizonId = nonEmpty(
      exit.horizon_id,
      `${field}.scheduled_exits[${exitIndex}].horizon_id`,
    );
    if (!horizonIds.has(horizonId)) {
      throw new Error(
        `${field} references unknown horizon ${horizonId}.`,
      );
    }
    if (scheduled.has(horizonId)) {
      throw new Error(
        `${field} contains duplicate scheduled exit for ${horizonId}.`,
      );
    }
    scheduled.set(
      horizonId,
      timestamp(
        exit.scheduled_exit_at,
        `${field}.scheduled_exits[${exitIndex}].scheduled_exit_at`,
      ),
    );
  }
  if ([...horizonIds].some((horizonId) => !scheduled.has(horizonId))) {
    throw new Error(
      `${field} must freeze every horizon exit.`,
    );
  }
  const orderedExits = [...horizons]
    .sort((left, right) => left.trading_days - right.trading_days)
    .map((horizon) => ({
      horizon,
      scheduled_exit_at: scheduled.get(horizon.horizon_id)!,
    }));
  for (const item of orderedExits) {
    if (
      Date.parse(item.scheduled_exit_at) <= Date.parse(entryCheckpoint)
    ) {
      throw new Error(
        `${field} ${item.horizon.horizon_id} exit must be after the entry checkpoint.`,
      );
    }
  }
  for (let orderedIndex = 1; orderedIndex < orderedExits.length; orderedIndex += 1) {
    if (
      Date.parse(orderedExits[orderedIndex].scheduled_exit_at) <=
      Date.parse(orderedExits[orderedIndex - 1].scheduled_exit_at)
    ) {
      throw new Error(
        `${field} scheduled exits must increase with trading_days.`,
      );
    }
  }
  const exactLegs = input.exact_legs.map((leg, legIndex) => {
    if (
      leg.action !== "BUY_TO_OPEN" &&
      leg.action !== "SELL_TO_OPEN"
    ) {
      throw new Error(
        `${field}.exact_legs[${legIndex}].action must be an opening action.`,
      );
    }
    if (!Number.isSafeInteger(leg.ratio) || leg.ratio <= 0) {
      throw new Error(
        `${field}.exact_legs[${legIndex}].ratio must be a positive integer.`,
      );
    }
    if (leg.settlement !== "AM" && leg.settlement !== "PM") {
      throw new Error(
        `${field}.exact_legs[${legIndex}].settlement must be AM or PM.`,
      );
    }
    const multiplier = ExactDecimal.parse(leg.multiplier);
    if (multiplier.compare(ExactDecimal.zero()) <= 0) {
      throw new Error(
        `${field}.exact_legs[${legIndex}].multiplier must be positive.`,
      );
    }
    return {
      provider_symbol: symbols[legIndex],
      action: leg.action,
      ratio: leg.ratio,
      expiration: date(
        leg.expiration,
        `${field}.exact_legs[${legIndex}].expiration`,
      ),
      settlement: leg.settlement,
      multiplier: multiplier.toString(),
    };
  });

  return {
    candidate_id: candidateId,
    candidate_fingerprint: fingerprint,
    trade_date: tradeDate,
    family: input.family,
    exact_legs: exactLegs,
    data_status: input.data_status,
    reason_codes: stringArray(input.reason_codes, `${field}.reason_codes`),
    scheduled_exits: [...scheduled]
      .map(([horizon_id, scheduled_exit_at]) => ({
        horizon_id,
        scheduled_exit_at,
      }))
      .sort((left, right) =>
        left.horizon_id.localeCompare(right.horizon_id),
      ),
  };
}

function normalizePolicy(
  input: HistoricalReplayPolicyInput,
  index: number,
  candidateIds: Set<string>,
  outcomeAccessedAt: string,
): HistoricalReplayPolicyInput {
  const field = `policies[${index}]`;
  if (input.role !== "BASELINE" && input.role !== "RESEARCH") {
    throw new Error(`${field}.role must be BASELINE or RESEARCH.`);
  }
  if (
    input.role === "BASELINE" &&
    input.policy_version !== "SPX-SPREAD-V1"
  ) {
    throw new Error(
      "The baseline policy_version must be SPX-SPREAD-V1.",
    );
  }
  if (
    input.policy_version === "DD_RELAXED_SURFACE_V1" &&
    input.effect_scope !== "BACK_RICH_AND_FALLING_IV"
  ) {
    throw new Error(
      "DD_RELAXED_SURFACE_V1 changes BACK_RICH and FALLING_IV and cannot be labeled mild-only.",
    );
  }
  if (
    input.policy_version === "DD_MILD_BACK_RICH_V1" &&
    input.effect_scope !== "MILD_BACK_RICH_ONLY"
  ) {
    throw new Error(
      "DD_MILD_BACK_RICH_V1 must use MILD_BACK_RICH_ONLY effect_scope.",
    );
  }
  if (
    input.role === "RESEARCH" &&
    input.policy_version !== "DD_MILD_BACK_RICH_V1"
  ) {
    throw new Error(
      "The V1 research policy_version must be DD_MILD_BACK_RICH_V1.",
    );
  }
  if (
    ![
      "BASELINE",
      "MILD_BACK_RICH_ONLY",
      "BACK_RICH_AND_FALLING_IV",
    ].includes(input.effect_scope)
  ) {
    throw new Error(`${field}.effect_scope is unsupported.`);
  }
  const frozenAt = timestamp(input.frozen_at, `${field}.frozen_at`);
  if (Date.parse(frozenAt) > Date.parse(outcomeAccessedAt)) {
    throw new Error(`${field}.frozen_at must precede outcome access.`);
  }
  const decisions = new Map<
    string,
    HistoricalReplayPolicyInput["decisions"][number]
  >();
  for (const [decisionIndex, decision] of input.decisions.entries()) {
    const candidateId = nonEmpty(
      decision.candidate_id,
      `${field}.decisions[${decisionIndex}].candidate_id`,
    );
    if (!candidateIds.has(candidateId)) {
      throw new Error(
        `${field} references unknown candidate ${candidateId}.`,
      );
    }
    if (decisions.has(candidateId)) {
      throw new Error(
        `${field} contains duplicate decision for ${candidateId}.`,
      );
    }
    decisions.set(candidateId, {
      candidate_id: candidateId,
      status: decision.status,
      reason_codes: stringArray(
        decision.reason_codes,
        `${field}.decisions[${decisionIndex}].reason_codes`,
      ),
    });
  }
  if (
    decisions.size !== candidateIds.size ||
    [...candidateIds].some((candidateId) => !decisions.has(candidateId))
  ) {
    throw new Error(
      `${field} must preserve a decision for every candidate.`,
    );
  }
  return {
    role: input.role,
    policy_id: nonEmpty(input.policy_id, `${field}.policy_id`),
    policy_version: nonEmpty(
      input.policy_version,
      `${field}.policy_version`,
    ),
    policy_hash: contentId(input.policy_hash, `${field}.policy_hash`),
    effect_scope: input.effect_scope,
    frozen_at: frozenAt,
    decisions: [...decisions.values()].sort((left, right) =>
      left.candidate_id.localeCompare(right.candidate_id),
    ),
  };
}

function normalizeScenario(
  input: HistoricalReplayScenarioInput,
  index: number,
): NormalizedScenario {
  const field = `scenarios[${index}]`;
  const profileHash = historicalExecutionProfileHash(
    input.execution_profile,
  );
  if (input.execution_profile.profile_hash !== profileHash) {
    throw new Error(`${field} execution profile hash does not match.`);
  }
  if (
    input.evidence_strength === "QUOTE_BACKED" &&
    input.execution_profile.model === "REFERENCE_COST"
  ) {
    throw new Error(
      `${field} REFERENCE_COST must use REFERENCE_MODEL evidence_strength.`,
    );
  }
  if (
    input.evidence_strength === "REFERENCE_MODEL" &&
    input.execution_profile.model !== "REFERENCE_COST"
  ) {
    throw new Error(
      `${field} REFERENCE_MODEL requires REFERENCE_COST.`,
    );
  }
  if (
    input.role === "REFERENCE" &&
    input.evidence_strength !== "REFERENCE_MODEL"
  ) {
    throw new Error(`${field} REFERENCE role must be a reference model.`);
  }
  if (
    input.role !== "REFERENCE" &&
    input.evidence_strength !== "QUOTE_BACKED"
  ) {
    throw new Error(`${field} core scenarios must be quote-backed.`    );
  }
  const expectedModel = {
    OPTIMISTIC: "QUOTE_PRICE_IMPROVEMENT",
    BASELINE: "QUOTE_PRICE_IMPROVEMENT",
    STRESS: "QUOTE_CROSS",
    REFERENCE: "REFERENCE_COST",
  }[input.role];
  if (input.execution_profile.model !== expectedModel) {
    throw new Error(
      `${field} ${input.role} scenario must use ${expectedModel}.`,
    );
  }
  if (
    input.role === "OPTIMISTIC" &&
    (ExactDecimal.parse(
      input.execution_profile.midpoint_to_adverse_fraction ?? "1",
    ).compare(ExactDecimal.zero()) !== 0 ||
      ExactDecimal.parse(
        input.execution_profile.additional_cost_per_package,
      ).compare(ExactDecimal.zero()) !== 0)
  ) {
    throw new Error(
      `${field} OPTIMISTIC scenario must use midpoint fraction 0 and zero additional cost.`,
    );
  }
  if (
    input.role === "BASELINE" &&
    ExactDecimal.parse(
      input.execution_profile.midpoint_to_adverse_fraction ?? "0",
    ).compare(ExactDecimal.zero()) === 0 &&
    ExactDecimal.parse(
      input.execution_profile.additional_cost_per_package,
    ).compare(ExactDecimal.zero()) === 0
  ) {
    throw new Error(
      `${field} BASELINE scenario must be more adverse than OPTIMISTIC.`,
    );
  }
  if (input.fee_model !== null) {
    const feeHash = historicalFeeModelHash(input.fee_model);
    if (input.fee_model.fee_model_hash !== feeHash) {
      throw new Error(`${field} fee model hash does not match.`);
    }
  }
  const normalizedSource = sourceContract(
    input.source_contract,
    `${field}.source_contract`,
  );
  const normalizedProfile: HistoricalExecutionProfileInput = {
    ...input.execution_profile,
    profile_id: nonEmpty(
      input.execution_profile.profile_id,
      `${field}.execution_profile.profile_id`,
    ),
    profile_version: nonEmpty(
      input.execution_profile.profile_version,
      `${field}.execution_profile.profile_version`,
    ),
    tick_size: ExactDecimal.parse(
      input.execution_profile.tick_size,
    ).toString(),
    midpoint_to_adverse_fraction:
      input.execution_profile.midpoint_to_adverse_fraction === null
        ? null
        : ExactDecimal.parse(
            input.execution_profile.midpoint_to_adverse_fraction,
          ).toString(),
    additional_cost_per_package: ExactDecimal.parse(
      input.execution_profile.additional_cost_per_package,
    ).toString(),
  };
  const normalizedFee: HistoricalFeeModelInput | null =
    input.fee_model === null
      ? null
      : {
          ...input.fee_model,
          fee_model_id: nonEmpty(
            input.fee_model.fee_model_id,
            `${field}.fee_model.fee_model_id`,
          ),
          fee_model_version: nonEmpty(
            input.fee_model.fee_model_version,
            `${field}.fee_model.fee_model_version`,
          ),
          amount_per_contract_per_leg_side: ExactDecimal.parse(
            input.fee_model.amount_per_contract_per_leg_side,
          ).toString(),
        };
  return {
    scenario_id: nonEmpty(
      input.scenario_id,
      `${field}.scenario_id`,
    ),
    role: input.role,
    evidence_strength: input.evidence_strength,
    source_contract: normalizedSource,
    execution_profile: normalizedProfile,
    fee_model: normalizedFee,
    source_group_id: stableEvidenceContentId({
      source_contract: normalizedSource,
      evidence_strength: input.evidence_strength,
    }),
  };
}

function verifySimulationId(
  simulation: HistoricalExecutionSimulationResult,
): void {
  const { simulation_id: simulationId, ...body } = simulation;
  if (stableEvidenceContentId(body) !== simulationId) {
    throw new Error("simulation_id does not match the simulation content.");
  }
}

function nullableDecimal(
  value: string | null,
  field: string,
): ExactDecimal | null {
  return value === null ? null : ExactDecimal.parse(value, field);
}

function verifySimulationArithmetic(
  simulation: HistoricalExecutionSimulationResult,
): void {
  if (
    simulation.contract_version !== "1.0.0" ||
    simulation.evidence_class !== "SIMULATED_EXECUTION" ||
    simulation.broker_fill_verified !== false ||
    simulation.mutates_live_event !== false ||
    simulation.mutates_source_evidence !== false
  ) {
    throw new Error(
      "Simulation does not satisfy the V1 execution-result constants.",
    );
  }
  if (!Number.isSafeInteger(simulation.quantity) || simulation.quantity <= 0) {
    throw new Error("Simulation quantity must be a positive integer.");
  }
  if (
    simulation.horizon.kind !== "FIXED_TRADING_DAYS" ||
    !Number.isSafeInteger(simulation.horizon.trading_days) ||
    simulation.horizon.trading_days <= 0
  ) {
    throw new Error(
      "Simulation horizon must be positive FIXED_TRADING_DAYS.",
    );
  }
  for (const [phaseName, phase] of [
    ["entry", simulation.entry],
    ["exit", simulation.exit],
  ] as const) {
    if (
      ![
        "SIMULATED_FILLED",
        "NO_FILL_UNDER_MODEL",
        "NOT_ASSESSABLE",
        "NOT_EVALUATED",
      ].includes(phase.status)
    ) {
      throw new Error(
        `Simulation ${phaseName} has an unsupported phase status.`,
      );
    }
    if (phase.phase !== phaseName.toUpperCase()) {
      throw new Error(`Simulation ${phaseName} phase is mislabeled.`);
    }
    if (Date.parse(phase.window_start) > Date.parse(phase.window_end)) {
      throw new Error(
        `Simulation ${phaseName} window_start must not exceed window_end.`,
      );
    }
    const filled = phase.status === "SIMULATED_FILLED";
    const limit = ExactDecimal.parse(phase.signed_limit);
    const tick = ExactDecimal.parse(
      simulation.execution_profile.tick_size,
    );
    if (limit.floorToIncrement(tick).compare(limit) !== 0) {
      throw new Error(
        `Simulation ${phaseName} signed_limit is not aligned to tick_size.`,
      );
    }
    if (
      filled !==
      (phase.fill_price !== null && phase.filled_at !== null)
    ) {
      throw new Error(
        `Simulation ${phaseName} fill fields do not match phase status.`,
      );
    }
    if (
      phase.filled_at !== null &&
      (Date.parse(phase.filled_at) < Date.parse(phase.window_start) ||
        Date.parse(phase.filled_at) > Date.parse(phase.window_end))
    ) {
      throw new Error(
        `Simulation ${phaseName} filled_at is outside its window.`,
      );
    }
    if (
      filled &&
      (phase.evidence_id === null ||
        phase.evidence_kind === null ||
        phase.first_touch_window === null)
    ) {
      throw new Error(
        `Simulation ${phaseName} fill requires selected evidence provenance.`,
      );
    }
    if (
      !filled &&
      (phase.evidence_id !== null ||
        phase.first_touch_window !== null)
    ) {
      throw new Error(
        `Simulation ${phaseName} non-fill cannot claim selected fill evidence.`,
      );
    }
    if (
      phase.status === "NO_FILL_UNDER_MODEL" &&
      phase.evidence_coverage !== "COMPLETE"
    ) {
      throw new Error(
        `Simulation ${phaseName} no-fill requires complete evidence coverage.`,
      );
    }
    if (
      phase.status === "NOT_EVALUATED" &&
      (phaseName !== "exit" ||
        phase.evidence_coverage !== "NONE" ||
        phase.selected_observation_count !== 0)
    ) {
      throw new Error(
        "Simulation NOT_EVALUATED is valid only for an untouched exit.",
      );
    }
    if (filled) {
      const fillPrice = ExactDecimal.parse(phase.fill_price!);
      if (
        (phaseName === "entry" && fillPrice.compare(limit) > 0) ||
        (phaseName === "exit" && fillPrice.compare(limit) < 0)
      ) {
        throw new Error(
          `Simulation ${phaseName} fill violates the frozen signed limit.`,
        );
      }
      if (
        fillPrice.floorToIncrement(tick).compare(fillPrice) !== 0
      ) {
        throw new Error(
          `Simulation ${phaseName} fill is not aligned to tick_size.`,
        );
      }
    }
  }
  if (
    simulation.pnl.formula !==
    "(signed_exit_receipt - signed_entry_cost) * multiplier * quantity"
  ) {
    throw new Error("Simulation P&L formula is unsupported.");
  }
  if (
    simulation.pnl.quantity !== simulation.quantity ||
    simulation.pnl.multiplier !==
      simulation.inventory[0]?.multiplier
  ) {
    throw new Error(
      "Simulation P&L quantity or multiplier does not match inventory.",
    );
  }
  const entryFilled =
    simulation.entry.status === "SIMULATED_FILLED";
  const exitFilled =
    simulation.exit.status === "SIMULATED_FILLED";
  if (
    simulation.pnl.signed_entry_cost !== simulation.entry.fill_price ||
    simulation.pnl.signed_exit_receipt !== simulation.exit.fill_price
  ) {
    throw new Error(
      "Simulation P&L fill prices do not match phase results.",
    );
  }
  const expectedStatus: HistoricalExecutionSimulationResult["status"] =
    simulation.entry.status === "NO_FILL_UNDER_MODEL"
      ? "NO_FILL_UNDER_MODEL"
      : !entryFilled
        ? "NOT_ASSESSABLE"
        : exitFilled
          ? "SIMULATED_FILLED"
          : "OPEN_EXIT_UNRESOLVED";
  if (simulation.status !== expectedStatus) {
    throw new Error(
      "Simulation status does not match entry and exit phase statuses.",
    );
  }
  if (
    simulation.entry.status !== "SIMULATED_FILLED" &&
    simulation.exit.status !== "NOT_EVALUATED"
  ) {
    throw new Error(
      "Simulation exit must remain NOT_EVALUATED when entry is not filled.",
    );
  }
  if (
    simulation.entry.status === "SIMULATED_FILLED" &&
    simulation.exit.status === "NOT_EVALUATED"
  ) {
    throw new Error(
      "Simulation filled entry requires an evaluated exit phase.",
    );
  }
  const expectedGross =
    entryFilled && exitFilled
      ? ExactDecimal.parse(simulation.exit.fill_price!)
          .subtract(
            ExactDecimal.parse(simulation.entry.fill_price!),
          )
          .multiply(ExactDecimal.parse(simulation.pnl.multiplier))
          .multiplyInteger(simulation.quantity)
      : null;
  if (
    (expectedGross?.toString() ?? null) !== simulation.pnl.gross_pnl
  ) {
    throw new Error("Simulation gross_pnl does not match fill arithmetic.");
  }
  if (simulation.fee_model === null) {
    if (
      simulation.pnl.entry_fees !== null ||
      simulation.pnl.exit_fees !== null ||
      simulation.pnl.total_fees !== null ||
      simulation.pnl.net_pnl !== null
    ) {
      throw new Error(
        "Simulation without a fee model must keep fee and net P&L fields null.",
      );
    }
    return;
  }
  const legUnits = simulation.inventory.reduce(
    (total, leg) => total + Math.abs(leg.inventory_quantity),
    0,
  );
  const perSide = ExactDecimal.parse(
    simulation.fee_model.amount_per_contract_per_leg_side,
  )
    .multiplyInteger(legUnits)
    .multiplyInteger(simulation.quantity);
  const expectedEntryFees = entryFilled
    ? perSide
    : ExactDecimal.zero();
  const expectedExitFees = exitFilled
    ? perSide
    : ExactDecimal.zero();
  const expectedTotalFees =
    expectedEntryFees.add(expectedExitFees);
  const expectedNet =
    expectedGross === null
      ? null
      : expectedGross.subtract(expectedTotalFees);
  for (const [field, expected, actual] of [
    ["entry_fees", expectedEntryFees, simulation.pnl.entry_fees],
    ["exit_fees", expectedExitFees, simulation.pnl.exit_fees],
    ["total_fees", expectedTotalFees, simulation.pnl.total_fees],
  ] as const) {
    const parsed = nullableDecimal(actual, `simulation.pnl.${field}`);
    if (parsed === null || parsed.compare(expected) !== 0) {
      throw new Error(`Simulation ${field} does not match fee arithmetic.`);
    }
  }
  if (
    (expectedNet?.toString() ?? null) !== simulation.pnl.net_pnl
  ) {
    throw new Error("Simulation net_pnl does not match fee arithmetic.");
  }
}

function normalizeRecord(
  input: HistoricalReplayExecutionRecordInput,
  candidate: NormalizedCandidate,
  scenario: NormalizedScenario,
  horizon: HistoricalReplayInput["horizons"][number],
  runId: string,
  studyStage: HistoricalReplayInput["study_stage"],
  experimentFrozenAt: string,
  outcomeAccessedAt: string,
  checkpointLocalTime: string,
  timezone: string,
  candidateProfile: HistoricalReplayInput["candidate_construction_profile"],
  measurementBasis: HistoricalReplayInput["measurement_basis"],
): HistoricalReplayExecutionRecordInput {
  if (
    input.evidence_class !== "SIMULATED_EXECUTION" &&
    input.evidence_class !== "VALUATION_ONLY" &&
    input.evidence_class !== "MISSING_EVIDENCE"
  ) {
    throw new Error(
      `Unsupported evidence_class: ${String(input.evidence_class)}.`,
    );
  }
  const expectedRecordId = historicalReplayRecordId({
    candidate_id: candidate.candidate_id,
    scenario_id: scenario.scenario_id,
    horizon_id: horizon.horizon_id,
  });
  if (input.record_id !== expectedRecordId) {
    throw new Error(
      `record_id does not match candidate/scenario/horizon identity for ${candidate.candidate_id}.`,
    );
  }
  const exactSymbols = input.exact_symbols.map((value, index) =>
    nonEmpty(value, `execution_records.exact_symbols[${index}]`),
  );
  const candidateSymbols = candidate.exact_legs.map(
    (leg) => leg.provider_symbol,
  );
  if (
    JSON.stringify(exactSymbols) !== JSON.stringify(candidateSymbols)
  ) {
    throw new Error(
      `Execution record exact symbols do not match ${candidate.candidate_id}.`,
    );
  }
  const manifests = input.source_manifest_ids.map((value, index) =>
    contentId(value, `execution_records.source_manifest_ids[${index}]`),
  );
  const scheduledExit = candidate.scheduled_exits.find(
    (item) => item.horizon_id === horizon.horizon_id,
  );
  if (!scheduledExit) {
    throw new Error(
      `Candidate ${candidate.candidate_id} has no ${horizon.horizon_id} exit.`,
    );
  }
  if (
    Date.parse(scheduledExit.scheduled_exit_at) >
    Date.parse(outcomeAccessedAt)
  ) {
    throw new Error(
      `Candidate ${candidate.candidate_id} scheduled exit is after outcome_accessed_at.`,
    );
  }

  if (input.evidence_class === "SIMULATED_EXECUTION") {
    if (input.simulation === null || input.valuation_evidence_id !== null) {
      throw new Error(
        "SIMULATED_EXECUTION records require simulation and no valuation_evidence_id.",
      );
    }
    verifySimulationId(input.simulation);
    const simulation = input.simulation;
    for (const [field, value] of [
      ["entry.window_end", simulation.entry.window_end],
      ["exit.window_end", simulation.exit.window_end],
      ["entry.filled_at", simulation.entry.filled_at],
      ["exit.filled_at", simulation.exit.filled_at],
    ] as const) {
      if (
        value !== null &&
        Date.parse(value) > Date.parse(outcomeAccessedAt)
      ) {
        throw new Error(
          `Simulation ${field} must not be after outcome_accessed_at.`,
        );
      }
    }
    if (input.source_manifest_ids.length === 0) {
      throw new Error(
        "SIMULATED_EXECUTION records require immutable source manifests.",
      );
    }
    if (
      simulation.run_id !== runId ||
      simulation.frozen_candidate_id !== candidate.candidate_id ||
      simulation.candidate_fingerprint !==
        candidate.candidate_fingerprint ||
      simulation.family !== candidate.family ||
      simulation.study_stage !== studyStage ||
      simulation.evidence_strength !== scenario.evidence_strength
    ) {
      throw new Error(
        `Simulation identity does not match replay record ${input.record_id}.`,
      );
    }
    if (
      simulation.prior_outcome_accessed &&
      studyStage !== "IN_SAMPLE"
    ) {
      throw new Error(
        "Simulations with prior outcome access must remain IN_SAMPLE.",
      );
    }
    const candidateCheckpoint = resolveCheckpoint(
      undefined,
      {
        local_date: candidate.trade_date,
        local_time: checkpointLocalTime,
        timezone,
      },
      `candidate ${candidate.candidate_id} checkpoint`,
    ).instant;
    if (simulation.entry.window_start !== candidateCheckpoint) {
      throw new Error(
        `Simulation entry window must start at the frozen checkpoint for ${candidate.candidate_id}.`,
      );
    }
    for (const [field, value] of [
      ["decision_frozen_at", simulation.decision_frozen_at],
      ["candidate_frozen_at", simulation.candidate_frozen_at],
      ["profile_frozen_at", simulation.profile_frozen_at],
    ] as const) {
      if (Date.parse(value) > Date.parse(experimentFrozenAt)) {
        throw new Error(
          `Simulation ${field} must not be after experiment_frozen_at.`,
        );
      }
    }
    if (
      simulation.outcome_accessed_at !== outcomeAccessedAt ||
      simulation.broker_fill_verified !== false ||
      simulation.mutates_live_event !== false ||
      simulation.mutates_source_evidence !== false
    ) {
      throw new Error(
        `Simulation ${simulation.simulation_id} violates replay provenance invariants.`,
      );
    }
    if (
      JSON.stringify(
        simulation.inventory.map((leg) => ({
          provider_symbol: leg.provider_symbol,
          action: leg.action,
          ratio: leg.ratio,
          inventory_quantity: leg.inventory_quantity,
          expiration: leg.expiration,
          settlement: leg.settlement,
          multiplier: leg.multiplier,
        })),
      ) !==
      JSON.stringify(
        candidate.exact_legs.map((leg) => ({
          provider_symbol: leg.provider_symbol,
          action: leg.action,
          ratio: leg.ratio,
          inventory_quantity:
            leg.action === "BUY_TO_OPEN" ? leg.ratio : -leg.ratio,
          expiration: leg.expiration,
          settlement: leg.settlement,
          multiplier: ExactDecimal.parse(leg.multiplier).toString(),
        })),
      )
    ) {
      throw new Error(
        `Simulation inventory does not match ${candidate.candidate_id}.`,
      );
    }
    const {
      profile_hash: simulationProfileHash,
      ...simulationProfileBody
    } = simulation.execution_profile;
    if (
      historicalExecutionProfileHash(simulationProfileBody) !==
        simulationProfileHash ||
      stableEvidenceContentId(simulation.execution_profile) !==
        stableEvidenceContentId(scenario.execution_profile) ||
      simulationProfileHash !==
        scenario.execution_profile.profile_hash ||
      simulation.execution_profile.profile_id !==
        scenario.execution_profile.profile_id ||
      simulation.execution_profile.profile_version !==
        scenario.execution_profile.profile_version
    ) {
      throw new Error(
        `Simulation profile does not match scenario ${scenario.scenario_id}.`,
      );
    }
    if (
      stableEvidenceContentId(simulation.source_contract) !==
      stableEvidenceContentId(scenario.source_contract)
    ) {
      throw new Error(
        `Simulation source does not match scenario ${scenario.scenario_id}.`,
      );
    }
    if (
      simulation.horizon.trading_days !== horizon.trading_days ||
      simulation.horizon.scheduled_exit_at !==
        scheduledExit.scheduled_exit_at
    ) {
      throw new Error(
        `Simulation horizon does not match ${horizon.horizon_id}.`,
      );
    }
    if (
      simulation.exit.status !== "NOT_EVALUATED" &&
      Date.parse(simulation.exit.window_end) <
        Date.parse(scheduledExit.scheduled_exit_at)
    ) {
      throw new Error(
        `Simulation exit window does not reach the frozen scheduled exit.`,
      );
    }
    if (
      simulation.exit.filled_at !== null &&
      Date.parse(simulation.exit.filled_at) <
        Date.parse(scheduledExit.scheduled_exit_at)
    ) {
      throw new Error(
        `Simulation exit fill precedes the frozen scheduled exit.`,
      );
    }
    if (
      simulation.exit.first_touch_window !== null &&
      (Date.parse(simulation.exit.first_touch_window.start) <
        Date.parse(scheduledExit.scheduled_exit_at) ||
        Date.parse(simulation.exit.first_touch_window.end) <
          Date.parse(scheduledExit.scheduled_exit_at))
    ) {
      throw new Error(
        `Simulation exit first-touch window precedes the frozen scheduled exit.`,
      );
    }
    if (
      stableEvidenceContentId(
        simulation.candidate_construction_profile,
      ) !== stableEvidenceContentId(candidateProfile) ||
      stableEvidenceContentId(simulation.measurement_basis) !==
        stableEvidenceContentId(measurementBasis)
    ) {
      throw new Error(
        `Simulation construction or measurement basis does not match the replay.`,
      );
    }
    const expectedFeeHash = scenario.fee_model?.fee_model_hash ?? null;
    if (simulation.fee_model !== null) {
      const {
        fee_model_hash: simulationFeeHash,
        ...simulationFeeBody
      } = simulation.fee_model;
      if (
        historicalFeeModelHash(simulationFeeBody) !==
        simulationFeeHash
      ) {
        throw new Error(
          `Simulation fee model hash does not match its content.`,
        );
      }
    }
    if (
      stableEvidenceContentId(simulation.fee_model) !==
        stableEvidenceContentId(scenario.fee_model) ||
      (simulation.fee_model?.fee_model_hash ?? null) !== expectedFeeHash
    ) {
      throw new Error(
        `Simulation fee model does not match scenario ${scenario.scenario_id}.`,
      );
    }
    verifySimulationArithmetic(simulation);
    if (
      !sameSet(manifests, simulation.source_manifest_ids)
    ) {
      throw new Error(
        `Record source_manifest_ids do not match simulation ${simulation.simulation_id}.`,
      );
    }
  } else {
    if (input.simulation !== null) {
      throw new Error(
        `${input.evidence_class} records cannot contain a simulation.`,
      );
    }
    if (
      input.evidence_class === "VALUATION_ONLY" &&
      input.valuation_evidence_id === null
    ) {
      throw new Error(
        "VALUATION_ONLY records require valuation_evidence_id.",
      );
    }
    if (
      input.evidence_class === "VALUATION_ONLY" &&
      scenario.role !== "REFERENCE"
    ) {
      throw new Error(
        "VALUATION_ONLY records must remain in a REFERENCE scenario.",
      );
    }
    if (
      input.evidence_class === "MISSING_EVIDENCE" &&
      input.valuation_evidence_id !== null
    ) {
      throw new Error(
        "MISSING_EVIDENCE records cannot contain valuation evidence.",
      );
    }
  }
  if (
    input.evidence_class !== "SIMULATED_EXECUTION" &&
    input.reason_codes.length === 0
  ) {
    throw new Error(
      `${input.evidence_class} records require reason_codes.`,
    );
  }
  return {
    record_id: input.record_id,
    candidate_id: candidate.candidate_id,
    scenario_id: scenario.scenario_id,
    horizon_id: horizon.horizon_id,
    exact_symbols: exactSymbols,
    source_manifest_ids: unique(manifests).sort(),
    evidence_class: input.evidence_class,
    simulation: input.simulation,
    valuation_evidence_id:
      input.valuation_evidence_id === null
        ? null
        : contentId(
            input.valuation_evidence_id,
            "valuation_evidence_id",
          ),
    reason_codes: stringArray(
      input.reason_codes,
      "execution_records.reason_codes",
    ),
  };
}

function sameSet(left: string[], right: string[]): boolean {
  const leftSet = unique(left).sort();
  const rightSet = unique(right).sort();
  return (
    leftSet.length === rightSet.length &&
    leftSet.every((value, index) => value === rightSet[index])
  );
}

function metricSummary(
  values: ExactDecimal[],
): HistoricalReplayMetricSummary {
  if (values.length === 0) {
    return {
      closed_position_denominator: 0,
      win_count: 0,
      loss_count: 0,
      breakeven_count: 0,
      win_rate: null,
      expectancy: null,
      profit_factor: null,
      profit_factor_status: "NO_CLOSED_POSITIONS",
      independent_trade_pnl_sum: null,
    };
  }
  const zero = ExactDecimal.zero();
  const wins = values.filter((value) => value.compare(zero) > 0);
  const losses = values.filter((value) => value.compare(zero) < 0);
  const breakeven = values.length - wins.length - losses.length;
  const sum = values.reduce(
    (total, value) => total.add(value),
    zero,
  );
  const gainSum = wins.reduce(
    (total, value) => total.add(value),
    zero,
  );
  const lossSum = losses
    .reduce((total, value) => total.add(value), zero)
    .abs();
  let profitFactor: string | null = null;
  let profitFactorStatus: HistoricalReplayMetricSummary["profit_factor_status"];
  if (losses.length === 0) {
    profitFactorStatus =
      wins.length === 0 ? "NO_GAINS" : "NO_LOSSES";
  } else if (wins.length === 0) {
    profitFactorStatus = "NO_GAINS";
    profitFactor = "0";
  } else {
    profitFactorStatus = "AVAILABLE";
    profitFactor = gainSum.divide(lossSum).toString();
  }
  return {
    closed_position_denominator: values.length,
    win_count: wins.length,
    loss_count: losses.length,
    breakeven_count: breakeven,
    win_rate: ExactDecimal.parse(wins.length.toString())
      .divide(ExactDecimal.parse(values.length.toString()))
      .toString(),
    expectancy: sum
      .divide(ExactDecimal.parse(values.length.toString()))
      .toString(),
    profit_factor: profitFactor,
    profit_factor_status: profitFactorStatus,
    independent_trade_pnl_sum: sum.toString(),
  };
}

function closeSequenceDrawdown(
  records: HistoricalReplayExecutionRecordInput[],
  field: "gross_pnl" | "net_pnl",
): string | null {
  const closed = records
    .filter(
      (record) =>
        record.simulation?.status === "SIMULATED_FILLED" &&
        record.simulation.pnl[field] !== null,
    )
    .sort((left, right) => {
      const time =
        Date.parse(left.simulation!.exit.filled_at!) -
        Date.parse(right.simulation!.exit.filled_at!);
      return time !== 0
        ? time
        : left.candidate_id.localeCompare(right.candidate_id);
    });
  if (closed.length === 0) return null;
  let cumulative = ExactDecimal.zero();
  let peak = ExactDecimal.zero();
  let maximum = ExactDecimal.zero();
  for (const record of closed) {
    cumulative = cumulative.add(
      ExactDecimal.parse(record.simulation!.pnl[field]!),
    );
    if (cumulative.compare(peak) > 0) peak = cumulative;
    const drawdown = peak.subtract(cumulative);
    if (drawdown.compare(maximum) > 0) maximum = drawdown;
  }
  return maximum.toString();
}

function buildGroup(
  policy: HistoricalReplayPolicyInput,
  scenario: NormalizedScenario,
  horizon: HistoricalReplayInput["horizons"][number],
  acceptedCandidateIds: string[],
  recordsByKey: Map<string, HistoricalReplayExecutionRecordInput>,
): HistoricalReplayGroup {
  const records = acceptedCandidateIds.map(
    (candidateId) =>
      recordsByKey.get(
        `${candidateId}\u0000${scenario.scenario_id}\u0000${horizon.horizon_id}`,
      )!,
  );
  const simulations = records
    .map((record) => record.simulation)
    .filter(
      (
        simulation,
      ): simulation is HistoricalExecutionSimulationResult =>
        simulation !== null,
    );
  const closed = simulations.filter(
    (simulation) => simulation.status === "SIMULATED_FILLED",
  );
  const grossValues = closed.map((simulation) =>
    ExactDecimal.parse(simulation.pnl.gross_pnl!),
  );
  const netValues = closed
    .filter((simulation) => simulation.pnl.net_pnl !== null)
    .map((simulation) =>
      ExactDecimal.parse(simulation.pnl.net_pnl!),
    );
  const body = {
    policy_id: policy.policy_id,
    policy_role: policy.role,
    policy_version: policy.policy_version,
    scenario_id: scenario.scenario_id,
    scenario_role: scenario.role,
    profile_id: scenario.execution_profile.profile_id,
    profile_version: scenario.execution_profile.profile_version,
    profile_hash: scenario.execution_profile.profile_hash,
    fee_model_hash: scenario.fee_model?.fee_model_hash ?? null,
    horizon_id: horizon.horizon_id,
    trading_days: horizon.trading_days,
    source_group_id: scenario.source_group_id,
    evidence_strength: scenario.evidence_strength,
    accepted_candidate_count: acceptedCandidateIds.length,
    record_count: records.length,
    simulated_filled_count: closed.length,
    no_fill_count: simulations.filter(
      (simulation) => simulation.status === "NO_FILL_UNDER_MODEL",
    ).length,
    not_assessable_count: simulations.filter(
      (simulation) => simulation.status === "NOT_ASSESSABLE",
    ).length,
    open_exit_count: simulations.filter(
      (simulation) => simulation.status === "OPEN_EXIT_UNRESOLVED",
    ).length,
    valuation_only_count: records.filter(
      (record) => record.evidence_class === "VALUATION_ONLY",
    ).length,
    missing_evidence_count: records.filter(
      (record) => record.evidence_class === "MISSING_EVIDENCE",
    ).length,
    closed_position_denominator: closed.length,
    gross: metricSummary(grossValues),
    net: metricSummary(netValues),
    drawdown: {
      metric: "CLOSE_SEQUENCE_DRAWDOWN" as const,
      portfolio_mtm: false as const,
      gross: closeSequenceDrawdown(records, "gross_pnl"),
      net: closeSequenceDrawdown(records, "net_pnl"),
    },
    account_return: null,
    account_return_reason:
      "CAPITAL_CONCURRENCY_SIZING_POLICY_NOT_PROVIDED" as const,
  };
  return {
    group_id: stableEvidenceContentId(body),
    ...body,
  };
}

function conclusion(
  group: HistoricalReplayGroup,
): "POSITIVE_EXPECTANCY" | "NON_POSITIVE_EXPECTANCY" | "NO_CLOSED_POSITIONS" {
  if (group.gross.expectancy === null) return "NO_CLOSED_POSITIONS";
  return ExactDecimal.parse(group.gross.expectancy).compare(
    ExactDecimal.zero(),
  ) > 0
    ? "POSITIVE_EXPECTANCY"
    : "NON_POSITIVE_EXPECTANCY";
}

export function buildHistoricalReplayReport(
  input: HistoricalReplayInput,
): HistoricalReplayResult {
  const runId = nonEmpty(input.run_id, "run_id");
  const experimentVersion = nonEmpty(
    input.experiment_version,
    "experiment_version",
  );
  const frozenAt = timestamp(
    input.experiment_frozen_at,
    "experiment_frozen_at",
  );
  const outcomeAccessedAt = timestamp(
    input.outcome_accessed_at,
    "outcome_accessed_at",
  );
  if (Date.parse(frozenAt) > Date.parse(outcomeAccessedAt)) {
    throw new Error(
      "experiment_frozen_at must not be after outcome_accessed_at.",
    );
  }
  if (
    input.study_stage !== "IN_SAMPLE" &&
    input.study_stage !== "OUT_OF_SAMPLE"
  ) {
    throw new Error(`Unsupported study_stage: ${String(input.study_stage)}.`);
  }
  const startDate = date(input.window.start_date, "window.start_date");
  const endDate = date(input.window.end_date, "window.end_date");
  if (endDate < startDate) {
    throw new Error("window.end_date must not precede start_date.");
  }
  if (input.window.checkpoint_local_time !== "07:30") {
    throw new Error(
      "V1 replay requires window.checkpoint_local_time=07:30.",
    );
  }
  const timezone = nonEmpty(input.window.timezone, "window.timezone");
  if (timezone !== "America/Los_Angeles") {
    throw new Error(
      "V1 replay requires window.timezone=America/Los_Angeles.",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
      new Date(0),
    );
  } catch {
    throw new Error("window.timezone must be a valid IANA timezone.");
  }
  if (input.candidate_selection_source !== "FROZEN_POLICY_OUTPUT") {
    throw new Error(
      "candidate_selection_source must be FROZEN_POLICY_OUTPUT.",
    );
  }
  if (input.later_selector_fallback_used !== false) {
    throw new Error("later_selector_fallback_used must remain false.");
  }
  const candidateProfile = versionedHash(
    input.candidate_construction_profile,
    "candidate_construction_profile",
  );
  const measurementBasis = {
    basis_id: nonEmpty(
      input.measurement_basis.basis_id,
      "measurement_basis.basis_id",
    ),
    ...versionedHash(input.measurement_basis, "measurement_basis"),
  };
  const horizonPolicy = {
    policy_id: nonEmpty(
      input.horizon_policy.policy_id,
      "horizon_policy.policy_id",
    ),
    ...versionedHash(input.horizon_policy, "horizon_policy"),
  };
  const horizons = input.horizons.map((horizon, index) => ({
    horizon_id: nonEmpty(
      horizon.horizon_id,
      `horizons[${index}].horizon_id`,
    ),
    trading_days: horizon.trading_days,
  }));
  if (
    horizons.length !== 2 ||
    new Set(horizons.map((horizon) => horizon.horizon_id)).size !== 2 ||
    !sameSet(
      horizons.map((horizon) => String(horizon.trading_days)),
      ["3", "5"],
    )
  ) {
    throw new Error(
      "V1 replay requires separate +3 and +5 trading-day horizons.",
    );
  }
  const horizonMap = new Map(
    horizons.map((horizon) => [horizon.horizon_id, horizon]),
  );
  const candidatesById = new Map<string, NormalizedCandidate>();
  for (const [index, candidateInput] of input.candidates.entries()) {
    const candidate = normalizeCandidate(
      candidateInput,
      index,
      horizons,
      startDate,
      endDate,
      input.window.checkpoint_local_time,
      timezone,
    );
    const existing = candidatesById.get(candidate.candidate_id);
    if (
      existing &&
      stableEvidenceContentId(existing) !==
        stableEvidenceContentId(candidate)
    ) {
      throw new Error(
        `Conflicting duplicate candidate_id: ${candidate.candidate_id}.`,
      );
    }
    if (!existing) candidatesById.set(candidate.candidate_id, candidate);
  }
  const candidates = [...candidatesById.values()].sort((left, right) =>
    left.candidate_id.localeCompare(right.candidate_id),
  );
  const candidateIds = new Set(candidatesById.keys());

  if (input.policies.length !== 2) {
    throw new Error("Replay requires one BASELINE and one RESEARCH policy.");
  }
  const policies = input.policies
    .map((policy, index) =>
      normalizePolicy(policy, index, candidateIds, outcomeAccessedAt),
    )
    .sort((left, right) => left.role.localeCompare(right.role));
  const roles = new Set(policies.map((policy) => policy.role));
  if (!roles.has("BASELINE") || !roles.has("RESEARCH")) {
    throw new Error("Replay requires one BASELINE and one RESEARCH policy.");
  }
  if (new Set(policies.map((policy) => policy.policy_id)).size !== 2) {
    throw new Error("Baseline and research policy IDs must be distinct.");
  }
  for (const policy of policies) {
    if (Date.parse(policy.frozen_at) > Date.parse(frozenAt)) {
      throw new Error(
        `Policy ${policy.policy_id} must be frozen by experiment_frozen_at.`,
      );
    }
  }
  for (const policy of policies) {
    for (const decision of policy.decisions) {
      const candidate = candidatesById.get(decision.candidate_id)!;
      if (
        candidate.data_status !== "AVAILABLE" &&
        decision.status !== "NOT_EVALUATED_MISSING_DATA"
      ) {
        throw new Error(
          `Policy ${policy.policy_id} cannot accept/reject missing candidate ${candidate.candidate_id}.`,
        );
      }
      if (
        candidate.data_status === "AVAILABLE" &&
        decision.status === "NOT_EVALUATED_MISSING_DATA"
      ) {
        throw new Error(
          `Available candidate ${candidate.candidate_id} requires an explicit policy decision.`,
        );
      }
    }
  }

  const scenarioMap = new Map<string, NormalizedScenario>();
  for (const [index, scenarioInput] of input.scenarios.entries()) {
    const scenario = normalizeScenario(scenarioInput, index);
    if (scenarioMap.has(scenario.scenario_id)) {
      throw new Error(
        `Duplicate scenario_id: ${scenario.scenario_id}.`,
      );
    }
    scenarioMap.set(scenario.scenario_id, scenario);
  }
  for (const role of ["OPTIMISTIC", "BASELINE", "STRESS"] as const) {
    if (
      [...scenarioMap.values()].filter(
        (scenario) => scenario.role === role,
      ).length !== 1
    ) {
      throw new Error(`Replay requires exactly one ${role} scenario.`);
    }
  }
  const scenarios = [...scenarioMap.values()].sort((left, right) =>
    left.scenario_id.localeCompare(right.scenario_id),
  );
  const coreScenarios = scenarios.filter(
    (scenario) => scenario.role !== "REFERENCE",
  );
  if (
    new Set(
      coreScenarios.map(
        (scenario) => scenario.execution_profile.profile_hash,
      ),
    ).size !== coreScenarios.length
  ) {
    throw new Error("Core scenarios must use distinct profile hashes.");
  }
  if (
    new Set(
      coreScenarios.map(
        (scenario) => scenario.execution_profile.quote_source,
      ),
    ).size !== 1
  ) {
    throw new Error("Core scenarios must use the same quote_source.");
  }
  if (
    new Set(
      coreScenarios.map((scenario) => scenario.source_group_id),
    ).size !== 1
  ) {
    throw new Error(
      "Core scenarios must use the same source contract and evidence strength.",
    );
  }
  const baseline = policies.find(
    (policy) => policy.role === "BASELINE",
  )!;
  const research = policies.find(
    (policy) => policy.role === "RESEARCH",
  )!;
  const accepted = (policy: HistoricalReplayPolicyInput) =>
    policy.decisions
      .filter((decision) => decision.status === "ACCEPTED")
      .map((decision) => decision.candidate_id)
      .sort();
  const baselineAccepted = accepted(baseline);
  const researchAccepted = accepted(research);
  const baselineSet = new Set(baselineAccepted);
  const researchSet = new Set(researchAccepted);
  const common = baselineAccepted.filter((id) => researchSet.has(id));
  const added = researchAccepted.filter((id) => !baselineSet.has(id));
  const removed = baselineAccepted.filter((id) => !researchSet.has(id));
  const acceptedUnion = unique([
    ...baselineAccepted,
    ...researchAccepted,
  ]).sort();
  for (const candidateId of acceptedUnion) {
    if (candidatesById.get(candidateId)?.data_status !== "AVAILABLE") {
      throw new Error(
        `Accepted candidate ${candidateId} does not have AVAILABLE data.`,
      );
    }
  }

  const rawRecordById = new Map<
    string,
    HistoricalReplayExecutionRecordInput
  >();
  for (const record of input.execution_records) {
    const existing = rawRecordById.get(record.record_id);
    if (
      existing &&
      stableEvidenceContentId(existing) !==
        stableEvidenceContentId(record)
    ) {
      throw new Error(
        `Conflicting duplicate record_id: ${record.record_id}.`,
      );
    }
    if (!existing) rawRecordById.set(record.record_id, record);
  }
  const rawRecords = [...rawRecordById.values()];
  const rawRecordByKey = new Map<
    string,
    HistoricalReplayExecutionRecordInput
  >();
  for (const record of rawRecords) {
    const key = `${record.candidate_id}\u0000${record.scenario_id}\u0000${record.horizon_id}`;
    if (rawRecordByKey.has(key)) {
      throw new Error(
        `Duplicate execution matrix cell: ${record.candidate_id}/${record.scenario_id}/${record.horizon_id}.`,
      );
    }
    rawRecordByKey.set(key, record);
  }
  for (const candidateId of acceptedUnion) {
    for (const horizon of horizons) {
      const coreRecords = ["OPTIMISTIC", "BASELINE", "STRESS"].map(
        (role) => {
          const scenario = scenarios.find(
            (item) => item.role === role,
          )!;
          return rawRecordByKey.get(
            `${candidateId}\u0000${scenario.scenario_id}\u0000${horizon.horizon_id}`,
          );
        },
      );
      if (coreRecords.some((record) => record === undefined)) {
        throw new Error(
          `Missing core execution matrix record for ${candidateId}/${horizon.horizon_id}.`,
        );
      }
      const manifestSets = coreRecords.map((record) =>
        unique(record!.source_manifest_ids).sort(),
      );
      if (
        manifestSets.some(
          (manifestIds) =>
            JSON.stringify(manifestIds) !==
            JSON.stringify(manifestSets[0]),
        )
      ) {
        throw new Error(
          `Candidate ${candidateId} core scenarios must use the same source manifests for ${horizon.horizon_id}.`,
        );
      }
    }
  }

  const recordsByKey = new Map<
    string,
    HistoricalReplayExecutionRecordInput
  >();
  for (const record of rawRecords) {
    const candidate = candidatesById.get(record.candidate_id);
    const scenario = scenarioMap.get(record.scenario_id);
    const horizon = horizonMap.get(record.horizon_id);
    if (!candidate || !scenario || !horizon) {
      throw new Error(
        `Execution record ${record.record_id} references unknown dimensions.`,
      );
    }
    if (!acceptedUnion.includes(candidate.candidate_id)) {
      throw new Error(
        `Execution record ${record.record_id} is outside the accepted candidate union.`,
      );
    }
    const normalized = normalizeRecord(
      record,
      candidate,
      scenario,
      horizon,
      runId,
      input.study_stage,
      frozenAt,
      outcomeAccessedAt,
      input.window.checkpoint_local_time,
      timezone,
      candidateProfile,
      measurementBasis,
    );
    recordsByKey.set(
      `${candidate.candidate_id}\u0000${scenario.scenario_id}\u0000${horizon.horizon_id}`,
      normalized,
    );
  }
  for (const candidateId of acceptedUnion) {
    for (const scenario of scenarios) {
      for (const horizon of horizons) {
        const key = `${candidateId}\u0000${scenario.scenario_id}\u0000${horizon.horizon_id}`;
        if (!recordsByKey.has(key)) {
          throw new Error(
            `Missing execution matrix record: ${candidateId}/${scenario.scenario_id}/${horizon.horizon_id}.`,
          );
        }
      }
    }
  }
  for (const candidateId of acceptedUnion) {
    for (const horizon of horizons) {
      const coreSimulations = coreScenarios
        .map(
          (scenario) =>
            recordsByKey.get(
              `${candidateId}\u0000${scenario.scenario_id}\u0000${horizon.horizon_id}`,
            )!.simulation,
        )
        .filter(
          (
            simulation,
          ): simulation is HistoricalExecutionSimulationResult =>
            simulation !== null,
        );
      const comparisonKeys = coreSimulations.map((simulation) =>
        stableEvidenceContentId({
          quantity: simulation.quantity,
          frozen_decision_id: simulation.frozen_decision_id,
          grading_profile: simulation.grading_profile,
          source_evidence_ids: simulation.source_evidence_ids,
          decision_frozen_at: simulation.decision_frozen_at,
          candidate_frozen_at: simulation.candidate_frozen_at,
          entry_order: {
            window_start: simulation.entry.window_start,
            window_end: simulation.entry.window_end,
            signed_limit: simulation.entry.signed_limit,
          },
          exit_order: {
            window_start: simulation.exit.window_start,
            window_end: simulation.exit.window_end,
            signed_limit: simulation.exit.signed_limit,
          },
        }),
      );
      if (new Set(comparisonKeys).size > 1) {
        throw new Error(
          `Candidate ${candidateId} core scenarios must use the same decision, quantity, and source evidence for ${horizon.horizon_id}.`,
        );
      }
    }
  }
  for (const candidateId of acceptedUnion) {
    const horizonEntryKeys = coreScenarios.flatMap((scenario) =>
      horizons.flatMap((horizon) => {
        const simulation = recordsByKey.get(
          `${candidateId}\u0000${scenario.scenario_id}\u0000${horizon.horizon_id}`,
        )!.simulation;
        if (simulation === null) return [];
        return [
          stableEvidenceContentId({
            quantity: simulation.quantity,
            frozen_decision_id: simulation.frozen_decision_id,
            grading_profile: simulation.grading_profile,
            candidate_construction_profile:
              simulation.candidate_construction_profile,
            measurement_basis: simulation.measurement_basis,
            source_evidence_entry:
              simulation.source_evidence_ids.entry,
            decision_frozen_at: simulation.decision_frozen_at,
            candidate_frozen_at: simulation.candidate_frozen_at,
            entry_order: {
              window_start: simulation.entry.window_start,
              window_end: simulation.entry.window_end,
              signed_limit: simulation.entry.signed_limit,
            },
          }),
        ];
      }),
    );
    if (new Set(horizonEntryKeys).size > 1) {
      throw new Error(
        `Candidate ${candidateId} horizons must share one frozen entry order and source evidence.`,
      );
    }
  }
  const records = [...recordsByKey.values()].sort((left, right) =>
    `${left.candidate_id}/${left.scenario_id}/${left.horizon_id}`.localeCompare(
      `${right.candidate_id}/${right.scenario_id}/${right.horizon_id}`,
    ),
  );

  const groups: HistoricalReplayGroup[] = [];
  for (const policy of policies) {
    const acceptedIds = accepted(policy);
    for (const scenario of scenarios) {
      for (const horizon of horizons) {
        groups.push(
          buildGroup(
            policy,
            scenario,
            horizon,
            acceptedIds,
            recordsByKey,
          ),
        );
      }
    }
  }
  groups.sort((left, right) =>
    `${left.policy_role}/${left.scenario_id}/${left.horizon_id}`.localeCompare(
      `${right.policy_role}/${right.scenario_id}/${right.horizon_id}`,
    ),
  );

  const sensitivity: HistoricalReplayResult["execution_sensitivity"] = [];
  for (const policy of policies) {
    for (const horizon of horizons) {
      const grouped = new Map<string, HistoricalReplayGroup[]>();
      for (const group of groups.filter(
        (item) =>
          item.policy_id === policy.policy_id &&
          item.horizon_id === horizon.horizon_id,
      )) {
        const key = `${group.source_group_id}\u0000${group.evidence_strength}`;
        grouped.set(key, [...(grouped.get(key) ?? []), group]);
      }
      for (const sourceGroups of grouped.values()) {
        const scenarioConclusions = sourceGroups
          .map((group) => ({
            scenario_id: group.scenario_id,
            scenario_role: group.scenario_role,
            conclusion: conclusion(group),
          }))
          .sort((left, right) =>
            left.scenario_id.localeCompare(right.scenario_id),
          );
        sensitivity.push({
          policy_id: policy.policy_id,
          policy_role: policy.role,
          horizon_id: horizon.horizon_id,
          source_group_id: sourceGroups[0].source_group_id,
          evidence_strength: sourceGroups[0].evidence_strength,
          scenario_conclusions: scenarioConclusions,
          execution_sensitive:
            new Set(
              scenarioConclusions.map((item) => item.conclusion),
            ).size > 1,
          selected_winner: null,
          grading_adjusted: false,
        });
      }
    }
  }
  sensitivity.sort((left, right) =>
    `${left.policy_role}/${left.horizon_id}/${left.source_group_id}`.localeCompare(
      `${right.policy_role}/${right.horizon_id}/${right.source_group_id}`,
    ),
  );

  const missingCandidates = candidates.filter(
    (candidate) => candidate.data_status === "MISSING",
  ).length;
  const rejectedCandidates = candidates.filter(
    (candidate) => candidate.data_status === "REJECTED",
  ).length;
  const unavailableCandidates = missingCandidates + rejectedCandidates;
  const missingData = {
    total_candidate_count: candidates.length,
    available_candidate_count: candidates.length - unavailableCandidates,
    missing_candidate_count: missingCandidates,
    rejected_candidate_count: rejectedCandidates,
    missing_or_rejected_candidate_count: unavailableCandidates,
    missing_data_rate:
      candidates.length === 0
        ? null
        : ExactDecimal.parse(unavailableCandidates.toString())
            .divide(ExactDecimal.parse(candidates.length.toString()))
            .toString(),
    missing_execution_record_count: records.filter(
      (record) => record.evidence_class === "MISSING_EVIDENCE",
    ).length,
    valuation_only_record_count: records.filter(
      (record) => record.evidence_class === "VALUATION_ONLY",
    ).length,
    not_assessable_simulation_count: records.filter(
      (record) =>
        record.simulation?.status === "NOT_ASSESSABLE",
    ).length,
    open_exit_simulation_count: records.filter(
      (record) =>
        record.simulation?.status === "OPEN_EXIT_UNRESOLVED",
    ).length,
  };
  const incomplete =
    unavailableCandidates > 0 ||
    missingData.missing_execution_record_count > 0 ||
    missingData.not_assessable_simulation_count > 0 ||
    missingData.open_exit_simulation_count > 0;
  const closedCount = records.filter(
    (record) =>
      record.simulation?.status === "SIMULATED_FILLED",
  ).length;
  const status: HistoricalReplayResult["status"] =
    closedCount === 0
      ? "NOT_ASSESSABLE"
      : incomplete
        ? "PARTIAL"
        : "COMPLETE";
  const warnings = [
    "EXECUTION_PROFILES_ARE_RESEARCH_ASSUMPTIONS_NOT_CALIBRATED_FILLS",
    "CLOSE_SEQUENCE_DRAWDOWN_IS_NOT_PORTFOLIO_MTM_DRAWDOWN",
    "ACCOUNT_RETURN_WITHHELD_WITHOUT_CAPITAL_CONCURRENCY_AND_SIZING_POLICY",
  ];
  if (sensitivity.some((item) => item.execution_sensitive)) {
    warnings.push("RESULTS_ARE_EXECUTION_SENSITIVE");
  }
  if (status !== "COMPLETE") {
    warnings.push("PARTIAL_RESULTS_ARE_NOT_COMPLETE_PERFORMANCE_ACCEPTANCE");
  }
  const body = {
    contract_version: HISTORICAL_REPLAY_CONTRACT_VERSION,
    report_type: "HISTORICAL_REPLAY_ACCEPTANCE" as const,
    status,
    complete_performance_acceptance: status === "COMPLETE",
    run_id: runId,
    experiment_version: experimentVersion,
    experiment_frozen_at: frozenAt,
    outcome_accessed_at: outcomeAccessedAt,
    study_stage: input.study_stage,
    window: {
      start_date: startDate,
      end_date: endDate,
      checkpoint_local_time: input.window.checkpoint_local_time,
      timezone,
    },
    candidate_selection_source: "FROZEN_POLICY_OUTPUT" as const,
    later_selector_fallback_used: false as const,
    candidate_construction_profile: candidateProfile,
    measurement_basis: measurementBasis,
    horizon_policy: horizonPolicy,
    horizons: horizons.sort((left, right) =>
      left.trading_days - right.trading_days,
    ),
    policies,
    scenarios,
    candidates,
    execution_records: records,
    policy_comparison: {
      baseline_policy_id: baseline.policy_id,
      research_policy_id: research.policy_id,
      common_candidate_ids: common,
      added_by_research_candidate_ids: added,
      removed_by_research_candidate_ids: removed,
      accepted_union_candidate_ids: acceptedUnion,
    },
    groups,
    missing_data: missingData,
    execution_sensitivity: sensitivity,
    drawdown_label: "CLOSE_SEQUENCE_DRAWDOWN" as const,
    portfolio_mtm_drawdown_available: false as const,
    account_return: null,
    account_return_reason:
      "CAPITAL_CONCURRENCY_SIZING_POLICY_NOT_PROVIDED" as const,
    selected_winner: null,
    grading_adjusted: false as const,
    writes_forward_paper_state: false as const,
    writes_monthly_paper_file: false as const,
    warnings,
  };
  return {
    ...body,
    replay_id: stableEvidenceContentId(body),
  };
}
