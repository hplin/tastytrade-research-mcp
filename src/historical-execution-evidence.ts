import { ExactDecimal, type DecimalInput } from "./decimal.js";
import { stableEvidenceContentId } from "./evidence-cache.js";
import { parseHistoricalOptionSymbol } from "./historical-option-package.js";
import type { SpreadFamily } from "./package-pricing.js";
import { normalizeRfc3339 } from "./time.js";

export const HISTORICAL_EXECUTION_EVIDENCE_CONTRACT_VERSION =
  "1.0.0" as const;

export type HistoricalEvidenceScope = "SNAPSHOT" | "WINDOW";
export type HistoricalInventoryAction = "BUY_TO_OPEN" | "SELL_TO_OPEN";
export type HistoricalQuoteKind =
  | "NBBO"
  | "BBO"
  | "INDICATIVE"
  | "UNKNOWN";
export type HistoricalQuoteStatus =
  | "NORMAL"
  | "CLOSED"
  | "HALTED"
  | "SNIP"
  | "UNKNOWN";
export type HistoricalReferenceType =
  | "TRADE_REFERENCE"
  | "CANDLE_REFERENCE"
  | "MODEL_REFERENCE";
export type CoverageStatus = "COMPLETE" | "PARTIAL" | "NONE";

export type HistoricalResolutionIdentity = {
  profile_id: string;
  profile_version: string;
  native_resolution: string;
  effective_resolution: string;
};

export type HistoricalEvidenceSourceInput = {
  source_id: string;
  provider_id: string;
  dataset_id: string;
  license_scope_id: string;
  resolution_profile: HistoricalResolutionIdentity;
  source_revision: string;
  revision: number;
  manifest_id: string;
  normalized_content_id: string;
};

export type HistoricalExecutionInventoryLegInput = {
  provider_symbol: string;
  action: HistoricalInventoryAction;
  ratio: number;
  expiration: string;
  settlement: "AM" | "PM";
  multiplier: DecimalInput;
};

export type HistoricalLegQuoteInput = HistoricalEvidenceSourceInput & {
  provider_symbol: string;
  bid: DecimalInput | null;
  ask: DecimalInput | null;
  bid_size: number | null;
  ask_size: number | null;
  quote_kind: HistoricalQuoteKind;
  quote_status: HistoricalQuoteStatus;
  price_semantics: "OPTION_PREMIUM_PER_UNIT" | "UNKNOWN";
  source_timestamp: string | null;
  available_at: string | null;
  bar_end: string | null;
  retrieved_at: string | null;
};

export type HistoricalNativePackageQuoteInput =
  HistoricalEvidenceSourceInput & {
    signed_bid: DecimalInput | null;
    signed_ask: DecimalInput | null;
    bid_size: number | null;
    ask_size: number | null;
    quote_kind: HistoricalQuoteKind;
    quote_status: HistoricalQuoteStatus;
    price_semantics:
      | "SIGNED_CASH_FLOW_PER_UNIT"
      | "UNSIGNED_ABSOLUTE"
      | "UNKNOWN";
    source_timestamp: string | null;
    available_at: string | null;
    bar_end: string | null;
    retrieved_at: string | null;
  };

export type HistoricalReferenceInput = HistoricalEvidenceSourceInput & {
  evidence_type: HistoricalReferenceType;
  signed_value: DecimalInput | null;
  price_semantics:
    | "SIGNED_CASH_FLOW_PER_UNIT"
    | "UNSIGNED_ABSOLUTE"
    | "UNKNOWN";
  source_timestamp: string | null;
  available_at: string | null;
  bar_end: string | null;
  retrieved_at: string | null;
  model_version: string | null;
};

export type HistoricalEvidenceObservationInput = {
  observed_at: string;
  leg_quotes: HistoricalLegQuoteInput[];
  native_package_quote?: HistoricalNativePackageQuoteInput | null;
  references?: HistoricalReferenceInput[];
};

export type HistoricalExecutionEvidenceInput = {
  scope: HistoricalEvidenceScope;
  family: SpreadFamily;
  underlying: "SPX";
  candidate_fingerprint: string;
  quote_policy: {
    max_quote_age_ms: number;
    max_temporal_skew_ms: number;
    require_sizes: true;
  };
  expected_observation_times: string[];
  legs: HistoricalExecutionInventoryLegInput[];
  observations: HistoricalEvidenceObservationInput[];
};

export type NormalizedHistoricalEvidenceSource = {
  source_id: string;
  provider_id: string;
  dataset_id: string;
  license_scope_id: string;
  resolution_profile: HistoricalResolutionIdentity;
  source_revision: string;
  revision: number;
  manifest_id: string;
  normalized_content_id: string;
};

export type HistoricalQuoteCohort = Omit<
  NormalizedHistoricalEvidenceSource,
  "source_id" | "revision" | "manifest_id" | "normalized_content_id"
> & {
  cohort_id: string;
};

export type HistoricalExecutionInventoryLeg = {
  provider_symbol: string;
  streamer_symbol: string;
  option_side: "CALL" | "PUT";
  strike: string;
  action: HistoricalInventoryAction;
  ratio: number;
  inventory_quantity: number;
  expiration: string;
  settlement: "AM" | "PM";
  multiplier: string;
};

export type NormalizedHistoricalLegQuote = {
  provider_symbol: string;
  inventory_quantity: number;
  bid: string | null;
  ask: string | null;
  bid_size: number | null;
  ask_size: number | null;
  quote_kind: HistoricalQuoteKind;
  quote_status: HistoricalQuoteStatus;
  price_semantics: "OPTION_PREMIUM_PER_UNIT" | "UNKNOWN";
  source_timestamp: string | null;
  available_at: string | null;
  bar_end: string | null;
  retrieved_at: string | null;
  source: NormalizedHistoricalEvidenceSource | null;
  status: "COMPLETE" | "REJECTED";
  rejection_reasons: string[];
};

export type NormalizedHistoricalPackageQuote = {
  evidence_id: string;
  signed_bid: string | null;
  signed_ask: string | null;
  bid_size: number | null;
  ask_size: number | null;
  quote_kind: HistoricalQuoteKind | "SYNTHETIC";
  quote_status: HistoricalQuoteStatus;
  price_semantics:
    | "SIGNED_CASH_FLOW_PER_UNIT"
    | "UNSIGNED_ABSOLUTE"
    | "UNKNOWN";
  quote_origin: "NATIVE_PACKAGE" | "ALIGNED_LEG_QUOTES";
  source_timestamp: string | null;
  available_at: string | null;
  bar_end: string | null;
  retrieved_at: string | null;
  source: NormalizedHistoricalEvidenceSource | HistoricalQuoteCohort | null;
  usable_for_simulated_execution: boolean;
  rejection_reasons: string[];
};

export type NormalizedHistoricalReference = {
  evidence_id: string;
  evidence_type: HistoricalReferenceType;
  evidence_class: "VALUATION_ONLY";
  signed_value: string | null;
  price_semantics:
    | "SIGNED_CASH_FLOW_PER_UNIT"
    | "UNSIGNED_ABSOLUTE"
    | "UNKNOWN";
  source_timestamp: string | null;
  available_at: string | null;
  bar_end: string | null;
  retrieved_at: string | null;
  model_version: string | null;
  source: NormalizedHistoricalEvidenceSource;
  status: "AVAILABLE" | "NOT_AVAILABLE";
  rejection_reasons: string[];
};

export type HistoricalExecutionEvidenceObservation = {
  observation_id: string;
  observed_at: string;
  status: "COMPLETE" | "PARTIAL" | "REJECTED";
  quote_coverage: CoverageStatus;
  trade_coverage: CoverageStatus;
  candle_coverage: CoverageStatus;
  model_coverage: CoverageStatus;
  temporal_skew_ms: number | null;
  source_cohort: HistoricalQuoteCohort | null;
  leg_quotes: NormalizedHistoricalLegQuote[];
  native_package_quote: NormalizedHistoricalPackageQuote | null;
  synthetic_package_quote: NormalizedHistoricalPackageQuote;
  references: NormalizedHistoricalReference[];
  rejection_reasons: string[];
  warnings: string[];
};

export type HistoricalExecutionEvidenceResult = {
  contract_version:
    typeof HISTORICAL_EXECUTION_EVIDENCE_CONTRACT_VERSION;
  evidence_id: string;
  evidence_type: "HISTORICAL_EXACT_LEG_QUOTE_HANDOFF";
  evidence_phase: "POST_SESSION_REGRESSION";
  scope: HistoricalEvidenceScope;
  status: "AVAILABLE" | "PARTIAL" | "NOT_AVAILABLE";
  family: SpreadFamily;
  underlying: "SPX";
  candidate_fingerprint: string;
  verified_multiplier: string;
  broker_fill_verified: false;
  inventory: HistoricalExecutionInventoryLeg[];
  quote_policy: {
    max_quote_age_ms: number;
    max_temporal_skew_ms: number;
    require_sizes: true;
  };
  expected_observation_times: string[];
  observations: HistoricalExecutionEvidenceObservation[];
  coverage: {
    expected_observations: number;
    observed_observations: number;
    complete_quote_observations: number;
    partial_quote_observations: number;
    missing_observations: number;
    quote_coverage: CoverageStatus;
    trade_coverage: CoverageStatus;
    candle_coverage: CoverageStatus;
    model_coverage: CoverageStatus;
    gaps: Array<{
      observed_at: string;
      reasons: string[];
    }>;
  };
  evidence_layers: {
    valuation_only: {
      present: boolean;
      evidence_ids: string[];
    };
    simulated_execution: {
      input_status: CoverageStatus;
      result_present: false;
    };
    broker_execution: {
      verified: false;
      evidence_ids: [];
    };
  };
  source_manifest_ids: string[];
  normalized_content_ids: string[];
  warnings: string[];
};

const INPUT_TIMESTAMP_SCHEMA = {
  type: "string",
  pattern:
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
} as const;
const INPUT_DATE_SCHEMA = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
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
const INPUT_NULLABLE_TIMESTAMP_SCHEMA = {
  anyOf: [INPUT_TIMESTAMP_SCHEMA, { type: "null" }],
} as const;
const INPUT_NULLABLE_SIZE_SCHEMA = {
  anyOf: [
    { type: "integer", minimum: 0 },
    { type: "null" },
  ],
} as const;
const INPUT_CONTENT_ID_SCHEMA = {
  type: "string",
  pattern: "^sha256:[a-f0-9]{64}$",
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
const INPUT_SOURCE_PROPERTIES = {
  source_id: { type: "string", minLength: 1, maxLength: 200 },
  provider_id: { type: "string", minLength: 1, maxLength: 200 },
  dataset_id: { type: "string", minLength: 1, maxLength: 200 },
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
  revision: { type: "integer", minimum: 1 },
  manifest_id: INPUT_CONTENT_ID_SCHEMA,
  normalized_content_id: INPUT_CONTENT_ID_SCHEMA,
} as const;
const INPUT_SOURCE_REQUIRED = [
  "source_id",
  "provider_id",
  "dataset_id",
  "license_scope_id",
  "resolution_profile",
  "source_revision",
  "revision",
  "manifest_id",
  "normalized_content_id",
] as const;
const INPUT_QUOTE_COMMON_PROPERTIES = {
  bid_size: INPUT_NULLABLE_SIZE_SCHEMA,
  ask_size: INPUT_NULLABLE_SIZE_SCHEMA,
  quote_kind: {
    type: "string",
    enum: ["NBBO", "BBO", "INDICATIVE", "UNKNOWN"],
  },
  quote_status: {
    type: "string",
    enum: ["NORMAL", "CLOSED", "HALTED", "SNIP", "UNKNOWN"],
  },
  source_timestamp: INPUT_NULLABLE_TIMESTAMP_SCHEMA,
  available_at: INPUT_NULLABLE_TIMESTAMP_SCHEMA,
  bar_end: INPUT_NULLABLE_TIMESTAMP_SCHEMA,
  retrieved_at: INPUT_NULLABLE_TIMESTAMP_SCHEMA,
} as const;
const INPUT_QUOTE_COMMON_REQUIRED = [
  "bid_size",
  "ask_size",
  "quote_kind",
  "quote_status",
  "source_timestamp",
  "available_at",
  "bar_end",
  "retrieved_at",
] as const;

export const HISTORICAL_EXECUTION_EVIDENCE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["SNAPSHOT", "WINDOW"],
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
        underlying: { type: "string", const: "SPX" },
        candidate_fingerprint: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        quote_policy: {
          type: "object",
          properties: {
            max_quote_age_ms: {
              type: "integer",
              minimum: 0,
              maximum: 86400000,
            },
            max_temporal_skew_ms: {
              type: "integer",
              minimum: 0,
              maximum: 86400000,
            },
            require_sizes: { type: "boolean", const: true },
          },
          required: [
            "max_quote_age_ms",
            "max_temporal_skew_ms",
            "require_sizes",
          ],
          additionalProperties: false,
        },
        expected_observation_times: {
          type: "array",
          minItems: 1,
          maxItems: 10000,
          uniqueItems: true,
          items: INPUT_TIMESTAMP_SCHEMA,
        },
        legs: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              provider_symbol: {
                type: "string",
                minLength: 21,
                maxLength: 21,
              },
              action: {
                type: "string",
                enum: ["BUY_TO_OPEN", "SELL_TO_OPEN"],
              },
              ratio: { type: "integer", minimum: 1, maximum: 1000 },
              expiration: INPUT_DATE_SCHEMA,
              settlement: { type: "string", enum: ["AM", "PM"] },
              multiplier: INPUT_DECIMAL_SCHEMA,
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
        observations: {
          type: "array",
          maxItems: 10000,
          items: {
            type: "object",
            properties: {
              observed_at: INPUT_TIMESTAMP_SCHEMA,
              leg_quotes: {
                type: "array",
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    provider_symbol: {
                      type: "string",
                      minLength: 21,
                      maxLength: 21,
                    },
                    bid: INPUT_NULLABLE_DECIMAL_SCHEMA,
                    ask: INPUT_NULLABLE_DECIMAL_SCHEMA,
                    ...INPUT_QUOTE_COMMON_PROPERTIES,
                    price_semantics: {
                      type: "string",
                      enum: ["OPTION_PREMIUM_PER_UNIT", "UNKNOWN"],
                    },
                    ...INPUT_SOURCE_PROPERTIES,
                  },
                  required: [
                    "provider_symbol",
                    "bid",
                    "ask",
                    ...INPUT_QUOTE_COMMON_REQUIRED,
                    "price_semantics",
                    ...INPUT_SOURCE_REQUIRED,
                  ],
                  additionalProperties: false,
                },
              },
              native_package_quote: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      signed_bid: INPUT_NULLABLE_DECIMAL_SCHEMA,
                      signed_ask: INPUT_NULLABLE_DECIMAL_SCHEMA,
                      ...INPUT_QUOTE_COMMON_PROPERTIES,
                      price_semantics: {
                        type: "string",
                        enum: [
                          "SIGNED_CASH_FLOW_PER_UNIT",
                          "UNSIGNED_ABSOLUTE",
                          "UNKNOWN",
                        ],
                      },
                      ...INPUT_SOURCE_PROPERTIES,
                    },
                    required: [
                      "signed_bid",
                      "signed_ask",
                      ...INPUT_QUOTE_COMMON_REQUIRED,
                      "price_semantics",
                      ...INPUT_SOURCE_REQUIRED,
                    ],
                    additionalProperties: false,
                  },
                  { type: "null" },
                ],
              },
              references: {
                type: "array",
                maxItems: 100,
                items: {
                  type: "object",
                  properties: {
                    evidence_type: {
                      type: "string",
                      enum: [
                        "TRADE_REFERENCE",
                        "CANDLE_REFERENCE",
                        "MODEL_REFERENCE",
                      ],
                    },
                    signed_value: INPUT_NULLABLE_DECIMAL_SCHEMA,
                    price_semantics: {
                      type: "string",
                      enum: [
                        "SIGNED_CASH_FLOW_PER_UNIT",
                        "UNSIGNED_ABSOLUTE",
                        "UNKNOWN",
                      ],
                    },
                    source_timestamp: INPUT_NULLABLE_TIMESTAMP_SCHEMA,
                    available_at: INPUT_NULLABLE_TIMESTAMP_SCHEMA,
                    bar_end: INPUT_NULLABLE_TIMESTAMP_SCHEMA,
                    retrieved_at: INPUT_NULLABLE_TIMESTAMP_SCHEMA,
                    model_version: {
                      anyOf: [
                        {
                          type: "string",
                          minLength: 1,
                          maxLength: 200,
                        },
                        { type: "null" },
                      ],
                    },
                    ...INPUT_SOURCE_PROPERTIES,
                  },
                  required: [
                    "evidence_type",
                    "signed_value",
                    "price_semantics",
                    "source_timestamp",
                    "available_at",
                    "bar_end",
                    "retrieved_at",
                    "model_version",
                    ...INPUT_SOURCE_REQUIRED,
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ["observed_at", "leg_quotes"],
            additionalProperties: false,
          },
        },
      },
      required: [
        "scope",
        "family",
        "underlying",
        "candidate_fingerprint",
        "quote_policy",
        "expected_observation_times",
        "legs",
        "observations",
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const CONTENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

function unique(values: string[]): string[] {
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

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeIntegerOrNull(
  value: number | null,
  field: string,
): number | null {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error(`${field} must be a non-negative integer or null.`);
  }
  return value;
}

function duration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function normalizeTimestampOrNull(
  value: string | null,
  field: string,
): string | null {
  return value === null ? null : normalizeRfc3339(value, field);
}

function normalizeDecimalOrNull(
  value: DecimalInput | null,
  field: string,
  nonNegative: boolean,
): string | null {
  if (value === null) return null;
  const decimal = ExactDecimal.parse(value, field);
  if (nonNegative && decimal.compare(ExactDecimal.zero()) < 0) {
    throw new Error(`${field} must be non-negative.`);
  }
  return decimal.toString();
}

function normalizeResolution(
  input: HistoricalResolutionIdentity,
  field: string,
): HistoricalResolutionIdentity {
  return {
    profile_id: nonEmpty(input.profile_id, `${field}.profile_id`),
    profile_version: nonEmpty(
      input.profile_version,
      `${field}.profile_version`,
    ),
    native_resolution: nonEmpty(
      input.native_resolution,
      `${field}.native_resolution`,
    ),
    effective_resolution: nonEmpty(
      input.effective_resolution,
      `${field}.effective_resolution`,
    ),
  };
}

function normalizeSource(
  input: HistoricalEvidenceSourceInput,
  field: string,
): NormalizedHistoricalEvidenceSource {
  return {
    source_id: nonEmpty(input.source_id, `${field}.source_id`),
    provider_id: nonEmpty(input.provider_id, `${field}.provider_id`),
    dataset_id: nonEmpty(input.dataset_id, `${field}.dataset_id`),
    license_scope_id: nonEmpty(
      input.license_scope_id,
      `${field}.license_scope_id`,
    ),
    resolution_profile: normalizeResolution(
      input.resolution_profile,
      `${field}.resolution_profile`,
    ),
    source_revision: nonEmpty(
      input.source_revision,
      `${field}.source_revision`,
    ),
    revision: positiveInteger(input.revision, `${field}.revision`),
    manifest_id: contentId(input.manifest_id, `${field}.manifest_id`),
    normalized_content_id: contentId(
      input.normalized_content_id,
      `${field}.normalized_content_id`,
    ),
  };
}

function sourceCohort(
  source: NormalizedHistoricalEvidenceSource,
): HistoricalQuoteCohort {
  const identity = {
    provider_id: source.provider_id,
    dataset_id: source.dataset_id,
    license_scope_id: source.license_scope_id,
    resolution_profile: source.resolution_profile,
    source_revision: source.source_revision,
  };
  return {
    ...identity,
    cohort_id: stableEvidenceContentId(identity),
  };
}

function normalizeInventory(
  family: SpreadFamily,
  legs: HistoricalExecutionInventoryLegInput[],
): {
  inventory: HistoricalExecutionInventoryLeg[];
  multiplier: string;
} {
  const expectedCount =
    family === "DEBIT_VERTICAL" || family === "CREDIT_VERTICAL"
      ? 2
      : family === "IRON_CONDOR" || family === "DOUBLE_DIAGONAL"
        ? 4
        : (() => {
            throw new Error(`Unsupported spread family: ${String(family)}.`);
          })();
  if (legs.length !== expectedCount) {
    throw new Error(`${family} requires exactly ${expectedCount} legs.`);
  }

  const symbols = new Set<string>();
  const inventory = legs.map((leg, index) => {
    if (symbols.has(leg.provider_symbol)) {
      throw new Error(
        `Duplicate leg provider_symbol: ${leg.provider_symbol}.`,
      );
    }
    symbols.add(leg.provider_symbol);
    const parsed = parseHistoricalOptionSymbol(leg.provider_symbol);
    if (
      leg.action !== "BUY_TO_OPEN" &&
      leg.action !== "SELL_TO_OPEN"
    ) {
      throw new Error(
        `legs[${index}].action must freeze an opening inventory action.`,
      );
    }
    if (leg.settlement !== "AM" && leg.settlement !== "PM") {
      throw new Error(`legs[${index}].settlement must be AM or PM.`);
    }
    if (leg.expiration !== parsed.expiration) {
      throw new Error(
        `legs[${index}].expiration does not match OCC expiration ${parsed.expiration}.`,
      );
    }
    const ratio = positiveInteger(leg.ratio, `legs[${index}].ratio`);
    const multiplier = ExactDecimal.parse(
      leg.multiplier,
      `legs[${index}].multiplier`,
    );
    if (multiplier.compare(ExactDecimal.zero()) <= 0) {
      throw new Error(`legs[${index}].multiplier must be positive.`);
    }
    return {
      provider_symbol: leg.provider_symbol,
      streamer_symbol: parsed.streamer_symbol,
      option_side: parsed.option_side,
      strike: parsed.strike,
      action: leg.action,
      ratio,
      inventory_quantity:
        leg.action === "BUY_TO_OPEN" ? ratio : -ratio,
      expiration: leg.expiration,
      settlement: leg.settlement,
      multiplier: multiplier.toString(),
    };
  });

  const buyCount = inventory.filter(
    (item) => item.inventory_quantity > 0,
  ).length;
  if (buyCount !== expectedCount / 2) {
    throw new Error(
      `${family} requires equal numbers of long and short legs.`,
    );
  }
  const expirations = new Map<string, number>();
  for (const item of inventory) {
    expirations.set(
      item.expiration,
      (expirations.get(item.expiration) ?? 0) + 1,
    );
  }
  if (
    family === "DOUBLE_DIAGONAL" &&
    (expirations.size !== 2 ||
      [...expirations.values()].some((count) => count !== 2))
  ) {
    throw new Error(
      "DOUBLE_DIAGONAL requires two legs in each of two expirations.",
    );
  }
  if (family !== "DOUBLE_DIAGONAL" && expirations.size !== 1) {
    throw new Error(`${family} requires a single shared expiration.`);
  }

  const multipliers = unique(inventory.map((item) => item.multiplier));
  if (multipliers.length !== 1) {
    throw new Error(
      "All legs must use the same verified contract multiplier.",
    );
  }
  return { inventory, multiplier: multipliers[0] };
}

function quoteTimingReasons(
  observedAt: number,
  sourceTimestamp: string | null,
  availableAt: string | null,
  barEnd: string | null,
  retrievedAt: string | null,
  maxQuoteAgeMs: number,
): string[] {
  const reasons: string[] = [];
  if (!sourceTimestamp || !availableAt || !retrievedAt) {
    reasons.push("MISSING_QUOTE_TIMESTAMP");
    return reasons;
  }

  const sourceMs = Date.parse(sourceTimestamp);
  const availableMs = Date.parse(availableAt);
  const retrievedMs = Date.parse(retrievedAt);
  if (sourceMs > observedAt) reasons.push("FUTURE_SOURCE_TIMESTAMP");
  if (availableMs > observedAt) reasons.push("FUTURE_AVAILABLE_AT");
  if (
    sourceMs > availableMs ||
    availableMs > retrievedMs ||
    observedAt > retrievedMs
  ) {
    reasons.push("INVALID_TIMESTAMP_ORDER");
  }
  if (observedAt - sourceMs > maxQuoteAgeMs) {
    reasons.push("STALE_QUOTE");
  }
  if (barEnd !== null) {
    const barEndMs = Date.parse(barEnd);
    if (barEndMs > observedAt) reasons.push("INCOMPLETE_BAR");
    if (barEndMs > availableMs) reasons.push("INVALID_TIMESTAMP_ORDER");
  }
  return unique(reasons);
}

function normalizeLegQuote(
  input: HistoricalLegQuoteInput,
  inventory: HistoricalExecutionInventoryLeg,
  index: number,
  observedAt: number,
  policy: HistoricalExecutionEvidenceInput["quote_policy"],
): NormalizedHistoricalLegQuote {
  const field = `leg_quotes[${index}]`;
  const bid = normalizeDecimalOrNull(input.bid, `${field}.bid`, true);
  const ask = normalizeDecimalOrNull(input.ask, `${field}.ask`, true);
  const bidSize = nonNegativeIntegerOrNull(
    input.bid_size,
    `${field}.bid_size`,
  );
  const askSize = nonNegativeIntegerOrNull(
    input.ask_size,
    `${field}.ask_size`,
  );
  const sourceTimestamp = normalizeTimestampOrNull(
    input.source_timestamp,
    `${field}.source_timestamp`,
  );
  const availableAt = normalizeTimestampOrNull(
    input.available_at,
    `${field}.available_at`,
  );
  const barEnd = normalizeTimestampOrNull(
    input.bar_end,
    `${field}.bar_end`,
  );
  const retrievedAt = normalizeTimestampOrNull(
    input.retrieved_at,
    `${field}.retrieved_at`,
  );
  const source = normalizeSource(input, field);
  const reasons = quoteTimingReasons(
    observedAt,
    sourceTimestamp,
    availableAt,
    barEnd,
    retrievedAt,
    policy.max_quote_age_ms,
  );
  if (bid === null || ask === null) reasons.push("MISSING_LEG_QUOTE");
  if (
    bid !== null &&
    ask !== null &&
    ExactDecimal.parse(bid).compare(ExactDecimal.parse(ask)) > 0
  ) {
    reasons.push("CROSSED_LEG_QUOTE");
  }
  if (
    policy.require_sizes &&
    (bidSize === null ||
      askSize === null ||
      bidSize === 0 ||
      askSize === 0)
  ) {
    reasons.push("MISSING_LEG_SIZE");
  }
  if (
    input.quote_kind !== "NBBO" &&
    input.quote_kind !== "BBO"
  ) {
    reasons.push("UNUSABLE_QUOTE_KIND");
  }
  if (input.quote_status !== "NORMAL") {
    reasons.push("UNUSABLE_QUOTE_STATUS");
  }
  if (input.price_semantics !== "OPTION_PREMIUM_PER_UNIT") {
    reasons.push("UNCLEAR_PRICE_SEMANTICS");
  }

  return {
    provider_symbol: inventory.provider_symbol,
    inventory_quantity: inventory.inventory_quantity,
    bid,
    ask,
    bid_size: bidSize,
    ask_size: askSize,
    quote_kind: input.quote_kind,
    quote_status: input.quote_status,
    price_semantics: input.price_semantics,
    source_timestamp: sourceTimestamp,
    available_at: availableAt,
    bar_end: barEnd,
    retrieved_at: retrievedAt,
    source,
    status: reasons.length === 0 ? "COMPLETE" : "REJECTED",
    rejection_reasons: unique(reasons),
  };
}

function missingLegQuote(
  inventory: HistoricalExecutionInventoryLeg,
): NormalizedHistoricalLegQuote {
  return {
    provider_symbol: inventory.provider_symbol,
    inventory_quantity: inventory.inventory_quantity,
    bid: null,
    ask: null,
    bid_size: null,
    ask_size: null,
    quote_kind: "UNKNOWN",
    quote_status: "UNKNOWN",
    price_semantics: "UNKNOWN",
    source_timestamp: null,
    available_at: null,
    bar_end: null,
    retrieved_at: null,
    source: null,
    status: "REJECTED",
    rejection_reasons: ["MISSING_LEG_QUOTE", "MISSING_LEG_SIZE"],
  };
}

function packageSize(
  quotes: NormalizedHistoricalLegQuote[],
  side: "BID" | "ASK",
): number | null {
  const sizes = quotes.map((quote) => {
    const sellInventory = side === "BID";
    const usesBid =
      (sellInventory && quote.inventory_quantity > 0) ||
      (!sellInventory && quote.inventory_quantity < 0);
    const size = usesBid ? quote.bid_size : quote.ask_size;
    if (size === null || size <= 0) return null;
    return Math.floor(size / Math.abs(quote.inventory_quantity));
  });
  if (sizes.some((size) => size === null || size === 0)) return null;
  return Math.min(...(sizes as number[]));
}

function syntheticPackageQuote(
  quotes: NormalizedHistoricalLegQuote[],
  sourceCohortValue: HistoricalQuoteCohort | null,
  frameReasons: string[],
  inventory: HistoricalExecutionInventoryLeg[],
  policy: HistoricalExecutionEvidenceInput["quote_policy"],
): NormalizedHistoricalPackageQuote {
  let bid = ExactDecimal.zero();
  let ask = ExactDecimal.zero();
  let pricesAvailable = true;
  for (const quote of quotes) {
    if (quote.bid === null || quote.ask === null) {
      pricesAvailable = false;
      continue;
    }
    const ratio = Math.abs(quote.inventory_quantity);
    if (quote.inventory_quantity > 0) {
      bid = bid.add(ExactDecimal.parse(quote.bid).multiplyInteger(ratio));
      ask = ask.add(ExactDecimal.parse(quote.ask).multiplyInteger(ratio));
    } else {
      bid = bid.subtract(
        ExactDecimal.parse(quote.ask).multiplyInteger(ratio),
      );
      ask = ask.subtract(
        ExactDecimal.parse(quote.bid).multiplyInteger(ratio),
      );
    }
  }
  const timestamps = quotes
    .map((quote) => quote.source_timestamp)
    .filter((value): value is string => value !== null)
    .map(Date.parse);
  const availableTimes = quotes
    .map((quote) => quote.available_at)
    .filter((value): value is string => value !== null)
    .map(Date.parse);
  const retrievedTimes = quotes
    .map((quote) => quote.retrieved_at)
    .filter((value): value is string => value !== null)
    .map(Date.parse);
  const reasons = unique([
    ...quotes.flatMap((quote) => quote.rejection_reasons),
    ...frameReasons,
  ]);
  const bidSize = packageSize(quotes, "BID");
  const askSize = packageSize(quotes, "ASK");
  if (policy.require_sizes && (bidSize === null || askSize === null)) {
    reasons.push("INSUFFICIENT_PACKAGE_SIZE");
  }
  const normalizedBid = pricesAvailable ? bid.toString() : null;
  const normalizedAsk = pricesAvailable ? ask.toString() : null;
  if (
    normalizedBid !== null &&
    normalizedAsk !== null &&
    bid.compare(ask) > 0
  ) {
    reasons.push("CROSSED_SYNTHETIC_PACKAGE_QUOTE");
  }
  const body = {
    signed_bid: normalizedBid,
    signed_ask: normalizedAsk,
    bid_size: bidSize,
    ask_size: askSize,
    quote_kind: "SYNTHETIC" as const,
    quote_status: reasons.length === 0 ? ("NORMAL" as const) : ("UNKNOWN" as const),
    price_semantics: "SIGNED_CASH_FLOW_PER_UNIT" as const,
    quote_origin: "ALIGNED_LEG_QUOTES" as const,
    source_timestamp:
      timestamps.length === quotes.length
        ? new Date(Math.max(...timestamps)).toISOString()
        : null,
    available_at:
      availableTimes.length === quotes.length
        ? new Date(Math.max(...availableTimes)).toISOString()
        : null,
    bar_end: null,
    retrieved_at:
      retrievedTimes.length === quotes.length
        ? new Date(Math.max(...retrievedTimes)).toISOString()
        : null,
    source: sourceCohortValue,
    usable_for_simulated_execution: reasons.length === 0,
    rejection_reasons: unique(reasons),
  };
  return {
    evidence_id: stableEvidenceContentId({ inventory, quote: body }),
    ...body,
  };
}

function normalizeNativePackageQuote(
  input: HistoricalNativePackageQuoteInput,
  observedAt: number,
  policy: HistoricalExecutionEvidenceInput["quote_policy"],
  expectedCohortIds: string[],
  inventory: HistoricalExecutionInventoryLeg[],
): NormalizedHistoricalPackageQuote {
  const field = "native_package_quote";
  const signedBid = normalizeDecimalOrNull(
    input.signed_bid,
    `${field}.signed_bid`,
    false,
  );
  const signedAsk = normalizeDecimalOrNull(
    input.signed_ask,
    `${field}.signed_ask`,
    false,
  );
  const bidSize = nonNegativeIntegerOrNull(
    input.bid_size,
    `${field}.bid_size`,
  );
  const askSize = nonNegativeIntegerOrNull(
    input.ask_size,
    `${field}.ask_size`,
  );
  const sourceTimestamp = normalizeTimestampOrNull(
    input.source_timestamp,
    `${field}.source_timestamp`,
  );
  const availableAt = normalizeTimestampOrNull(
    input.available_at,
    `${field}.available_at`,
  );
  const barEnd = normalizeTimestampOrNull(
    input.bar_end,
    `${field}.bar_end`,
  );
  const retrievedAt = normalizeTimestampOrNull(
    input.retrieved_at,
    `${field}.retrieved_at`,
  );
  const source = normalizeSource(input, field);
  const reasons = quoteTimingReasons(
    observedAt,
    sourceTimestamp,
    availableAt,
    barEnd,
    retrievedAt,
    policy.max_quote_age_ms,
  );
  if (signedBid === null || signedAsk === null) {
    reasons.push("MISSING_NATIVE_PACKAGE_QUOTE");
  }
  if (
    signedBid !== null &&
    signedAsk !== null &&
    ExactDecimal.parse(signedBid).compare(ExactDecimal.parse(signedAsk)) >
      0
  ) {
    reasons.push("CROSSED_NATIVE_PACKAGE_QUOTE");
  }
  if (
    policy.require_sizes &&
    (bidSize === null ||
      askSize === null ||
      bidSize === 0 ||
      askSize === 0)
  ) {
    reasons.push("MISSING_NATIVE_PACKAGE_SIZE");
  }
  if (
    input.quote_kind !== "NBBO" &&
    input.quote_kind !== "BBO"
  ) {
    reasons.push("UNUSABLE_QUOTE_KIND");
  }
  if (input.quote_status !== "NORMAL") {
    reasons.push("UNUSABLE_QUOTE_STATUS");
  }
  if (input.price_semantics !== "SIGNED_CASH_FLOW_PER_UNIT") {
    reasons.push("UNCLEAR_PRICE_SEMANTICS");
  }
  if (
    expectedCohortIds.length !== 1 ||
    sourceCohort(source).cohort_id !== expectedCohortIds[0]
  ) {
    reasons.push("MIXED_QUOTE_COHORT");
  }

  const signedSemantics =
    input.price_semantics === "SIGNED_CASH_FLOW_PER_UNIT";
  const body = {
    signed_bid: signedSemantics ? signedBid : null,
    signed_ask: signedSemantics ? signedAsk : null,
    bid_size: bidSize,
    ask_size: askSize,
    quote_kind: input.quote_kind,
    quote_status: input.quote_status,
    price_semantics: input.price_semantics,
    quote_origin: "NATIVE_PACKAGE" as const,
    source_timestamp: sourceTimestamp,
    available_at: availableAt,
    bar_end: barEnd,
    retrieved_at: retrievedAt,
    source,
    usable_for_simulated_execution: reasons.length === 0,
    rejection_reasons: unique(reasons),
  };
  return {
    evidence_id: stableEvidenceContentId({ inventory, quote: body }),
    ...body,
  };
}

function normalizeReference(
  input: HistoricalReferenceInput,
  index: number,
  observedAt: number,
): NormalizedHistoricalReference {
  const field = `references[${index}]`;
  const signedValue = normalizeDecimalOrNull(
    input.signed_value,
    `${field}.signed_value`,
    false,
  );
  const sourceTimestamp = normalizeTimestampOrNull(
    input.source_timestamp,
    `${field}.source_timestamp`,
  );
  const availableAt = normalizeTimestampOrNull(
    input.available_at,
    `${field}.available_at`,
  );
  const barEnd = normalizeTimestampOrNull(
    input.bar_end,
    `${field}.bar_end`,
  );
  const retrievedAt = normalizeTimestampOrNull(
    input.retrieved_at,
    `${field}.retrieved_at`,
  );
  const source = normalizeSource(input, field);
  const modelVersion =
    input.model_version === null
      ? null
      : nonEmpty(input.model_version, `${field}.model_version`);
  const reasons: string[] = [];
  if (signedValue === null) reasons.push("MISSING_REFERENCE_VALUE");
  if (input.price_semantics !== "SIGNED_CASH_FLOW_PER_UNIT") {
    reasons.push("UNCLEAR_PRICE_SEMANTICS");
  }
  if (!sourceTimestamp || !availableAt || !retrievedAt) {
    reasons.push("MISSING_REFERENCE_TIMESTAMP");
  } else {
    const sourceMs = Date.parse(sourceTimestamp);
    const availableMs = Date.parse(availableAt);
    const retrievedMs = Date.parse(retrievedAt);
    if (sourceMs > observedAt) reasons.push("FUTURE_SOURCE_TIMESTAMP");
    if (availableMs > observedAt) reasons.push("FUTURE_AVAILABLE_AT");
    if (
      sourceMs > availableMs ||
      availableMs > retrievedMs ||
      observedAt > retrievedMs
    ) {
      reasons.push("INVALID_TIMESTAMP_ORDER");
    }
  }
  if (barEnd !== null && Date.parse(barEnd) > observedAt) {
    reasons.push("INCOMPLETE_BAR");
  }
  if (input.evidence_type === "MODEL_REFERENCE" && modelVersion === null) {
    reasons.push("MISSING_MODEL_VERSION");
  }
  const body = {
    evidence_type: input.evidence_type,
    evidence_class: "VALUATION_ONLY" as const,
    signed_value: signedValue,
    price_semantics: input.price_semantics,
    source_timestamp: sourceTimestamp,
    available_at: availableAt,
    bar_end: barEnd,
    retrieved_at: retrievedAt,
    model_version: modelVersion,
    source,
    status:
      reasons.length === 0
        ? ("AVAILABLE" as const)
        : ("NOT_AVAILABLE" as const),
    rejection_reasons: unique(reasons),
  };
  return {
    evidence_id: stableEvidenceContentId(body),
    ...body,
  };
}

function referenceCoverage(
  references: NormalizedHistoricalReference[],
  type: HistoricalReferenceType,
): CoverageStatus {
  const matching = references.filter(
    (reference) => reference.evidence_type === type,
  );
  if (matching.length === 0) return "NONE";
  return matching.some((reference) => reference.status === "AVAILABLE")
    ? matching.every((reference) => reference.status === "AVAILABLE")
      ? "COMPLETE"
      : "PARTIAL"
    : "PARTIAL";
}

function aggregateCoverage(
  observations: HistoricalExecutionEvidenceObservation[],
  expectedCount: number,
  selector: (
    observation: HistoricalExecutionEvidenceObservation,
  ) => CoverageStatus,
): CoverageStatus {
  const statuses = observations.map(selector);
  if (
    observations.length === expectedCount &&
    statuses.every((status) => status === "COMPLETE")
  ) {
    return "COMPLETE";
  }
  if (statuses.some((status) => status !== "NONE")) return "PARTIAL";
  return "NONE";
}

function normalizeObservation(
  input: HistoricalEvidenceObservationInput,
  inventory: HistoricalExecutionInventoryLeg[],
  policy: HistoricalExecutionEvidenceInput["quote_policy"],
): HistoricalExecutionEvidenceObservation {
  const observedAtText = normalizeRfc3339(
    input.observed_at,
    "observed_at",
  );
  const observedAt = Date.parse(observedAtText);
  const quotesBySymbol = new Map<string, HistoricalLegQuoteInput>();
  for (const quote of input.leg_quotes) {
    if (quotesBySymbol.has(quote.provider_symbol)) {
      throw new Error(
        `Duplicate leg quote provider_symbol: ${quote.provider_symbol}.`,
      );
    }
    quotesBySymbol.set(quote.provider_symbol, quote);
  }
  const unknownSymbols = [...quotesBySymbol.keys()].filter(
    (symbol) =>
      !inventory.some((item) => item.provider_symbol === symbol),
  );
  if (unknownSymbols.length > 0) {
    throw new Error(
      `Leg quote does not belong to frozen inventory: ${unknownSymbols.join(", ")}.`,
    );
  }

  const legQuotes = inventory.map((item, index) => {
    const quote = quotesBySymbol.get(item.provider_symbol);
    return quote
      ? normalizeLegQuote(quote, item, index, observedAt, policy)
      : missingLegQuote(item);
  });
  const cohorts = unique(
    legQuotes
      .map((quote) =>
        quote.source ? sourceCohort(quote.source).cohort_id : null,
      )
      .filter((value): value is string => value !== null),
  );
  const frameReasons: string[] = [];
  if (cohorts.length > 1) frameReasons.push("MIXED_QUOTE_COHORT");
  const sourceTimestamps = legQuotes
    .map((quote) => quote.source_timestamp)
    .filter((value): value is string => value !== null)
    .map(Date.parse);
  const temporalSkewMs =
    sourceTimestamps.length === inventory.length
      ? Math.max(...sourceTimestamps) - Math.min(...sourceTimestamps)
      : null;
  if (
    temporalSkewMs !== null &&
    temporalSkewMs > policy.max_temporal_skew_ms
  ) {
    frameReasons.push("TEMPORAL_SKEW_EXCEEDED");
  }
  const cohort =
    cohorts.length === 1
      ? sourceCohort(
          legQuotes.find((quote) => quote.source !== null)!.source!,
        )
      : null;
  const synthetic = syntheticPackageQuote(
    legQuotes,
    cohort,
    frameReasons,
    inventory,
    policy,
  );
  const native =
    input.native_package_quote === null ||
    input.native_package_quote === undefined
      ? null
      : normalizeNativePackageQuote(
          input.native_package_quote,
          observedAt,
          policy,
          cohorts,
          inventory,
        );
  const references = (input.references ?? []).map((reference, index) =>
    normalizeReference(reference, index, observedAt),
  );
  const quoteEvidencePresent =
    input.leg_quotes.length > 0 || native !== null;
  const usableQuote =
    synthetic.usable_for_simulated_execution ||
    native?.usable_for_simulated_execution === true;
  const rejectedProvidedQuote =
    synthetic.rejection_reasons.length > 0 ||
    (native !== null && native.rejection_reasons.length > 0);
  const status: HistoricalExecutionEvidenceObservation["status"] = usableQuote
    ? rejectedProvidedQuote
      ? "PARTIAL"
      : "COMPLETE"
    : "REJECTED";
  const quoteCoverage: CoverageStatus = usableQuote
    ? "COMPLETE"
    : quoteEvidencePresent
      ? "PARTIAL"
      : "NONE";
  const rejectionReasons = unique([
    ...frameReasons,
    ...synthetic.rejection_reasons,
    ...(native?.rejection_reasons ?? []),
  ]);
  const warnings: string[] = [];
  if (native !== null) {
    warnings.push("NATIVE_AND_SYNTHETIC_PACKAGE_QUOTES_REMAIN_DISTINCT");
  }
  if (references.length > 0) {
    warnings.push("VALUATION_REFERENCES_ARE_NOT_EXECUTION_EVIDENCE");
  }

  const body = {
    observed_at: observedAtText,
    status,
    quote_coverage: quoteCoverage,
    trade_coverage: referenceCoverage(references, "TRADE_REFERENCE"),
    candle_coverage: referenceCoverage(
      references,
      "CANDLE_REFERENCE",
    ),
    model_coverage: referenceCoverage(references, "MODEL_REFERENCE"),
    temporal_skew_ms: temporalSkewMs,
    source_cohort: cohort,
    leg_quotes: legQuotes,
    native_package_quote: native,
    synthetic_package_quote: synthetic,
    references,
    rejection_reasons: rejectionReasons,
    warnings,
  };
  return {
    observation_id: stableEvidenceContentId(body),
    ...body,
  };
}

export function normalizeHistoricalExecutionEvidence(
  input: HistoricalExecutionEvidenceInput,
): HistoricalExecutionEvidenceResult {
  if (input.scope !== "SNAPSHOT" && input.scope !== "WINDOW") {
    throw new Error(`Unsupported evidence scope: ${String(input.scope)}.`);
  }
  if (input.underlying !== "SPX") {
    throw new Error("Historical execution evidence supports SPX only.");
  }
  const candidateFingerprint = nonEmpty(
    input.candidate_fingerprint,
    "candidate_fingerprint",
  );
  const policy = {
    max_quote_age_ms: duration(
      input.quote_policy.max_quote_age_ms,
      "quote_policy.max_quote_age_ms",
    ),
    max_temporal_skew_ms: duration(
      input.quote_policy.max_temporal_skew_ms,
      "quote_policy.max_temporal_skew_ms",
    ),
    require_sizes: input.quote_policy.require_sizes,
  };
  if (policy.require_sizes !== true) {
    throw new Error(
      "quote_policy.require_sizes must be true for execution evidence.",
    );
  }
  const { inventory, multiplier } = normalizeInventory(
    input.family,
    input.legs,
  );
  const expectedTimes = input.expected_observation_times.map(
    (value, index) =>
      normalizeRfc3339(value, `expected_observation_times[${index}]`),
  );
  if (expectedTimes.length === 0) {
    throw new Error(
      "expected_observation_times must contain at least one timestamp.",
    );
  }
  if (new Set(expectedTimes).size !== expectedTimes.length) {
    throw new Error("expected_observation_times must be unique.");
  }
  if (input.scope === "SNAPSHOT" && expectedTimes.length !== 1) {
    throw new Error(
      "SNAPSHOT evidence requires exactly one expected observation.",
    );
  }
  const expectedSet = new Set(expectedTimes);
  const seenObservations = new Set<string>();
  for (const observation of input.observations) {
    const observedAt = normalizeRfc3339(
      observation.observed_at,
      "observed_at",
    );
    if (!expectedSet.has(observedAt)) {
      throw new Error(
        `Observation ${observedAt} is outside expected_observation_times.`,
      );
    }
    if (seenObservations.has(observedAt)) {
      throw new Error(`Duplicate observation: ${observedAt}.`);
    }
    seenObservations.add(observedAt);
  }
  const observations = input.observations
    .map((observation) =>
      normalizeObservation(observation, inventory, policy),
    )
    .sort(
      (left, right) =>
        Date.parse(left.observed_at) - Date.parse(right.observed_at),
    );
  const sortedExpectedTimes = [...expectedTimes].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );
  const missingTimes = sortedExpectedTimes.filter(
    (time) => !seenObservations.has(time),
  );
  const completeQuoteObservations = observations.filter(
    (observation) => observation.quote_coverage === "COMPLETE",
  ).length;
  const partialQuoteObservations = observations.filter(
    (observation) => observation.quote_coverage === "PARTIAL",
  ).length;
  const quoteCoverage = aggregateCoverage(
    observations,
    sortedExpectedTimes.length,
    (observation) => observation.quote_coverage,
  );
  const coverage = {
    expected_observations: sortedExpectedTimes.length,
    observed_observations: observations.length,
    complete_quote_observations: completeQuoteObservations,
    partial_quote_observations: partialQuoteObservations,
    missing_observations: missingTimes.length,
    quote_coverage: quoteCoverage,
    trade_coverage: aggregateCoverage(
      observations,
      sortedExpectedTimes.length,
      (observation) => observation.trade_coverage,
    ),
    candle_coverage: aggregateCoverage(
      observations,
      sortedExpectedTimes.length,
      (observation) => observation.candle_coverage,
    ),
    model_coverage: aggregateCoverage(
      observations,
      sortedExpectedTimes.length,
      (observation) => observation.model_coverage,
    ),
    gaps: missingTimes.map((observedAt) => ({
      observed_at: observedAt,
      reasons: ["MISSING_OBSERVATION"],
    })),
  };
  const references = observations.flatMap(
    (observation) => observation.references,
  );
  const allSources = [
    ...observations.flatMap((observation) =>
      observation.leg_quotes
        .map((quote) => quote.source)
        .filter(
          (
            source,
          ): source is NormalizedHistoricalEvidenceSource =>
            source !== null,
        ),
    ),
    ...observations.flatMap((observation) =>
      observation.native_package_quote?.source &&
      "manifest_id" in observation.native_package_quote.source
        ? [
            observation.native_package_quote
              .source as NormalizedHistoricalEvidenceSource,
          ]
        : [],
    ),
    ...references.map((reference) => reference.source),
  ];
  const status: HistoricalExecutionEvidenceResult["status"] =
    quoteCoverage === "COMPLETE"
      ? "AVAILABLE"
      : completeQuoteObservations > 0
        ? "PARTIAL"
        : "NOT_AVAILABLE";
  const warnings = [
    "QUOTE_EVIDENCE_DOES_NOT_VERIFY_BROKER_EXECUTION",
    "SIMULATED_EXECUTION_REQUIRES_A_SEPARATE_FROZEN_MODEL",
  ];
  if (quoteCoverage !== "COMPLETE") {
    warnings.push("QUOTE_COVERAGE_NOT_COMPLETE");
  }
  if (coverage.trade_coverage === "NONE") {
    warnings.push("TRADE_COVERAGE_NOT_PRESENT");
  }
  const body = {
    contract_version:
      HISTORICAL_EXECUTION_EVIDENCE_CONTRACT_VERSION,
    evidence_type: "HISTORICAL_EXACT_LEG_QUOTE_HANDOFF" as const,
    evidence_phase: "POST_SESSION_REGRESSION" as const,
    scope: input.scope,
    status,
    family: input.family,
    underlying: input.underlying,
    candidate_fingerprint: candidateFingerprint,
    verified_multiplier: multiplier,
    broker_fill_verified: false as const,
    inventory,
    quote_policy: policy,
    expected_observation_times: sortedExpectedTimes,
    observations,
    coverage,
    evidence_layers: {
      valuation_only: {
        present: references.length > 0,
        evidence_ids: references.map(
          (reference) => reference.evidence_id,
        ),
      },
      simulated_execution: {
        input_status: quoteCoverage,
        result_present: false as const,
      },
      broker_execution: {
        verified: false as const,
        evidence_ids: [] as [],
      },
    },
    source_manifest_ids: unique(
      allSources.map((source) => source.manifest_id),
    ).sort(),
    normalized_content_ids: unique(
      allSources.map((source) => source.normalized_content_id),
    ).sort(),
    warnings,
  };

  return {
    ...body,
    evidence_id: stableEvidenceContentId(body),
  };
}
