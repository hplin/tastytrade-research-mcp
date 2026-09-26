import { describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { stableEvidenceContentId } from "../dist/evidence-cache.js";
import {
  historicalExecutionProfileHash,
  historicalFeeModelHash,
  simulateHistoricalExecution,
} from "../dist/historical-execution-model.js";
import { normalizeHistoricalExecutionEvidence } from "../dist/historical-execution-evidence.js";
import {
  buildHistoricalReplayReport,
  historicalReplayRecordId,
} from "../dist/historical-replay.js";
import { createResearchServer } from "../dist/server.js";

const execFileAsync = promisify(execFile);

const ENTRY_AT = "2026-09-24T14:30:10.000Z";
const RETRIEVED_AT = "2026-10-05T12:00:00.000Z";
const QUOTE_SOURCE = {
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
};
const REFERENCE_SOURCE = {
  provider_id: "reference-fixture-provider",
  dataset_id: "spxw-candle-reference",
  license_scope_id: "private-research",
  resolution_profile: {
    profile_id: "REFERENCE_5M",
    profile_version: "1.0.0",
    native_resolution: "5m",
    effective_resolution: "5m",
  },
  source_revision: "fixture-reference/1",
};

function contentId(value) {
  return stableEvidenceContentId(value);
}

function source(candidateId, observedAt, index, sourceContract = QUOTE_SOURCE) {
  return {
    source_id: `${sourceContract.provider_id}:${candidateId}:${observedAt}:${index}`,
    ...sourceContract,
    revision: 1,
    manifest_id: contentId({
      type: "manifest",
      candidateId,
      observedAt,
      index,
      provider: sourceContract.provider_id,
    }),
    normalized_content_id: contentId({
      type: "content",
      candidateId,
      observedAt,
      index,
      provider: sourceContract.provider_id,
    }),
    source_timestamp: new Date(Date.parse(observedAt) - 1000).toISOString(),
    available_at: new Date(Date.parse(observedAt) - 900).toISOString(),
    bar_end: null,
    retrieved_at: RETRIEVED_AT,
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

const CANDIDATES = [
  {
    candidate_id: "candidate-dv",
    candidate_fingerprint: "fingerprint-dv",
    trade_date: "2026-09-24",
    family: "DEBIT_VERTICAL",
    exact_legs: [
      leg("SPXW  261016C06000000", "BUY_TO_OPEN"),
      leg("SPXW  261016C06050000", "SELL_TO_OPEN"),
    ],
    data_status: "AVAILABLE",
    reason_codes: [],
  },
  {
    candidate_id: "candidate-cv",
    candidate_fingerprint: "fingerprint-cv",
    trade_date: "2026-09-24",
    family: "CREDIT_VERTICAL",
    exact_legs: [
      leg("SPXW  261016P05900000", "SELL_TO_OPEN"),
      leg("SPXW  261016P05850000", "BUY_TO_OPEN"),
    ],
    data_status: "AVAILABLE",
    reason_codes: [],
  },
  {
    candidate_id: "candidate-ic",
    candidate_fingerprint: "fingerprint-ic",
    trade_date: "2026-09-24",
    family: "IRON_CONDOR",
    exact_legs: [
      leg("SPXW  261016P05800000", "BUY_TO_OPEN"),
      leg("SPXW  261016P05850000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06150000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06200000", "BUY_TO_OPEN"),
    ],
    data_status: "AVAILABLE",
    reason_codes: [],
  },
  {
    candidate_id: "candidate-dd",
    candidate_fingerprint: "fingerprint-dd",
    trade_date: "2026-09-24",
    family: "DOUBLE_DIAGONAL",
    exact_legs: [
      leg("SPXW  261009P05850000", "SELL_TO_OPEN"),
      leg("SPXW  261016P05800000", "BUY_TO_OPEN"),
      leg("SPXW  261009C06150000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06200000", "BUY_TO_OPEN"),
    ],
    data_status: "AVAILABLE",
    reason_codes: [],
  },
  {
    candidate_id: "candidate-missing",
    candidate_fingerprint: "fingerprint-missing",
    trade_date: "2026-09-24",
    family: "DEBIT_VERTICAL",
    exact_legs: [],
    data_status: "MISSING",
    reason_codes: ["MISSING_CANDIDATE_EVIDENCE"],
  },
  {
    candidate_id: "candidate-rejected",
    candidate_fingerprint: "fingerprint-rejected",
    trade_date: "2026-09-24",
    family: "DOUBLE_DIAGONAL",
    exact_legs: [],
    data_status: "REJECTED",
    reason_codes: ["INVALID_MEASUREMENT_BASIS"],
  },
];

const HORIZONS = [
  {
    horizon_id: "PLUS_3_TRADING_DAYS",
    trading_days: 3,
    scheduled_exit_at: "2026-09-29T14:30:10.000Z",
  },
  {
    horizon_id: "PLUS_5_TRADING_DAYS",
    trading_days: 5,
    scheduled_exit_at: "2026-10-01T14:30:10.000Z",
  },
];

function profileBody(role) {
  if (role === "OPTIMISTIC") {
    return {
      profile_id: "optimistic-midpoint",
      profile_version: "1.0.0",
      model: "QUOTE_PRICE_IMPROVEMENT",
      quote_source: "NATIVE_PACKAGE",
      reference_type: null,
      latency_ms: 0,
      minimum_package_size: 1,
      tick_size: "0.05",
      midpoint_to_adverse_fraction: "0",
      additional_cost_per_package: "0",
      queue_model: "NOT_MODELED",
      market_impact_model: "NOT_MODELED",
      atomic_package: true,
    };
  }
  if (role === "BASELINE") {
    return {
      profile_id: "baseline-half-spread",
      profile_version: "1.0.0",
      model: "QUOTE_PRICE_IMPROVEMENT",
      quote_source: "NATIVE_PACKAGE",
      reference_type: null,
      latency_ms: 0,
      minimum_package_size: 1,
      tick_size: "0.05",
      midpoint_to_adverse_fraction: "0.5",
      additional_cost_per_package: "0.05",
      queue_model: "NOT_MODELED",
      market_impact_model: "NOT_MODELED",
      atomic_package: true,
    };
  }
  return {
    profile_id: "stress-cross",
    profile_version: "1.0.0",
    model: "QUOTE_CROSS",
    quote_source: "NATIVE_PACKAGE",
    reference_type: null,
    latency_ms: 0,
    minimum_package_size: 1,
    tick_size: "0.05",
    midpoint_to_adverse_fraction: null,
    additional_cost_per_package: "0",
    queue_model: "NOT_MODELED",
    market_impact_model: "NOT_MODELED",
    atomic_package: true,
  };
}

const FEE_BODY = {
  fee_model_id: "fixture-fees",
  fee_model_version: "1.0.0",
  scope: "PER_CONTRACT_PER_LEG_PER_SIDE",
  amount_per_contract_per_leg_side: "0.65",
};
const FEE_MODEL = {
  ...FEE_BODY,
  fee_model_hash: historicalFeeModelHash(FEE_BODY),
};

const CORE_SCENARIOS = ["OPTIMISTIC", "BASELINE", "STRESS"].map(
  (role) => {
    const body = profileBody(role);
    return {
      scenario_id: role.toLowerCase(),
      role,
      evidence_strength: "QUOTE_BACKED",
      source_contract: QUOTE_SOURCE,
      execution_profile: {
        ...body,
        profile_hash: historicalExecutionProfileHash(body),
      },
      fee_model: role === "OPTIMISTIC" ? null : FEE_MODEL,
    };
  },
);

const REFERENCE_PROFILE_BODY = {
  profile_id: "reference-cost",
  profile_version: "1.0.0",
  model: "REFERENCE_COST",
  quote_source: null,
  reference_type: "CANDLE_REFERENCE",
  latency_ms: 0,
  minimum_package_size: 1,
  tick_size: "0.05",
  midpoint_to_adverse_fraction: null,
  additional_cost_per_package: "0.1",
  queue_model: "NOT_MODELED",
  market_impact_model: "NOT_MODELED",
  atomic_package: true,
};

const SCENARIOS = [
  ...CORE_SCENARIOS,
  {
    scenario_id: "reference",
    role: "REFERENCE",
    evidence_strength: "REFERENCE_MODEL",
    source_contract: REFERENCE_SOURCE,
    execution_profile: {
      ...REFERENCE_PROFILE_BODY,
      profile_hash: historicalExecutionProfileHash(
        REFERENCE_PROFILE_BODY,
      ),
    },
    fee_model: null,
  },
];

function makeEvidence(
  candidate,
  observedAt,
  signedBid,
  signedAsk,
  { partial = false } = {},
) {
  const expected = partial
    ? [
        observedAt,
        new Date(Date.parse(observedAt) + 30_000).toISOString(),
      ]
    : [observedAt];
  return normalizeHistoricalExecutionEvidence({
    scope: "WINDOW",
    family: candidate.family,
    underlying: "SPX",
    candidate_fingerprint: candidate.candidate_fingerprint,
    quote_policy: {
      max_quote_age_ms: 2_000,
      max_temporal_skew_ms: 500,
      require_sizes: true,
    },
    expected_observation_times: expected,
    legs: candidate.exact_legs,
    observations: [
      {
        observed_at: observedAt,
        leg_quotes: candidate.exact_legs.map((item, index) => ({
          provider_symbol: item.provider_symbol,
          bid: "1",
          ask: "1.1",
          bid_size: 20,
          ask_size: 20,
          quote_kind: "NBBO",
          quote_status: "NORMAL",
          price_semantics: "OPTION_PREMIUM_PER_UNIT",
          ...source(candidate.candidate_id, observedAt, index),
        })),
        native_package_quote: {
          signed_bid: signedBid,
          signed_ask: signedAsk,
          bid_size: 10,
          ask_size: 10,
          quote_kind: "NBBO",
          quote_status: "NORMAL",
          price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
          ...source(candidate.candidate_id, observedAt, 7, {
            ...QUOTE_SOURCE,
          }),
        },
        references: [],
      },
    ],
  });
}

function simulationFor(candidate, scenario, horizon) {
  const outcome =
    candidate.candidate_id === "candidate-dv"
      ? "FILLED"
      : candidate.candidate_id === "candidate-cv"
        ? "NO_FILL"
        : candidate.candidate_id === "candidate-ic"
          ? "INSUFFICIENT"
          : "OPEN";
  const entryEvidence = makeEvidence(
    candidate,
    ENTRY_AT,
    outcome === "NO_FILL" || outcome === "INSUFFICIENT" ? "-2.2" : "0.8",
    outcome === "NO_FILL" || outcome === "INSUFFICIENT" ? "-2" : "1.2",
    { partial: outcome === "INSUFFICIENT" },
  );
  const exitEvidence =
    outcome === "FILLED"
      ? makeEvidence(
          candidate,
          horizon.scheduled_exit_at,
          "1",
          "1.4",
        )
      : null;
  const sourceManifestIds = [
    ...entryEvidence.source_manifest_ids,
    ...(exitEvidence?.source_manifest_ids ?? []),
  ];
  return simulateHistoricalExecution({
    run_id: "replay-run-1",
    frozen_decision_id: `decision-${candidate.candidate_id}`,
    frozen_candidate_id: candidate.candidate_id,
    candidate_fingerprint: candidate.candidate_fingerprint,
    grading_profile: {
      version: "SPX-SPREAD-V1",
      hash: contentId("grading-profile"),
    },
    candidate_construction_profile: {
      version: "candidate-construction/7",
      hash: contentId("candidate-construction"),
    },
    measurement_basis: {
      basis_id: "selected-leg",
      version: "1.0.0",
      hash: contentId("measurement-basis"),
    },
    study_stage: "IN_SAMPLE",
    prior_outcome_accessed: true,
    decision_frozen_at: "2026-09-20T12:00:00.000Z",
    candidate_frozen_at: "2026-09-20T12:01:00.000Z",
    profile_frozen_at: "2026-09-20T12:02:00.000Z",
    outcome_accessed_at: "2026-10-05T13:00:00.000Z",
    source_manifest_ids: [...new Set(sourceManifestIds)].sort(),
    source_contract: scenario.source_contract,
    quantity: 1,
    horizon: {
      kind: "FIXED_TRADING_DAYS",
      trading_days: horizon.trading_days,
      scheduled_exit_at: horizon.scheduled_exit_at,
    },
    execution_profile: scenario.execution_profile,
    fee_model: scenario.fee_model,
    entry: {
      window_start: "2026-09-24T14:30:00.000Z",
      window_end: "2026-09-24T14:31:00.000Z",
      signed_limit:
        outcome === "NO_FILL" || outcome === "INSUFFICIENT"
          ? "-3"
          : "1.5",
      evidence: entryEvidence,
    },
    exit: {
      window_start: new Date(
        Date.parse(horizon.scheduled_exit_at) - 10_000,
      ).toISOString(),
      window_end: new Date(
        Date.parse(horizon.scheduled_exit_at) + 50_000,
      ).toISOString(),
      signed_limit: "0.8",
      evidence: exitEvidence,
    },
  });
}

function policy(role, decisions) {
  const baseline = role === "BASELINE";
  return {
    role,
    policy_id: baseline ? "baseline-policy" : "research-policy",
    policy_version: baseline
      ? "SPX-SPREAD-V1"
      : "DD_MILD_BACK_RICH_V1",
    policy_hash: contentId(`${role}-policy`),
    effect_scope: baseline ? "BASELINE" : "MILD_BACK_RICH_ONLY",
    frozen_at: "2026-09-20T12:00:00.000Z",
    decisions,
  };
}

function decisions(acceptedIds) {
  return CANDIDATES.map((candidate) => ({
    candidate_id: candidate.candidate_id,
    status:
      candidate.data_status === "AVAILABLE"
        ? acceptedIds.includes(candidate.candidate_id)
          ? "ACCEPTED"
          : "REJECTED"
        : "NOT_EVALUATED_MISSING_DATA",
    reason_codes:
      candidate.data_status === "AVAILABLE"
        ? acceptedIds.includes(candidate.candidate_id)
          ? []
          : ["POLICY_REJECTED"]
        : candidate.reason_codes,
  }));
}

function replayInput() {
  const available = CANDIDATES.filter(
    (candidate) => candidate.data_status === "AVAILABLE",
  );
  const records = [];
  for (const candidate of available) {
    for (const horizon of HORIZONS) {
      let coreManifestIds = null;
      for (const scenario of CORE_SCENARIOS) {
        const simulation = simulationFor(candidate, scenario, horizon);
        coreManifestIds ??= simulation.source_manifest_ids;
        records.push({
          record_id: historicalReplayRecordId({
            candidate_id: candidate.candidate_id,
            scenario_id: scenario.scenario_id,
            horizon_id: horizon.horizon_id,
          }),
          candidate_id: candidate.candidate_id,
          scenario_id: scenario.scenario_id,
          horizon_id: horizon.horizon_id,
          exact_symbols: candidate.exact_legs.map(
            (item) => item.provider_symbol,
          ),
          source_manifest_ids: simulation.source_manifest_ids,
          evidence_class: "SIMULATED_EXECUTION",
          simulation,
          valuation_evidence_id: null,
          reason_codes: [],
        });
      }
      records.push({
        record_id: historicalReplayRecordId({
          candidate_id: candidate.candidate_id,
          scenario_id: "reference",
          horizon_id: horizon.horizon_id,
        }),
        candidate_id: candidate.candidate_id,
        scenario_id: "reference",
        horizon_id: horizon.horizon_id,
        exact_symbols: candidate.exact_legs.map(
          (item) => item.provider_symbol,
        ),
        source_manifest_ids: [
          contentId({
            type: "reference",
            candidate: candidate.candidate_id,
            horizon: horizon.horizon_id,
          }),
        ],
        evidence_class: "VALUATION_ONLY",
        simulation: null,
        valuation_evidence_id: contentId({
          type: "valuation",
          candidate: candidate.candidate_id,
          horizon: horizon.horizon_id,
        }),
        reason_codes: ["QUOTE_EVIDENCE_NOT_AVAILABLE"],
      });
      expect(coreManifestIds).not.toBeNull();
    }
  }

  return {
    run_id: "replay-run-1",
    experiment_version: "1.0.0",
    experiment_frozen_at: "2026-09-20T12:02:00.000Z",
    outcome_accessed_at: "2026-10-05T13:00:00.000Z",
    study_stage: "IN_SAMPLE",
    window: {
      start_date: "2026-09-24",
      end_date: "2026-09-24",
      checkpoint_local_time: "07:30",
      timezone: "America/Los_Angeles",
    },
    candidate_selection_source: "FROZEN_POLICY_OUTPUT",
    later_selector_fallback_used: false,
    candidate_construction_profile: {
      version: "candidate-construction/7",
      hash: contentId("candidate-construction"),
    },
    measurement_basis: {
      basis_id: "selected-leg",
      version: "1.0.0",
      hash: contentId("measurement-basis"),
    },
    horizon_policy: {
      policy_id: "fixed-trading-day-exit",
      version: "1.0.0",
      hash: contentId("horizon-policy"),
    },
    horizons: HORIZONS.map(
      ({ horizon_id, trading_days }) => ({
        horizon_id,
        trading_days,
      }),
    ),
    policies: [
      policy(
        "BASELINE",
        decisions(["candidate-dv", "candidate-ic", "candidate-dd"]),
      ),
      policy(
        "RESEARCH",
        decisions(["candidate-dv", "candidate-cv", "candidate-dd"]),
      ),
    ],
    scenarios: structuredClone(SCENARIOS),
    candidates: CANDIDATES.map((candidate) => ({
      ...candidate,
      scheduled_exits: HORIZONS.map(
        ({ horizon_id, scheduled_exit_at }) => ({
          horizon_id,
          scheduled_exit_at,
        }),
      ),
    })),
    execution_records: records,
  };
}

function rehashSimulation(simulation) {
  const { simulation_id: _simulationId, ...body } = simulation;
  return {
    ...body,
    simulation_id: stableEvidenceContentId(body),
  };
}

describe("historical replay acceptance", () => {
  test("computes frozen policy sets and scenario metrics without denominator leakage", async () => {
    const expected = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/historical-replay-golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const result = buildHistoricalReplayReport(replayInput());

    expect(result.policy_comparison).toMatchObject(
      expected.policy_comparison,
    );
    expect(result.missing_data).toMatchObject(expected.missing_data);
    const baselineOptimisticH3 = result.groups.find(
      (group) =>
        group.policy_role === "BASELINE" &&
        group.scenario_role === "OPTIMISTIC" &&
        group.horizon_id === "PLUS_3_TRADING_DAYS",
    );
    expect(baselineOptimisticH3).toMatchObject({
      accepted_candidate_count: 3,
      simulated_filled_count: 1,
      no_fill_count: 0,
      not_assessable_count: 1,
      open_exit_count: 1,
      valuation_only_count: 0,
      closed_position_denominator: 1,
      gross: {
        win_count: 1,
        win_rate: "1",
      },
      net: {
        closed_position_denominator: 0,
        win_rate: null,
      },
      drawdown: {
        metric: "CLOSE_SEQUENCE_DRAWDOWN",
        portfolio_mtm: false,
      },
      account_return: null,
    });
    const baselineReferenceH3 = result.groups.find(
      (group) =>
        group.policy_role === "BASELINE" &&
        group.scenario_role === "REFERENCE" &&
        group.horizon_id === "PLUS_3_TRADING_DAYS",
    );
    expect(baselineReferenceH3).toMatchObject({
      valuation_only_count: 3,
      closed_position_denominator: 0,
      gross: {
        win_rate: null,
        expectancy: null,
        profit_factor: null,
      },
    });
    expect(result.execution_sensitivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policy_role: "BASELINE",
          horizon_id: "PLUS_3_TRADING_DAYS",
          execution_sensitive: true,
          selected_winner: null,
          grading_adjusted: false,
        }),
      ]),
    );
    expect(result).toMatchObject({
      complete_performance_acceptance: false,
      writes_forward_paper_state: false,
      account_return: null,
      selected_winner: null,
      grading_adjusted: false,
    });
  });

  test("keeps +3 and +5 horizons and source/evidence cohorts separate", () => {
    const result = buildHistoricalReplayReport(replayInput());
    expect(new Set(result.groups.map((group) => group.horizon_id))).toEqual(
      new Set(["PLUS_3_TRADING_DAYS", "PLUS_5_TRADING_DAYS"]),
    );
    const quoteGroup = result.groups.find(
      (group) => group.scenario_role === "BASELINE",
    );
    const referenceGroup = result.groups.find(
      (group) => group.scenario_role === "REFERENCE",
    );
    expect(quoteGroup.source_group_id).not.toBe(
      referenceGroup.source_group_id,
    );
    expect(quoteGroup.evidence_strength).toBe("QUOTE_BACKED");
    expect(referenceGroup.evidence_strength).toBe("REFERENCE_MODEL");
  });

  test("is deterministic and rejects conflicting duplicate IDs", () => {
    const input = replayInput();
    const first = buildHistoricalReplayReport(input);
    expect(buildHistoricalReplayReport(structuredClone(input))).toEqual(
      first,
    );

    const conflicting = replayInput();
    conflicting.candidates.push({
      ...conflicting.candidates[0],
      candidate_fingerprint: "different-fingerprint",
    });
    expect(() => buildHistoricalReplayReport(conflicting)).toThrow(
      "Conflicting duplicate candidate_id",
    );
  });

  test("rejects mixed manifests, profiles, horizons, and later candidate selection", () => {
    const mixedManifest = replayInput();
    const record = mixedManifest.execution_records.find(
      (item) =>
        item.candidate_id === "candidate-dv" &&
        item.scenario_id === "stress" &&
        item.horizon_id === "PLUS_3_TRADING_DAYS",
    );
    record.source_manifest_ids = [contentId("different-manifest")];
    expect(() => buildHistoricalReplayReport(mixedManifest)).toThrow(
      "core scenarios must use the same source manifests",
    );

    const mixedProfile = replayInput();
    mixedProfile.execution_records[0].simulation.execution_profile.profile_hash =
      contentId("different-profile");
    expect(() => buildHistoricalReplayReport(mixedProfile)).toThrow(
      "simulation_id does not match",
    );

    const mixedHorizon = replayInput();
    mixedHorizon.execution_records[0].simulation.horizon.trading_days = 4;
    mixedHorizon.execution_records[0].simulation.simulation_id =
      contentId("tampered-simulation");
    expect(() => buildHistoricalReplayReport(mixedHorizon)).toThrow(
      "simulation_id does not match",
    );

    const fallback = replayInput();
    fallback.later_selector_fallback_used = true;
    expect(() => buildHistoricalReplayReport(fallback)).toThrow(
      "later_selector_fallback_used must remain false",
    );
  });

  test("prevents the relaxed two-factor policy from masquerading as mild-only", () => {
    const input = replayInput();
    input.policies[1].policy_version = "DD_RELAXED_SURFACE_V1";
    input.policies[1].effect_scope = "MILD_BACK_RICH_ONLY";

    expect(() => buildHistoricalReplayReport(input)).toThrow(
      "DD_RELAXED_SURFACE_V1 changes BACK_RICH and FALLING_IV",
    );
  });

  test("enforces the frozen 07:30 checkpoint and pre-outcome freeze ordering", () => {
    const lateEntry = replayInput();
    const lateRecord = lateEntry.execution_records.find(
      (record) => record.simulation !== null,
    );
    lateRecord.simulation.entry.window_start =
      "2026-09-24T19:45:00.000Z";
    lateRecord.simulation = rehashSimulation(lateRecord.simulation);
    expect(() => buildHistoricalReplayReport(lateEntry)).toThrow(
      "entry window must start at the frozen checkpoint",
    );

    const lateSimulationFreeze = replayInput();
    const freezeRecord = lateSimulationFreeze.execution_records.find(
      (record) => record.simulation !== null,
    );
    freezeRecord.simulation.candidate_frozen_at =
      "2026-09-21T12:00:00.000Z";
    freezeRecord.simulation = rehashSimulation(
      freezeRecord.simulation,
    );
    expect(() =>
      buildHistoricalReplayReport(lateSimulationFreeze),
    ).toThrow(
      "candidate_frozen_at must not be after experiment_frozen_at",
    );
  });

  test("rejects incomparable core sizing and unordered horizon exits", () => {
    const mixedQuantity = replayInput();
    const quantityRecord = mixedQuantity.execution_records.find(
      (record) =>
        record.candidate_id === "candidate-dv" &&
        record.scenario_id === "stress" &&
        record.horizon_id === "PLUS_3_TRADING_DAYS",
    );
    quantityRecord.simulation.quantity = 10;
    quantityRecord.simulation.pnl.quantity = 10;
    const quantityScale = 10;
    for (const field of [
      "gross_pnl",
      "entry_fees",
      "exit_fees",
      "total_fees",
      "net_pnl",
    ]) {
      if (quantityRecord.simulation.pnl[field] !== null) {
        quantityRecord.simulation.pnl[field] = String(
          Number(quantityRecord.simulation.pnl[field]) * quantityScale,
        );
      }
    }
    quantityRecord.simulation = rehashSimulation(
      quantityRecord.simulation,
    );
    expect(() => buildHistoricalReplayReport(mixedQuantity)).toThrow(
      "must use the same decision, quantity, and source evidence",
    );

    const duplicateExit = replayInput();
    duplicateExit.candidates[0].scheduled_exits[1].scheduled_exit_at =
      duplicateExit.candidates[0].scheduled_exits[0].scheduled_exit_at;
    expect(() => buildHistoricalReplayReport(duplicateExit)).toThrow(
      "scheduled exits must increase with trading_days",
    );
  });

  test("rejects inventory, P&L, and quote-source tampering", () => {
    const reversedInventory = replayInput();
    reversedInventory.candidates[0].exact_legs[0].action =
      "SELL_TO_OPEN";
    try {
      expect(() =>
        buildHistoricalReplayReport(reversedInventory),
      ).toThrow("Simulation inventory does not match");
    } finally {
      reversedInventory.candidates[0].exact_legs[0].action =
        "BUY_TO_OPEN";
    }

    const tamperedPnl = replayInput();
    const pnlRecord = tamperedPnl.execution_records.find(
      (record) =>
        record.simulation?.status === "SIMULATED_FILLED",
    );
    pnlRecord.simulation.pnl.gross_pnl = "999999999";
    pnlRecord.simulation = rehashSimulation(pnlRecord.simulation);
    expect(() => buildHistoricalReplayReport(tamperedPnl)).toThrow(
      "gross_pnl does not match fill arithmetic",
    );

    const mixedQuoteSource = replayInput();
    const baseline = mixedQuoteSource.scenarios.find(
      (scenario) => scenario.role === "BASELINE",
    );
    baseline.execution_profile.quote_source = "ALIGNED_LEG_QUOTES";
    const { profile_hash: _profileHash, ...profileBody } =
      baseline.execution_profile;
    baseline.execution_profile.profile_hash =
      historicalExecutionProfileHash(profileBody);
    expect(() =>
      buildHistoricalReplayReport(mixedQuoteSource),
    ).toThrow("Core scenarios must use the same quote_source");
  });

  test("revalidates embedded hashes and preserves prior-access samples as in-sample", () => {
    const staleProfileHash = replayInput();
    const profileRecord = staleProfileHash.execution_records.find(
      (record) =>
        record.simulation?.execution_profile.model ===
        "QUOTE_PRICE_IMPROVEMENT",
    );
    profileRecord.simulation.execution_profile.quote_source =
      "ALIGNED_LEG_QUOTES";
    profileRecord.simulation = rehashSimulation(
      profileRecord.simulation,
    );
    expect(() =>
      buildHistoricalReplayReport(staleProfileHash),
    ).toThrow("Simulation profile does not match");

    const staleFeeHash = replayInput();
    const feeRecord = staleFeeHash.execution_records.find(
      (record) => record.simulation?.fee_model !== null,
    );
    feeRecord.simulation.fee_model.amount_per_contract_per_leg_side =
      "100";
    feeRecord.simulation = rehashSimulation(feeRecord.simulation);
    expect(() => buildHistoricalReplayReport(staleFeeHash)).toThrow(
      "Simulation fee model hash does not match its content",
    );

    const mislabeledOos = replayInput();
    mislabeledOos.study_stage = "OUT_OF_SAMPLE";
    for (const record of mislabeledOos.execution_records) {
      if (record.simulation === null) continue;
      record.simulation.study_stage = "OUT_OF_SAMPLE";
      record.simulation = rehashSimulation(record.simulation);
    }
    expect(() => buildHistoricalReplayReport(mislabeledOos)).toThrow(
      "prior outcome access must remain IN_SAMPLE",
    );
  });

  test("rejects non-V1 simulations and different frozen orders across scenarios", () => {
    const invalidVersion = replayInput();
    const versionRecord = invalidVersion.execution_records.find(
      (record) => record.simulation !== null,
    );
    versionRecord.simulation.contract_version = "99.0.0";
    versionRecord.simulation = rehashSimulation(
      versionRecord.simulation,
    );
    expect(() => buildHistoricalReplayReport(invalidVersion)).toThrow(
      "V1 execution-result constants",
    );

    const zeroQuantity = replayInput();
    const quantityRecord = zeroQuantity.execution_records.find(
      (record) => record.simulation?.status === "SIMULATED_FILLED",
    );
    quantityRecord.simulation.quantity = 0;
    quantityRecord.simulation.pnl.quantity = 0;
    for (const field of [
      "gross_pnl",
      "entry_fees",
      "exit_fees",
      "total_fees",
      "net_pnl",
    ]) {
      if (quantityRecord.simulation.pnl[field] !== null) {
        quantityRecord.simulation.pnl[field] = "0";
      }
    }
    quantityRecord.simulation = rehashSimulation(
      quantityRecord.simulation,
    );
    expect(() => buildHistoricalReplayReport(zeroQuantity)).toThrow(
      "quantity must be a positive integer",
    );

    const differentOrder = replayInput();
    const stressRecord = differentOrder.execution_records.find(
      (record) =>
        record.candidate_id === "candidate-dv" &&
        record.scenario_id === "stress" &&
        record.horizon_id === "PLUS_3_TRADING_DAYS",
    );
    stressRecord.simulation.entry.signed_limit = "999";
    stressRecord.simulation = rehashSimulation(
      stressRecord.simulation,
    );
    expect(() => buildHistoricalReplayReport(differentOrder)).toThrow(
      "must use the same decision, quantity, and source evidence",
    );
  });

  test("rejects unknown evidence, limit violations, and horizon-specific entries", () => {
    const unknownEvidence = replayInput();
    const unknownRecord = unknownEvidence.execution_records.find(
      (record) => record.simulation !== null,
    );
    unknownRecord.evidence_class = "UNKNOWN_CLASS";
    unknownRecord.simulation = null;
    unknownRecord.reason_codes = ["UNKNOWN"];
    expect(() => buildHistoricalReplayReport(unknownEvidence)).toThrow(
      "Unsupported evidence_class",
    );

    const badFill = replayInput();
    const fillRecord = badFill.execution_records.find(
      (record) => record.simulation?.status === "SIMULATED_FILLED",
    );
    fillRecord.simulation.entry.fill_price = "999";
    fillRecord.simulation.pnl.signed_entry_cost = "999";
    const exitPrice = Number(
      fillRecord.simulation.pnl.signed_exit_receipt,
    );
    const gross =
      (exitPrice - 999) *
      Number(fillRecord.simulation.pnl.multiplier) *
      fillRecord.simulation.quantity;
    fillRecord.simulation.pnl.gross_pnl = String(gross);
    fillRecord.simulation.pnl.net_pnl = String(
      gross - Number(fillRecord.simulation.pnl.total_fees),
    );
    fillRecord.simulation = rehashSimulation(fillRecord.simulation);
    expect(() => buildHistoricalReplayReport(badFill)).toThrow(
      "fill violates the frozen signed limit",
    );

    const horizonEntry = replayInput();
    for (const record of horizonEntry.execution_records.filter(
      (item) =>
        item.horizon_id === "PLUS_5_TRADING_DAYS" &&
        item.simulation !== null,
    )) {
      record.simulation.entry.window_end =
        "2026-09-24T14:45:00.000Z";
      record.simulation = rehashSimulation(record.simulation);
    }
    expect(() => buildHistoricalReplayReport(horizonEntry)).toThrow(
      "horizons must share one frozen entry order",
    );
  });

  test("requires the V1 checkpoint, manifests, tick-aligned limits, and cross-horizon comparability", () => {
    const wrongCheckpoint = replayInput();
    wrongCheckpoint.window.checkpoint_local_time = "12:45";
    expect(() => buildHistoricalReplayReport(wrongCheckpoint)).toThrow(
      "checkpoint_local_time=07:30",
    );

    const noManifests = replayInput();
    for (const manifestRecord of noManifests.execution_records.filter(
      (record) =>
        record.candidate_id === "candidate-dv" &&
        record.horizon_id === "PLUS_3_TRADING_DAYS" &&
        record.simulation !== null &&
        record.scenario_id !== "reference",
    )) {
      manifestRecord.source_manifest_ids = [];
      manifestRecord.simulation.source_manifest_ids = [];
      manifestRecord.simulation = rehashSimulation(
        manifestRecord.simulation,
      );
    }
    expect(() => buildHistoricalReplayReport(noManifests)).toThrow(
      "require immutable source manifests",
    );

    const badLimitTick = replayInput();
    const limitRecord = badLimitTick.execution_records.find(
      (record) => record.simulation?.status === "SIMULATED_FILLED",
    );
    limitRecord.simulation.entry.signed_limit = "1.53";
    limitRecord.simulation = rehashSimulation(
      limitRecord.simulation,
    );
    expect(() => buildHistoricalReplayReport(badLimitTick)).toThrow(
      "signed_limit is not aligned to tick_size",
    );

    const missingBaseline = replayInput();
    for (const record of missingBaseline.execution_records.filter(
      (item) => item.scenario_id === "baseline",
    )) {
      record.evidence_class = "MISSING_EVIDENCE";
      record.simulation = null;
      record.valuation_evidence_id = null;
      record.reason_codes = ["MISSING_BASELINE_SIMULATION"];
    }
    for (const record of missingBaseline.execution_records.filter(
      (item) =>
        item.horizon_id === "PLUS_5_TRADING_DAYS" &&
        ["optimistic", "stress"].includes(item.scenario_id),
    )) {
      record.simulation.entry.window_end =
        "2026-09-24T14:45:00.000Z";
      record.simulation = rehashSimulation(record.simulation);
    }
    expect(() => buildHistoricalReplayReport(missingBaseline)).toThrow(
      "horizons must share one frozen entry order",
    );
  });

  test("enforces execution state transitions, fill provenance, and outcome chronology", () => {
    const impossibleState = replayInput();
    const stateRecord = impossibleState.execution_records.find(
      (record) => record.simulation?.status === "SIMULATED_FILLED",
    );
    stateRecord.simulation.status = "NO_FILL_UNDER_MODEL";
    stateRecord.simulation.entry.status = "NO_FILL_UNDER_MODEL";
    stateRecord.simulation.entry.fill_price = null;
    stateRecord.simulation.entry.filled_at = null;
    stateRecord.simulation.entry.evidence_id = null;
    stateRecord.simulation.entry.first_touch_window = null;
    stateRecord.simulation.pnl.signed_entry_cost = null;
    stateRecord.simulation.pnl.signed_exit_receipt =
      stateRecord.simulation.exit.fill_price;
    stateRecord.simulation.pnl.gross_pnl = null;
    stateRecord.simulation.pnl.net_pnl = null;
    stateRecord.simulation = rehashSimulation(
      stateRecord.simulation,
    );
    expect(() => buildHistoricalReplayReport(impossibleState)).toThrow(
      "exit must remain NOT_EVALUATED when entry is not filled",
    );

    const missingFillEvidence = replayInput();
    const evidenceRecord =
      missingFillEvidence.execution_records.find(
        (record) => record.simulation?.status === "SIMULATED_FILLED",
      );
    evidenceRecord.simulation.entry.evidence_id = null;
    evidenceRecord.simulation = rehashSimulation(
      evidenceRecord.simulation,
    );
    expect(() =>
      buildHistoricalReplayReport(missingFillEvidence),
    ).toThrow("fill requires selected evidence provenance");

    const futureOutcome = replayInput();
    futureOutcome.study_stage = "OUT_OF_SAMPLE";
    futureOutcome.outcome_accessed_at =
      "2026-09-25T00:00:00.000Z";
    for (const record of futureOutcome.execution_records) {
      if (record.simulation === null) continue;
      record.simulation.study_stage = "OUT_OF_SAMPLE";
      record.simulation.prior_outcome_accessed = false;
      record.simulation.outcome_accessed_at =
        futureOutcome.outcome_accessed_at;
      record.simulation = rehashSimulation(record.simulation);
    }
    expect(() => buildHistoricalReplayReport(futureOutcome)).toThrow(
      "scheduled exit is after outcome_accessed_at",
    );

    const unfilledLimit = replayInput();
    for (const record of unfilledLimit.execution_records.filter(
      (item) =>
        item.candidate_id === "candidate-cv" &&
        item.horizon_id === "PLUS_3_TRADING_DAYS" &&
        item.simulation !== null &&
        item.scenario_id !== "reference",
    )) {
      record.simulation.exit.signed_limit = "0.83";
      record.simulation = rehashSimulation(record.simulation);
    }
    expect(() => buildHistoricalReplayReport(unfilledLimit)).toThrow(
      "signed_limit is not aligned to tick_size",
    );
  });

  test("rejects premature horizon exits and unknown candidate states", () => {
    const prematureExit = replayInput();
    const exitRecord = prematureExit.execution_records.find(
      (record) => record.simulation?.status === "SIMULATED_FILLED",
    );
    exitRecord.simulation.exit.window_start =
      "2026-09-24T14:39:00.000Z";
    exitRecord.simulation.exit.window_end =
      "2026-09-24T14:41:00.000Z";
    exitRecord.simulation.exit.filled_at =
      "2026-09-24T14:40:00.000Z";
    exitRecord.simulation.exit.first_touch_window = {
      start: "2026-09-24T14:39:00.000Z",
      end: "2026-09-24T14:40:00.000Z",
    };
    exitRecord.simulation = rehashSimulation(exitRecord.simulation);
    expect(() => buildHistoricalReplayReport(prematureExit)).toThrow(
      "exit window does not reach the frozen scheduled exit",
    );

    const unknownCandidateState = replayInput();
    unknownCandidateState.candidates.at(-1).data_status =
      "UNKNOWN_RUNTIME_STATUS";
    expect(() =>
      buildHistoricalReplayReport(unknownCandidateState),
    ).toThrow(
      "data_status must be AVAILABLE, MISSING, or REJECTED",
    );
  });

  test("requires the explicit V1 research policy and non-optimistic baseline", () => {
    const disguisedPolicy = replayInput();
    disguisedPolicy.policies[1].policy_version =
      "DD_RELAXED_SURFACE_V1_TWEAK";
    expect(() => buildHistoricalReplayReport(disguisedPolicy)).toThrow(
      "research policy_version must be DD_MILD_BACK_RICH_V1",
    );

    const optimisticBaseline = replayInput();
    const baseline = optimisticBaseline.scenarios.find(
      (scenario) => scenario.role === "BASELINE",
    );
    baseline.execution_profile.midpoint_to_adverse_fraction = "0";
    baseline.execution_profile.additional_cost_per_package = "0";
    const { profile_hash: _profileHash, ...profileBody } =
      baseline.execution_profile;
    baseline.execution_profile.profile_hash =
      historicalExecutionProfileHash(profileBody);
    expect(() =>
      buildHistoricalReplayReport(optimisticBaseline),
    ).toThrow("BASELINE scenario must be more adverse than OPTIMISTIC");
  });

  test("keeps reference-cost simulations isolated but metric-eligible", () => {
    const input = replayInput();
    const candidate = CANDIDATES.find(
      (item) => item.candidate_id === "candidate-dv",
    );
    const referenceScenario = input.scenarios.find(
      (scenario) => scenario.role === "REFERENCE",
    );
    const horizon = HORIZONS[0];
    let simulation = simulationFor(
      candidate,
      referenceScenario,
      horizon,
    );
    simulation = rehashSimulation({
      ...simulation,
      status: "SIMULATED_FILLED",
      entry: {
        ...simulation.entry,
        status: "SIMULATED_FILLED",
        fill_price: "1.3",
        filled_at: ENTRY_AT,
        evidence_id: contentId("reference-entry-evidence"),
        evidence_kind: "CANDLE_REFERENCE",
        evidence_coverage: "COMPLETE",
        first_touch_window: {
          start: ENTRY_AT,
          end: ENTRY_AT,
        },
        selected_observation_count: 1,
      },
      exit: {
        ...simulation.entry,
        phase: "EXIT",
        status: "SIMULATED_FILLED",
        window_start: new Date(
          Date.parse(horizon.scheduled_exit_at) - 10_000,
        ).toISOString(),
        window_end: new Date(
          Date.parse(horizon.scheduled_exit_at) + 50_000,
        ).toISOString(),
        signed_limit: "0.8",
        fill_price: "1.2",
        filled_at: horizon.scheduled_exit_at,
        evidence_id: contentId("reference-exit-evidence"),
        evidence_kind: "CANDLE_REFERENCE",
        evidence_coverage: "COMPLETE",
        first_touch_window: {
          start: horizon.scheduled_exit_at,
          end: horizon.scheduled_exit_at,
        },
        selected_observation_count: 1,
      },
      pnl: {
        ...simulation.pnl,
        signed_entry_cost: "1.3",
        signed_exit_receipt: "1.2",
        gross_pnl: "-10",
        net_pnl: null,
      },
    });
    const record = input.execution_records.find(
      (item) =>
        item.candidate_id === candidate.candidate_id &&
        item.scenario_id === referenceScenario.scenario_id &&
        item.horizon_id === horizon.horizon_id,
    );
    record.source_manifest_ids = simulation.source_manifest_ids;
    record.evidence_class = "SIMULATED_EXECUTION";
    record.simulation = simulation;
    record.valuation_evidence_id = null;
    record.reason_codes = [];

    const result = buildHistoricalReplayReport(input);
    const group = result.groups.find(
      (item) =>
        item.policy_role === "BASELINE" &&
        item.scenario_role === "REFERENCE" &&
        item.horizon_id === horizon.horizon_id,
    );
    expect(group.evidence_strength).toBe("REFERENCE_MODEL");
    expect(group.simulated_filled_count).toBe(1);
    expect(group.closed_position_denominator).toBe(1);
  });

  test("publishes a machine-readable replay report schema", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../docs/historical-replay.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const result = buildHistoricalReplayReport(replayInput());

    expect(validate(result)).toBe(true);
    expect(
      validate({ ...result, writes_forward_paper_state: true }),
    ).toBe(false);
  });

  test("exposes the replay builder through the local MCP contract", async () => {
    const server = createResearchServer({
      backtester: {},
      candles: {},
      evidenceCache: null,
    });
    const client = new Client({
      name: "historical-replay-test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "tastytrade_build_historical_replay_report",
        arguments: { request: replayInput() },
      });
      const report = JSON.parse(
        result.content.find((item) => item.type === "text").text,
      );
      expect(report.report_type).toBe("HISTORICAL_REPLAY_ACCEPTANCE");
      expect(report.writes_forward_paper_state).toBe(false);
      expect(report.writes_monthly_paper_file).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("builds the same report through the CLI runner", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "historical-replay-cli-"),
    );
    const inputPath = join(directory, "request.json");
    try {
      await writeFile(
        inputPath,
        JSON.stringify(replayInput()),
        "utf8",
      );
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "scripts/build-historical-replay-report.mjs",
          "--input",
          inputPath,
        ],
        { cwd: new URL("..", import.meta.url) },
      );
      const report = JSON.parse(stdout);
      expect(report.replay_id).toBe(
        buildHistoricalReplayReport(replayInput()).replay_id,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
