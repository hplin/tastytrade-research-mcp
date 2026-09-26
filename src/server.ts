import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  Ajv2020,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TastytradeBacktesterClient,
  type JsonObject,
} from "./backtester-client.js";
import {
  TastytradeHistoricalCandlesClient,
  type HistoricalCandlesBatchInput,
  type HistoricalCandlesInput,
  type HistoricalCandlesResult,
} from "./historical-candles.js";
import {
  CachedHistoricalCandlesService,
  evidenceCacheFromEnv,
  type FileEvidenceCache,
} from "./evidence-cache.js";
import {
  discoverHistoricalSpxCandidates,
  type HistoricalSpxCandidatesInput,
} from "./historical-spx-candidates.js";
import {
  getHistoricalSpxCandidateUniverse,
  type HistoricalSpxCandidateUniverseInput,
} from "./historical-spx-reconstruction.js";
import {
  verifyHistoricalFill,
  verifyHistoricalFillWithBacktester,
  type HistoricalFillInput,
  type HistoricalFillBacktesterInput,
} from "./historical-fill.js";
import {
  getHistoricalOptionPackageAtCheckpoint,
  getHistoricalOptionPackagePath,
  type HistoricalOptionPackageCheckpointInput,
  type HistoricalOptionPackagePathInput,
} from "./historical-option-package.js";
import {
  HISTORICAL_EXECUTION_EVIDENCE_INPUT_SCHEMA,
  normalizeHistoricalExecutionEvidence,
  type HistoricalExecutionEvidenceInput,
} from "./historical-execution-evidence.js";
import {
  priceOptionPackage,
  type PackagePricingInput,
} from "./package-pricing.js";
import {
  createSpreadBacktest,
  prepareSpreadResearch,
  runSpreadSimulation,
  type SpreadResearchInput,
} from "./spread-adapter.js";

const RFC3339_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$";
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const RFC3339_SCHEMA = {
  type: "string",
  pattern: RFC3339_PATTERN,
} as const;
const DATE_SCHEMA = {
  type: "string",
  pattern: DATE_PATTERN,
} as const;

const LOCAL_CHECKPOINT_SCHEMA = {
  type: "object",
  properties: {
    local_date: DATE_SCHEMA,
    local_time: {
      type: "string",
      pattern:
        "^([01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\\.[0-9]{1,3})?)?$",
    },
    timezone: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description:
        "IANA timezone such as America/Los_Angeles. Ambiguous and nonexistent local instants are rejected.",
    },
  },
  required: ["local_date", "local_time", "timezone"],
  additionalProperties: false,
} as const;

const RESOLUTION_PROFILE_SCHEMA = {
  type: "object",
  properties: {
    profile_id: {
      type: "string",
      enum: ["DEFAULT_5M", "HOURLY_VALUATION_RESEARCH"],
    },
    profile_version: { type: "string", const: "1.0.0" },
    provider_id: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
      maxLength: 100,
    },
    max_observation_age_minutes: {
      type: "integer",
      minimum: 0,
      maximum: 1440,
    },
    max_temporal_skew_minutes: {
      type: "integer",
      minimum: 0,
      maximum: 1440,
    },
    allowed_fallback_aggregations: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        pattern: "^[1-9][0-9]*(s|m|h|d|w)$",
      },
    },
  },
  required: ["profile_id", "profile_version"],
  additionalProperties: false,
} as const;

const CANDIDATE_CONSTRUCTION_PROFILE_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", minLength: 1, maxLength: 100 },
  },
  required: ["version"],
  additionalProperties: true,
} as const;

const DECIMAL_SCHEMA = {
  anyOf: [
    { type: "string", pattern: "^[+-]?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" },
    { type: "number" },
  ],
} as const;

const DD_IV_SELECTED_LEG_SCHEMA = {
  type: "object",
  properties: {
    role: {
      type: "string",
      enum: [
        "FRONT_PUT_SHORT",
        "FRONT_CALL_SHORT",
        "BACK_PUT_LONG",
        "BACK_CALL_LONG",
      ],
    },
    source_symbol: { type: "string", minLength: 1, maxLength: 200 },
    expiration: RFC3339_SCHEMA,
    option_side: { type: "string", enum: ["CALL", "PUT"] },
    strike: DECIMAL_SCHEMA,
  },
  required: [
    "role",
    "source_symbol",
    "expiration",
    "option_side",
    "strike",
  ],
  additionalProperties: false,
} as const;

const DD_IV_MATCHED_COORDINATE_COMMON_PROPERTIES = {
  measurement_id: { type: "string", minLength: 1, maxLength: 200 },
  front_expiration: RFC3339_SCHEMA,
  back_expiration: RFC3339_SCHEMA,
  option_side: { type: "string", enum: ["CALL", "PUT"] },
  tolerance: DECIMAL_SCHEMA,
  missing_policy: { type: "string", const: "NOT_AVAILABLE" },
  max_front_back_skew_ms: {
    type: "integer",
    minimum: 0,
    maximum: 604800000,
  },
} as const;

const DD_IV_MATCHED_COORDINATE_COMMON_REQUIRED = [
  "measurement_id",
  "measurement_basis",
  "front_expiration",
  "back_expiration",
  "option_side",
  "tolerance",
  "missing_policy",
  "max_front_back_skew_ms",
] as const;

const DD_IV_MATCHED_COORDINATE_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        ...DD_IV_MATCHED_COORDINATE_COMMON_PROPERTIES,
        measurement_basis: { type: "string", const: "MATCHED_DELTA" },
        target_delta: DECIMAL_SCHEMA,
        delta_convention: {
          type: "string",
          enum: [
            "SIGNED_FORWARD_DELTA_PERCENT",
            "ABSOLUTE_FORWARD_DELTA_PERCENT",
          ],
        },
        interpolation: {
          type: "object",
          properties: {
            allowed: { type: "boolean", const: true },
            method: { type: "string", const: "LINEAR_BY_DELTA" },
            max_bracket_width: DECIMAL_SCHEMA,
            max_bracket_skew_ms: {
              type: "integer",
              minimum: 0,
              maximum: 604800000,
            },
          },
          required: [
            "allowed",
            "method",
            "max_bracket_width",
            "max_bracket_skew_ms",
          ],
          additionalProperties: false,
        },
      },
      required: [
        ...DD_IV_MATCHED_COORDINATE_COMMON_REQUIRED,
        "target_delta",
        "delta_convention",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...DD_IV_MATCHED_COORDINATE_COMMON_PROPERTIES,
        measurement_basis: {
          type: "string",
          const: "MATCHED_FORWARD_MONEYNESS",
        },
        target_log_moneyness: DECIMAL_SCHEMA,
        moneyness_convention: {
          type: "string",
          const: "LN_STRIKE_OVER_FORWARD",
        },
        interpolation: {
          type: "object",
          properties: {
            allowed: { type: "boolean", const: true },
            method: {
              type: "string",
              const: "LINEAR_BY_LOG_MONEYNESS",
            },
            max_bracket_width: DECIMAL_SCHEMA,
            max_bracket_skew_ms: {
              type: "integer",
              minimum: 0,
              maximum: 604800000,
            },
          },
          required: [
            "allowed",
            "method",
            "max_bracket_width",
            "max_bracket_skew_ms",
          ],
          additionalProperties: false,
        },
      },
      required: [
        ...DD_IV_MATCHED_COORDINATE_COMMON_REQUIRED,
        "target_log_moneyness",
        "moneyness_convention",
      ],
      additionalProperties: false,
    },
  ],
} as const;

const DD_IV_MEASUREMENT_SCHEMA = {
  type: "object",
  properties: {
    contract_version: { type: "string", const: "1.0.0" },
    candidate_id: { type: "string", minLength: 1, maxLength: 200 },
    selected_legs: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: DD_IV_SELECTED_LEG_SCHEMA,
    },
    measurement_profile: {
      type: "object",
      properties: {
        profile_version: { type: "string", const: "1.0.0" },
        selected_leg: {
          type: "object",
          properties: {
            max_front_back_skew_ms: {
              type: "integer",
              minimum: 0,
              maximum: 604800000,
            },
            combined: {
              type: "object",
              properties: {
                aggregation: {
                  type: "string",
                  const: "WEIGHTED_ARITHMETIC_MEAN",
                },
                put_weight: DECIMAL_SCHEMA,
                call_weight: DECIMAL_SCHEMA,
              },
              required: ["aggregation", "put_weight", "call_weight"],
              additionalProperties: false,
            },
          },
          required: ["max_front_back_skew_ms"],
          additionalProperties: false,
        },
        matched_coordinates: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: DD_IV_MATCHED_COORDINATE_SCHEMA,
        },
      },
      required: [
        "profile_version",
        "selected_leg",
        "matched_coordinates",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "contract_version",
    "candidate_id",
    "selected_legs",
    "measurement_profile",
  ],
  additionalProperties: false,
} as const;

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const REFERENCES_SCHEMA = {
  type: "object",
  properties: {
    checkpoint_id: { type: "string", minLength: 1, maxLength: 200 },
    paper_order_id: { type: "string", minLength: 1, maxLength: 200 },
    position_id: { type: "string", minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
} as const;

const EVIDENCE_CACHE_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["BYPASS", "READ_WRITE", "REFRESH", "CACHE_ONLY"],
    },
    manifest_ids: {
      type: "array",
      minItems: 1,
      maxItems: 500,
      uniqueItems: true,
      items: {
        type: "string",
        pattern: "^sha256:[a-f0-9]{64}$",
      },
      description:
        "Exact immutable source-manifest or manifest-set IDs. Required for CACHE_ONLY and never used to fetch current provider data.",
    },
    dataset_id: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
      maxLength: 200,
    },
    license_scope_id: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
      maxLength: 200,
    },
    normalization_version: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
      maxLength: 200,
    },
    model_version: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
      maxLength: 200,
    },
    source_revision: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
      maxLength: 200,
    },
    as_of: RFC3339_SCHEMA,
    evidence_role: {
      type: "string",
      enum: [
        "ENTRY",
        "REFERENCE",
        "REFERENCE_PATH",
        "OUTCOME_3_TRADING_DAYS",
        "OUTCOME_5_TRADING_DAYS",
      ],
    },
    references: REFERENCES_SCHEMA,
  },
  required: ["mode"],
  additionalProperties: false,
} as const;

const PACKAGE_LEG_SCHEMA = {
  type: "object",
  properties: {
    symbol: { type: "string", minLength: 1 },
    action: {
      type: "string",
      enum: [
        "BUY_TO_OPEN",
        "SELL_TO_OPEN",
        "BUY_TO_CLOSE",
        "SELL_TO_CLOSE",
      ],
    },
    quantity: { type: "integer", minimum: 1 },
    expiration: RFC3339_SCHEMA,
    bid: DECIMAL_SCHEMA,
    ask: DECIMAL_SCHEMA,
    as_of: RFC3339_SCHEMA,
    source: { type: "string", minLength: 1 },
  },
  required: ["symbol", "action", "quantity", "expiration"],
  additionalProperties: false,
} as const;

const PACKAGE_PRICING_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        family: {
          type: "string",
          enum: [
            "DEBIT_VERTICAL",
            "CREDIT_VERTICAL",
            "IRON_CONDOR",
            "DOUBLE_DIAGONAL",
          ],
        },
        legs: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: PACKAGE_LEG_SCHEMA,
        },
        native_package: {
          type: "object",
          properties: {
            bid: DECIMAL_SCHEMA,
            ask: DECIMAL_SCHEMA,
            price_effect: {
              type: "string",
              enum: ["DEBIT", "CREDIT"],
            },
            as_of: RFC3339_SCHEMA,
            source: { type: "string", minLength: 1 },
          },
          required: ["bid", "ask", "price_effect", "as_of", "source"],
          additionalProperties: false,
        },
        evaluated_at: RFC3339_SCHEMA,
        max_quote_age_ms: { type: "integer", minimum: 0 },
        max_temporal_skew_ms: { type: "integer", minimum: 0 },
        references: REFERENCES_SCHEMA,
      },
      required: ["family", "legs"],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const BACKTEST_SELECTOR_SCHEMA = {
  type: "object",
  properties: {
    method: {
      type: "string",
      enum: ["DELTA", "PERCENTAGE_OTM", "CURRENT_PRICE_OFFSET", "PREMIUM"],
    },
    value: DECIMAL_SCHEMA,
  },
  required: ["method", "value"],
  additionalProperties: false,
} as const;

const HISTORICAL_CANDIDATE_SELECTOR_SCHEMA = {
  type: "object",
  properties: {
    ...BACKTEST_SELECTOR_SCHEMA.properties,
    days_until_expiration: {
      type: "integer",
      minimum: 1,
      maximum: 365,
    },
  },
  required: ["method", "value", "days_until_expiration"],
  additionalProperties: false,
} as const;

const HISTORICAL_SPX_CANDIDATES_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        underlying: { type: "string", enum: ["SPX"] },
        as_of: RFC3339_SCHEMA,
        local_checkpoint: LOCAL_CHECKPOINT_SCHEMA,
        min_dte: { type: "integer", minimum: 1, maximum: 365 },
        max_dte: { type: "integer", minimum: 1, maximum: 365 },
        sides: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { type: "string", enum: ["CALL", "PUT"] },
        },
        selector_grid: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: HISTORICAL_CANDIDATE_SELECTOR_SCHEMA,
        },
        lookback_calendar_days: {
          type: "integer",
          minimum: 0,
          maximum: 30,
        },
        resolution_profile: RESOLUTION_PROFILE_SCHEMA,
        candidate_construction_profile:
          CANDIDATE_CONSTRUCTION_PROFILE_SCHEMA,
        evidence_cache: EVIDENCE_CACHE_SCHEMA,
        phase: {
          type: "string",
          enum: ["REGRESSION_RESEARCH"],
        },
        references: REFERENCES_SCHEMA,
      },
      required: [
        "underlying",
        "selector_grid",
        "phase",
      ],
      oneOf: [
        { required: ["as_of"], not: { required: ["local_checkpoint"] } },
        { required: ["local_checkpoint"], not: { required: ["as_of"] } },
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const HISTORICAL_SPX_UNIVERSE_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        underlying: { type: "string", enum: ["SPX"] },
        as_of: RFC3339_SCHEMA,
        local_checkpoint: LOCAL_CHECKPOINT_SCHEMA,
        min_dte: { type: "integer", minimum: 1, maximum: 365 },
        max_dte: { type: "integer", minimum: 1, maximum: 365 },
        strike_min: { type: "integer", minimum: 1, maximum: 100000 },
        strike_max: { type: "integer", minimum: 1, maximum: 100000 },
        strike_step: { type: "integer", minimum: 1, maximum: 1000 },
        option_sides: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { type: "string", enum: ["CALL", "PUT"] },
        },
        expirations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: DATE_SCHEMA,
        },
        max_contracts: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
        },
        max_observation_age_minutes: {
          type: "integer",
          minimum: 5,
          maximum: 1440,
        },
        resolution_profile: RESOLUTION_PROFILE_SCHEMA,
        candidate_construction_profile:
          CANDIDATE_CONSTRUCTION_PROFILE_SCHEMA,
        dd_iv_measurement: DD_IV_MEASUREMENT_SCHEMA,
        evidence_cache: EVIDENCE_CACHE_SCHEMA,
        phase: {
          type: "string",
          enum: ["REGRESSION_RESEARCH"],
        },
        references: REFERENCES_SCHEMA,
      },
      required: [
        "underlying",
        "strike_min",
        "strike_max",
        "phase",
      ],
      oneOf: [
        { required: ["as_of"], not: { required: ["local_checkpoint"] } },
        { required: ["local_checkpoint"], not: { required: ["as_of"] } },
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const SPREAD_LEG_SCHEMA = {
  type: "object",
  properties: {
    provider_symbol: {
      type: "string",
      minLength: 1,
      description:
        "Exact tastytrade/OCC option symbol. It is preserved verbatim in simulate-trade requests.",
    },
    action: {
      type: "string",
      enum: [
        "BUY_TO_OPEN",
        "SELL_TO_OPEN",
        "BUY_TO_CLOSE",
        "SELL_TO_CLOSE",
      ],
    },
    quantity: { type: "integer", minimum: 1 },
    expiration: RFC3339_SCHEMA,
    strike: DECIMAL_SCHEMA,
    option_side: { type: "string", enum: ["CALL", "PUT"] },
    backtest_selector: BACKTEST_SELECTOR_SCHEMA,
    days_until_expiration: { type: "integer", minimum: 0 },
  },
  required: [
    "provider_symbol",
    "action",
    "quantity",
    "expiration",
    "strike",
    "option_side",
  ],
  additionalProperties: false,
} as const;

const SPREAD_REQUEST_PROPERTIES = {
  family: {
    type: "string",
    enum: [
      "DEBIT_VERTICAL",
      "CREDIT_VERTICAL",
      "IRON_CONDOR",
      "DOUBLE_DIAGONAL",
    ],
  },
  underlying: { type: "string", enum: ["SPX"] },
  legs: {
    type: "array",
    minItems: 2,
    maxItems: 4,
    items: SPREAD_LEG_SCHEMA,
  },
  entry_at: RFC3339_SCHEMA,
  exit_at: RFC3339_SCHEMA,
  intended_price: DECIMAL_SCHEMA,
  price_effect: { type: "string", enum: ["DEBIT", "CREDIT"] },
  allow_0dte: { type: "boolean" },
  backtest: {
    type: "object",
    properties: {
      start_date: DATE_SCHEMA,
      end_date: DATE_SCHEMA,
      entry_conditions: {
        type: "object",
        additionalProperties: true,
      },
      exit_conditions: {
        type: "object",
        additionalProperties: true,
      },
    },
    required: ["start_date", "end_date"],
    additionalProperties: false,
  },
  references: REFERENCES_SCHEMA,
} as const;

const SPREAD_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: SPREAD_REQUEST_PROPERTIES,
      required: [
        "family",
        "underlying",
        "legs",
        "entry_at",
        "exit_at",
        "intended_price",
        "price_effect",
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const HISTORICAL_FILL_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        family: SPREAD_REQUEST_PROPERTIES.family,
        underlying: SPREAD_REQUEST_PROPERTIES.underlying,
        legs: SPREAD_REQUEST_PROPERTIES.legs,
        submitted_at: RFC3339_SCHEMA,
        valid_until: RFC3339_SCHEMA,
        working_limit: DECIMAL_SCHEMA,
        acceptable_bound: DECIMAL_SCHEMA,
        price_effect: SPREAD_REQUEST_PROPERTIES.price_effect,
        verification_side: {
          type: "string",
          enum: ["ENTRY", "EXIT"],
        },
        fill_model: {
          type: "string",
          enum: ["LIMIT_TOUCH", "CONSERVATIVE_CROSS"],
        },
        allow_0dte: { type: "boolean" },
        max_observation_gap_ms: { type: "integer", minimum: 1 },
        live_assumption: {
          type: "string",
          enum: ["FILLED", "NOT_FILLED", "PENDING"],
        },
        path: {
          type: "array",
          items: {
            type: "object",
            properties: {
              as_of: RFC3339_SCHEMA,
              price: DECIMAL_SCHEMA,
              price_effect: {
                type: "string",
                enum: ["DEBIT", "CREDIT"],
              },
              source: { type: "string", minLength: 1 },
            },
            required: ["as_of", "price", "price_effect"],
            additionalProperties: false,
          },
        },
        evidence_source: { type: "string", minLength: 1 },
        references: {
          ...REFERENCES_SCHEMA,
          anyOf: [
            { required: ["paper_order_id"] },
            { required: ["checkpoint_id"] },
          ],
        },
      },
      required: [
        "submitted_at",
        "valid_until",
        "working_limit",
        "price_effect",
        "verification_side",
        "fill_model",
        "references",
      ],
      oneOf: [
        {
          required: ["family", "underlying", "legs"],
        },
        {
          required: ["path", "evidence_source"],
        },
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const HISTORICAL_OPTION_PACKAGE_LEG_SCHEMA = {
  type: "object",
  properties: {
    provider_symbol: {
      type: "string",
      minLength: 21,
      maxLength: 21,
      description:
        "Exact 21-character SPX/SPXW OCC option symbol, including root padding.",
    },
    action: {
      type: "string",
      enum: [
        "BUY_TO_OPEN",
        "SELL_TO_OPEN",
        "BUY_TO_CLOSE",
        "SELL_TO_CLOSE",
      ],
    },
    quantity: { type: "integer", minimum: 1 },
  },
  required: ["provider_symbol", "action"],
  additionalProperties: false,
} as const;

const HISTORICAL_OPTION_PACKAGE_COMMON_PROPERTIES = {
  family: {
    type: "string",
    enum: [
      "DEBIT_VERTICAL",
      "CREDIT_VERTICAL",
      "IRON_CONDOR",
      "DOUBLE_DIAGONAL",
    ],
  },
  underlying: { type: "string", enum: ["SPX"] },
  legs: {
    type: "array",
    minItems: 2,
    maxItems: 4,
    items: HISTORICAL_OPTION_PACKAGE_LEG_SCHEMA,
  },
  phase: {
    type: "string",
    enum: ["REGRESSION_RESEARCH"],
  },
  resolution_profile: RESOLUTION_PROFILE_SCHEMA,
  candidate_construction_profile:
    CANDIDATE_CONSTRUCTION_PROFILE_SCHEMA,
  references: REFERENCES_SCHEMA,
  evidence_cache: EVIDENCE_CACHE_SCHEMA,
} as const;

const HISTORICAL_OPTION_PACKAGE_CHECKPOINT_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        ...HISTORICAL_OPTION_PACKAGE_COMMON_PROPERTIES,
        as_of: RFC3339_SCHEMA,
        local_checkpoint: LOCAL_CHECKPOINT_SCHEMA,
        max_observation_age_minutes: {
          type: "integer",
          minimum: 0,
          maximum: 1440,
        },
        max_temporal_skew_minutes: {
          type: "integer",
          minimum: 0,
          maximum: 1440,
        },
      },
      required: ["family", "underlying", "legs", "phase"],
      oneOf: [
        { required: ["as_of"], not: { required: ["local_checkpoint"] } },
        { required: ["local_checkpoint"], not: { required: ["as_of"] } },
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const HISTORICAL_OPTION_PACKAGE_PATH_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        ...HISTORICAL_OPTION_PACKAGE_COMMON_PROPERTIES,
        start_time: RFC3339_SCHEMA,
        end_time: RFC3339_SCHEMA,
        resolution: {
          type: "string",
          enum: ["1m", "5m", "15m", "30m", "1h"],
        },
      },
      required: [
        "family",
        "underlying",
        "start_time",
        "end_time",
        "resolution",
        "legs",
        "phase",
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const CANDLE_SESSION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "ALL" },
        timezone: { type: "string", minLength: 1 },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "REGULAR" },
        timezone: { type: "string", minLength: 1 },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "CUSTOM" },
        timezone: { type: "string", minLength: 1 },
        start_time: {
          type: "string",
          pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
        },
        end_time: {
          type: "string",
          pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
        },
      },
      required: ["kind", "timezone", "start_time", "end_time"],
      additionalProperties: false,
    },
  ],
} as const;

const HISTORICAL_CANDLES_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        symbol: { type: "string", minLength: 1 },
        streamer_symbol: {
          type: "string",
          minLength: 1,
          description:
            "DXLink streamer-symbol from tastytrade instrument metadata. Defaults to symbol for equities and indices.",
        },
        instrument_type: {
          type: "string",
          enum: [
            "EQUITY",
            "INDEX",
            "OPTION",
            "FUTURE",
            "FUTURE_OPTION",
            "CRYPTO",
          ],
        },
        interval: {
          type: "string",
          pattern: "^[1-9][0-9]*(s|m|h|d|w)$",
        },
        start_time: RFC3339_SCHEMA,
        end_time: RFC3339_SCHEMA,
        session: CANDLE_SESSION_SCHEMA,
        resolution_profile: RESOLUTION_PROFILE_SCHEMA,
        evidence_cache: EVIDENCE_CACHE_SCHEMA,
        deadline_ms: {
          type: "integer",
          minimum: 1,
          maximum: 60000,
          description:
            "DXLink snapshot deadline for the whole request. Cannot be combined with deprecated timeout_ms.",
        },
        max_output_candles: {
          type: "integer",
          minimum: 1,
          maximum: 250000,
          description:
            "Maximum retained and returned candle rows per symbol after indexed-event deduplication.",
        },
        max_received_events: {
          type: "integer",
          minimum: 1,
          maximum: 1000000,
          description:
            "Maximum aggregate Candle protocol rows received across all symbols in this request.",
        },
        max_buffer_bytes: {
          type: "integer",
          minimum: 1,
          maximum: 134217728,
          description:
            "Maximum aggregate accounted bytes for queued wire messages and retained indexed candle state.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: 60000,
          description:
            "Deprecated compatibility alias for deadline_ms.",
        },
        max_candles: {
          type: "integer",
          minimum: 1,
          maximum: 20000,
          description:
            "Deprecated compatibility shorthand that applies the same limit to max_output_candles per symbol and max_received_events per request. Cannot be combined with either explicit field.",
        },
      },
      required: [
        "symbol",
        "instrument_type",
        "interval",
        "start_time",
        "end_time",
      ],
      additionalProperties: false,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const BACKTEST_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      description:
        "Raw request body accepted by tastytrade POST /backtests. Kept provider-native so new upstream fields remain usable.",
      additionalProperties: true,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const SIMULATE_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      description:
        "Raw request body accepted by tastytrade POST /simulate-trade.",
      additionalProperties: true,
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const ID_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Backtest ID returned by tastytrade.",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

export const TOOLS: Tool[] = [
  {
    name: "tastytrade_get_backtest_available_dates",
    description:
      "List tastytrade Backtester symbols and their available historical date ranges. Use this before regression tests to verify SPY, XSP, SPX, or other symbol coverage.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "tastytrade_list_backtests",
    description:
      "List backtests submitted for the authenticated tastytrade API grant.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "tastytrade_create_backtest",
    description:
      "Create a tastytrade historical options backtest. This is research-only and does not place brokerage orders.",
    inputSchema: BACKTEST_REQUEST_SCHEMA,
  },
  {
    name: "tastytrade_get_backtest",
    description:
      "Get a tastytrade backtest by ID, including its current status and results when completed.",
    inputSchema: ID_SCHEMA,
  },
  {
    name: "tastytrade_get_backtest_logs",
    description:
      "Get tastytrade Backtester execution logs for a backtest ID.",
    inputSchema: ID_SCHEMA,
  },
  {
    name: "tastytrade_cancel_backtest",
    description:
      "Cancel a running research backtest. This affects only the Backtester job and never a brokerage order.",
    inputSchema: ID_SCHEMA,
  },
  {
    name: "tastytrade_simulate_trade",
    description:
      "Simulate a single historical option trade with tastytrade Backtester and return its historical path/results. Research-only; no brokerage order is placed.",
    inputSchema: SIMULATE_REQUEST_SCHEMA,
  },
  {
    name: "tastytrade_price_option_package",
    description:
      "Price a 2-4 leg option package with explicit native-package, synthetic-natural, and midpoint-reference provenance using exact decimal arithmetic.",
    inputSchema: PACKAGE_PRICING_SCHEMA,
  },
  {
    name: "tastytrade_discover_historical_spx_candidates",
    description:
      "Discover checkpoint-safe historical SPX contracts from a selector grid. Defaults to the versioned 5-minute cohort; native-hour RTH reconstruction is explicit via HOURLY_VALUATION_RESEARCH. Accepts RFC3339 or unambiguous IANA-local checkpoints, supports private exact-manifest source replay, and preserves an opaque candidate-construction profile without implementing grading or final leg selection.",
    inputSchema: HISTORICAL_SPX_CANDIDATES_SCHEMA,
  },
  {
    name: "tastytrade_get_historical_spx_candidate_universe",
    description:
      "Return a bounded timestamp-safe SPXW contract universe with explicit versioned resolution/cohort metadata and optional private immutable source manifests. An optional versioned DD IV request attaches separate RESEARCH_ONLY selected-leg, matched-delta, and matched-forward-moneyness handoff cohorts without changing production term_structure, grading, routing, fills, or P&L.",
    inputSchema: HISTORICAL_SPX_UNIVERSE_SCHEMA,
  },
  {
    name: "tastytrade_get_historical_option_package_at_checkpoint",
    description:
      "Reconstruct an exact-leg SPX option package reference from completed bars at an RFC3339 or unambiguous IANA-local checkpoint. Supports private exact-manifest replay and returns explicit requested/native/effective resolution, session, alignment, age/skew, fallback, and cohort metadata; candle closes remain valuation-only.",
    inputSchema: HISTORICAL_OPTION_PACKAGE_CHECKPOINT_SCHEMA,
  },
  {
    name: "tastytrade_get_historical_option_package_path",
    description:
      "Reconstruct a short exact-leg SPX package reference path from aligned completed bars under a versioned resolution profile. Optional private manifests support cache-only replay; declared fallback order is explicit, cohorts remain distinct, and gaps are reported without interpolation or forward fill.",
    inputSchema: HISTORICAL_OPTION_PACKAGE_PATH_SCHEMA,
  },
  {
    name: "tastytrade_normalize_historical_execution_evidence",
    description:
      "Normalize caller-supplied exact-leg historical quote snapshots or windows into a deterministic, immutable-cache-linked handoff. Preserves signed package cash flows and keeps valuation references, simulated-execution inputs, and broker execution strictly separate; it does not fetch data, select a model, or verify a broker fill.",
    inputSchema: HISTORICAL_EXECUTION_EVIDENCE_INPUT_SCHEMA,
  },
  {
    name: "tastytrade_prepare_spx_spread",
    description:
      "Normalize an SPX debit vertical, credit vertical, iron condor, or double diagonal into deterministic Backtester and exact-leg simulation requests without submitting it.",
    inputSchema: SPREAD_REQUEST_SCHEMA,
  },
  {
    name: "tastytrade_simulate_spx_spread",
    description:
      "Run exact-leg historical simulation for a normalized SPX defined-risk spread and return a stable regression result contract.",
    inputSchema: SPREAD_REQUEST_SCHEMA,
  },
  {
    name: "tastytrade_create_spx_spread_backtest",
    description:
      "Create an aggregate SPX spread Backtester job when the structure can be represented faithfully enough by relative leg selectors. Double diagonals remain exact-simulation only.",
    inputSchema: SPREAD_REQUEST_SCHEMA,
  },
  {
    name: "tastytrade_verify_historical_fill",
    description:
      "Verify whether a frozen paper-order limit was touched during a forward historical interval using either caller-supplied historical package points or Backtester exact-leg simulation. Returns separate post-session evidence and never rewrites the live paper event.",
    inputSchema: HISTORICAL_FILL_SCHEMA,
  },
  {
    name: "tastytrade_get_historical_candles",
    description:
      "Retrieve normalized historical OHLCV candles with explicit bar_start, bar_end, available_at, retrieved_at, and versioned resolution/cohort metadata. Supports private immutable cache/offline replay, exact UTC/session windows, canonical provider symbol matching, independent resource budgets, and no resampling.",
    inputSchema: HISTORICAL_CANDLES_SCHEMA,
  },
];

const schemaValidator = new Ajv2020({
  allErrors: true,
  strict: false,
});
const TOOL_VALIDATORS = new Map<string, ValidateFunction>(
  TOOLS.map((tool) => [
    tool.name,
    schemaValidator.compile(tool.inputSchema),
  ]),
);

export type BacktesterService = {
  getAvailableDates(): Promise<unknown>;
  listBacktests(): Promise<unknown>;
  createBacktest(request: JsonObject): Promise<unknown>;
  getBacktest(id: string): Promise<unknown>;
  getBacktestLogs(id: string): Promise<unknown>;
  cancelBacktest(id: string): Promise<unknown>;
  simulateTrade(request: JsonObject): Promise<unknown>;
};

export type HistoricalCandlesService = {
  getHistoricalCandles(
    request: HistoricalCandlesInput,
  ): Promise<HistoricalCandlesResult>;
  getHistoricalCandlesBatch?(
    request: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]>;
};

export type ResearchServices = {
  backtester?: BacktesterService;
  candles?: HistoricalCandlesService;
  evidenceCache?: FileEvidenceCache | null;
};

function objectArg(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as JsonObject;
}

function stringArg(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error(
      `${field} must be a non-empty string no longer than 200 characters.`,
    );
  }
  return value;
}

function requestArg<T>(args: Record<string, unknown>): T {
  return objectArg(args.request, "request") as T;
}

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function createResearchServer(
  services: ResearchServices = {},
): Server {
  const backtester = services.backtester ?? new TastytradeBacktesterClient();
  const sourceCandles =
    services.candles ?? new TastytradeHistoricalCandlesClient();
  const evidenceCache =
    "evidenceCache" in services
      ? services.evidenceCache ?? null
      : evidenceCacheFromEnv();
  const candles = new CachedHistoricalCandlesService(
    sourceCandles,
    evidenceCache,
  );
  const reconstructionCandles = sourceCandles.getHistoricalCandlesBatch
    ? {
        getHistoricalCandles: (request: HistoricalCandlesInput) =>
          candles.getHistoricalCandles(request),
        getHistoricalCandlesBatch: (request: HistoricalCandlesBatchInput) =>
          candles.getHistoricalCandlesBatch!(request),
      }
    : undefined;
  const server = new Server(
    {
      name: "tastytrade-research-mcp",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const validator = TOOL_VALIDATORS.get(request.params.name);
    if (!validator) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    if (!validator(args)) {
      const details = (validator.errors ?? [])
        .map(
          (error) =>
            `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
        )
        .join("; ");
      throw new Error(
        `Invalid arguments for ${request.params.name}: ${details}`,
      );
    }

    switch (request.params.name) {
      case "tastytrade_get_backtest_available_dates":
        return toolResult(await backtester.getAvailableDates());
      case "tastytrade_list_backtests":
        return toolResult(await backtester.listBacktests());
      case "tastytrade_create_backtest":
        return toolResult(
          await backtester.createBacktest(objectArg(args.request, "request")),
        );
      case "tastytrade_get_backtest":
        return toolResult(
          await backtester.getBacktest(stringArg(args.id, "id")),
        );
      case "tastytrade_get_backtest_logs":
        return toolResult(
          await backtester.getBacktestLogs(stringArg(args.id, "id")),
        );
      case "tastytrade_cancel_backtest":
        return toolResult(
          await backtester.cancelBacktest(stringArg(args.id, "id")),
        );
      case "tastytrade_simulate_trade":
        return toolResult(
          await backtester.simulateTrade(objectArg(args.request, "request")),
        );
      case "tastytrade_price_option_package":
        return toolResult(
          priceOptionPackage(requestArg<PackagePricingInput>(args)),
        );
      case "tastytrade_discover_historical_spx_candidates":
        return toolResult(
          await discoverHistoricalSpxCandidates(
            backtester,
            requestArg<HistoricalSpxCandidatesInput>(args),
            reconstructionCandles,
          ),
        );
      case "tastytrade_get_historical_spx_candidate_universe":
        if (!reconstructionCandles) {
          throw new Error(
            "Historical SPX candidate universe requires batched candle retrieval.",
          );
        }
        return toolResult(
          await getHistoricalSpxCandidateUniverse(
            reconstructionCandles,
            requestArg<HistoricalSpxCandidateUniverseInput>(args),
          ),
        );
      case "tastytrade_get_historical_option_package_at_checkpoint":
        if (!reconstructionCandles) {
          throw new Error(
            "Historical option package reconstruction requires batched candle retrieval.",
          );
        }
        return toolResult(
          await getHistoricalOptionPackageAtCheckpoint(
            reconstructionCandles,
            requestArg<HistoricalOptionPackageCheckpointInput>(args),
          ),
        );
      case "tastytrade_get_historical_option_package_path":
        if (!reconstructionCandles) {
          throw new Error(
            "Historical option package paths require batched candle retrieval.",
          );
        }
        return toolResult(
          await getHistoricalOptionPackagePath(
            reconstructionCandles,
            requestArg<HistoricalOptionPackagePathInput>(args),
          ),
        );
      case "tastytrade_normalize_historical_execution_evidence":
        return toolResult(
          normalizeHistoricalExecutionEvidence(
            requestArg<HistoricalExecutionEvidenceInput>(args),
          ),
        );
      case "tastytrade_prepare_spx_spread":
        return toolResult(
          prepareSpreadResearch(requestArg<SpreadResearchInput>(args)),
        );
      case "tastytrade_simulate_spx_spread":
        return toolResult(
          await runSpreadSimulation(
            backtester,
            requestArg<SpreadResearchInput>(args),
          ),
        );
      case "tastytrade_create_spx_spread_backtest":
        return toolResult(
          await createSpreadBacktest(
            backtester,
            requestArg<SpreadResearchInput>(args),
          ),
        );
      case "tastytrade_verify_historical_fill":
        if (Array.isArray(objectArg(args.request, "request").path)) {
          return toolResult(
            verifyHistoricalFill(requestArg<HistoricalFillInput>(args)),
          );
        }
        return toolResult(
          await verifyHistoricalFillWithBacktester(
            backtester,
            requestArg<HistoricalFillBacktesterInput>(args),
          ),
        );
      case "tastytrade_get_historical_candles":
        return toolResult(
          await candles.getHistoricalCandles(
            requestArg<HistoricalCandlesInput>(args),
          ),
        );
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  });

  return server;
}
