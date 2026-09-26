import { readFileSync } from "node:fs";
import { describe, expect, jest, test } from "@jest/globals";
import { getHistoricalSpxCandidateUniverse } from "../dist/historical-spx-reconstruction.js";
import { runSpreadSimulation } from "../dist/spread-adapter.js";

function loadFixture(name) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

const fixture = loadFixture("spx-universe-acceptance-2026-08-25.json");
const CHECKPOINT = "2026-08-25T14:30:00.000Z";
const REQUEST = {
  underlying: "SPX",
  as_of: CHECKPOINT,
  min_dte: 21,
  max_dte: 35,
  strike_min: 7300,
  strike_max: 8050,
  strike_step: 25,
  option_sides: ["CALL", "PUT"],
  max_contracts: 500,
  max_observation_age_minutes: 1_440,
  phase: "REGRESSION_RESEARCH",
  references: { checkpoint_id: "spx-2026-08-25-0730-pt-acceptance" },
};

function candleResult(symbol, streamerSymbol, candles) {
  return {
    contract_version: "1.0.0",
    symbol,
    streamer_symbol: streamerSymbol,
    instrument_type: symbol === "SPX" ? "INDEX" : "OPTION",
    interval: "5m",
    requested_range: {
      start: "2026-08-24T14:25:00.000Z",
      end: CHECKPOINT,
    },
    actual_range:
      candles.length === 0
        ? null
        : {
            start: candles[0].source_time,
            end: candles.at(-1).source_time,
          },
    timezone: "UTC",
    session: "ALL",
    source: "tastytrade-dxlink",
    source_timestamp_unit: "epoch_milliseconds",
    snapshot_complete: true,
    snapshot_truncated: false,
    resampled: false,
    candles,
    warnings: [],
  };
}

function fixtureCandles() {
  const bySymbol = new Map(
    fixture.options.map((option) => [option.symbol, option]),
  );
  return {
    getHistoricalCandles: jest.fn(async () =>
      candleResult(
        fixture.underlying.symbol,
        fixture.underlying.streamer_symbol,
        [structuredClone(fixture.underlying.candle)],
      ),
    ),
    getHistoricalCandlesBatch: jest.fn(async (input) =>
      input.instruments.map((instrument) => {
        const option = bySymbol.get(instrument.symbol);
        return candleResult(
          instrument.symbol,
          instrument.streamer_symbol,
          option ? [structuredClone(option.candle)] : [],
        );
      }),
    ),
  };
}

function nearestDeltaWithWing(contracts, optionSide, wingOffset) {
  const byStrike = new Map(
    contracts
      .filter((contract) => contract.option_side === optionSide)
      .map((contract) => [Number(contract.strike), contract]),
  );
  return contracts
    .filter(
      (contract) =>
        contract.option_side === optionSide &&
        contract.historical_delta !== null &&
        byStrike.has(Number(contract.strike) + wingOffset),
    )
    .map((contract) => ({
      short: contract,
      wing: byStrike.get(Number(contract.strike) + wingOffset),
      error: Math.abs(Math.abs(Number(contract.historical_delta)) - 20),
    }))
    .sort(
      (left, right) =>
        left.error - right.error ||
        left.short.observation_age_ms - right.short.observation_age_ms ||
        Number(left.short.strike) - Number(right.short.strike),
    )[0];
}

function constructIronCondor(universe) {
  const expiration = "2026-09-22T20:00:00.000Z";
  const contracts = universe.contracts.filter(
    (contract) => contract.expiration === expiration,
  );
  const put = nearestDeltaWithWing(contracts, "PUT", -50);
  const call = nearestDeltaWithWing(contracts, "CALL", 50);
  if (!put || !call) {
    return {
      status: "INSUFFICIENT_TIMESTAMP_SAFE_CONTRACTS",
      missing: [
        ...(put ? [] : ["PUT_SHORT_OR_50_POINT_WING"]),
        ...(call ? [] : ["CALL_SHORT_OR_50_POINT_WING"]),
      ],
    };
  }
  return {
    status: "CONSTRUCTED",
    family: "IRON_CONDOR",
    phase: "REPLAY_DECISION",
    frozen_at: universe.as_of,
    checkpoint_id: universe.references.checkpoint_id,
    legs: [
      { ...put.wing, action: "BUY_TO_OPEN" },
      { ...put.short, action: "SELL_TO_OPEN" },
      { ...call.short, action: "SELL_TO_OPEN" },
      { ...call.wing, action: "BUY_TO_OPEN" },
    ],
  };
}

function evaluateDoubleDiagonal(universe) {
  const requirements = [
    [
      "FRONT_PUT_DELTA",
      "2026-09-15T20:00:00.000Z",
      "PUT",
      20,
      "SELL_TO_OPEN",
    ],
    [
      "FRONT_CALL_DELTA",
      "2026-09-15T20:00:00.000Z",
      "CALL",
      20,
      "SELL_TO_OPEN",
    ],
    [
      "BACK_PUT_DELTA",
      "2026-09-29T20:00:00.000Z",
      "PUT",
      30,
      "BUY_TO_OPEN",
    ],
    [
      "BACK_CALL_DELTA",
      "2026-09-29T20:00:00.000Z",
      "CALL",
      30,
      "BUY_TO_OPEN",
    ],
  ];
  const selections = requirements.map(
    ([name, expiration, side, target, action]) => {
      const selected = universe.contracts
        .filter(
          (contract) =>
            contract.expiration === expiration &&
            contract.option_side === side &&
            contract.historical_delta !== null,
        )
        .map((contract) => ({
          contract,
          error: Math.abs(
            Math.abs(Number(contract.historical_delta)) - target,
          ),
        }))
        .sort(
          (left, right) =>
            left.error - right.error ||
            left.contract.observation_age_ms -
              right.contract.observation_age_ms ||
            Number(left.contract.strike) - Number(right.contract.strike),
        )[0]?.contract;
      return { name, action, selected };
    },
  );
  const missing = selections
    .filter(({ selected }) => !selected)
    .map(({ name }) => name);
  if (missing.length > 0) {
    return { status: "INSUFFICIENT_TIMESTAMP_SAFE_CONTRACTS", missing };
  }
  return {
    status: "CONSTRUCTED",
    family: "DOUBLE_DIAGONAL",
    phase: "REPLAY_DECISION",
    frozen_at: universe.as_of,
    checkpoint_id: universe.references.checkpoint_id,
    legs: selections.map(({ action, selected }) => ({
      ...selected,
      action,
    })),
  };
}

function createReplayOutcome(decision, simulation) {
  return {
    phase: "REPLAY_OUTCOME",
    checkpoint_id: decision.checkpoint_id,
    decision_frozen_at: decision.frozen_at,
    simulation_entry_at: simulation.entry_at,
    simulation_exit_at: simulation.exit_at,
    exact_legs: simulation.legs.map((leg) => leg.provider_symbol),
    snapshots: simulation.snapshots,
  };
}

async function acceptanceUniverse() {
  return getHistoricalSpxCandidateUniverse(fixtureCandles(), REQUEST);
}

describe("2026-08-25 07:30 PT SPX universe acceptance", () => {
  test("constructs and freezes an exact four-leg Iron Condor downstream", async () => {
    const universe = await acceptanceUniverse();
    const decision = constructIronCondor(universe);

    expect(universe.status).toBe("PARTIAL");
    expect(universe.capabilities).toMatchObject({
      historical_contract_universe_reconstructed: true,
      exact_provider_contract_identity: true,
      reconstructed_contract_identity: true,
      provider_returned_contract_identity: false,
      checkpoint_timestamp_safe: true,
    });
    expect(universe.coverage).toMatchObject({
      requested_contract_count: 186,
      verified_contract_count: 16,
      missing_contract_count: 170,
      provider_errors: [],
    });
    expect(universe.field_coverage.historical_delta).toEqual({
      available: 15,
      missing: 1,
    });
    expect(universe.capabilities.historical_delta).toBe(false);
    for (const expiration of [
      "2026-09-15T20:00:00.000Z",
      "2026-09-22T20:00:00.000Z",
      "2026-09-29T20:00:00.000Z",
    ]) {
      for (const side of ["CALL", "PUT"]) {
        expect(
          universe.contracts.filter(
            (contract) =>
              contract.expiration === expiration &&
              contract.option_side === side,
          ).length,
        ).toBeGreaterThanOrEqual(2);
      }
    }
    expect(decision).toMatchObject({
      status: "CONSTRUCTED",
      family: "IRON_CONDOR",
      phase: "REPLAY_DECISION",
      frozen_at: CHECKPOINT,
      checkpoint_id: REQUEST.references.checkpoint_id,
      legs: [
        {
          provider_symbol: "SPXW  260922P07350000",
          action: "BUY_TO_OPEN",
        },
        {
          provider_symbol: "SPXW  260922P07400000",
          action: "SELL_TO_OPEN",
          historical_delta: "-19.086897",
        },
        {
          provider_symbol: "SPXW  260922C07900000",
          action: "SELL_TO_OPEN",
          historical_delta: "18.766569",
        },
        {
          provider_symbol: "SPXW  260922C07950000",
          action: "BUY_TO_OPEN",
        },
      ],
    });
    expect(
      universe.contracts.every(
        (contract) =>
          Date.parse(contract.source_timestamp) <= Date.parse(CHECKPOINT) &&
          contract.provenance.every(
            (item) =>
              Date.parse(item.source_timestamp) <= Date.parse(CHECKPOINT),
          ),
      ),
    ).toBe(true);
    expect(
      universe.contracts.every(
        (contract) =>
            contract.provider_symbol === contract.occ_symbol &&
            contract.provider_symbol === contract.simulation_symbol &&
            contract.identity_source ===
              "RECONSTRUCTED_OCC_VALIDATED_BY_DXLINK" &&
            contract.provenance.every(
              (item) => !item.source.includes("backtester"),
            ),
      ),
    ).toBe(true);
    expect(
      universe.contracts.some(
          (contract) =>
          contract.provider_symbol === "SPXW  260922C07925000",
      ),
    ).toBe(false);
  });

  test("constructs a Double Diagonal from reconstructed front/back deltas", async () => {
    const universe = await acceptanceUniverse();
    const decision = evaluateDoubleDiagonal(universe);

    expect(
      universe.contracts.filter(
        (contract) =>
          contract.dte_at_as_of === 21 &&
          contract.historical_delta !== null,
      ).length,
    ).toBe(4);
    expect(
      universe.contracts.filter(
        (contract) =>
          contract.dte_at_as_of === 35 &&
          contract.historical_delta !== null,
      ).length,
    ).toBe(3);
    expect(
      universe.contracts.find(
        (contract) =>
          contract.provider_symbol === "SPXW  260929P07450000",
      ),
    ).toMatchObject({
      historical_delta: null,
      historical_iv: null,
    });
    expect(decision).toMatchObject({
      status: "CONSTRUCTED",
      family: "DOUBLE_DIAGONAL",
      phase: "REPLAY_DECISION",
      frozen_at: CHECKPOINT,
      checkpoint_id: REQUEST.references.checkpoint_id,
      legs: [
        {
          provider_symbol: "SPXW  260915P07400000",
          action: "SELL_TO_OPEN",
        },
        {
          provider_symbol: "SPXW  260915C07850000",
          action: "SELL_TO_OPEN",
        },
        {
          provider_symbol: "SPXW  260929P07500000",
          action: "BUY_TO_OPEN",
        },
        {
          provider_symbol: "SPXW  260929C07825000",
          action: "BUY_TO_OPEN",
        },
      ],
    });
    expect(
      decision.legs.every((leg) =>
        leg.warnings.includes(
          "DELTA_DERIVED_FROM_CANDLE_IV_AND_SPOT_FORWARD_APPROXIMATION",
        ),
      ),
    ).toBe(true);
  });

  test("preserves the frozen exact legs through forward simulation output", async () => {
    const universe = await acceptanceUniverse();
    const decision = constructIronCondor(universe);
    const captured = fixture.exact_leg_forward_simulation;
    const backtester = {
      simulateTrade: jest.fn(async () => ({
        snapshots: structuredClone(captured.snapshots),
      })),
    };
    const outcome = await runSpreadSimulation(backtester, {
      family: "IRON_CONDOR",
      underlying: "SPX",
      entry_at: captured.provider_supported_entry_at,
      exit_at: captured.exit_at,
      intended_price: captured.intended_price,
      price_effect: captured.price_effect,
      legs: decision.legs.map((leg) => ({
        provider_symbol: leg.provider_symbol,
        action: leg.action,
        quantity: 1,
        expiration: leg.expiration,
        strike: leg.strike,
        option_side: leg.option_side,
      })),
      references: {
        checkpoint_id: REQUEST.references.checkpoint_id,
        position_id: "replay-spx-2026-08-25-ic",
      },
    });

    expect(backtester.simulateTrade).toHaveBeenCalledWith({
      underlying: "SPX",
      startTime: captured.provider_supported_entry_at,
      endTime: captured.exit_at,
      legs: [
        {
          symbol: "SPXW  260922P07350000",
          direction: "long",
          quantity: 1,
        },
        {
          symbol: "SPXW  260922P07400000",
          direction: "short",
          quantity: 1,
        },
        {
          symbol: "SPXW  260922C07900000",
          direction: "short",
          quantity: 1,
        },
        {
          symbol: "SPXW  260922C07950000",
          direction: "long",
          quantity: 1,
        },
      ],
    });
    expect(outcome).toMatchObject({
      request_id: captured.request_id,
      family: "IRON_CONDOR",
      legs: [
        { provider_symbol: "SPXW  260922P07350000" },
        { provider_symbol: "SPXW  260922P07400000" },
        { provider_symbol: "SPXW  260922C07900000" },
        { provider_symbol: "SPXW  260922C07950000" },
      ],
      snapshots: [
        {
          as_of: "2026-08-25T19:45:00.000Z",
          price: "13.55",
          price_effect: "CREDIT",
          delta: "-2.5",
        },
        {
          as_of: "2026-08-26T19:45:00.000Z",
          price: "13.6",
          price_effect: "CREDIT",
          delta: "-2.73",
        },
      ],
      evidence: {
        evidence_phase: "POST_SESSION_REGRESSION",
        references: {
          checkpoint_id: REQUEST.references.checkpoint_id,
          position_id: "replay-spx-2026-08-25-ic",
        },
      },
    });
    expect(createReplayOutcome(decision, outcome)).toMatchObject({
      phase: "REPLAY_OUTCOME",
      checkpoint_id: REQUEST.references.checkpoint_id,
      decision_frozen_at: CHECKPOINT,
      simulation_entry_at: "2026-08-25T19:45:00.000Z",
      simulation_exit_at: "2026-08-26T19:45:00.000Z",
      exact_legs: [
        "SPXW  260922P07350000",
        "SPXW  260922P07400000",
        "SPXW  260922C07900000",
        "SPXW  260922C07950000",
      ],
    });
  });
});
