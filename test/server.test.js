import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, jest, test } from "@jest/globals";
import { createResearchServer } from "../dist/server.js";

function textResult(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  return JSON.parse(text);
}

describe("MCP research server", () => {
  test("lists and invokes the expanded research tool surface", async () => {
    const backtester = {
      getAvailableDates: jest.fn(async () => []),
      listBacktests: jest.fn(async () => []),
      createBacktest: jest.fn(async () => ({ id: "job-1", status: "pending" })),
      getBacktest: jest.fn(async () => ({ id: "job-1", status: "completed" })),
      getBacktestLogs: jest.fn(async () => ({ trials: [] })),
      cancelBacktest: jest.fn(async () => ""),
      simulateTrade: jest.fn(async () => ({ snapshots: [] })),
    };
    const candles = {
      getHistoricalCandles: jest.fn(async () => ({
        candles: [],
        resampled: false,
      })),
    };
    const server = createResearchServer({ backtester, candles });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(13);
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "tastytrade_price_option_package",
          "tastytrade_verify_historical_fill",
          "tastytrade_get_historical_candles",
          "tastytrade_prepare_spx_spread",
          "tastytrade_simulate_spx_spread",
          "tastytrade_create_spx_spread_backtest",
        ]),
      );

      const priced = textResult(
        await client.callTool({
          name: "tastytrade_price_option_package",
          arguments: {
            request: {
              family: "CREDIT_VERTICAL",
              evaluated_at: "2026-09-24T20:00:00.000Z",
              legs: [
                {
                  symbol: "SHORT",
                  action: "SELL_TO_OPEN",
                  quantity: 1,
                  expiration: "2026-10-16T20:00:00.000Z",
                  bid: "2",
                  ask: "2.1",
                  as_of: "2026-09-24T20:00:00.000Z",
                  source: "fixture",
                },
                {
                  symbol: "LONG",
                  action: "BUY_TO_OPEN",
                  quantity: 1,
                  expiration: "2026-10-16T20:00:00.000Z",
                  bid: "0.9",
                  ask: "1",
                  as_of: "2026-09-24T20:00:00.000Z",
                  source: "fixture",
                },
              ],
            },
          },
        }),
      );
      expect(priced.synthetic_natural).toMatchObject({
        value: "1",
        price_effect: "CREDIT",
      });

      const candleResult = textResult(
        await client.callTool({
          name: "tastytrade_get_historical_candles",
          arguments: {
            request: {
              symbol: "SPY",
              instrument_type: "EQUITY",
              interval: "5m",
              start_time: "2026-09-24T14:00:00.000Z",
              end_time: "2026-09-24T15:00:00.000Z",
            },
          },
        }),
      );
      expect(candleResult.resampled).toBe(false);
      expect(candles.getHistoricalCandles).toHaveBeenCalledTimes(1);

      await expect(
        client.callTool({
          name: "tastytrade_prepare_spx_spread",
          arguments: {
            request: {
              family: "DEBIT_VERTICAL",
              underlying: "SPX",
              entry_at: "2026-09-24T14:30:00.000Z",
              exit_at: "2026-09-25T14:30:00.000Z",
              intended_price: "1",
              price_effect: "DEBIT",
              legs: [
                {
                  provider_symbol: "ONE",
                  action: "NOT_AN_ACTION",
                  quantity: 1,
                  expiration: "2026-10-16T20:00:00.000Z",
                  strike: "7500",
                  option_side: "CALL",
                },
                {
                  provider_symbol: "TWO",
                  action: "ALSO_BAD",
                  quantity: 1,
                  expiration: "2026-10-16T20:00:00.000Z",
                  strike: "7550",
                  option_side: "CALL",
                },
              ],
            },
          },
        }),
      ).rejects.toThrow("Invalid arguments");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
