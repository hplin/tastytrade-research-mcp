import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";
import {
  migrateLegacyDdIvRecord,
  normalizeDdIvMeasurements,
} from "../dist/dd-iv-measurement.js";

function fixtureInput() {
  return JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/dd-iv-measurement-input-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).input;
}

function matched(result, id) {
  return result.matched_measurements.find(
    (measurement) => measurement.measurement_id === id,
  );
}

function interpolationInput(targetDelta = "25") {
  const input = fixtureInput();
  input.request.measurement_profile.matched_coordinates = [
    {
      measurement_id: "put-interpolated",
      measurement_basis: "MATCHED_DELTA",
      front_expiration: "2026-09-15T20:00:00.000Z",
      back_expiration: "2026-09-29T20:00:00.000Z",
      option_side: "PUT",
      target_delta: targetDelta,
      delta_convention: "ABSOLUTE_FORWARD_DELTA_PERCENT",
      tolerance: "0",
      missing_policy: "NOT_AVAILABLE",
      max_front_back_skew_ms: 600000,
      interpolation: {
        allowed: true,
        method: "LINEAR_BY_DELTA",
        max_bracket_width: "10",
        max_bracket_skew_ms: 600000,
      },
    },
  ];
  input.observations = input.observations.filter(
    (observation) =>
      !["FRONT-PUT-25D", "BACK-PUT-25D"].includes(
        observation.source_symbol,
      ),
  );
  const frontUpper = structuredClone(
    input.observations.find(
      (observation) => observation.source_symbol === "FRONT-PUT-20D",
    ),
  );
  frontUpper.source_symbol = "FRONT-PUT-30D";
  frontUpper.strike = "7425";
  frontUpper.iv = "0.22";
  frontUpper.delta = "-30";
  const backLower = structuredClone(
    input.observations.find(
      (observation) => observation.source_symbol === "BACK-PUT-30D",
    ),
  );
  backLower.source_symbol = "BACK-PUT-20D";
  backLower.strike = "7475";
  backLower.iv = "0.21";
  backLower.delta = "-20";
  input.observations.find(
    (observation) => observation.source_symbol === "BACK-PUT-30D",
  ).iv = "0.24";
  input.observations.push(frontUpper, backLower);
  return input;
}

function moneynessInterpolationInput() {
  const input = fixtureInput();
  input.request.measurement_profile.matched_coordinates = [
    {
      measurement_id: "put-atm-log-moneyness-interpolated",
      measurement_basis: "MATCHED_FORWARD_MONEYNESS",
      front_expiration: "2026-09-15T20:00:00.000Z",
      back_expiration: "2026-09-29T20:00:00.000Z",
      option_side: "PUT",
      target_log_moneyness: "0",
      moneyness_convention: "LN_STRIKE_OVER_FORWARD",
      tolerance: "0",
      missing_policy: "NOT_AVAILABLE",
      max_front_back_skew_ms: 600000,
      interpolation: {
        allowed: true,
        method: "LINEAR_BY_LOG_MONEYNESS",
        max_bracket_width: "0.02",
        max_bracket_skew_ms: 600000,
      },
    },
  ];
  const additions = [
    ["FRONT-PUT-7600", "2026-09-15T20:00:00.000Z", "7600", "0.2"],
    ["FRONT-PUT-7700", "2026-09-15T20:00:00.000Z", "7700", "0.22"],
    ["BACK-PUT-7600", "2026-09-29T20:00:00.000Z", "7600", "0.21"],
    ["BACK-PUT-7700", "2026-09-29T20:00:00.000Z", "7700", "0.23"],
  ].map(([sourceSymbol, expiration, strike, iv]) => {
    const observation = structuredClone(
      input.observations.find(
        (item) =>
          item.option_side === "PUT" && item.expiration === expiration,
      ),
    );
    observation.source_symbol = sourceSymbol;
    observation.strike = strike;
    observation.iv = iv;
    observation.delta = null;
    observation.delta_convention = null;
    observation.delta_origin = null;
    observation.lineage = [
      {
        source: `fixture:${sourceSymbol}`,
        source_timestamp: observation.available_at,
        fields: ["iv", "forward", "strike"],
        origin: "PROVIDER_OBSERVATION",
      },
    ];
    return observation;
  });
  input.observations.push(...additions);
  return input;
}

describe("Double Diagonal IV measurement contract", () => {
  test("reproduces the checked-in grading/regression handoff dataset", () => {
    const example = JSON.parse(
      readFileSync(
        new URL(
          "../docs/examples/dd-iv-measurement-handoff-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    expect(example).toMatchObject({
      dataset_version: "dd-iv-handoff/1.0.0",
      intended_consumers: [
        "spx-spread-grading",
        "spx-spread-regression",
      ],
      policy_fields_included: false,
    });
    expect(normalizeDdIvMeasurements(fixtureInput())).toEqual(
      example.handoff,
    );
  });

  test("keeps selected-leg and matched-delta measurements distinct", () => {
    const result = normalizeDdIvMeasurements(fixtureInput());
    const selected = result.selected_leg_measurement;
    const putMatched = matched(
      result,
      "put-25-absolute-forward-delta",
    );
    const callMatched = matched(
      result,
      "call-25-absolute-forward-delta",
    );

    expect(result).toMatchObject({
      contract_version: "1.0.0",
      grading_role: "RESEARCH_ONLY",
      measurement_profile_version: "1.0.0",
      candidate_id: "dd-fixture-2026-08-25",
      legacy_term_structure_replaced: false,
    });
    expect(selected).toMatchObject({
      measurement_basis: "SELECTED_LEG_IV_DIFFERENCE",
      status: "AVAILABLE",
      iv_unit: "DECIMAL",
      sides: {
        PUT: {
          front_iv_decimal: "0.2",
          back_iv_decimal: "0.215",
          spread_decimal: "0.015",
          spread_vol_points: "1.50",
        },
        CALL: {
          front_iv_decimal: "0.18",
          back_iv_decimal: "0.17",
          spread_decimal: "-0.01",
          spread_vol_points: "-1.00",
        },
      },
      combined: {
        status: "AVAILABLE",
        aggregation: "WEIGHTED_ARITHMETIC_MEAN",
        weights: { PUT: "0.5", CALL: "0.5" },
        component_spreads: { PUT: "0.015", CALL: "-0.01" },
        spread_decimal: "0.0025",
        spread_vol_points: "0.25",
      },
    });
    expect(selected.warnings).toContain(
      "SELECTED_LEG_SIDE_SPREADS_HAVE_OPPOSING_SIGNS",
    );
    expect(
      selected.frozen_legs.map((leg) => [
        leg.candidate_id,
        leg.role,
        leg.source_symbol,
        leg.iv,
        leg.delta,
        leg.model.forward_model,
        leg.provider,
        leg.dataset,
        leg.resolution,
        leg.alignment,
        leg.source_cohort_id,
      ]),
    ).toEqual([
      [
        "dd-fixture-2026-08-25",
        "FRONT_PUT_SHORT",
        "FRONT-PUT-20D",
        "0.2",
        "-20",
        "SPOT_FORWARD_ZERO_CARRY",
        "tastytrade-dxlink",
        "historical-spx-candidate-universe/1.0.0",
        "5m",
        "MIDNIGHT",
        "fixture-5m-cohort",
      ],
      [
        "dd-fixture-2026-08-25",
        "FRONT_CALL_SHORT",
        "FRONT-CALL-20D",
        "0.18",
        "20",
        "SPOT_FORWARD_ZERO_CARRY",
        "tastytrade-dxlink",
        "historical-spx-candidate-universe/1.0.0",
        "5m",
        "MIDNIGHT",
        "fixture-5m-cohort",
      ],
      [
        "dd-fixture-2026-08-25",
        "BACK_PUT_LONG",
        "BACK-PUT-30D",
        "0.215",
        "-30",
        "SPOT_FORWARD_ZERO_CARRY",
        "tastytrade-dxlink",
        "historical-spx-candidate-universe/1.0.0",
        "5m",
        "MIDNIGHT",
        "fixture-5m-cohort",
      ],
      [
        "dd-fixture-2026-08-25",
        "BACK_CALL_LONG",
        "BACK-CALL-30D",
        "0.17",
        "30",
        "SPOT_FORWARD_ZERO_CARRY",
        "tastytrade-dxlink",
        "historical-spx-candidate-universe/1.0.0",
        "5m",
        "MIDNIGHT",
        "fixture-5m-cohort",
      ],
    ]);
    expect(putMatched).toMatchObject({
      measurement_basis: "MATCHED_DELTA",
      option_side: "PUT",
      status: "AVAILABLE",
      iv_unit: "DECIMAL",
      spread_decimal: "0",
      spread_vol_points: "0.00",
      front: {
        status: "AVAILABLE",
        achieved_coordinate: "25",
        delta_error: "0",
        source_strikes: ["7450"],
      },
      back: {
        status: "AVAILABLE",
        achieved_coordinate: "25",
        delta_error: "0",
        source_strikes: ["7475"],
      },
    });
    expect(putMatched.front.inputs[0]).toMatchObject({
      delta: "-25",
      delta_convention: "SIGNED_FORWARD_DELTA_PERCENT",
      delta_origin: "DERIVED",
      iv_origin: "PROVIDER_OBSERVATION",
      model: {
        delta_model: "BLACK_76_FORWARD_DELTA",
        forward_model: "SPOT_FORWARD_ZERO_CARRY",
      },
      forward: {
        origin: "DERIVED",
      },
    });
    expect(callMatched).toMatchObject({
      measurement_basis: "MATCHED_DELTA",
      option_side: "CALL",
      status: "AVAILABLE",
      spread_decimal: "0.005",
      spread_vol_points: "0.50",
    });
    expect(selected.cohort_id).not.toBe(putMatched.cohort_id);
    expect(selected.cohort_id).not.toBe(callMatched.cohort_id);
    expect(putMatched.cohort_id).not.toBe(callMatched.cohort_id);
  });

  test("does not turn null, NaN, stale, incomplete, or future bars into evidence", () => {
    const input = fixtureInput();
    input.observations.find(
      (observation) => observation.source_symbol === "FRONT-PUT-20D",
    ).iv = null;
    input.observations.find(
      (observation) => observation.source_symbol === "FRONT-CALL-20D",
    ).iv = Number.NaN;
    input.observations.find(
      (observation) => observation.source_symbol === "BACK-PUT-30D",
    ).freshness = "STALE";
    input.observations.find(
      (observation) => observation.source_symbol === "BACK-CALL-30D",
    ).bar_status = "INCOMPLETE";
    input.observations.find(
      (observation) => observation.source_symbol === "FRONT-PUT-25D",
    ).available_at = "2026-08-25T14:35:00.000Z";
    input.observations.find(
      (observation) => observation.source_symbol === "BACK-PUT-25D",
    ).freshness = "STALE";
    input.observations.find(
      (observation) => observation.source_symbol === "FRONT-CALL-25D",
    ).forward.source_timestamp = "2026-08-25T14:35:00.000Z";
    input.observations.find(
      (observation) => observation.source_symbol === "BACK-CALL-25D",
    ).lineage[0].source_timestamp = "2026-08-25T14:35:00.000Z";

    const result = normalizeDdIvMeasurements(input);

    expect(result.selected_leg_measurement.status).toBe("NOT_AVAILABLE");
    expect(result.selected_leg_measurement.sides.PUT.spread_decimal).toBeNull();
    expect(result.selected_leg_measurement.sides.CALL.spread_decimal).toBeNull();
    expect(
      matched(result, "put-25-absolute-forward-delta").front,
    ).toMatchObject({
      status: "NOT_AVAILABLE",
      iv_decimal: null,
    });
    expect(
      matched(result, "call-25-absolute-forward-delta"),
    ).toMatchObject({
      status: "NOT_AVAILABLE",
      spread_decimal: null,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "INVALID_IV_EXCLUDED:FRONT-CALL-20D",
        "MISSING_IV:FRONT-PUT-20D",
        "STALE_OBSERVATION_EXCLUDED:BACK-PUT-30D",
        "INCOMPLETE_BAR_EXCLUDED:BACK-CALL-30D",
        "POST_CHECKPOINT_OBSERVATION_EXCLUDED:FRONT-PUT-25D",
        "STALE_OBSERVATION_EXCLUDED:BACK-PUT-25D",
        "POST_CHECKPOINT_FORWARD_EXCLUDED:FRONT-CALL-25D",
        "POST_CHECKPOINT_LINEAGE_EXCLUDED:BACK-CALL-25D",
      ]),
    );
  });

  test("rejects a far closest contract and reports achieved delta coverage", () => {
    const input = fixtureInput();
    input.request.measurement_profile.matched_coordinates = [
      {
        measurement_id: "far-put",
        measurement_basis: "MATCHED_DELTA",
        front_expiration: "2026-09-15T20:00:00.000Z",
        back_expiration: "2026-09-29T20:00:00.000Z",
        option_side: "PUT",
        target_delta: "5",
        delta_convention: "ABSOLUTE_FORWARD_DELTA_PERCENT",
        tolerance: "1",
        missing_policy: "NOT_AVAILABLE",
        max_front_back_skew_ms: 600000,
      },
    ];

    const result = matched(
      normalizeDdIvMeasurements(input),
      "far-put",
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.spread_decimal).toBeNull();
    expect(result.front).toMatchObject({
      status: "NOT_AVAILABLE",
      achieved_coordinate: "20",
      delta_error: "15",
      coverage_gap: "14",
      source_strikes: ["7400"],
    });
    expect(result.back).toMatchObject({
      status: "NOT_AVAILABLE",
      achieved_coordinate: "25",
      delta_error: "20",
      coverage_gap: "19",
      source_strikes: ["7475"],
    });
    expect(result.warnings).toContain(
      "MATCH_TOLERANCE_NOT_MET_DEFAULTED_TO_NOT_AVAILABLE",
    );
  });

  test("interpolates only inside a predeclared timestamp-safe bracket", () => {
    const input = interpolationInput();
    const measurement = matched(
      normalizeDdIvMeasurements(input),
      "put-interpolated",
    );

    expect(measurement).toMatchObject({
      status: "AVAILABLE",
      spread_decimal: "0.015",
      spread_vol_points: "1.50",
      front: {
        value_origin: "DERIVED",
        achieved_coordinate: "25",
        delta_error: "0",
        iv_decimal: "0.21",
        interpolation: {
          method: "LINEAR_BY_DELTA",
          lower_coordinate: "20",
          upper_coordinate: "30",
          lower_weight: "0.5",
          upper_weight: "0.5",
        },
      },
      back: {
        value_origin: "DERIVED",
        iv_decimal: "0.225",
        interpolation: {
          lower_weight: "0.5",
          upper_weight: "0.5",
        },
      },
    });
    expect(measurement.front.source_strikes).toEqual(["7400", "7425"]);
    expect(measurement.back.source_strikes).toEqual(["7475", "7500"]);
    expect(
      measurement.front.interpolation.inputs.map((item) => item.weight),
    ).toEqual(["0.5", "0.5"]);
  });

  test("does not extrapolate or use an out-of-bounds interpolation bracket", () => {
    const extrapolated = matched(
      normalizeDdIvMeasurements(interpolationInput("35")),
      "put-interpolated",
    );
    const tooWideInput = interpolationInput();
    tooWideInput.request.measurement_profile.matched_coordinates[0]
      .interpolation.max_bracket_width = "8";
    const tooWide = matched(
      normalizeDdIvMeasurements(tooWideInput),
      "put-interpolated",
    );

    expect(extrapolated.status).toBe("NOT_AVAILABLE");
    expect(extrapolated.warnings).toContain(
      "INTERPOLATION_BRACKET_NOT_AVAILABLE_NO_EXTRAPOLATION",
    );
    expect(tooWide.status).toBe("NOT_AVAILABLE");
    expect(tooWide.warnings).toContain(
      "INTERPOLATION_BRACKET_EXCEEDS_DECLARED_WIDTH",
    );
  });

  test("matches and interpolates by declared ln(K/F) without requiring delta", () => {
    const direct = matched(
      normalizeDdIvMeasurements(fixtureInput()),
      "put-atm-log-moneyness",
    );
    const interpolated = matched(
      normalizeDdIvMeasurements(moneynessInterpolationInput()),
      "put-atm-log-moneyness-interpolated",
    );

    expect(direct).toMatchObject({
      measurement_basis: "MATCHED_FORWARD_MONEYNESS",
      coordinate_definition: "LN_STRIKE_OVER_FORWARD",
      target_log_moneyness: "-0.025",
      target_coordinate: "-0.025",
      status: "AVAILABLE",
      spread_decimal: "0",
      front: {
        achieved_coordinate: "-0.028450479932",
        coordinate_error: "0.003450479932",
        moneyness_error: "0.003450479932",
        source_strikes: ["7450"],
      },
      back: {
        achieved_coordinate: "-0.025100393047",
        coordinate_error: "0.000100393047",
        moneyness_error: "0.000100393047",
        source_strikes: ["7475"],
      },
    });
    expect(interpolated).toMatchObject({
      measurement_basis: "MATCHED_FORWARD_MONEYNESS",
      coordinate_definition: "LN_STRIKE_OVER_FORWARD",
      target_log_moneyness: "0",
      status: "AVAILABLE",
      spread_decimal: "0.01",
      spread_vol_points: "1.00",
      front: {
        achieved_coordinate: "0",
        coordinate_error: "0",
        moneyness_error: "0",
        method: "LINEAR_BY_LOG_MONEYNESS",
        source_strikes: ["7600", "7700"],
        interpolation: {
          method: "LINEAR_BY_LOG_MONEYNESS",
        },
      },
      back: {
        achieved_coordinate: "0",
        method: "LINEAR_BY_LOG_MONEYNESS",
        source_strikes: ["7600", "7700"],
      },
    });
    expect(interpolated.front.inputs[0]).toMatchObject({
      delta: null,
      delta_convention: null,
      delta_origin: null,
      coordinate_definition: "LN_STRIKE_OVER_FORWARD",
      forward: {
        value: "7665",
        origin: "DERIVED",
      },
    });
  });

  test("fails closed when forward-moneyness evidence lacks a forward", () => {
    const input = fixtureInput();
    input.request.measurement_profile.matched_coordinates = [
      {
        measurement_id: "put-missing-forward",
        measurement_basis: "MATCHED_FORWARD_MONEYNESS",
        front_expiration: "2026-09-15T20:00:00.000Z",
        back_expiration: "2026-09-29T20:00:00.000Z",
        option_side: "PUT",
        target_log_moneyness: "0",
        moneyness_convention: "LN_STRIKE_OVER_FORWARD",
        tolerance: "0.1",
        missing_policy: "NOT_AVAILABLE",
        max_front_back_skew_ms: 600000,
      },
    ];
    for (const observation of input.observations) {
      if (
        observation.option_side === "PUT" &&
        observation.expiration === "2026-09-15T20:00:00.000Z"
      ) {
        observation.delta = null;
        observation.delta_convention = null;
        observation.delta_origin = null;
        if (observation.source_symbol === "FRONT-PUT-20D") {
          observation.forward = null;
        } else {
          observation.model.forward_model = null;
        }
      }
    }

    const measurement = matched(
      normalizeDdIvMeasurements(input),
      "put-missing-forward",
    );

    expect(measurement.status).toBe("NOT_AVAILABLE");
    expect(measurement.front.status).toBe("NOT_AVAILABLE");
    expect(measurement.front.achieved_coordinate).toBeNull();
    expect(measurement.warnings).toEqual(
      expect.arrayContaining([
        "MISSING_FORWARD:FRONT-PUT-20D",
        "MISSING_FORWARD_MODEL:FRONT-PUT-25D",
      ]),
    );
  });

  test("preserves ambiguous legacy term-spread values and source files", () => {
    const record = {
      candidate_id: "legacy-dd-1",
      term_spread_vol_points: 0.5,
      term_structure: "legacy-production-value",
    };
    const rawFile =
      '{"candidate_id":"legacy-dd-1","term_spread_vol_points":0.5,"term_structure":"legacy-production-value"}\n';
    const original = structuredClone(record);
    const migrated = migrateLegacyDdIvRecord({
      source_file: "frozen/legacy-dd-1.json",
      source_schema_version: null,
      raw_file: rawFile,
      record,
    });

    expect(migrated).toMatchObject({
      migration_contract_version: "1.0.0",
      status: "PRESERVED_AMBIGUOUS_LEGACY",
      source_file: "frozen/legacy-dd-1.json",
      source_schema_version: null,
      raw_file: rawFile,
      raw_term_spread_vol_points: 0.5,
      normalized_measurement: null,
      warnings: [
        "AMBIGUOUS_LEGACY_TERM_SPREAD_VOL_POINTS_PRESERVED_WITHOUT_CONVERSION",
        "SOURCE_FILE_PRESERVED_WITHOUT_OVERWRITE",
      ],
    });
    expect(migrated.raw_record).toEqual(original);
    expect(record).toEqual(original);
    expect(migrated).not.toHaveProperty("spread_decimal");
    expect(migrated).not.toHaveProperty("spread_vol_points");

    expect(
      migrateLegacyDdIvRecord({
        source_file: "handoff-v1.json",
        source_schema_version: "1.0.0",
        raw_file: '{"contract_version":"1.0.0"}\n',
        record: { contract_version: "1.0.0" },
      }).status,
    ).toBe("ALREADY_VERSIONED_PRESERVED");
  });
});

test("binds an optional immutable source manifest into the handoff identity", () => {
  const input = fixtureInput();
  const baseline = normalizeDdIvMeasurements(input);
  const manifestId = `sha256:${"1".repeat(64)}`;
  const normalizedContentId = `sha256:${"2".repeat(64)}`;
  const providerContentId = `sha256:${"3".repeat(64)}`;
  const linked = normalizeDdIvMeasurements({
    ...input,
    source_evidence: {
      manifest_contract_version: "1.0.0",
      manifest_ids: [manifestId],
      normalized_content_ids: [normalizedContentId],
      provider_payload_content_ids: [providerContentId],
    },
  });

  expect(linked.source_evidence).toEqual({
    manifest_contract_version: "1.0.0",
    manifest_ids: [manifestId],
    normalized_content_ids: [normalizedContentId],
    provider_payload_content_ids: [providerContentId],
  });
  expect(linked.handoff_id).not.toBe(baseline.handoff_id);
});
