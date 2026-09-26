import { describe, expect, test } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  HISTORICAL_EXECUTION_EVIDENCE_CONTRACT_VERSION,
  normalizeHistoricalExecutionEvidence,
} from "../dist/historical-execution-evidence.js";

const OBSERVED_AT = "2026-09-24T14:30:00.000Z";
const RETRIEVED_AT = "2026-10-01T12:00:00.000Z";

function contentId(character) {
  return `sha256:${character.repeat(64)}`;
}

function source(index, overrides = {}) {
  return {
    source_id: `quote-${index}`,
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
      String.fromCharCode("a".charCodeAt(0) + index),
    ),
    ...overrides,
  };
}

function leg(providerSymbol, action, ratio = 1, settlement = "PM") {
  const compact = providerSymbol.slice(6, 12);
  return {
    provider_symbol: providerSymbol,
    action,
    ratio,
    expiration: `20${compact.slice(0, 2)}-${compact.slice(2, 4)}-${compact.slice(4, 6)}`,
    settlement,
    multiplier: "100",
  };
}

function quote(providerSymbol, bid, ask, index, overrides = {}) {
  return {
    provider_symbol: providerSymbol,
    bid,
    ask,
    bid_size: 20,
    ask_size: 20,
    quote_kind: "NBBO",
    quote_status: "NORMAL",
    price_semantics: "OPTION_PREMIUM_PER_UNIT",
    source_timestamp: "2026-09-24T14:29:59.000Z",
    available_at: "2026-09-24T14:29:59.100Z",
    bar_end: null,
    retrieved_at: RETRIEVED_AT,
    ...source(index),
    ...overrides,
  };
}

function baseInput({
  family = "DEBIT_VERTICAL",
  legs = [
    leg("SPXW  261016C06000000", "BUY_TO_OPEN"),
    leg("SPXW  261016C06050000", "SELL_TO_OPEN"),
  ],
  legQuotes = [
    quote("SPXW  261016C06000000", "4", "4.2", 0),
    quote("SPXW  261016C06050000", "1", "1.2", 1),
  ],
  nativePackageQuote = null,
  references = [],
  scope = "SNAPSHOT",
  expectedObservationTimes = [OBSERVED_AT],
  observations,
} = {}) {
  return {
    scope,
    family,
    underlying: "SPX",
    candidate_fingerprint: "candidate-fixture-v1",
    quote_policy: {
      max_quote_age_ms: 2_000,
      max_temporal_skew_ms: 500,
      require_sizes: true,
    },
    expected_observation_times: expectedObservationTimes,
    legs,
    observations:
      observations ??
      [
        {
          observed_at: OBSERVED_AT,
          leg_quotes: legQuotes,
          native_package_quote: nativePackageQuote,
          references,
        },
      ],
  };
}

const familyCases = [
  {
    family: "DEBIT_VERTICAL",
    legs: [
      leg("SPXW  261016C06000000", "BUY_TO_OPEN"),
      leg("SPXW  261016C06050000", "SELL_TO_OPEN"),
    ],
    quotes: [
      quote("SPXW  261016C06000000", "4", "4.2", 0),
      quote("SPXW  261016C06050000", "1", "1.2", 1),
    ],
    signedBid: "2.8",
    signedAsk: "3.2",
  },
  {
    family: "CREDIT_VERTICAL",
    legs: [
      leg("SPXW  261016C06000000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06050000", "BUY_TO_OPEN"),
    ],
    quotes: [
      quote("SPXW  261016C06000000", "4", "4.2", 0),
      quote("SPXW  261016C06050000", "1", "1.2", 1),
    ],
    signedBid: "-3.2",
    signedAsk: "-2.8",
  },
  {
    family: "IRON_CONDOR",
    legs: [
      leg("SPXW  261016P05800000", "BUY_TO_OPEN"),
      leg("SPXW  261016P05850000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06150000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06200000", "BUY_TO_OPEN"),
    ],
    quotes: [
      quote("SPXW  261016P05800000", "0.8", "0.9", 0),
      quote("SPXW  261016P05850000", "2", "2.1", 1),
      quote("SPXW  261016C06150000", "2.2", "2.3", 2),
      quote("SPXW  261016C06200000", "0.7", "0.8", 3),
    ],
    signedBid: "-2.9",
    signedAsk: "-2.5",
  },
  {
    family: "DOUBLE_DIAGONAL",
    legs: [
      leg("SPXW  261002P05850000", "SELL_TO_OPEN"),
      leg("SPXW  261016P05800000", "BUY_TO_OPEN"),
      leg("SPXW  261002C06150000", "SELL_TO_OPEN"),
      leg("SPXW  261016C06200000", "BUY_TO_OPEN"),
    ],
    quotes: [
      quote("SPXW  261002P05850000", "2", "2.1", 0),
      quote("SPXW  261016P05800000", "3", "3.2", 1),
      quote("SPXW  261002C06150000", "2.2", "2.3", 2),
      quote("SPXW  261016C06200000", "3.1", "3.3", 3),
    ],
    signedBid: "1.7",
    signedAsk: "2.3",
  },
];

describe("historical exact-leg execution evidence", () => {
  test.each(familyCases)(
    "normalizes $family signed package quotes without discarding cash-flow direction",
    ({ family, legs, quotes, signedBid, signedAsk }) => {
      const result = normalizeHistoricalExecutionEvidence(
        baseInput({ family, legs, legQuotes: quotes }),
      );

      expect(result).toMatchObject({
        contract_version:
          HISTORICAL_EXECUTION_EVIDENCE_CONTRACT_VERSION,
        evidence_type: "HISTORICAL_EXACT_LEG_QUOTE_HANDOFF",
        status: "AVAILABLE",
        candidate_fingerprint: "candidate-fixture-v1",
        verified_multiplier: "100",
        broker_fill_verified: false,
        observations: [
          {
            status: "COMPLETE",
            quote_coverage: "COMPLETE",
            trade_coverage: "NONE",
            candle_coverage: "NONE",
            model_coverage: "NONE",
            synthetic_package_quote: {
              signed_bid: signedBid,
              signed_ask: signedAsk,
              bid_size: 20,
              ask_size: 20,
              price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
              quote_origin: "ALIGNED_LEG_QUOTES",
              usable_for_simulated_execution: true,
            },
          },
        ],
        evidence_layers: {
          valuation_only: { present: false },
          simulated_execution: {
            input_status: "COMPLETE",
            result_present: false,
          },
          broker_execution: { verified: false },
        },
      });
      expect(result.evidence_id).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.inventory.map((item) => item.inventory_quantity)).toEqual(
        legs.map((item) =>
          item.action === "BUY_TO_OPEN" ? item.ratio : -item.ratio,
        ),
      );
    },
  );

  test("keeps native package, synthetic package, and valuation references separate", () => {
    const input = baseInput({
      nativePackageQuote: {
        signed_bid: "2.85",
        signed_ask: "3.15",
        bid_size: 5,
        ask_size: 4,
        quote_kind: "NBBO",
        quote_status: "NORMAL",
        price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
        source_timestamp: "2026-09-24T14:29:59.000Z",
        available_at: "2026-09-24T14:29:59.100Z",
        bar_end: null,
        retrieved_at: RETRIEVED_AT,
        ...source(4, { source_id: "native-combo-1" }),
      },
      references: [
        {
          evidence_type: "CANDLE_REFERENCE",
          signed_value: "2.95",
          price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
          source_timestamp: "2026-09-24T14:29:00.000Z",
          available_at: "2026-09-24T14:30:00.000Z",
          bar_end: "2026-09-24T14:30:00.000Z",
          retrieved_at: RETRIEVED_AT,
          model_version: null,
          ...source(5, {
            source_id: "candle-reference-1",
            dataset_id: "dxlink-candles",
            resolution_profile: {
              profile_id: "DEFAULT_5M",
              profile_version: "1.0.0",
              native_resolution: "5m",
              effective_resolution: "5m",
            },
          }),
        },
      ],
    });

    const result = normalizeHistoricalExecutionEvidence(input);
    expect(result.observations[0]).toMatchObject({
      native_package_quote: {
        signed_bid: "2.85",
        signed_ask: "3.15",
        quote_origin: "NATIVE_PACKAGE",
        usable_for_simulated_execution: true,
      },
      synthetic_package_quote: {
        signed_bid: "2.8",
        signed_ask: "3.2",
        quote_origin: "ALIGNED_LEG_QUOTES",
      },
      trade_coverage: "NONE",
      candle_coverage: "COMPLETE",
    });
    expect(result.observations[0].references).toEqual([
      expect.objectContaining({
        evidence_type: "CANDLE_REFERENCE",
        evidence_class: "VALUATION_ONLY",
        signed_value: "2.95",
      }),
    ]);
    expect(result.evidence_layers).toMatchObject({
      valuation_only: { present: true },
      simulated_execution: {
        input_status: "COMPLETE",
        result_present: false,
      },
      broker_execution: {
        verified: false,
        evidence_ids: [],
      },
    });
  });

  test("keeps quote coverage complete when no trade or candle exists", () => {
    const result = normalizeHistoricalExecutionEvidence(baseInput());

    expect(result.coverage).toMatchObject({
      expected_observations: 1,
      observed_observations: 1,
      complete_quote_observations: 1,
      quote_coverage: "COMPLETE",
      trade_coverage: "NONE",
      candle_coverage: "NONE",
    });
    expect(result.observations[0].references).toEqual([]);
  });

  test("fails closed when raw size cannot satisfy a multi-contract ratio", () => {
    const input = baseInput();
    input.legs[0].ratio = 5;
    input.legs[1].ratio = 5;
    input.observations[0].leg_quotes[0].bid_size = 3;
    input.observations[0].leg_quotes[0].ask_size = 3;
    input.observations[0].leg_quotes[1].bid_size = 3;
    input.observations[0].leg_quotes[1].ask_size = 3;

    const result = normalizeHistoricalExecutionEvidence(input);

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.observations[0].synthetic_package_quote).toMatchObject({
      bid_size: null,
      ask_size: null,
      usable_for_simulated_execution: false,
      rejection_reasons: expect.arrayContaining([
        "INSUFFICIENT_PACKAGE_SIZE",
      ]),
    });
  });

  test("rejects ambiguous native signs without rewriting their semantics", () => {
    const input = baseInput({
      nativePackageQuote: {
        signed_bid: "2.85",
        signed_ask: "3.15",
        bid_size: 5,
        ask_size: 4,
        quote_kind: "NBBO",
        quote_status: "NORMAL",
        price_semantics: "UNSIGNED_ABSOLUTE",
        source_timestamp: "2026-09-24T14:29:59.000Z",
        available_at: "2026-09-24T14:29:59.100Z",
        bar_end: null,
        retrieved_at: RETRIEVED_AT,
        ...source(4, { source_id: "native-combo-1" }),
      },
    });

    const result = normalizeHistoricalExecutionEvidence(input);

    expect(result.status).toBe("AVAILABLE");
    expect(result.coverage.quote_coverage).toBe("COMPLETE");
    expect(result.observations[0]).toMatchObject({
      status: "PARTIAL",
      native_package_quote: {
        signed_bid: null,
        signed_ask: null,
        price_semantics: "UNSIGNED_ABSOLUTE",
        usable_for_simulated_execution: false,
        rejection_reasons: expect.arrayContaining([
          "UNCLEAR_PRICE_SEMANTICS",
        ]),
      },
      synthetic_package_quote: {
        usable_for_simulated_execution: true,
      },
    });
  });

  test("rejects a native package quote when the leg quote cohort is mixed", () => {
    const input = baseInput({
      nativePackageQuote: {
        signed_bid: "2.85",
        signed_ask: "3.15",
        bid_size: 5,
        ask_size: 4,
        quote_kind: "NBBO",
        quote_status: "NORMAL",
        price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
        source_timestamp: "2026-09-24T14:29:59.000Z",
        available_at: "2026-09-24T14:29:59.100Z",
        bar_end: null,
        retrieved_at: RETRIEVED_AT,
        ...source(4, {
          source_id: "native-combo-1",
          provider_id: "third-provider",
        }),
      },
    });
    input.observations[0].leg_quotes[0].provider_id = "other-provider";

    const result = normalizeHistoricalExecutionEvidence(input);

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(
      result.observations[0].native_package_quote.rejection_reasons,
    ).toContain("MIXED_QUOTE_COHORT");
    expect(
      result.observations[0].native_package_quote
        .usable_for_simulated_execution,
    ).toBe(false);
  });

  test.each([
    [
      "future availability",
      (input) => {
        input.observations[0].leg_quotes[0].available_at =
          "2026-09-24T14:30:00.001Z";
      },
      "FUTURE_AVAILABLE_AT",
    ],
    [
      "incomplete bar",
      (input) => {
        input.observations[0].leg_quotes[0].bar_end =
          "2026-09-24T14:30:00.001Z";
      },
      "INCOMPLETE_BAR",
    ],
    [
      "stale quote",
      (input) => {
        input.observations[0].leg_quotes[0].source_timestamp =
          "2026-09-24T14:29:00.000Z";
      },
      "STALE_QUOTE",
    ],
    [
      "temporal skew",
      (input) => {
        input.observations[0].leg_quotes[0].source_timestamp =
          "2026-09-24T14:29:58.000Z";
      },
      "TEMPORAL_SKEW_EXCEEDED",
    ],
    [
      "cross-provider leg mix",
      (input) => {
        input.observations[0].leg_quotes[0].provider_id = "other-provider";
      },
      "MIXED_QUOTE_COHORT",
    ],
    [
      "cross-resolution leg mix",
      (input) => {
        input.observations[0].leg_quotes[0].resolution_profile = {
          ...input.observations[0].leg_quotes[0].resolution_profile,
          effective_resolution: "1m",
        };
      },
      "MIXED_QUOTE_COHORT",
    ],
    [
      "missing leg",
      (input) => {
        input.observations[0].leg_quotes.pop();
      },
      "MISSING_LEG_QUOTE",
    ],
    [
      "missing size",
      (input) => {
        input.observations[0].leg_quotes[0].bid_size = null;
      },
      "MISSING_LEG_SIZE",
    ],
    [
      "crossed quote",
      (input) => {
        input.observations[0].leg_quotes[0].bid = "4.3";
      },
      "CROSSED_LEG_QUOTE",
    ],
    [
      "SNIP status",
      (input) => {
        input.observations[0].leg_quotes[0].quote_status = "SNIP";
      },
      "UNUSABLE_QUOTE_STATUS",
    ],
    [
      "unclear price semantics",
      (input) => {
        input.observations[0].leg_quotes[0].price_semantics = "UNKNOWN";
      },
      "UNCLEAR_PRICE_SEMANTICS",
    ],
    [
      "retrieval before observation",
      (input) => {
        input.observations[0].leg_quotes[0].retrieved_at =
          "2026-09-24T14:29:59.500Z";
      },
      "INVALID_TIMESTAMP_ORDER",
    ],
  ])("fails closed for %s", (_label, mutate, expectedReason) => {
    const input = structuredClone(baseInput());
    mutate(input);

    const result = normalizeHistoricalExecutionEvidence(input);

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.coverage.quote_coverage).toBe("PARTIAL");
    expect(result.observations[0]).toMatchObject({
      status: "REJECTED",
      quote_coverage: "PARTIAL",
      synthetic_package_quote: expect.objectContaining({
        usable_for_simulated_execution: false,
      }),
    });
    expect(result.observations[0].rejection_reasons).toContain(
      expectedReason,
    );
  });

  test("reports ordered window coverage and missing observations without filling gaps", () => {
    const first = baseInput().observations[0];
    const last = structuredClone(first);
    last.observed_at = "2026-09-24T14:32:00.000Z";
    for (const quoteItem of last.leg_quotes) {
      quoteItem.source_timestamp = "2026-09-24T14:31:59.000Z";
      quoteItem.available_at = "2026-09-24T14:31:59.100Z";
    }
    const result = normalizeHistoricalExecutionEvidence(
      baseInput({
        scope: "WINDOW",
        expectedObservationTimes: [
          "2026-09-24T14:30:00.000Z",
          "2026-09-24T14:31:00.000Z",
          "2026-09-24T14:32:00.000Z",
        ],
        observations: [last, first],
      }),
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.observations.map((item) => item.observed_at)).toEqual([
      "2026-09-24T14:30:00.000Z",
      "2026-09-24T14:32:00.000Z",
    ]);
    expect(result.coverage).toMatchObject({
      expected_observations: 3,
      observed_observations: 2,
      complete_quote_observations: 2,
      missing_observations: 1,
      quote_coverage: "PARTIAL",
      gaps: [
        {
          observed_at: "2026-09-24T14:31:00.000Z",
          reasons: ["MISSING_OBSERVATION"],
        },
      ],
    });
  });

  test("uses immutable source lineage in deterministic evidence identity", () => {
    const input = baseInput();
    const first = normalizeHistoricalExecutionEvidence(input);
    const replay = normalizeHistoricalExecutionEvidence(
      structuredClone(input),
    );
    expect(replay).toEqual(first);

    const revised = structuredClone(input);
    revised.observations[0].leg_quotes[0].revision = 2;
    revised.observations[0].leg_quotes[0].manifest_id = contentId("9");
    const second = normalizeHistoricalExecutionEvidence(revised);

    expect(second.evidence_id).not.toBe(first.evidence_id);
    expect(first.source_manifest_ids).toEqual(
      expect.arrayContaining([contentId("1"), contentId("2")]),
    );
    expect(first.normalized_content_ids).toHaveLength(2);
  });

  test("binds derived package quote IDs to the exact frozen inventory", () => {
    const first = normalizeHistoricalExecutionEvidence(baseInput());
    const secondInput = baseInput();
    secondInput.legs[0].ratio = 2;
    secondInput.observations[0].leg_quotes[0].bid_size = 40;
    secondInput.observations[0].leg_quotes[0].ask_size = 40;
    const second = normalizeHistoricalExecutionEvidence(secondInput);

    expect(
      second.observations[0].synthetic_package_quote.evidence_id,
    ).not.toBe(
      first.observations[0].synthetic_package_quote.evidence_id,
    );
  });

  test("rejects inventory changes hidden in duplicate or mismatched OCC metadata", () => {
    const duplicate = baseInput();
    duplicate.legs[1].provider_symbol =
      duplicate.legs[0].provider_symbol;
    expect(() =>
      normalizeHistoricalExecutionEvidence(duplicate),
    ).toThrow("Duplicate leg provider_symbol");

    const mismatch = baseInput();
    mismatch.legs[0].expiration = "2026-10-17";
    expect(() =>
      normalizeHistoricalExecutionEvidence(mismatch),
    ).toThrow("does not match OCC expiration");
  });

  test("publishes a machine-readable schema matching the normalized handoff", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL(
          "../docs/historical-execution-evidence.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const result = normalizeHistoricalExecutionEvidence(baseInput());

    expect(validate(result)).toBe(true);
    expect(
      validate({
        ...result,
        broker_fill_verified: true,
      }),
    ).toBe(false);
  });
});
