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
  discoverHistoricalSpxCandidates,
  type HistoricalSpxCandidatesInput,
} from "./historical-spx-candidates.js";
import {
  getHistoricalSpxCandidateUniverse,
  type HistoricalSpxCandidateUniverseInput,
} from "./historical-spx-reconstruction.js";
import {
  verifyHistoricalFillWithBacktester,
  type HistoricalFillBacktesterInput,
} from "./historical-fill.js";
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

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const DECIMAL_SCHEMA = {
  anyOf: [
    { type: "string", pattern: "^[+-]?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" },
    { type: "number" },
  ],
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
        phase: {
          type: "string",
          enum: ["REGRESSION_RESEARCH"],
        },
        references: REFERENCES_SCHEMA,
      },
      required: [
        "underlying",
        "as_of",
        "selector_grid",
        "phase",
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
        phase: {
          type: "string",
          enum: ["REGRESSION_RESEARCH"],
        },
        references: REFERENCES_SCHEMA,
      },
      required: [
        "underlying",
        "as_of",
        "strike_min",
        "strike_max",
        "phase",
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
        references: {
          ...REFERENCES_SCHEMA,
          anyOf: [
            { required: ["paper_order_id"] },
            { required: ["checkpoint_id"] },
          ],
        },
      },
      required: [
        "family",
        "underlying",
        "legs",
        "submitted_at",
        "valid_until",
        "working_limit",
        "price_effect",
        "verification_side",
        "fill_model",
        "references",
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
        timeout_ms: { type: "integer", minimum: 1, maximum: 60000 },
        max_candles: { type: "integer", minimum: 1, maximum: 20000 },
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
      "Discover checkpoint-safe historical SPX contracts from a selector grid. DELTA and PERCENTAGE_OTM selectors are deterministically reconstructed from completed DXLink SPX/SPXW candles at or before as_of; exact-timestamp Backtester selection remains a fallback, and stale or future evidence always fails closed.",
    inputSchema: HISTORICAL_SPX_CANDIDATES_SCHEMA,
  },
  {
    name: "tastytrade_get_historical_spx_candidate_universe",
    description:
      "Return a bounded timestamp-safe SPXW contract universe across requested strikes, sides, and min/mid/max DTE expirations. Exact OCC identity is returned only when completed DXLink evidence exists at or before as_of; the tool is research-only and never selects a final spread.",
    inputSchema: HISTORICAL_SPX_UNIVERSE_SCHEMA,
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
      "Verify whether a frozen paper-order limit was touched during a forward historical interval. Returns separate post-session evidence and never rewrites the live paper event.",
    inputSchema: HISTORICAL_FILL_SCHEMA,
  },
  {
    name: "tastytrade_get_historical_candles",
    description:
      "Retrieve normalized historical OHLCV candles from tastytrade DXLink for an exact UTC and session window, with source timestamps and explicit gap warnings. No resampling is performed.",
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
  const candles =
    services.candles ?? new TastytradeHistoricalCandlesClient();
  const reconstructionCandles = candles.getHistoricalCandlesBatch
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
