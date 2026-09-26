import { describe, expect, test } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  historicalExecutionProfileHash,
  historicalFeeModelHash,
  simulateHistoricalExecution,
} from "../dist/historical-execution-model.js";
import { normalizeHistoricalExecutionEvidence } from "../dist/historical-execution-evidence.js";

const ENTRY_AT = "2026-09-24T14:30:10.000Z";
const EXIT_AT = "2026-10-01T14:30:10.000Z";
const RETRIEVED_AT = "2026-10-02T12:00:00.000Z";

function contentId(character) {
  return `sha256:${character.repeat(64)}`;
}

function source(index, observedAt, overrides = {}) {
  const observed = Date.parse(observedAt);
  return {
    source_id: `quote-${index}-${observedAt}`,
    provider_id: "licensed-fixture-provider",
    dataset_id: "spxw-nbbo-fixture",
    license_scope_id: "private-research",
    resolution_profile: {
      profile_id: "QUOTE_TICK",
      profile_version: "1.0.0",
      native_resolution: "tick",
      effective_resolution: "tick",
    },
    source_revision: "fixture-source/1",
    revision: 1,
    manifest_id: contentId(((index % 8) + 1).toString()),
    normalized_content_id: contentId(
      "abcdef0123456789"[index % 16],
    ),
    source_timestamp: new Date(observed - 1000).toISOString(),
    available_at: new Date(observed - 900).toISOString(),
    bar_end: null,
    retrieved_at: RETRIEVED_AT,
    ...overrides,
  };
}

function leg(providerSymbol, action) {
  const compact = providerSymbol.slice(6, 12);
  return {
    provider_symbol: providerSymbol,
    action,
    ratio: 1,
    expiration: `20${compact.slice(0, 2)}-${compact.slice(2, 4)}-${compact.slice(4, 6)}`,
    settlement: "PM",
    multiplier: "100",
  };
}

const FAMILY_FIXTURES = {
  DEBIT_VERTICAL: {
    legs: [
      leg("SPXW  261016C06000000", "BUY_TO_OPEN"),
      leg("SPXW  261016C06050000", "SELL_TO_OPEN"),
    ],
    entry: [
      ["4", "4.1"],
      ["1", "1.2"],
    ],
    exit: [
      ["5.2", "5.4"],
      ["1.2", "1.4"],
    ],
  },
  CREDIT_VERTICAL: {
    legs: [
      leg("SPXW  261016C06000000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06050000", "BUY_TO_OPEN"),
    ],
    entry: [
      ["4", "4.2"],
      ["1", "1.2"],
    ],
    exit: [
      ["1.8", "2"],
      ["0.9", "1.1"],
    ],
  },
  IRON_CONDOR: {
    legs: [
      leg("SPXW  261016P05800000", "BUY_TO_OPEN"),
      leg("SPXW  261016P05850000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06150000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06200000", "BUY_TO_OPEN"),
    ],
    entry: [
      ["0.8", "0.9"],
      ["2", "2.1"],
      ["2.2", "2.3"],
      ["0.7", "0.8"],
    ],
    exit: [
      ["0.8", "0.9"],
      ["1.2", "1.3"],
      ["1.1", "1.2"],
      ["0.7", "0.8"],
    ],
  },
  DOUBLE_DIAGONAL: {
    legs: [
      leg("SPXW  261002P05850000", "SELL_TO_OPEN"),
      leg("SPXW  261016P05800000", "BUY_TO_OPEN"),
      leg("SPXW  261002C06150000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06200000", "BUY_TO_OPEN"),
    ],
    entry: [
      ["2", "2.1"],
      ["3", "3.2"],
      ["2.2", "2.3"],
      ["3.1", "3.3"],
    ],
    exit: [
      ["1.8", "1.9"],
      ["3.4", "3.6"],
      ["2", "2.1"],
      ["3.5", "3.7"],
    ],
  },
};

function quote(providerSymbol, values, index, observedAt, overrides = {}) {
  return {
    provider_symbol: providerSymbol,
    bid: values[0],
    ask: values[1],
    bid_size: 20,
    ask_size: 20,
    quote_kind: "NBBO",
    quote_status: "NORMAL",
    price_semantics: "OPTION_PREMIUM_PER_UNIT",
    ...source(index, observedAt),
    ...overrides,
  };
}

function evidence({
  family,
  observedAt,
  quoteValues,
  nativePackageQuote = null,
  references = [],
  quoteOverrides = [],
  expectedObservationTimes = [observedAt],
  observations,
}) {
  const fixture = FAMILY_FIXTURES[family];
  return normalizeHistoricalExecutionEvidence({
    scope: "WINDOW",
    family,
    underlying: "SPX",
    candidate_fingerprint: `candidate-${family.toLowerCase()}`,
    quote_policy: {
      max_quote_age_ms: 2_000,
      max_temporal_skew_ms: 500,
      require_sizes: true,
    },
    expected_observation_times: expectedObservationTimes,
    legs: fixture.legs,
    observations:
      observations ??
      [
        {
          observed_at: observedAt,
          leg_quotes: fixture.legs.map((item, index) =>
            quote(
              item.provider_symbol,
              quoteValues[index],
              index,
              observedAt,
              quoteOverrides[index],
            ),
          ),
          native_package_quote: nativePackageQuote,
          references,
        },
      ],
  });
}

function profile(overrides = {}) {
  const body = {
    profile_id: "baseline-profile",
    profile_version: "1.0.0",
    model: "QUOTE_LIMIT_TOUCH",
    quote_source: "ALIGNED_LEG_QUOTES",
    reference_type: null,
    latency_ms: 0,
    minimum_package_size: 1,
    tick_size: "0.05",
    midpoint_to_adverse_fraction: null,
    additional_cost_per_package: "0",
    queue_model: "NOT_MODELED",
    market_impact_model: "NOT_MODELED",
    atomic_package: true,
    ...overrides,
  };
  return {
    ...body,
    profile_hash: historicalExecutionProfileHash(body),
  };
}

function feeModel() {
  const body = {
    fee_model_id: "fixture-fees",
    fee_model_version: "1.0.0",
    scope: "PER_CONTRACT_PER_LEG_PER_SIDE",
    amount_per_contract_per_leg_side: "0.65",
  };
  return {
    ...body,
    fee_model_hash: historicalFeeModelHash(body),
  };
}

function request({
  family = "DEBIT_VERTICAL",
  entryEvidence,
  exitEvidence,
  executionProfile = profile(),
  entryLimit = "3.1",
  exitLimit = "3.8",
  fees = null,
  priorOutcomeAccessed = true,
  studyStage = "IN_SAMPLE",
} = {}) {
  const manifests = [
    ...entryEvidence.source_manifest_ids,
    ...(exitEvidence?.source_manifest_ids ?? []),
  ];
  return {
    run_id: "run-fixture-1",
    frozen_decision_id: "decision-fixture-1",
    frozen_candidate_id: "candidate-fixture-1",
    candidate_fingerprint: entryEvidence.candidate_fingerprint,
    grading_profile: {
      version: "SPX-SPREAD-V1",
      hash: contentId("d"),
    },
    candidate_construction_profile: {
      version: "candidate-construction/7",
      hash: contentId("e"),
    },
    measurement_basis: {
      basis_id: "selected-leg",
      version: "1.0.0",
      hash: contentId("f"),
    },
    study_stage: studyStage,
    prior_outcome_accessed: priorOutcomeAccessed,
    decision_frozen_at: "2026-09-20T12:00:00.000Z",
    candidate_frozen_at: "2026-09-20T12:01:00.000Z",
    profile_frozen_at: "2026-09-20T12:02:00.000Z",
    outcome_accessed_at: "2026-10-03T12:00:00.000Z",
    source_manifest_ids: [...new Set(manifests)].sort(),
    source_contract: {
      provider_id: "licensed-fixture-provider",
      dataset_id: "spxw-nbbo-fixture",
      license_scope_id: "private-research",
      resolution_profile: {
        profile_id: "QUOTE_TICK",
        profile_version: "1.0.0",
        native_resolution: "tick",
        effective_resolution: "tick",
      },
      source_revision: "fixture-source/1",
    },
    quantity: 1,
    horizon: {
      kind: "FIXED_TRADING_DAYS",
      trading_days: 5,
      scheduled_exit_at: EXIT_AT,
    },
    execution_profile: executionProfile,
    fee_model: fees,
    entry: {
      window_start: "2026-09-24T14:30:00.000Z",
      window_end: "2026-09-24T14:31:00.000Z",
      signed_limit: entryLimit,
      evidence: entryEvidence,
    },
    exit: {
      window_start: "2026-10-01T14:30:00.000Z",
      window_end: "2026-10-01T14:31:00.000Z",
      signed_limit: exitLimit,
      evidence: exitEvidence,
    },
  };
}

async function goldenCases() {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/historical-execution-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return fixture.cases;
}

describe("caller-frozen historical execution models", () => {
  test("pins profile and fee hashes for cross-runner compatibility", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/historical-execution-golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const {
      expected_hash: expectedProfileHash,
      ...profileBody
    } = fixture.hash_vectors.baseline_profile;
    const {
      expected_hash: expectedFeeHash,
      ...feeBody
    } = fixture.hash_vectors.fee_model;

    expect(historicalExecutionProfileHash(profileBody)).toBe(
      expectedProfileHash,
    );
    expect(historicalFeeModelHash(feeBody)).toBe(expectedFeeHash);
  });

  test("matches the shared DV/CV/IC/DD golden outcomes", async () => {
    for (const testCase of await goldenCases()) {
      const fixture = FAMILY_FIXTURES[testCase.family];
      const useNative =
        testCase.quote_source === "NATIVE_PACKAGE";
      const entryEvidence = evidence({
        family: testCase.family,
        observedAt: ENTRY_AT,
        quoteValues: fixture.entry,
        nativePackageQuote: useNative
          ? {
              signed_bid: "1",
              signed_ask: "1.4",
              bid_size: 10,
              ask_size: 10,
              quote_kind: "NBBO",
              quote_status: "NORMAL",
              price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
              ...source(5, ENTRY_AT, {
                source_id: "entry-native",
              }),
            }
          : null,
      });
      const exitEvidence = evidence({
        family: testCase.family,
        observedAt: EXIT_AT,
        quoteValues: fixture.exit,
        nativePackageQuote: useNative
          ? {
              signed_bid: "2",
              signed_ask: "2.4",
              bid_size: 10,
              ask_size: 10,
              quote_kind: "NBBO",
              quote_status: "NORMAL",
              price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
              ...source(6, EXIT_AT, {
                source_id: "exit-native",
              }),
            }
          : null,
      });
      const executionProfile = profile({
        model: testCase.model,
        quote_source: testCase.quote_source,
        midpoint_to_adverse_fraction:
          testCase.model === "QUOTE_PRICE_IMPROVEMENT" ? "0.5" : null,
        additional_cost_per_package:
          testCase.model === "QUOTE_PRICE_IMPROVEMENT" ? "0.03" : "0",
      });
      const result = simulateHistoricalExecution(
        request({
          family: testCase.family,
          entryEvidence,
          exitEvidence,
          executionProfile,
          entryLimit: testCase.entry_limit,
          exitLimit: testCase.exit_limit,
          fees:
            testCase.family === "DOUBLE_DIAGONAL"
              ? feeModel()
              : null,
        }),
      );

      expect(result.status).toBe("SIMULATED_FILLED");
      expect(result.entry.fill_price).toBe(
        testCase.expected_entry_fill,
      );
      expect(result.exit.fill_price).toBe(
        testCase.expected_exit_fill,
      );
      expect(result.pnl.gross_pnl).toBe(
        testCase.expected_gross_pnl,
      );
      expect(result.pnl.total_fees).toBe(
        testCase.expected_total_fees ?? null,
      );
      expect(result.pnl.net_pnl).toBe(
        testCase.expected_net_pnl ?? null,
      );
      expect(result).toMatchObject({
        evidence_class: "SIMULATED_EXECUTION",
        broker_fill_verified: false,
        mutates_live_event: false,
        mutates_source_evidence: false,
      });
    }
  });

  test("returns no-fill only when the selected quote channel is complete", () => {
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
    });
    const result = simulateHistoricalExecution(
      request({
        entryEvidence,
        exitEvidence: null,
        entryLimit: "2.5",
      }),
    );

    expect(result.status).toBe("NO_FILL_UNDER_MODEL");
    expect(result.entry).toMatchObject({
      status: "NO_FILL_UNDER_MODEL",
      fill_price: null,
      evidence_coverage: "COMPLETE",
    });
    expect(result.exit.status).toBe("NOT_EVALUATED");
  });

  test("does not turn a sparse no-touch window into a no-fill verdict", () => {
    const observed = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
      expectedObservationTimes: [
        ENTRY_AT,
        "2026-09-24T14:30:30.000Z",
      ],
    });
    const result = simulateHistoricalExecution(
      request({
        entryEvidence: observed,
        exitEvidence: null,
        entryLimit: "2.5",
      }),
    );

    expect(result.status).toBe("NOT_ASSESSABLE");
    expect(result.entry).toMatchObject({
      status: "NOT_ASSESSABLE",
      evidence_coverage: "PARTIAL",
    });
  });

  test("keeps an entry fill open when exit evidence is unresolved", () => {
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
    });
    const result = simulateHistoricalExecution(
      request({ entryEvidence, exitEvidence: null }),
    );

    expect(result.status).toBe("OPEN_EXIT_UNRESOLVED");
    expect(result.entry.status).toBe("SIMULATED_FILLED");
    expect(result.exit.status).toBe("NOT_ASSESSABLE");
    expect(result.pnl).toMatchObject({
      gross_pnl: null,
      net_pnl: null,
    });
  });

  test.each([
    [
      "future",
      [
        {
          available_at: "2026-09-24T14:30:10.001Z",
        },
      ],
    ],
    [
      "stale",
      [
        {
          source_timestamp: "2026-09-24T14:29:00.000Z",
        },
      ],
    ],
    [
      "misaligned",
      [
        {
          source_timestamp: "2026-09-24T14:30:07.000Z",
          available_at: "2026-09-24T14:30:07.100Z",
        },
      ],
    ],
    [
      "missing-size",
      [
        {
          ask_size: null,
        },
      ],
    ],
  ])("returns NOT_ASSESSABLE for %s quote evidence", (_label, overrides) => {
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
      quoteOverrides: overrides,
    });

    const result = simulateHistoricalExecution(
      request({ entryEvidence, exitEvidence: null }),
    );

    expect(result.status).toBe("NOT_ASSESSABLE");
    expect(result.entry).toMatchObject({
      status: "NOT_ASSESSABLE",
      evidence_coverage: "NONE",
    });
  });

  test.each([
    [
      "latency",
      { latency_ms: 20_000 },
      "NOT_ASSESSABLE",
      { skipped_for_latency: 1, skipped_for_size: 0 },
    ],
    [
      "package size",
      { minimum_package_size: 25 },
      "NO_FILL_UNDER_MODEL",
      { skipped_for_latency: 0, skipped_for_size: 1 },
    ],
  ])("applies frozen %s requirements without fallback", (_label, profileOverride, expectedStatus, counts) => {
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
    });
    const result = simulateHistoricalExecution(
      request({
        entryEvidence,
        exitEvidence: null,
        executionProfile: profile(profileOverride),
      }),
    );

    expect(result).toMatchObject({
      status: expectedStatus,
      entry: {
        status: expectedStatus,
        ...counts,
      },
    });
  });

  test("does not fill a fixed-horizon exit before its scheduled timestamp", () => {
    const fixture = FAMILY_FIXTURES.DEBIT_VERTICAL;
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: fixture.entry,
    });
    const earlyAt = "2026-10-01T14:30:05.000Z";
    const scheduledAt = EXIT_AT;
    const exitEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: scheduledAt,
      quoteValues: fixture.exit,
      expectedObservationTimes: [earlyAt, scheduledAt],
      observations: [
        {
          observed_at: earlyAt,
          leg_quotes: fixture.legs.map((item, index) =>
            quote(
              item.provider_symbol,
              fixture.exit[index],
              index,
              earlyAt,
            ),
          ),
          native_package_quote: null,
          references: [],
        },
        {
          observed_at: scheduledAt,
          leg_quotes: fixture.legs.map((item, index) =>
            quote(
              item.provider_symbol,
              [
                index === 0 ? "4.4" : "1.2",
                index === 0 ? "4.6" : "1.4",
              ],
              index,
              scheduledAt,
            ),
          ),
          native_package_quote: null,
          references: [],
        },
      ],
    });

    const result = simulateHistoricalExecution(
      request({ entryEvidence, exitEvidence }),
    );

    expect(result.status).toBe("OPEN_EXIT_UNRESOLVED");
    expect(result.exit).toMatchObject({
      status: "NO_FILL_UNDER_MODEL",
      selected_observation_count: 1,
      filled_at: null,
    });
  });

  test("reports entry fees when a filled position has no resolved exit", () => {
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
    });
    const result = simulateHistoricalExecution(
      request({
        entryEvidence,
        exitEvidence: null,
        fees: feeModel(),
      }),
    );

    expect(result.status).toBe("OPEN_EXIT_UNRESOLVED");
    expect(result.pnl).toMatchObject({
      gross_pnl: null,
      entry_fees: "1.3",
      exit_fees: "0",
      total_fees: "1.3",
      net_pnl: null,
    });
  });

  test("supports an explicit low-evidence reference-cost model", () => {
    function referenceEvidence(observedAt, value, index) {
      const fixture = FAMILY_FIXTURES.DEBIT_VERTICAL;
      const missingQuotes = fixture.legs.map((item, quoteIndex) =>
        quote(
          item.provider_symbol,
          [null, null],
          quoteIndex,
          observedAt,
          { bid_size: null, ask_size: null },
        ),
      );
      return evidence({
        family: "DEBIT_VERTICAL",
        observedAt,
        quoteValues: fixture.entry,
        observations: [
          {
            observed_at: observedAt,
            leg_quotes: missingQuotes,
            native_package_quote: null,
            references: [
              {
                evidence_type: "CANDLE_REFERENCE",
                signed_value: value,
                price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
                model_version: null,
                ...source(index, observedAt, {
                  source_id: `reference-${index}`,
                  provider_id: "reference-provider",
                  dataset_id: "reference-candles",
                  resolution_profile: {
                    profile_id: "REFERENCE_5M",
                    profile_version: "1.0.0",
                    native_resolution: "5m",
                    effective_resolution: "5m",
                  },
                }),
              },
            ],
          },
        ],
      });
    }
    const entryEvidence = referenceEvidence(ENTRY_AT, "2", 5);
    const exitEvidence = referenceEvidence(EXIT_AT, "3", 6);
    const executionProfile = profile({
      model: "REFERENCE_COST",
      quote_source: null,
      reference_type: "CANDLE_REFERENCE",
      midpoint_to_adverse_fraction: null,
      additional_cost_per_package: "0.1",
    });
    const input = request({
      entryEvidence,
      exitEvidence,
      executionProfile,
      entryLimit: "2.2",
      exitLimit: "2.8",
    });
    input.source_contract = {
      provider_id: "reference-provider",
      dataset_id: "reference-candles",
      license_scope_id: "private-research",
      resolution_profile: {
        profile_id: "REFERENCE_5M",
        profile_version: "1.0.0",
        native_resolution: "5m",
        effective_resolution: "5m",
      },
      source_revision: "fixture-source/1",
    };

    const result = simulateHistoricalExecution(input);

    expect(result).toMatchObject({
      status: "SIMULATED_FILLED",
      evidence_strength: "REFERENCE_MODEL",
      entry: {
        fill_price: "2.1",
        evidence_kind: "CANDLE_REFERENCE",
      },
      exit: {
        fill_price: "2.9",
        evidence_kind: "CANDLE_REFERENCE",
      },
      pnl: {
        gross_pnl: "80",
        net_pnl: null,
      },
    });
  });

  test.each([
    [
      "future quote",
      (entryEvidence) => {
        entryEvidence.observations[0].synthetic_package_quote
          .usable_for_simulated_execution = false;
        entryEvidence.observations[0].synthetic_package_quote
          .rejection_reasons = ["FUTURE_AVAILABLE_AT"];
      },
    ],
    [
      "missing size",
      (entryEvidence) => {
        entryEvidence.observations[0].synthetic_package_quote.ask_size =
          null;
        entryEvidence.observations[0].synthetic_package_quote
          .usable_for_simulated_execution = false;
        entryEvidence.observations[0].synthetic_package_quote
          .rejection_reasons = ["MISSING_LEG_SIZE"];
      },
    ],
  ])("rejects tampered %s evidence identity", (_label, mutate) => {
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
    });
    mutate(entryEvidence);

    expect(() =>
      simulateHistoricalExecution(
        request({ entryEvidence, exitEvidence: null }),
      ),
    ).toThrow("evidence_id does not match");
  });

  test("rejects profile, source, manifest, and freeze boundary mismatches", () => {
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
    });
    const badHash = request({
      entryEvidence,
      exitEvidence: null,
    });
    badHash.execution_profile.profile_hash = contentId("0");
    expect(() => simulateHistoricalExecution(badHash)).toThrow(
      "profile_hash does not match",
    );

    const badSource = request({
      entryEvidence,
      exitEvidence: null,
    });
    badSource.source_contract.dataset_id = "other-dataset";
    expect(() => simulateHistoricalExecution(badSource)).toThrow(
      "does not match frozen source_contract",
    );

    const badManifest = request({
      entryEvidence,
      exitEvidence: null,
    });
    badManifest.source_manifest_ids = [contentId("0")];
    expect(() => simulateHistoricalExecution(badManifest)).toThrow(
      "source_manifest_ids do not match",
    );

    const badFreeze = request({
      entryEvidence,
      exitEvidence: null,
    });
    badFreeze.profile_frozen_at = "2026-10-04T12:00:00.000Z";
    expect(() => simulateHistoricalExecution(badFreeze)).toThrow(
      "must not be after outcome_accessed_at",
    );

    const mislabeledOos = request({
      entryEvidence,
      exitEvidence: null,
      studyStage: "OUT_OF_SAMPLE",
      priorOutcomeAccessed: true,
    });
    expect(() => simulateHistoricalExecution(mislabeledOos)).toThrow(
      "must remain IN_SAMPLE",
    );
  });

  test("rejects DD exits after the earliest expiration instead of valuing remaining legs", () => {
    const fixture = FAMILY_FIXTURES.DOUBLE_DIAGONAL;
    const entryEvidence = evidence({
      family: "DOUBLE_DIAGONAL",
      observedAt: ENTRY_AT,
      quoteValues: fixture.entry,
    });
    const exitEvidence = evidence({
      family: "DOUBLE_DIAGONAL",
      observedAt: "2026-10-05T14:30:10.000Z",
      quoteValues: fixture.exit,
    });
    const input = request({
      family: "DOUBLE_DIAGONAL",
      entryEvidence,
      exitEvidence,
    });
    input.exit.window_start = "2026-10-05T14:30:00.000Z";
    input.exit.window_end = "2026-10-05T14:31:00.000Z";
    input.horizon.scheduled_exit_at = "2026-10-05T14:30:10.000Z";

    expect(() => simulateHistoricalExecution(input)).toThrow(
      "DOUBLE_DIAGONAL fixed-horizon exit must precede",
    );
  });

  test("is deterministic and publishes a strict result schema", async () => {
    const entryEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: ENTRY_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.entry,
    });
    const exitEvidence = evidence({
      family: "DEBIT_VERTICAL",
      observedAt: EXIT_AT,
      quoteValues: FAMILY_FIXTURES.DEBIT_VERTICAL.exit,
    });
    const input = request({ entryEvidence, exitEvidence });
    const first = simulateHistoricalExecution(input);
    expect(simulateHistoricalExecution(structuredClone(input))).toEqual(
      first,
    );

    const schema = JSON.parse(
      await readFile(
        new URL(
          "../docs/historical-execution-model.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(first)).toBe(true);
    expect(validate({ ...first, broker_fill_verified: true })).toBe(
      false,
    );
  });
});
