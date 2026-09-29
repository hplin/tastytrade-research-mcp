import { describe, expect, jest, test } from "@jest/globals";
import {
  BASELINE_SIGNING_MODEL_ID,
  BASELINE_SIGNING_MODEL_VERSION,
  computeHeuristicSignedGexFromSnapshot,
  computeLiveHeuristicSignedGex,
} from "../dist/heuristic-signed-gex.js";

function optionContract({
  symbol,
  root = "SPXW",
  strike,
  optionType,
  gamma,
  impliedVolatility = "0.2",
  openInterest,
  dte = 30,
}) {
  return {
    provider_symbol: symbol,
    occ_symbol: symbol,
    streamer_symbol: `.${symbol}`,
    underlying: "SPX",
    root_symbol: root,
    strike,
    option_type: optionType,
    expiration: "2026-10-28",
    dte,
    multiplier: "100",
    settlement: root === "SPX" ? "AM" : "PM",
    quote: null,
    greeks: {
      delta: null,
      gamma,
      theta: null,
      vega: null,
      rho: null,
      implied_volatility: impliedVolatility,
      price: null,
      timestamp: "2026-09-28T20:00:00.000Z",
      timestamp_source: "PROVIDER_EVENT_TIME",
      received_at: "2026-09-28T20:00:00.100Z",
    },
    summary: {
      open_interest: openInterest,
      timestamp: "2026-09-28T20:00:00.100Z",
      timestamp_source: "LOCAL_RECEIVE_TIME",
      received_at: "2026-09-28T20:00:00.100Z",
    },
    event_timestamp_alignment: {
      status: "UNVERIFIABLE",
      skew_ms: null,
      receive_skew_ms: 0,
      threshold_ms: 5000,
    },
    cohort_alignment: {
      status: "CONFIRMED",
      receive_skew_ms: 0,
      threshold_ms: 5000,
      exact_contract_identity: true,
    },
    oi_freshness: {
      status: "CONFIRMED",
      basis: "CURRENT_REQUEST_RECEIVE_TIME",
      age_ms: 0,
    },
    greeks_freshness: {
      status: "CONFIRMED",
      basis: "PROVIDER_EVENT_TIME",
      age_ms: 100,
    },
    temporal_alignment: {
      status: "UNVERIFIABLE",
      skew_ms: null,
      receive_skew_ms: 0,
      threshold_ms: 5000,
    },
  };
}

function snapshot(contracts, overrides = {}) {
  return {
    contract_version: "1.1.0",
    request_id: "sha256:request",
    snapshot_id: "sha256:snapshot",
    status: "AVAILABLE",
    provider: "tastytrade-dxlink",
    underlying: "SPX",
    underlying_price: "100",
    retrieved_at: "2026-09-28T20:00:00.100Z",
    snapshot_complete: true,
    cohort_alignment: { status: "CONFIRMED" },
    oi_freshness: { status: "CONFIRMED" },
    greeks_freshness: { status: "CONFIRMED" },
    contracts,
    gamma_concentration_proxy: {
      methodology: "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION",
      methodology_version: "1.0.0",
      status: "COMPLETE",
    },
    ...overrides,
  };
}

function request(spotRepricing) {
  return {
    snapshot_request: {
      underlying: "SPX",
      expirations: ["2026-10-28"],
      around_price: "100",
      strike_count: 25,
      include_quotes: true,
      include_greeks: true,
      include_summary: true,
      phase: "LIVE_SUPPORT",
    },
    phase: "REGRESSION_RESEARCH",
    signing_model: {
      model_id: BASELINE_SIGNING_MODEL_ID,
      model_version: BASELINE_SIGNING_MODEL_VERSION,
    },
    ...(spotRepricing ? { spot_repricing: spotRepricing } : {}),
  };
}

function repricing(overrides = {}) {
  return {
    pricing_model: "BLACK_SCHOLES_GAMMA",
    model_version: "1.0.0",
    annualized_risk_free_rate: "0.04",
    annualized_dividend_yield: "0.01",
    minimum_years_to_expiration: "0.0001",
    spot_range: {
      minimum: "80",
      maximum: "120",
      step: "5",
      root_tolerance: "0.001",
    },
    ...overrides,
  };
}

describe("Level 3 heuristic signed GEX", () => {
  test("applies the explicit versioned signs and deterministic aggregation", () => {
    const source = snapshot([
      optionContract({
        symbol: "SPXW-C100",
        strike: "100",
        optionType: "CALL",
        gamma: "0.02",
        openInterest: "10",
      }),
      optionContract({
        symbol: "SPXW-P100",
        strike: "100",
        optionType: "PUT",
        gamma: "0.01",
        openInterest: "30",
      }),
    ]);
    const before = structuredClone(source);

    const first = computeHeuristicSignedGexFromSnapshot(
      source,
      request(),
    );
    const second = computeHeuristicSignedGexFromSnapshot(
      source,
      request(),
    );

    expect(first.result_id).toBe(second.result_id);
    expect(first.signing_model).toMatchObject({
      model_id: "CALL_SHORT_PUT_LONG_BASELINE",
      model_version: "1.0.0",
      model_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      rules: [
        { option_type: "CALL", assigned_sign: "-1" },
        { option_type: "PUT", assigned_sign: "1" },
      ],
    });
    expect(first.heuristic_signed_gex).toMatchObject({
      status: "AVAILABLE",
      methodology: "CURRENT_GAMMA_SIGNED_GEX",
      approximation: "SNAPSHOT_GAMMA_AT_CURRENT_SPOT",
      aggregation: {
        total_signed_gex: "1000",
        total_absolute_gex: "5000",
        sign_regime: "POSITIVE",
      },
    });
    expect(
      first.heuristic_signed_gex.aggregation.by_option_type,
    ).toEqual([
      expect.objectContaining({
        key: "CALL",
        signed_gex: "-2000",
      }),
      expect.objectContaining({
        key: "PUT",
        signed_gex: "3000",
      }),
    ]);
    expect(first.heuristic_gamma_flip).toMatchObject({
      status: "NOT_COMPUTABLE",
      reason: "SPOT_REPRICING_NOT_REQUESTED",
    });
    expect(first).toMatchObject({
      gamma_evidence_scope: "HEURISTIC_SIGNED_MODEL",
      evidence_role: "RESEARCH_ONLY",
      research_only: true,
      production_gate_eligible: false,
      snapshot: {
        snapshot_id: "sha256:snapshot",
        level_2_unsigned_status: "COMPLETE",
      },
    });
    expect(first).not.toHaveProperty("dealer_gex_status");
    expect(first.source_snapshot).toEqual(before);
    expect(source).toEqual(before);
  });

  test("finds a bounded spot-repriced zero crossing without extrapolation", () => {
    const result = computeHeuristicSignedGexFromSnapshot(
      snapshot([
        optionContract({
          symbol: "SPXW-P90",
          strike: "90",
          optionType: "PUT",
          gamma: "0.01",
          openInterest: "100",
        }),
        optionContract({
          symbol: "SPXW-C110",
          strike: "110",
          optionType: "CALL",
          gamma: "0.01",
          openInterest: "100",
        }),
      ]),
      request(repricing()),
    );

    expect(result.spot_repriced_signed_gex).toMatchObject({
      status: "AVAILABLE",
      methodology: "SPOT_REPRICED_SIGNED_GEX",
      pricing_model: "BLACK_SCHOLES_GAMMA",
      model_version: "1.0.0",
      gamma_rounding_significant_digits: 15,
      gex_rounding_decimal_places: 6,
      assumptions: {
        time_to_expiration_method:
          "SNAPSHOT_DTE_DIVIDED_BY_365_WITH_CALLER_MINIMUM",
        no_extrapolation: true,
      },
      current_spot_reconciliation: {
        snapshot_gamma_total_signed_gex: expect.any(String),
        repriced_total_signed_gex: expect.any(String),
        repriced_to_snapshot_ratio: null,
        signed_gex_difference: expect.any(String),
      },
    });
    expect(result.heuristic_gamma_flip).toMatchObject({
      status: "AVAILABLE",
      method: "BOUNDED_GRID_BRACKET_BISECTION",
      spot_range: {
        minimum: "80",
        maximum: "120",
        step: "5",
        root_tolerance: "0.001",
      },
      confidence: "UNKNOWN",
      evidence_role: "RESEARCH_ONLY",
      production_gate_eligible: false,
    });
    expect(Number(result.heuristic_gamma_flip.level)).toBeGreaterThan(80);
    expect(Number(result.heuristic_gamma_flip.level)).toBeLessThan(120);
  });

  test("ignores zero-gross underflow regions and keeps the real crossing primary", () => {
    const result = computeHeuristicSignedGexFromSnapshot(
      snapshot([
        optionContract({
          symbol: "SPXW-P99",
          strike: "99",
          optionType: "PUT",
          gamma: "0.01",
          openInterest: "100",
          dte: 0,
        }),
        optionContract({
          symbol: "SPXW-C101",
          strike: "101",
          optionType: "CALL",
          gamma: "0.01",
          openInterest: "100",
          dte: 0,
        }),
      ]),
      request(
        repricing({
          spot_range: {
            minimum: "10",
            maximum: "120",
            step: "1",
            root_tolerance: "0.1",
          },
        }),
      ),
    );

    expect(result.warnings).toContain(
      "SPOT_RANGE_CONTAINS_ZERO_EXPOSURE_REGION",
    );
    expect(result.heuristic_gamma_flip.status).toBe("AVAILABLE");
    expect(result.heuristic_gamma_flip.level).not.toBe("10");
    expect(result.heuristic_gamma_flip.candidate_levels).not.toContain(
      "10",
    );
    expect(Number(result.heuristic_gamma_flip.level)).toBeGreaterThan(80);
  });

  test("keeps gamma-flip evidence partial when the source snapshot is incomplete", () => {
    const result = computeHeuristicSignedGexFromSnapshot(
      snapshot(
        [
          optionContract({
            symbol: "SPXW-P90",
            strike: "90",
            optionType: "PUT",
            gamma: "0.01",
            openInterest: "100",
          }),
          optionContract({
            symbol: "SPXW-C110",
            strike: "110",
            optionType: "CALL",
            gamma: "0.01",
            openInterest: "100",
          }),
        ],
        {
          snapshot_complete: false,
          gamma_concentration_proxy: {
            methodology: "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION",
            methodology_version: "1.0.0",
            status: "PARTIAL",
          },
        },
      ),
      request(repricing()),
    );

    expect(result.spot_repriced_signed_gex.status).toBe("PARTIAL");
    expect(result.heuristic_gamma_flip.status).toBe("PARTIAL");
  });

  test("reports no crossing inside a complete caller-bounded range", () => {
    const result = computeHeuristicSignedGexFromSnapshot(
      snapshot([
        optionContract({
          symbol: "SPX-C100",
          root: "SPX",
          strike: "100",
          optionType: "CALL",
          gamma: "0.01",
          openInterest: "100",
        }),
      ]),
      request(repricing()),
    );

    expect(result.heuristic_gamma_flip).toEqual(
      expect.objectContaining({
        status: "NOT_FOUND_IN_RANGE",
        level: null,
        candidate_levels: [],
        crossing_count: 0,
        reason: "NO_ZERO_CROSSING_IN_REQUESTED_RANGE",
      }),
    );
  });

  test("fails partial inputs closed without zero-filling open interest", () => {
    const result = computeHeuristicSignedGexFromSnapshot(
      snapshot(
        [
          optionContract({
            symbol: "SPXW-P100",
            strike: "100",
            optionType: "PUT",
            gamma: "0.01",
            openInterest: null,
          }),
        ],
        {
          snapshot_complete: false,
          gamma_concentration_proxy: {
            methodology: "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION",
            methodology_version: "1.0.0",
            status: "NOT_AVAILABLE",
          },
        },
      ),
      request(),
    );

    expect(result.status).toBe("NOT_COMPUTABLE");
    expect(result.heuristic_signed_gex).toMatchObject({
      status: "NOT_COMPUTABLE",
      aggregation: null,
      data_completeness: {
        total_contracts: 1,
        eligible_contracts: 0,
        missing_open_interest: 1,
      },
      warnings: expect.arrayContaining([
        "MISSING_OPEN_INTEREST_EXCLUDED_NOT_ZERO_FILLED",
        "SOURCE_SNAPSHOT_INCOMPLETE",
      ]),
    });
    expect(result.production_gate_eligible).toBe(false);
  });

  test("uses one unified SPX/SPXW snapshot and preserves its identity", async () => {
    const source = snapshot([
      optionContract({
        symbol: "SPX-C100",
        root: "SPX",
        strike: "100",
        optionType: "CALL",
        gamma: "0.02",
        openInterest: "10",
      }),
      optionContract({
        symbol: "SPXW-P100",
        root: "SPXW",
        strike: "100",
        optionType: "PUT",
        gamma: "0.01",
        openInterest: "30",
      }),
    ]);
    const liveOptions = {
      getLiveOptionSnapshot: jest.fn(async () => source),
    };

    const result = await computeLiveHeuristicSignedGex(
      liveOptions,
      request(),
    );

    expect(liveOptions.getLiveOptionSnapshot).toHaveBeenCalledTimes(1);
    expect(liveOptions.getLiveOptionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        underlying: "SPX",
        include_greeks: true,
        include_summary: true,
      }),
    );
    expect(result.snapshot.snapshot_id).toBe(source.snapshot_id);
    expect(result.source_snapshot).toBe(source);
    expect(
      result.heuristic_signed_gex.aggregation.by_option_type,
    ).toHaveLength(2);
  });

  test("rejects unbounded scenario grids and disabled required evidence", () => {
    expect(() =>
      computeHeuristicSignedGexFromSnapshot(
        snapshot([]),
        request(
          repricing({
            spot_range: {
              minimum: "1",
              maximum: "2000",
              step: "1",
              root_tolerance: "0.1",
            },
          }),
        ),
      ),
    ).toThrow("more than 1001 scenarios");
    expect(() =>
      computeHeuristicSignedGexFromSnapshot(snapshot([]), {
        ...request(),
        snapshot_request: {
          ...request().snapshot_request,
          include_greeks: false,
        },
      }),
    ).toThrow("snapshot_request.include_greeks must not be false");
    expect(() =>
      computeHeuristicSignedGexFromSnapshot(
        snapshot([
          optionContract({
            symbol: "SPXW-P100",
            strike: "100",
            optionType: "PUT",
            gamma: "0.01",
            openInterest: "10",
          }),
        ]),
        request(
          repricing({
            spot_range: {
              minimum: "10",
              maximum: "90",
              step: "5",
              root_tolerance: "0.1",
            },
          }),
        ),
      ),
    ).toThrow(
      "spot_repricing.spot_range must include snapshot.underlying_price",
    );
  });
});
