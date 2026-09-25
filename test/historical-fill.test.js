import { describe, expect, test } from "@jest/globals";
import { createExecutionEvidence } from "../dist/execution-evidence.js";
import {
  verifyHistoricalFill,
  verifyHistoricalFillWithBacktester,
} from "../dist/historical-fill.js";

const BASE = {
  submitted_at: "2026-09-24T14:00:00.000Z",
  valid_until: "2026-09-24T14:10:00.000Z",
  working_limit: "1",
  price_effect: "DEBIT",
  verification_side: "ENTRY",
  fill_model: "LIMIT_TOUCH",
  evidence_source: "fixture",
  references: {
    paper_order_id: "paper-1",
    checkpoint_id: "checkpoint-1",
  },
  max_observation_gap_ms: 300_000,
};

function point(asOf, price, priceEffect = "DEBIT") {
  return {
    as_of: asOf,
    price,
    price_effect: priceEffect,
    source: "fixture",
  };
}

describe("historical fill verification", () => {
  test("reports a touch bounded between sparse checkpoints", () => {
    const result = verifyHistoricalFill({
      ...BASE,
      valid_until: "2026-09-24T14:30:00.000Z",
      path: [
        point("2026-09-24T14:00:00.000Z", "1.4"),
        point("2026-09-24T14:30:00.000Z", "0.9"),
      ],
    });

    expect(result.status).toBe("TOUCHED");
    expect(result.first_touch_at).toBeNull();
    expect(result.first_touch_window).toEqual({
      start: "2026-09-24T14:00:00.000Z",
      end: "2026-09-24T14:30:00.000Z",
    });
    expect(result.path_resolution).toBe("BOUNDED_INTERVAL");
  });

  test("bounds a first touched observation that occurs after submission", () => {
    const result = verifyHistoricalFill({
      ...BASE,
      path: [
        point("2026-09-24T14:05:00.000Z", "0.9"),
        point("2026-09-24T14:10:00.000Z", "0.8"),
      ],
    });

    expect(result.first_touch_at).toBeNull();
    expect(result.first_touch_window).toEqual({
      start: BASE.submitted_at,
      end: "2026-09-24T14:05:00.000Z",
    });
    expect(result.warnings).toContain(
      "FIRST_TOUCH_LACKS_PRECEDING_NON_TOUCH_OBSERVATION",
    );
  });

  test("reports a complete path that never touched", () => {
    const result = verifyHistoricalFill({
      ...BASE,
      verification_side: "EXIT",
      path: [
        point("2026-09-24T14:00:00.000Z", "1.4"),
        point("2026-09-24T14:05:00.000Z", "1.2"),
        point("2026-09-24T14:10:00.000Z", "1.1"),
      ],
    });

    expect(result.status).toBe("NOT_TOUCHED");
    expect(result.verification_side).toBe("EXIT");
    expect(result.path_resolution).toBe("COMPLETE_NO_TOUCH");
  });

  test("ignores hindsight observations outside the forward interval", () => {
    const result = verifyHistoricalFill({
      ...BASE,
      path: [
        point("2026-09-24T13:59:00.000Z", "0.5"),
        point("2026-09-24T14:00:00.000Z", "1.4"),
        point("2026-09-24T14:05:00.000Z", "1.2"),
        point("2026-09-24T14:10:00.000Z", "1.1"),
        point("2026-09-24T14:11:00.000Z", "0.5"),
      ],
    });

    expect(result.status).toBe("NOT_TOUCHED");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "PRE_SUBMISSION_OBSERVATIONS_IGNORED:1",
        "POST_EXPIRY_OBSERVATIONS_IGNORED:1",
      ]),
    );
  });

  test("uses NOT_VERIFIABLE for an incomplete ambiguous path", () => {
    const result = verifyHistoricalFill({
      ...BASE,
      path: [point("2026-09-24T14:05:00.000Z", "1.2")],
    });

    expect(result.status).toBe("NOT_VERIFIABLE");
    expect(result.quote_path_quality).toBe("PARTIAL");
  });

  test("preserves distinct LIMIT_TOUCH and CONSERVATIVE_CROSS thresholds", () => {
    const path = [
      point("2026-09-24T14:00:00.000Z", "1.2"),
      point("2026-09-24T14:05:00.000Z", "0.95"),
      point("2026-09-24T14:10:00.000Z", "1.1"),
    ];
    const touch = verifyHistoricalFill({ ...BASE, path });
    const conservative = verifyHistoricalFill({
      ...BASE,
      path,
      fill_model: "CONSERVATIVE_CROSS",
      acceptable_bound: "0.9",
    });

    expect(touch.status).toBe("TOUCHED");
    expect(conservative.status).toBe("NOT_TOUCHED");
    expect(conservative.threshold).toBe("0.9");
  });

  test("records disagreement without mutating the live paper event", () => {
    const result = verifyHistoricalFill({
      ...BASE,
      live_assumption: "FILLED",
      path: [
        point("2026-09-24T14:00:00.000Z", "1.4"),
        point("2026-09-24T14:05:00.000Z", "1.2"),
        point("2026-09-24T14:10:00.000Z", "1.1"),
      ],
    });

    expect(result.comparison_to_live_assumption).toBe("DISAGREES");
    expect(result.mutates_live_event).toBe(false);
    expect(result.warnings).toContain(
      "HISTORICAL_RESULT_DISAGREES_WITH_LIVE_ASSUMPTION",
    );
  });

  test("does not treat a broker dry-run acceptance as market fillability", () => {
    const dryRun = createExecutionEvidence({
      evidence_type: "BROKER_DRY_RUN",
      evidence_phase: "LIVE_CHECKPOINT",
      source: "broker-dry-run",
      freshness_status: "UNKNOWN",
      temporal_alignment: "UNKNOWN",
      native_available: false,
      working_limit: "1",
      acceptable_bound: null,
      fill_model: "NOT_APPLICABLE",
      fill_confidence: "NOT_APPLICABLE",
      references: BASE.references,
    });
    const historical = verifyHistoricalFill({
      ...BASE,
      path: [
        point("2026-09-24T14:00:00.000Z", "1.4"),
        point("2026-09-24T14:05:00.000Z", "1.2"),
        point("2026-09-24T14:10:00.000Z", "1.1"),
      ],
    });

    expect(dryRun.warnings).toContain(
      "BROKER_DRY_RUN_VALIDATES_STRUCTURE_NOT_FILLABILITY",
    );
    expect(historical.status).toBe("NOT_TOUCHED");
  });

  test("normalizes Backtester simulation before applying the fill model", async () => {
    const simulateTrade = async () => [
        {
          dateTime: "2026-09-24T14:00:00Z",
          price: "1.2",
          effect: "debit",
          underlyingPrice: "7600",
          delta: "5",
        },
        {
          dateTime: "2026-09-24T14:10:00Z",
          price: "0.9",
          effect: "debit",
          underlyingPrice: "7601",
          delta: "4",
        },
      ];
    const result = await verifyHistoricalFillWithBacktester(
      {
        simulateTrade,
        createBacktest: async () => {
          throw new Error("not used");
        },
      },
      {
        family: "DEBIT_VERTICAL",
        underlying: "SPX",
        submitted_at: BASE.submitted_at,
        valid_until: BASE.valid_until,
        working_limit: BASE.working_limit,
        price_effect: BASE.price_effect,
        verification_side: "ENTRY",
        fill_model: "LIMIT_TOUCH",
        max_observation_gap_ms: BASE.max_observation_gap_ms,
        references: BASE.references,
        legs: [
          {
            provider_symbol: "LONG",
            action: "BUY_TO_OPEN",
            quantity: 1,
            expiration: "2026-10-16T20:00:00.000Z",
            strike: "7500",
            option_side: "CALL",
          },
          {
            provider_symbol: "SHORT",
            action: "SELL_TO_OPEN",
            quantity: 1,
            expiration: "2026-10-16T20:00:00.000Z",
            strike: "7550",
            option_side: "CALL",
          },
        ],
      },
    );

    expect(result.status).toBe("TOUCHED");
    expect(result.evidence_source).toBe(
      "tastytrade-backtester:/simulate-trade",
    );
  });
});
