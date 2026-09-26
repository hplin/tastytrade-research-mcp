import { ExactDecimal, type DecimalInput } from "./decimal.js";
import { stableEvidenceContentId } from "./evidence-cache.js";
import type {
  CoverageStatus,
  HistoricalExecutionEvidenceResult,
  HistoricalQuoteCohort,
  HistoricalReferenceType,
  NormalizedHistoricalEvidenceSource,
  NormalizedHistoricalPackageQuote,
  NormalizedHistoricalReference,
} from "./historical-execution-evidence.js";
import { normalizeRfc3339 } from "./time.js";

export const HISTORICAL_EXECUTION_MODEL_CONTRACT_VERSION =
  "1.0.0" as const;

export type HistoricalExecutionModel =
  | "QUOTE_LIMIT_TOUCH"
  | "QUOTE_CROSS"
  | "QUOTE_PRICE_IMPROVEMENT"
  | "REFERENCE_COST";

export type HistoricalQuoteSource =
  | "NATIVE_PACKAGE"
  | "ALIGNED_LEG_QUOTES";

export type HistoricalExecutionProfileBody = {
  profile_id: string;
  profile_version: string;
  model: HistoricalExecutionModel;
  quote_source: HistoricalQuoteSource | null;
  reference_type: HistoricalReferenceType | null;
  latency_ms: number;
  minimum_package_size: number;
  tick_size: DecimalInput;
  midpoint_to_adverse_fraction: DecimalInput | null;
  additional_cost_per_package: DecimalInput;
  queue_model: "NOT_MODELED";
  market_impact_model: "NOT_MODELED";
  atomic_package: true;
};

export type HistoricalExecutionProfileInput =
  HistoricalExecutionProfileBody & {
    profile_hash: string;
  };

export type HistoricalFeeModelBody = {
  fee_model_id: string;
  fee_model_version: string;
  scope: "PER_CONTRACT_PER_LEG_PER_SIDE";
  amount_per_contract_per_leg_side: DecimalInput;
};

export type HistoricalFeeModelInput = HistoricalFeeModelBody & {
  fee_model_hash: string;
};

export type HistoricalExecutionSourceContract = {
  provider_id: string;
  dataset_id: string;
  license_scope_id: string;
  resolution_profile: {
    profile_id: string;
    profile_version: string;
    native_resolution: string;
    effective_resolution: string;
  };
  source_revision: string;
};

export type HistoricalExecutionWindowInput = {
  window_start: string;
  window_end: string;
  signed_limit: DecimalInput;
  evidence: HistoricalExecutionEvidenceResult | null;
};

export type HistoricalExecutionSimulationInput = {
  run_id: string;
  frozen_decision_id: string;
  frozen_candidate_id: string;
  candidate_fingerprint: string;
  grading_profile: {
    version: string;
    hash: string;
  };
  candidate_construction_profile: {
    version: string;
    hash: string;
  };
  measurement_basis: {
    basis_id: string;
    version: string;
    hash: string;
  };
  study_stage: "IN_SAMPLE" | "OUT_OF_SAMPLE";
  prior_outcome_accessed: boolean;
  decision_frozen_at: string;
  candidate_frozen_at: string;
  profile_frozen_at: string;
  outcome_accessed_at: string;
  source_manifest_ids: string[];
  source_contract: HistoricalExecutionSourceContract;
  quantity: number;
  horizon: {
    kind: "FIXED_TRADING_DAYS";
    trading_days: number;
    scheduled_exit_at: string;
  };
  execution_profile: HistoricalExecutionProfileInput;
  fee_model?: HistoricalFeeModelInput | null;
  entry: HistoricalExecutionWindowInput & {
    evidence: HistoricalExecutionEvidenceResult;
  };
  exit: HistoricalExecutionWindowInput;
};

export type NormalizedHistoricalExecutionProfile = Omit<
  HistoricalExecutionProfileInput,
  | "tick_size"
  | "midpoint_to_adverse_fraction"
  | "additional_cost_per_package"
> & {
  tick_size: string;
  midpoint_to_adverse_fraction: string | null;
  additional_cost_per_package: string;
};

export type NormalizedHistoricalFeeModel = Omit<
  HistoricalFeeModelInput,
  "amount_per_contract_per_leg_side"
> & {
  amount_per_contract_per_leg_side: string;
};

export type HistoricalExecutionPhaseStatus =
  | "SIMULATED_FILLED"
  | "NO_FILL_UNDER_MODEL"
  | "NOT_ASSESSABLE"
  | "NOT_EVALUATED";

export type HistoricalExecutionPhaseResult = {
  phase: "ENTRY" | "EXIT";
  status: HistoricalExecutionPhaseStatus;
  window_start: string;
  window_end: string;
  signed_limit: string;
  fill_price: string | null;
  filled_at: string | null;
  evidence_id: string | null;
  evidence_kind:
    | HistoricalQuoteSource
    | HistoricalReferenceType
    | null;
  evidence_coverage: CoverageStatus;
  first_touch_window: {
    start: string;
    end: string;
  } | null;
  selected_observation_count: number;
  skipped_for_latency: number;
  skipped_for_size: number;
  warnings: string[];
};

export type HistoricalExecutionSimulationResult = {
  contract_version:
    typeof HISTORICAL_EXECUTION_MODEL_CONTRACT_VERSION;
  simulation_id: string;
  evidence_class: "SIMULATED_EXECUTION";
  status:
    | "SIMULATED_FILLED"
    | "NO_FILL_UNDER_MODEL"
    | "NOT_ASSESSABLE"
    | "OPEN_EXIT_UNRESOLVED";
  run_id: string;
  frozen_decision_id: string;
  frozen_candidate_id: string;
  candidate_fingerprint: string;
  family: HistoricalExecutionEvidenceResult["family"];
  inventory: HistoricalExecutionEvidenceResult["inventory"];
  study_stage: "IN_SAMPLE" | "OUT_OF_SAMPLE";
  prior_outcome_accessed: boolean;
  source_manifest_ids: string[];
  source_evidence_ids: {
    entry: string;
    exit: string | null;
  };
  source_contract: HistoricalExecutionSourceContract;
  grading_profile: {
    version: string;
    hash: string;
  };
  candidate_construction_profile: {
    version: string;
    hash: string;
  };
  measurement_basis: {
    basis_id: string;
    version: string;
    hash: string;
  };
  decision_frozen_at: string;
  candidate_frozen_at: string;
  profile_frozen_at: string;
  outcome_accessed_at: string;
  quantity: number;
  horizon: {
    kind: "FIXED_TRADING_DAYS";
    trading_days: number;
    scheduled_exit_at: string;
  };
  execution_profile: NormalizedHistoricalExecutionProfile;
  fee_model: NormalizedHistoricalFeeModel | null;
  evidence_strength: "QUOTE_BACKED" | "REFERENCE_MODEL";
  entry: HistoricalExecutionPhaseResult;
  exit: HistoricalExecutionPhaseResult;
  pnl: {
    formula:
      "(signed_exit_receipt - signed_entry_cost) * multiplier * quantity";
    signed_entry_cost: string | null;
    signed_exit_receipt: string | null;
    multiplier: string;
    quantity: number;
    gross_pnl: string | null;
    entry_fees: string | null;
    exit_fees: string | null;
    total_fees: string | null;
    net_pnl: string | null;
  };
  broker_fill_verified: false;
  mutates_live_event: false;
  mutates_source_evidence: false;
  limitations: string[];
  warnings: string[];
};

const INPUT_TIMESTAMP_SCHEMA = {
  type: "string",
  pattern:
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
} as const;
const INPUT_DECIMAL_SCHEMA = {
  anyOf: [
    {
      type: "string",
      pattern: "^[+-]?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
    },
    { type: "number" },
  ],
} as const;
const INPUT_NULLABLE_DECIMAL_SCHEMA = {
  anyOf: [INPUT_DECIMAL_SCHEMA, { type: "null" }],
} as const;
const INPUT_CONTENT_ID_SCHEMA = {
  type: "string",
  pattern: "^sha256:[a-f0-9]{64}$",
} as const;
const INPUT_VERSIONED_HASH_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", minLength: 1, maxLength: 200 },
    hash: INPUT_CONTENT_ID_SCHEMA,
  },
  required: ["version", "hash"],
  additionalProperties: false,
} as const;
const INPUT_RESOLUTION_SCHEMA = {
  type: "object",
  properties: {
    profile_id: { type: "string", minLength: 1, maxLength: 200 },
    profile_version: { type: "string", minLength: 1, maxLength: 200 },
    native_resolution: { type: "string", minLength: 1, maxLength: 200 },
    effective_resolution: {
      type: "string",
      minLength: 1,
      maxLength: 200,
    },
  },
  required: [
    "profile_id",
    "profile_version",
    "native_resolution",
    "effective_resolution",
  ],
  additionalProperties: false,
} as const;
const INPUT_EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    contract_version: { type: "string", const: "1.0.0" },
    evidence_id: INPUT_CONTENT_ID_SCHEMA,
    evidence_type: {
      type: "string",
      const: "HISTORICAL_EXACT_LEG_QUOTE_HANDOFF",
    },
    evidence_phase: {
      type: "string",
      const: "POST_SESSION_REGRESSION",
    },
    broker_fill_verified: { type: "boolean", const: false },
  },
  required: [
    "contract_version",
    "evidence_id",
    "evidence_type",
    "evidence_phase",
    "broker_fill_verified",
  ],
  additionalProperties: true,
} as const;
const INPUT_WINDOW_PROPERTIES = {
  window_start: INPUT_TIMESTAMP_SCHEMA,
  window_end: INPUT_TIMESTAMP_SCHEMA,
  signed_limit: INPUT_DECIMAL_SCHEMA,
} as const;

export const HISTORICAL_EXECUTION_MODEL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        run_id: { type: "string", minLength: 1, maxLength: 200 },
        frozen_decision_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        frozen_candidate_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        candidate_fingerprint: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        grading_profile: INPUT_VERSIONED_HASH_SCHEMA,
        candidate_construction_profile: INPUT_VERSIONED_HASH_SCHEMA,
        measurement_basis: {
          type: "object",
          properties: {
            basis_id: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
            version:
              INPUT_VERSIONED_HASH_SCHEMA.properties.version,
            hash: INPUT_CONTENT_ID_SCHEMA,
          },
          required: ["basis_id", "version", "hash"],
          additionalProperties: false,
        },
        study_stage: {
          type: "string",
          enum: ["IN_SAMPLE", "OUT_OF_SAMPLE"],
        },
        prior_outcome_accessed: { type: "boolean" },
        decision_frozen_at: INPUT_TIMESTAMP_SCHEMA,
        candidate_frozen_at: INPUT_TIMESTAMP_SCHEMA,
        profile_frozen_at: INPUT_TIMESTAMP_SCHEMA,
        outcome_accessed_at: INPUT_TIMESTAMP_SCHEMA,
        source_manifest_ids: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: INPUT_CONTENT_ID_SCHEMA,
        },
        source_contract: {
          type: "object",
          properties: {
            provider_id: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
            dataset_id: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
            license_scope_id: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
            resolution_profile: INPUT_RESOLUTION_SCHEMA,
            source_revision: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
          },
          required: [
            "provider_id",
            "dataset_id",
            "license_scope_id",
            "resolution_profile",
            "source_revision",
          ],
          additionalProperties: false,
        },
        quantity: { type: "integer", minimum: 1, maximum: 1000000 },
        horizon: {
          type: "object",
          properties: {
            kind: { type: "string", const: "FIXED_TRADING_DAYS" },
            trading_days: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
            },
            scheduled_exit_at: INPUT_TIMESTAMP_SCHEMA,
          },
          required: ["kind", "trading_days", "scheduled_exit_at"],
          additionalProperties: false,
        },
        execution_profile: {
          type: "object",
          properties: {
            profile_id: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
            profile_version: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
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
            latency_ms: {
              type: "integer",
              minimum: 0,
              maximum: 86400000,
            },
            minimum_package_size: {
              type: "integer",
              minimum: 1,
              maximum: 1000000,
            },
            tick_size: INPUT_DECIMAL_SCHEMA,
            midpoint_to_adverse_fraction:
              INPUT_NULLABLE_DECIMAL_SCHEMA,
            additional_cost_per_package: INPUT_DECIMAL_SCHEMA,
            queue_model: { type: "string", const: "NOT_MODELED" },
            market_impact_model: {
              type: "string",
              const: "NOT_MODELED",
            },
            atomic_package: { type: "boolean", const: true },
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
        },
        fee_model: {
          anyOf: [
            {
              type: "object",
              properties: {
                fee_model_id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                },
                fee_model_version: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                },
                fee_model_hash: INPUT_CONTENT_ID_SCHEMA,
                scope: {
                  type: "string",
                  const: "PER_CONTRACT_PER_LEG_PER_SIDE",
                },
                amount_per_contract_per_leg_side:
                  INPUT_DECIMAL_SCHEMA,
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
        },
        entry: {
          type: "object",
          properties: {
            ...INPUT_WINDOW_PROPERTIES,
            evidence: INPUT_EVIDENCE_SCHEMA,
          },
          required: [
            "window_start",
            "window_end",
            "signed_limit",
            "evidence",
          ],
          additionalProperties: false,
        },
        exit: {
          type: "object",
          properties: {
            ...INPUT_WINDOW_PROPERTIES,
            evidence: {
              anyOf: [
                INPUT_EVIDENCE_SCHEMA,
                { type: "null" },
              ],
            },
          },
          required: [
            "window_start",
            "window_end",
            "signed_limit",
            "evidence",
          ],
          additionalProperties: false,
        },
      },
      required: [
        "run_id",
        "frozen_decision_id",
        "frozen_candidate_id",
        "candidate_fingerprint",
        "grading_profile",
        "candidate_construction_profile",
        "measurement_basis",
        "study_stage",
        "prior_outcome_accessed",
        "decision_frozen_at",
        "candidate_frozen_at",
        "profile_frozen_at",
        "outcome_accessed_at",
        "source_manifest_ids",
        "source_contract",
        "quantity",
        "horizon",
        "execution_profile",
        "fee_model",
        "entry",
        "exit",
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

type NormalizedWindow = {
  window_start: string;
  window_end: string;
  start_ms: number;
  end_ms: number;
  signed_limit: ExactDecimal;
  evidence: HistoricalExecutionEvidenceResult | null;
};

type SelectedPoint = {
  observedAt: string;
  timestamp: number;
  evidenceId: string;
  evidenceKind: HistoricalQuoteSource | HistoricalReferenceType;
  bid: ExactDecimal;
  ask: ExactDecimal;
  bidSize: number | null;
  askSize: number | null;
};

type NormalizedProfileBody = Omit<
  NormalizedHistoricalExecutionProfile,
  "profile_hash"
>;

type NormalizedFeeBody = Omit<
  NormalizedHistoricalFeeModel,
  "fee_model_hash"
>;

const CONTENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

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

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function nonNegativeDecimal(value: DecimalInput, field: string): ExactDecimal {
  const normalized = ExactDecimal.parse(value, field);
  if (normalized.compare(ExactDecimal.zero()) < 0) {
    throw new Error(`${field} must be non-negative.`);
  }
  return normalized;
}

function timestamp(value: string, field: string): string {
  return normalizeRfc3339(value, field);
}

function normalizeProfileBody(
  input: HistoricalExecutionProfileBody,
): NormalizedProfileBody {
  if (
    ![
      "QUOTE_LIMIT_TOUCH",
      "QUOTE_CROSS",
      "QUOTE_PRICE_IMPROVEMENT",
      "REFERENCE_COST",
    ].includes(input.model)
  ) {
    throw new Error(
      `Unsupported historical execution model: ${String(input.model)}.`,
    );
  }
  if (
    input.quote_source !== null &&
    input.quote_source !== "NATIVE_PACKAGE" &&
    input.quote_source !== "ALIGNED_LEG_QUOTES"
  ) {
    throw new Error(
      `Unsupported quote_source: ${String(input.quote_source)}.`,
    );
  }
  if (
    input.reference_type !== null &&
    ![
      "TRADE_REFERENCE",
      "CANDLE_REFERENCE",
      "MODEL_REFERENCE",
    ].includes(input.reference_type)
  ) {
    throw new Error(
      `Unsupported reference_type: ${String(input.reference_type)}.`,
    );
  }
  const profileId = nonEmpty(input.profile_id, "profile_id");
  const profileVersion = nonEmpty(
    input.profile_version,
    "profile_version",
  );
  const latencyMs = nonNegativeInteger(input.latency_ms, "latency_ms");
  const minimumPackageSize = positiveInteger(
    input.minimum_package_size,
    "minimum_package_size",
  );
  const tickSize = ExactDecimal.parse(input.tick_size, "tick_size");
  if (tickSize.compare(ExactDecimal.zero()) <= 0) {
    throw new Error("tick_size must be positive.");
  }
  const additionalCost = nonNegativeDecimal(
    input.additional_cost_per_package,
    "additional_cost_per_package",
  );
  const fraction =
    input.midpoint_to_adverse_fraction === null
      ? null
      : nonNegativeDecimal(
          input.midpoint_to_adverse_fraction,
          "midpoint_to_adverse_fraction",
        );
  if (
    fraction !== null &&
    fraction.compare(ExactDecimal.parse("1")) > 0
  ) {
    throw new Error(
      "midpoint_to_adverse_fraction must be between 0 and 1.",
    );
  }
  if (
    input.queue_model !== "NOT_MODELED" ||
    input.market_impact_model !== "NOT_MODELED" ||
    input.atomic_package !== true
  ) {
    throw new Error(
      "V1 requires atomic_package=true with queue and market impact NOT_MODELED.",
    );
  }
  if (input.model === "REFERENCE_COST") {
    if (input.quote_source !== null || input.reference_type === null) {
      throw new Error(
        "REFERENCE_COST requires reference_type and quote_source=null.",
      );
    }
  } else if (
    input.quote_source === null ||
    input.reference_type !== null
  ) {
    throw new Error(
      `${input.model} requires quote_source and reference_type=null.`,
    );
  }
  if (
    input.model === "QUOTE_PRICE_IMPROVEMENT" &&
    fraction === null
  ) {
    throw new Error(
      "QUOTE_PRICE_IMPROVEMENT requires midpoint_to_adverse_fraction.",
    );
  }
  if (
    input.model !== "QUOTE_PRICE_IMPROVEMENT" &&
    fraction !== null
  ) {
    throw new Error(
      `${input.model} does not accept midpoint_to_adverse_fraction.`,
    );
  }
  if (
    (input.model === "QUOTE_LIMIT_TOUCH" ||
      input.model === "QUOTE_CROSS") &&
    !additionalCost.isZero()
  ) {
    throw new Error(
      `${input.model} requires additional_cost_per_package=0.`,
    );
  }

  return {
    profile_id: profileId,
    profile_version: profileVersion,
    model: input.model,
    quote_source: input.quote_source,
    reference_type: input.reference_type,
    latency_ms: latencyMs,
    minimum_package_size: minimumPackageSize,
    tick_size: tickSize.toString(),
    midpoint_to_adverse_fraction: fraction?.toString() ?? null,
    additional_cost_per_package: additionalCost.toString(),
    queue_model: "NOT_MODELED",
    market_impact_model: "NOT_MODELED",
    atomic_package: true,
  };
}

export function historicalExecutionProfileHash(
  input: HistoricalExecutionProfileBody,
): string {
  return stableEvidenceContentId(normalizeProfileBody(input));
}

function normalizeProfile(
  input: HistoricalExecutionProfileInput,
): NormalizedHistoricalExecutionProfile {
  const body = normalizeProfileBody(input);
  const expectedHash = stableEvidenceContentId(body);
  if (input.profile_hash !== expectedHash) {
    throw new Error(
      "execution_profile.profile_hash does not match the normalized profile.",
    );
  }
  return {
    ...body,
    profile_hash: expectedHash,
  };
}

function normalizeFeeBody(
  input: HistoricalFeeModelBody,
): NormalizedFeeBody {
  return {
    fee_model_id: nonEmpty(input.fee_model_id, "fee_model_id"),
    fee_model_version: nonEmpty(
      input.fee_model_version,
      "fee_model_version",
    ),
    scope: input.scope,
    amount_per_contract_per_leg_side: nonNegativeDecimal(
      input.amount_per_contract_per_leg_side,
      "amount_per_contract_per_leg_side",
    ).toString(),
  };
}

export function historicalFeeModelHash(
  input: HistoricalFeeModelBody,
): string {
  return stableEvidenceContentId(normalizeFeeBody(input));
}

function normalizeFeeModel(
  input: HistoricalFeeModelInput | null | undefined,
): NormalizedHistoricalFeeModel | null {
  if (input === null || input === undefined) return null;
  if (input.scope !== "PER_CONTRACT_PER_LEG_PER_SIDE") {
    throw new Error(
      "fee_model.scope must be PER_CONTRACT_PER_LEG_PER_SIDE.",
    );
  }
  const body = normalizeFeeBody(input);
  const expectedHash = stableEvidenceContentId(body);
  if (input.fee_model_hash !== expectedHash) {
    throw new Error(
      "fee_model.fee_model_hash does not match the normalized fee model.",
    );
  }
  return {
    ...body,
    fee_model_hash: expectedHash,
  };
}

function normalizeSourceContract(
  input: HistoricalExecutionSourceContract,
): HistoricalExecutionSourceContract {
  return {
    provider_id: nonEmpty(
      input.provider_id,
      "source_contract.provider_id",
    ),
    dataset_id: nonEmpty(
      input.dataset_id,
      "source_contract.dataset_id",
    ),
    license_scope_id: nonEmpty(
      input.license_scope_id,
      "source_contract.license_scope_id",
    ),
    resolution_profile: {
      profile_id: nonEmpty(
        input.resolution_profile.profile_id,
        "source_contract.resolution_profile.profile_id",
      ),
      profile_version: nonEmpty(
        input.resolution_profile.profile_version,
        "source_contract.resolution_profile.profile_version",
      ),
      native_resolution: nonEmpty(
        input.resolution_profile.native_resolution,
        "source_contract.resolution_profile.native_resolution",
      ),
      effective_resolution: nonEmpty(
        input.resolution_profile.effective_resolution,
        "source_contract.resolution_profile.effective_resolution",
      ),
    },
    source_revision: nonEmpty(
      input.source_revision,
      "source_contract.source_revision",
    ),
  };
}

function sourceIdentity(
  source: NormalizedHistoricalEvidenceSource | HistoricalQuoteCohort,
): HistoricalExecutionSourceContract {
  return {
    provider_id: source.provider_id,
    dataset_id: source.dataset_id,
    license_scope_id: source.license_scope_id,
    resolution_profile: source.resolution_profile,
    source_revision: source.source_revision,
  };
}

function sourceMatches(
  source: NormalizedHistoricalEvidenceSource | HistoricalQuoteCohort,
  expected: HistoricalExecutionSourceContract,
): boolean {
  return (
    stableEvidenceContentId(sourceIdentity(source)) ===
    stableEvidenceContentId(expected)
  );
}

function verifyEvidenceId(
  evidence: HistoricalExecutionEvidenceResult,
  field: string,
): void {
  const { evidence_id: evidenceId, ...body } = evidence;
  if (stableEvidenceContentId(body) !== evidenceId) {
    throw new Error(`${field}.evidence_id does not match its content.`);
  }
  if (
    evidence.contract_version !== "1.0.0" ||
    evidence.evidence_type !== "HISTORICAL_EXACT_LEG_QUOTE_HANDOFF" ||
    evidence.evidence_phase !== "POST_SESSION_REGRESSION" ||
    evidence.broker_fill_verified !== false
  ) {
    throw new Error(`${field} is not compatible historical quote evidence.`);
  }
}

function normalizeWindow(
  input: HistoricalExecutionWindowInput,
  field: string,
): NormalizedWindow {
  const windowStart = timestamp(
    input.window_start,
    `${field}.window_start`,
  );
  const windowEnd = timestamp(input.window_end, `${field}.window_end`);
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  if (endMs <= startMs) {
    throw new Error(`${field}.window_end must be after window_start.`);
  }
  const signedLimit = ExactDecimal.parse(
    input.signed_limit,
    `${field}.signed_limit`,
  );
  if (input.evidence !== null) {
    verifyEvidenceId(input.evidence, `${field}.evidence`);
    if (input.evidence.scope !== "WINDOW") {
      throw new Error(`${field}.evidence must use WINDOW scope.`);
    }
    for (const expectedAt of input.evidence.expected_observation_times) {
      const value = Date.parse(expectedAt);
      if (value < startMs || value > endMs) {
        throw new Error(
          `${field}.evidence observation ${expectedAt} is outside the frozen window.`,
        );
      }
    }
  }
  return {
    window_start: windowStart,
    window_end: windowEnd,
    start_ms: startMs,
    end_ms: endMs,
    signed_limit: signedLimit,
    evidence: input.evidence,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (value, index) => value === normalizedRight[index],
    )
  );
}

function packageQuoteForSource(
  observation: HistoricalExecutionEvidenceResult["observations"][number],
  source: HistoricalQuoteSource,
): NormalizedHistoricalPackageQuote | null {
  return source === "NATIVE_PACKAGE"
    ? observation.native_package_quote
    : observation.synthetic_package_quote;
}

function assertSelectedSource(
  evidence: HistoricalExecutionEvidenceResult,
  profile: NormalizedHistoricalExecutionProfile,
  expected: HistoricalExecutionSourceContract,
  field: string,
): void {
  for (const observation of evidence.observations) {
    if (profile.model === "REFERENCE_COST") {
      const references = observation.references.filter(
        (reference) =>
          reference.evidence_type === profile.reference_type,
      );
      for (const reference of references) {
        if (!sourceMatches(reference.source, expected)) {
          throw new Error(
            `${field} reference source does not match frozen source_contract.`,
          );
        }
      }
      continue;
    }
    const quote = packageQuoteForSource(
      observation,
      profile.quote_source!,
    );
    if (
      quote?.source !== null &&
      quote?.source !== undefined &&
      !sourceMatches(quote.source, expected)
    ) {
      throw new Error(
        `${field} quote source does not match frozen source_contract.`,
      );
    }
  }
}

function selectedReference(
  references: NormalizedHistoricalReference[],
  type: HistoricalReferenceType,
): NormalizedHistoricalReference | null {
  const matching = references.filter(
    (reference) => reference.evidence_type === type,
  );
  if (matching.length > 1) {
    throw new Error(
      `Conflicting duplicate ${type} observations at one timestamp.`,
    );
  }
  return matching[0] ?? null;
}

function selectedPoints(
  window: NormalizedWindow,
  profile: NormalizedHistoricalExecutionProfile,
): SelectedPoint[] {
  const evidence = window.evidence;
  if (evidence === null) return [];
  const points: SelectedPoint[] = [];
  for (const observation of evidence.observations) {
    if (profile.model === "REFERENCE_COST") {
      const reference = selectedReference(
        observation.references,
        profile.reference_type!,
      );
      if (
        reference?.status === "AVAILABLE" &&
        reference.signed_value !== null
      ) {
        const value = ExactDecimal.parse(reference.signed_value);
        points.push({
          observedAt: observation.observed_at,
          timestamp: Date.parse(observation.observed_at),
          evidenceId: reference.evidence_id,
          evidenceKind: reference.evidence_type,
          bid: value,
          ask: value,
          bidSize: null,
          askSize: null,
        });
      }
      continue;
    }

    const quote = packageQuoteForSource(
      observation,
      profile.quote_source!,
    );
    if (
      quote?.usable_for_simulated_execution === true &&
      quote.signed_bid !== null &&
      quote.signed_ask !== null &&
      quote.price_semantics === "SIGNED_CASH_FLOW_PER_UNIT"
    ) {
      points.push({
        observedAt: observation.observed_at,
        timestamp: Date.parse(observation.observed_at),
        evidenceId: quote.evidence_id,
        evidenceKind: profile.quote_source!,
        bid: ExactDecimal.parse(quote.signed_bid),
        ask: ExactDecimal.parse(quote.signed_ask),
        bidSize: quote.bid_size,
        askSize: quote.ask_size,
      });
    }
  }
  return points.sort(
    (left, right) => left.timestamp - right.timestamp,
  );
}

function tickAligned(value: ExactDecimal, tick: ExactDecimal): boolean {
  return (
    value.floorToIncrement(tick).compare(value) === 0 &&
    value.ceilToIncrement(tick).compare(value) === 0
  );
}

function modeledPrice(
  point: SelectedPoint,
  profile: NormalizedHistoricalExecutionProfile,
  phase: "ENTRY" | "EXIT",
  limit: ExactDecimal,
): ExactDecimal {
  const tick = ExactDecimal.parse(profile.tick_size);
  const adverse = phase === "ENTRY" ? point.ask : point.bid;
  if (profile.model === "QUOTE_LIMIT_TOUCH") return limit;
  if (profile.model === "QUOTE_CROSS") {
    return phase === "ENTRY"
      ? adverse.ceilToIncrement(tick)
      : adverse.floorToIncrement(tick);
  }

  const cost = ExactDecimal.parse(
    profile.additional_cost_per_package,
  );
  if (profile.model === "REFERENCE_COST") {
    const adjusted =
      phase === "ENTRY" ? adverse.add(cost) : adverse.subtract(cost);
    return phase === "ENTRY"
      ? adjusted.ceilToIncrement(tick)
      : adjusted.floorToIncrement(tick);
  }

  const midpoint = point.bid.add(point.ask).half();
  const fraction = ExactDecimal.parse(
    profile.midpoint_to_adverse_fraction!,
  );
  const interpolated =
    phase === "ENTRY"
      ? midpoint.add(point.ask.subtract(midpoint).multiply(fraction))
      : midpoint.subtract(midpoint.subtract(point.bid).multiply(fraction));
  const adjusted =
    phase === "ENTRY"
      ? interpolated.add(cost)
      : interpolated.subtract(cost);
  return phase === "ENTRY"
    ? adjusted.ceilToIncrement(tick)
    : adjusted.floorToIncrement(tick);
}

function reachesLimit(
  price: ExactDecimal,
  limit: ExactDecimal,
  phase: "ENTRY" | "EXIT",
): boolean {
  return phase === "ENTRY"
    ? price.compare(limit) <= 0
    : price.compare(limit) >= 0;
}

function evaluatePhase(
  phase: "ENTRY" | "EXIT",
  window: NormalizedWindow,
  profile: NormalizedHistoricalExecutionProfile,
  quantity: number,
  notBeforeMs: number,
): HistoricalExecutionPhaseResult {
  const base = {
    phase,
    window_start: window.window_start,
    window_end: window.window_end,
    signed_limit: window.signed_limit.toString(),
  };
  if (window.evidence === null) {
    return {
      ...base,
      status: "NOT_ASSESSABLE",
      fill_price: null,
      filled_at: null,
      evidence_id: null,
      evidence_kind: null,
      evidence_coverage: "NONE",
      first_touch_window: null,
      selected_observation_count: 0,
      skipped_for_latency: 0,
      skipped_for_size: 0,
      warnings: ["MISSING_EXECUTION_EVIDENCE"],
    };
  }

  const selected = selectedPoints(window, profile);
  const eligibleAfter = Math.max(
    window.start_ms + profile.latency_ms,
    notBeforeMs,
  );
  const eligibleExpectedTimes =
    window.evidence.expected_observation_times.filter(
      (value) => Date.parse(value) >= eligibleAfter,
    );
  const eligiblePoints = selected.filter(
    (point) => point.timestamp >= eligibleAfter,
  );
  const selectedPointTimes = new Set(
    eligiblePoints.map((point) => point.observedAt),
  );
  const coverage: CoverageStatus =
    eligibleExpectedTimes.length === 0
      ? "NONE"
      : eligibleExpectedTimes.every((value) =>
            selectedPointTimes.has(value),
          )
        ? "COMPLETE"
        : eligiblePoints.length > 0
          ? "PARTIAL"
          : "NONE";
  const requiredSize = Math.max(
    quantity,
    profile.minimum_package_size,
  );
  const skippedForLatency = selected.length - eligiblePoints.length;
  let skippedForSize = 0;
  let previousExpectedAt = new Date(eligibleAfter).toISOString();
  for (const point of eligiblePoints) {
    if (profile.model !== "REFERENCE_COST") {
      const size = phase === "ENTRY" ? point.askSize : point.bidSize;
      if (size === null || size < requiredSize) {
        skippedForSize += 1;
        continue;
      }
    }
    const observedAdverse = phase === "ENTRY" ? point.ask : point.bid;
    const price = modeledPrice(
      point,
      profile,
      phase,
      window.signed_limit,
    );
    const triggerPrice =
      profile.model === "QUOTE_LIMIT_TOUCH"
        ? observedAdverse
        : price;
    if (!reachesLimit(triggerPrice, window.signed_limit, phase)) {
      previousExpectedAt = point.observedAt;
      continue;
    }
    if (!reachesLimit(price, window.signed_limit, phase)) {
      throw new Error(
        `${phase} modeled fill price exceeds the frozen limit.`,
      );
    }
    const warnings: string[] = [];
    if (coverage !== "COMPLETE") {
      warnings.push("FILL_OBSERVED_WITH_INCOMPLETE_WINDOW");
    }
    if (profile.model === "QUOTE_LIMIT_TOUCH") {
      warnings.push(
        "OBSERVED_RESOLUTION_DOES_NOT_PROVE_CONTINUOUS_FIRST_TOUCH",
      );
    }
    return {
      ...base,
      status: "SIMULATED_FILLED",
      fill_price: price.toString(),
      filled_at: point.observedAt,
      evidence_id: point.evidenceId,
      evidence_kind: point.evidenceKind,
      evidence_coverage: coverage,
      first_touch_window: {
        start: previousExpectedAt,
        end: point.observedAt,
      },
      selected_observation_count: eligiblePoints.length,
      skipped_for_latency: skippedForLatency,
      skipped_for_size: skippedForSize,
      warnings,
    };
  }

  return {
    ...base,
    status:
      coverage === "COMPLETE"
        ? "NO_FILL_UNDER_MODEL"
        : "NOT_ASSESSABLE",
    fill_price: null,
    filled_at: null,
    evidence_id: null,
    evidence_kind:
      profile.model === "REFERENCE_COST"
        ? profile.reference_type
        : profile.quote_source,
    evidence_coverage: coverage,
    first_touch_window: null,
    selected_observation_count: eligiblePoints.length,
    skipped_for_latency: skippedForLatency,
    skipped_for_size: skippedForSize,
    warnings:
      coverage === "COMPLETE"
        ? []
        : eligibleExpectedTimes.length === 0
          ? ["NO_EXPECTED_OBSERVATIONS_AFTER_LATENCY"]
          : ["INCOMPLETE_SELECTED_EVIDENCE_WINDOW"],
  };
}

function notEvaluatedExit(
  window: NormalizedWindow,
): HistoricalExecutionPhaseResult {
  return {
    phase: "EXIT",
    status: "NOT_EVALUATED",
    window_start: window.window_start,
    window_end: window.window_end,
    signed_limit: window.signed_limit.toString(),
    fill_price: null,
    filled_at: null,
    evidence_id: null,
    evidence_kind: null,
    evidence_coverage: "NONE",
    first_touch_window: null,
    selected_observation_count: 0,
    skipped_for_latency: 0,
    skipped_for_size: 0,
    warnings: ["ENTRY_NOT_FILLED"],
  };
}

function sameInventory(
  left: HistoricalExecutionEvidenceResult,
  right: HistoricalExecutionEvidenceResult,
): boolean {
  return (
    left.family === right.family &&
    left.underlying === right.underlying &&
    left.candidate_fingerprint === right.candidate_fingerprint &&
    stableEvidenceContentId(left.inventory) ===
      stableEvidenceContentId(right.inventory) &&
    left.verified_multiplier === right.verified_multiplier
  );
}

function exchangeDate(timestampValue: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampValue));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function verifyMetadataHash(
  value: { version: string; hash: string },
  field: string,
): { version: string; hash: string } {
  return {
    version: nonEmpty(value.version, `${field}.version`),
    hash: contentId(value.hash, `${field}.hash`),
  };
}

export function simulateHistoricalExecution(
  input: HistoricalExecutionSimulationInput,
): HistoricalExecutionSimulationResult {
  const runId = nonEmpty(input.run_id, "run_id");
  const frozenDecisionId = nonEmpty(
    input.frozen_decision_id,
    "frozen_decision_id",
  );
  const frozenCandidateId = nonEmpty(
    input.frozen_candidate_id,
    "frozen_candidate_id",
  );
  const candidateFingerprint = nonEmpty(
    input.candidate_fingerprint,
    "candidate_fingerprint",
  );
  const gradingProfile = verifyMetadataHash(
    input.grading_profile,
    "grading_profile",
  );
  const candidateProfile = verifyMetadataHash(
    input.candidate_construction_profile,
    "candidate_construction_profile",
  );
  const measurementBasis = {
    basis_id: nonEmpty(
      input.measurement_basis.basis_id,
      "measurement_basis.basis_id",
    ),
    ...verifyMetadataHash(input.measurement_basis, "measurement_basis"),
  };
  if (
    input.study_stage !== "IN_SAMPLE" &&
    input.study_stage !== "OUT_OF_SAMPLE"
  ) {
    throw new Error(`Unsupported study_stage: ${String(input.study_stage)}.`);
  }
  if (
    input.prior_outcome_accessed &&
    input.study_stage !== "IN_SAMPLE"
  ) {
    throw new Error(
      "Samples with prior outcome access must remain IN_SAMPLE.",
    );
  }
  const decisionFrozenAt = timestamp(
    input.decision_frozen_at,
    "decision_frozen_at",
  );
  const candidateFrozenAt = timestamp(
    input.candidate_frozen_at,
    "candidate_frozen_at",
  );
  const profileFrozenAt = timestamp(
    input.profile_frozen_at,
    "profile_frozen_at",
  );
  const outcomeAccessedAt = timestamp(
    input.outcome_accessed_at,
    "outcome_accessed_at",
  );
  for (const [field, value] of [
    ["decision_frozen_at", decisionFrozenAt],
    ["candidate_frozen_at", candidateFrozenAt],
    ["profile_frozen_at", profileFrozenAt],
  ] as const) {
    if (Date.parse(value) > Date.parse(outcomeAccessedAt)) {
      throw new Error(`${field} must not be after outcome_accessed_at.`);
    }
  }
  const sourceContract = normalizeSourceContract(input.source_contract);
  const quantity = positiveInteger(input.quantity, "quantity");
  if (input.horizon.kind !== "FIXED_TRADING_DAYS") {
    throw new Error("V1 supports FIXED_TRADING_DAYS horizons only.");
  }
  const horizon = {
    kind: "FIXED_TRADING_DAYS" as const,
    trading_days: positiveInteger(
      input.horizon.trading_days,
      "horizon.trading_days",
    ),
    scheduled_exit_at: timestamp(
      input.horizon.scheduled_exit_at,
      "horizon.scheduled_exit_at",
    ),
  };
  const profile = normalizeProfile(input.execution_profile);
  const feeModel = normalizeFeeModel(input.fee_model);
  const entryWindow = normalizeWindow(input.entry, "entry");
  const exitWindow = normalizeWindow(input.exit, "exit");
  if (entryWindow.evidence === null) {
    throw new Error("entry.evidence is required.");
  }
  if (
    Date.parse(horizon.scheduled_exit_at) < exitWindow.start_ms ||
    Date.parse(horizon.scheduled_exit_at) > exitWindow.end_ms
  ) {
    throw new Error(
      "horizon.scheduled_exit_at must be inside the frozen exit window.",
    );
  }
  if (exitWindow.start_ms <= entryWindow.end_ms) {
    throw new Error(
      "exit.window_start must be after entry.window_end.",
    );
  }
  if (!tickAligned(entryWindow.signed_limit, ExactDecimal.parse(profile.tick_size))) {
    throw new Error("entry.signed_limit must align to profile.tick_size.");
  }
  if (!tickAligned(exitWindow.signed_limit, ExactDecimal.parse(profile.tick_size))) {
    throw new Error("exit.signed_limit must align to profile.tick_size.");
  }

  const entryEvidence = entryWindow.evidence;
  if (
    entryEvidence.candidate_fingerprint !== candidateFingerprint
  ) {
    throw new Error(
      "entry evidence candidate_fingerprint does not match the frozen candidate.",
    );
  }
  if (
    exitWindow.evidence !== null &&
    !sameInventory(entryEvidence, exitWindow.evidence)
  ) {
    throw new Error(
      "entry and exit evidence must describe the same frozen inventory.",
    );
  }
  for (const [field, evidence] of [
    ["entry.evidence", entryEvidence],
    ["exit.evidence", exitWindow.evidence],
  ] as const) {
    if (evidence === null) continue;
    const retrievedTimes = evidence.observations.flatMap(
      (observation) => [
        ...observation.leg_quotes.map((quote) => quote.retrieved_at),
        observation.native_package_quote?.retrieved_at ?? null,
        ...observation.references.map(
          (reference) => reference.retrieved_at,
        ),
      ],
    );
    if (
      retrievedTimes.some(
        (value) =>
          value !== null &&
          Date.parse(value) > Date.parse(outcomeAccessedAt),
      )
    ) {
      throw new Error(
        `${field} was retrieved after outcome_accessed_at.`,
      );
    }
  }
  const evidenceManifests = [
    ...entryEvidence.source_manifest_ids,
    ...(exitWindow.evidence?.source_manifest_ids ?? []),
  ];
  const sourceManifestIds = input.source_manifest_ids.map((value, index) =>
    contentId(value, `source_manifest_ids[${index}]`),
  );
  if (!sameStringSet(sourceManifestIds, evidenceManifests)) {
    throw new Error(
      "source_manifest_ids do not match the exact evidence lineage.",
    );
  }
  assertSelectedSource(
    entryEvidence,
    profile,
    sourceContract,
    "entry.evidence",
  );
  if (exitWindow.evidence !== null) {
    assertSelectedSource(
      exitWindow.evidence,
      profile,
      sourceContract,
      "exit.evidence",
    );
  }

  if (entryEvidence.family === "DOUBLE_DIAGONAL") {
    const earliestExpiration = [...new Set(
      entryEvidence.inventory.map((leg) => leg.expiration),
    )].sort()[0];
    if (exchangeDate(exitWindow.window_end) >= earliestExpiration) {
      throw new Error(
        `DOUBLE_DIAGONAL fixed-horizon exit must precede the earliest expiration ${earliestExpiration}.`,
      );
    }
  }

  const entry = evaluatePhase(
    "ENTRY",
    entryWindow,
    profile,
    quantity,
    entryWindow.start_ms,
  );
  let exit: HistoricalExecutionPhaseResult;
  let status: HistoricalExecutionSimulationResult["status"];
  if (entry.status === "NO_FILL_UNDER_MODEL") {
    exit = notEvaluatedExit(exitWindow);
    status = "NO_FILL_UNDER_MODEL";
  } else if (entry.status !== "SIMULATED_FILLED") {
    exit = notEvaluatedExit(exitWindow);
    status = "NOT_ASSESSABLE";
  } else {
    exit = evaluatePhase(
      "EXIT",
      exitWindow,
      profile,
      quantity,
      Date.parse(horizon.scheduled_exit_at),
    );
    status =
      exit.status === "SIMULATED_FILLED"
        ? "SIMULATED_FILLED"
        : "OPEN_EXIT_UNRESOLVED";
  }

  const multiplier = ExactDecimal.parse(
    entryEvidence.verified_multiplier,
  );
  let grossPnl: ExactDecimal | null = null;
  let entryFees: ExactDecimal | null = null;
  let exitFees: ExactDecimal | null = null;
  let totalFees: ExactDecimal | null = null;
  let netPnl: ExactDecimal | null = null;
  if (feeModel !== null) {
    const legUnits = entryEvidence.inventory.reduce(
      (total, leg) => total + Math.abs(leg.inventory_quantity),
      0,
    );
    const perSide = ExactDecimal.parse(
      feeModel.amount_per_contract_per_leg_side,
    )
      .multiplyInteger(legUnits)
      .multiplyInteger(quantity);
    entryFees =
      entry.status === "SIMULATED_FILLED"
        ? perSide
        : ExactDecimal.zero();
    exitFees =
      exit.status === "SIMULATED_FILLED"
        ? perSide
        : ExactDecimal.zero();
    totalFees = entryFees.add(exitFees);
  }
  if (
    entry.status === "SIMULATED_FILLED" &&
    exit.status === "SIMULATED_FILLED"
  ) {
    grossPnl = ExactDecimal.parse(exit.fill_price!)
      .subtract(ExactDecimal.parse(entry.fill_price!))
      .multiply(multiplier)
      .multiplyInteger(quantity);
    if (totalFees !== null) {
      netPnl = grossPnl.subtract(totalFees);
    }
  }

  const limitations = [
    "ATOMIC_PACKAGE_ONLY",
    "QUEUE_POSITION_NOT_MODELED",
    "MARKET_IMPACT_NOT_MODELED",
    "BROKER_FILL_NOT_VERIFIED",
    "OBSERVATION_RESOLUTION_PRESERVED",
  ];
  const warnings: string[] = [];
  if (
    profile.model === "QUOTE_PRICE_IMPROVEMENT" &&
    profile.midpoint_to_adverse_fraction === "0"
  ) {
    warnings.push("ZERO_FRACTION_IS_OPTIMISTIC_MIDPOINT_SCENARIO");
  }
  if (profile.model === "REFERENCE_COST") {
    warnings.push("REFERENCE_COST_IS_LOW_EVIDENCE_NOT_QUOTE_TOUCH");
  }
  if (feeModel === null) {
    warnings.push("FEES_NOT_CONFIGURED_NET_PNL_IS_NULL");
  }
  const body = {
    contract_version:
      HISTORICAL_EXECUTION_MODEL_CONTRACT_VERSION,
    evidence_class: "SIMULATED_EXECUTION" as const,
    status,
    run_id: runId,
    frozen_decision_id: frozenDecisionId,
    frozen_candidate_id: frozenCandidateId,
    candidate_fingerprint: candidateFingerprint,
    family: entryEvidence.family,
    inventory: entryEvidence.inventory,
    study_stage: input.study_stage,
    prior_outcome_accessed: input.prior_outcome_accessed,
    source_manifest_ids: [...new Set(sourceManifestIds)].sort(),
    source_evidence_ids: {
      entry: entryEvidence.evidence_id,
      exit: exitWindow.evidence?.evidence_id ?? null,
    },
    source_contract: sourceContract,
    grading_profile: gradingProfile,
    candidate_construction_profile: candidateProfile,
    measurement_basis: measurementBasis,
    decision_frozen_at: decisionFrozenAt,
    candidate_frozen_at: candidateFrozenAt,
    profile_frozen_at: profileFrozenAt,
    outcome_accessed_at: outcomeAccessedAt,
    quantity,
    horizon,
    execution_profile: profile,
    fee_model: feeModel,
    evidence_strength:
      profile.model === "REFERENCE_COST"
        ? ("REFERENCE_MODEL" as const)
        : ("QUOTE_BACKED" as const),
    entry,
    exit,
    pnl: {
      formula:
        "(signed_exit_receipt - signed_entry_cost) * multiplier * quantity" as const,
      signed_entry_cost: entry.fill_price,
      signed_exit_receipt: exit.fill_price,
      multiplier: multiplier.toString(),
      quantity,
      gross_pnl: grossPnl?.toString() ?? null,
      entry_fees: entryFees?.toString() ?? null,
      exit_fees: exitFees?.toString() ?? null,
      total_fees: totalFees?.toString() ?? null,
      net_pnl: netPnl?.toString() ?? null,
    },
    broker_fill_verified: false as const,
    mutates_live_event: false as const,
    mutates_source_evidence: false as const,
    limitations,
    warnings,
  };
  return {
    ...body,
    simulation_id: stableEvidenceContentId(body),
  };
}
