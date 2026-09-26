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
      getHistoricalCandles: jest.fn(async (request) =>
        request.symbol === "SPX"
          ? {
              candles: [
                {
                  source_time: "2026-04-15T14:25:00.000Z",
                  close: "5300",
                  implied_volatility: "0.2",
                },
              ],
              snapshot_complete: true,
              snapshot_truncated: false,
              resampled: false,
            }
          : {
              candles: [],
              resampled: false,
            },
      ),
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) => ({
          symbol: instrument.symbol,
          candles: [],
          snapshot_complete: true,
          snapshot_truncated: false,
        })),
      ),
    };
    const server = createResearchServer({ backtester, candles });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(15);
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "tastytrade_price_option_package",
          "tastytrade_discover_historical_spx_candidates",
          "tastytrade_get_historical_spx_candidate_universe",
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

      const candidates = textResult(
        await client.callTool({
          name: "tastytrade_discover_historical_spx_candidates",
          arguments: {
            request: {
              underlying: "SPX",
              as_of: "2026-04-15T14:30:00.000Z",
              sides: ["PUT"],
              selector_grid: [
                {
                  method: "DELTA",
                  value: "20",
                  days_until_expiration: 28,
                },
              ],
              phase: "REGRESSION_RESEARCH",
            },
          },
        }),
      );
      expect(candidates).toMatchObject({
        status: "NOT_AVAILABLE",
        evidence_type: "HISTORICAL_SELECTOR_CANDIDATE_SET",
        evidence_phase: "REGRESSION_RESEARCH",
        surface: {
          atm_iv: null,
          skew: null,
          term_structure: null,
        },
        capabilities: {
          backtester_entry_time_configurable: false,
          exact_checkpoint_selection: false,
        },
      });
      expect(backtester.createBacktest).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: "SPX",
          legs: [
            expect.objectContaining({
              side: "put",
              strikeSelection: "delta",
              delta: 20,
              daysUntilExpiration: 28,
            }),
          ],
        }),
      );
      expect(candles.getHistoricalCandlesBatch).toHaveBeenCalled();
      expect(
        candles.getHistoricalCandlesBatch.mock.calls.every(
          ([request]) => request.instruments.length <= 20,
        ),
      ).toBe(true);

      const universe = textResult(
        await client.callTool({
          name: "tastytrade_get_historical_spx_candidate_universe",
          arguments: {
            request: {
              underlying: "SPX",
              as_of: "2026-04-15T14:30:00.000Z",
              min_dte: 21,
              max_dte: 21,
              strike_min: 5200,
              strike_max: 5400,
              strike_step: 100,
              option_sides: ["CALL", "PUT"],
              phase: "REGRESSION_RESEARCH",
            },
          },
        }),
      );
      expect(universe).toMatchObject({
        status: "NOT_AVAILABLE",
        evidence_type: "HISTORICAL_SPX_CANDIDATE_UNIVERSE",
        coverage: {
          requested_contract_count: 6,
          verified_contract_count: 0,
          missing_contract_count: 6,
        },
      });

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
