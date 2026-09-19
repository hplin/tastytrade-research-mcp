import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { TastytradeBacktesterClient, type JsonObject } from "./backtester-client.js";

const client = new TastytradeBacktesterClient();

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
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

const TOOLS: Tool[] = [
  {
    name: "tastytrade_get_backtest_available_dates",
    description:
      "List tastytrade Backtester symbols and their available historical date ranges. Use this before regression tests to verify SPY, XSP, SPX, or other symbol coverage.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "tastytrade_list_backtests",
    description: "List backtests submitted for the authenticated tastytrade API grant.",
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
    description: "Get tastytrade Backtester execution logs for a backtest ID.",
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
];

function objectArg(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as JsonObject;
}

function stringArg(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error(`${field} must be a non-empty string no longer than 200 characters.`);
  }
  return value;
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

const server = new Server(
  {
    name: "tastytrade-research-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};

  switch (request.params.name) {
    case "tastytrade_get_backtest_available_dates":
      return toolResult(await client.getAvailableDates());
    case "tastytrade_list_backtests":
      return toolResult(await client.listBacktests());
    case "tastytrade_create_backtest":
      return toolResult(
        await client.createBacktest(objectArg(args.request, "request")),
      );
    case "tastytrade_get_backtest":
      return toolResult(await client.getBacktest(stringArg(args.id, "id")));
    case "tastytrade_get_backtest_logs":
      return toolResult(await client.getBacktestLogs(stringArg(args.id, "id")));
    case "tastytrade_cancel_backtest":
      return toolResult(await client.cancelBacktest(stringArg(args.id, "id")));
    case "tastytrade_simulate_trade":
      return toolResult(
        await client.simulateTrade(objectArg(args.request, "request")),
      );
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
