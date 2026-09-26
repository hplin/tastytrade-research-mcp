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
                  source_time:
                    request.interval === "1h"
                      ? "2026-04-15T13:30:00.000Z"
                      : "2026-04-15T14:25:00.000Z",
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
          streamer_symbol: instrument.streamer_symbol,
          interval: request.interval,
          candles: [],
          snapshot_complete: true,
          snapshot_truncated: false,
          warnings: [],
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
      expect(tools.tools).toHaveLength(17);
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "tastytrade_price_option_package",
          "tastytrade_discover_historical_spx_candidates",
          "tastytrade_get_historical_spx_candidate_universe",
          "tastytrade_get_historical_option_package_at_checkpoint",
          "tastytrade_get_historical_option_package_path",
          "tastytrade_verify_historical_fill",
          "tastytrade_get_historical_candles",
          "tastytrade_prepare_spx_spread",
          "tastytrade_simulate_spx_spread",
          "tastytrade_create_spx_spread_backtest",
        ]),
      );
      const candleTool = tools.tools.find(
        (tool) => tool.name === "tastytrade_get_historical_candles",
      );
      expect(
        candleTool.inputSchema.properties.request.properties,
      ).toMatchObject({
        resolution_profile: expect.any(Object),
        deadline_ms: { maximum: 60000 },
        max_output_candles: { maximum: 250000 },
        max_received_events: { maximum: 1000000 },
        max_buffer_bytes: { maximum: 134217728 },
        timeout_ms: { maximum: 60000 },
        max_candles: { maximum: 20000 },
      });
      const candidateTool = tools.tools.find(
        (tool) =>
          tool.name === "tastytrade_discover_historical_spx_candidates",
      );
      expect(
        candidateTool.inputSchema.properties.request.properties,
      ).toMatchObject({
        local_checkpoint: expect.any(Object),
        resolution_profile: expect.any(Object),
        candidate_construction_profile: expect.any(Object),
      });
      const universeTool = tools.tools.find(
        (tool) =>
          tool.name === "tastytrade_get_historical_spx_candidate_universe",
      );
      expect(
        universeTool.inputSchema.properties.request.properties,
      ).toMatchObject({
        dd_iv_measurement: expect.any(Object),
      });

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
              deadline_ms: 5000,
              max_output_candles: 1000,
              max_received_events: 5000,
              max_buffer_bytes: 1048576,
            },
          },
        }),
      );
      expect(candleResult.resampled).toBe(false);
      expect(candles.getHistoricalCandles).toHaveBeenCalledWith(
        expect.objectContaining({
          deadline_ms: 5000,
          max_output_candles: 1000,
          max_received_events: 5000,
          max_buffer_bytes: 1048576,
        }),
      );

      const candidates = textResult(
        await client.callTool({
          name: "tastytrade_discover_historical_spx_candidates",
          arguments: {
            request: {
              underlying: "SPX",
              local_checkpoint: {
                local_date: "2026-04-15",
                local_time: "07:30",
                timezone: "America/Los_Angeles",
              },
              sides: ["PUT"],
              selector_grid: [
                {
                  method: "DELTA",
                  value: "20",
                  days_until_expiration: 28,
                },
              ],
              resolution_profile: {
                profile_id: "HOURLY_VALUATION_RESEARCH",
                profile_version: "1.0.0",
              },
              candidate_construction_profile: {
                version: "candidate-construction/7",
                grading: { external: true },
              },
              phase: "REGRESSION_RESEARCH",
            },
          },
        }),
      );
      expect(candidates).toMatchObject({
        status: "NOT_AVAILABLE",
        as_of: "2026-04-15T14:30:00.000Z",
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
        resolution_profile: {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          requested_aggregation: "1h",
        },
        candidate_construction_profile: {
          version: "candidate-construction/7",
          grading: { external: true },
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
              max_dte: 35,
              expirations: ["2026-05-06", "2026-05-20"],
              strike_min: 5200,
              strike_max: 5400,
              strike_step: 100,
              option_sides: ["CALL", "PUT"],
              dd_iv_measurement: {
                contract_version: "1.0.0",
                candidate_id: "mcp-dd-fixture",
                selected_legs: [
                  {
                    role: "FRONT_PUT_SHORT",
                    source_symbol: "FRONT-PUT",
                    expiration: "2026-05-06T20:00:00.000Z",
                    option_side: "PUT",
                    strike: "5200",
                  },
                  {
                    role: "FRONT_CALL_SHORT",
                    source_symbol: "FRONT-CALL",
                    expiration: "2026-05-06T20:00:00.000Z",
                    option_side: "CALL",
                    strike: "5400",
                  },
                  {
                    role: "BACK_PUT_LONG",
                    source_symbol: "BACK-PUT",
                    expiration: "2026-05-20T20:00:00.000Z",
                    option_side: "PUT",
                    strike: "5200",
                  },
                  {
                    role: "BACK_CALL_LONG",
                    source_symbol: "BACK-CALL",
                    expiration: "2026-05-20T20:00:00.000Z",
                    option_side: "CALL",
                    strike: "5400",
                  },
                ],
                measurement_profile: {
                  profile_version: "1.0.0",
                  selected_leg: {
                    max_front_back_skew_ms: 600000,
                  },
                  matched_coordinates: [
                    {
                      measurement_id: "put-25d",
                      measurement_basis: "MATCHED_DELTA",
                      front_expiration: "2026-05-06T20:00:00.000Z",
                      back_expiration: "2026-05-20T20:00:00.000Z",
                      option_side: "PUT",
                      target_delta: "25",
                      delta_convention:
                        "ABSOLUTE_FORWARD_DELTA_PERCENT",
                      tolerance: "1",
                      missing_policy: "NOT_AVAILABLE",
                      max_front_back_skew_ms: 600000,
                    },
                  ],
                },
              },
              phase: "REGRESSION_RESEARCH",
            },
          },
        }),
      );
      expect(universe).toMatchObject({
        status: "NOT_AVAILABLE",
        evidence_type: "HISTORICAL_SPX_CANDIDATE_UNIVERSE",
        coverage: {
          requested_contract_count: 12,
          verified_contract_count: 0,
          missing_contract_count: 12,
        },
        dd_iv_measurement_handoff: {
          contract_version: "1.0.0",
          grading_role: "RESEARCH_ONLY",
          candidate_id: "mcp-dd-fixture",
          legacy_term_structure_replaced: false,
          selected_leg_measurement: {
            status: "NOT_AVAILABLE",
          },
          matched_measurements: [
            {
              measurement_id: "put-25d",
              status: "NOT_AVAILABLE",
            },
          ],
        },
      });

      const checkpointPackage = textResult(
        await client.callTool({
          name: "tastytrade_get_historical_option_package_at_checkpoint",
          arguments: {
            request: {
              family: "DEBIT_VERTICAL",
              underlying: "SPX",
              as_of: "2026-08-27T14:30:00.000Z",
              legs: [
                {
                  provider_symbol: "SPXW  260924C07750000",
                  action: "BUY_TO_OPEN",
                },
                {
                  provider_symbol: "SPXW  260924C07800000",
                  action: "SELL_TO_OPEN",
                },
              ],
              max_observation_age_minutes: 30,
              max_temporal_skew_minutes: 10,
              phase: "REGRESSION_RESEARCH",
              references: { checkpoint_id: "checkpoint-35" },
            },
          },
        }),
      );
      expect(checkpointPackage).toMatchObject({
        status: "NOT_AVAILABLE",
        reference_value: null,
        effective_resolution: "5m",
      });

      const packagePath = textResult(
        await client.callTool({
          name: "tastytrade_get_historical_option_package_path",
          arguments: {
            request: {
              family: "DEBIT_VERTICAL",
              underlying: "SPX",
              start_time: "2026-08-27T14:30:00.000Z",
              end_time: "2026-08-27T14:50:00.000Z",
              resolution: "5m",
              legs: [
                {
                  provider_symbol: "SPXW  260924C07750000",
                  action: "BUY_TO_OPEN",
                },
                {
                  provider_symbol: "SPXW  260924C07800000",
                  action: "SELL_TO_OPEN",
                },
              ],
              phase: "REGRESSION_RESEARCH",
              references: { checkpoint_id: "checkpoint-35" },
            },
          },
        }),
      );
      expect(packagePath).toMatchObject({
        status: "NOT_AVAILABLE",
        expected_point_count: 4,
        observed_point_count: 0,
        fill_verification_compatible: true,
      });

      const directFill = textResult(
        await client.callTool({
          name: "tastytrade_verify_historical_fill",
          arguments: {
            request: {
              submitted_at: "2026-08-27T14:30:00.000Z",
              valid_until: "2026-08-27T14:40:00.000Z",
              working_limit: "5.5",
              price_effect: "DEBIT",
              verification_side: "ENTRY",
              fill_model: "LIMIT_TOUCH",
              path: [
                {
                  as_of: "2026-08-27T14:30:00.000Z",
                  price: "6",
                  price_effect: "DEBIT",
                  source: "fixture",
                },
                {
                  as_of: "2026-08-27T14:35:00.000Z",
                  price: "5.5",
                  price_effect: "DEBIT",
                  source: "fixture",
                },
                {
                  as_of: "2026-08-27T14:40:00.000Z",
                  price: "5",
                  price_effect: "DEBIT",
                  source: "fixture",
                },
              ],
              evidence_source: "fixture",
              references: { checkpoint_id: "checkpoint-35" },
              max_observation_gap_ms: 300000,
            },
          },
        }),
      );
      expect(directFill).toMatchObject({
        status: "TOUCHED",
        assessment_status: "TOUCHED",
        first_touch_at: "2026-08-27T14:35:00.000Z",
      });
      expect(backtester.simulateTrade).not.toHaveBeenCalled();

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
