import { describe, expect, test } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ExactDecimal } from "../dist/decimal.js";
import { createExecutionEvidence } from "../dist/execution-evidence.js";

describe("exact decimal arithmetic", () => {
  test("preserves decimal precision across arithmetic", () => {
    const result = ExactDecimal.parse("0.1")
      .add(ExactDecimal.parse("0.2"))
      .multiplyInteger(3)
      .half();

    expect(result.toString()).toBe("0.45");
  });

  test("accepts exponent notation without binary rounding", () => {
    expect(ExactDecimal.parse(1e-7).toString()).toBe("0.0000001");
  });
});

describe("execution evidence contract", () => {
  test("marks broker dry-run evidence as non-fillable", () => {
    const evidence = createExecutionEvidence({
      evidence_type: "BROKER_DRY_RUN",
      evidence_phase: "LIVE_CHECKPOINT",
      source: "broker",
      freshness_status: "UNKNOWN",
      temporal_alignment: "UNKNOWN",
      native_available: false,
      working_limit: "1.25",
      acceptable_bound: null,
      fill_model: "NOT_APPLICABLE",
      fill_confidence: "NOT_APPLICABLE",
      references: { paper_order_id: "paper-1" },
    });

    expect(evidence.contract_version).toBe("1.0.0");
    expect(evidence.warnings).toContain(
      "BROKER_DRY_RUN_VALIDATES_STRUCTURE_NOT_FILLABILITY",
    );
  });

  test.each([
    "HISTORICAL_OPTION_PACKAGE_REFERENCE",
    "HISTORICAL_PATH",
  ])("rejects %s evidence presented as a live checkpoint", (evidenceType) => {
    expect(() =>
      createExecutionEvidence({
        evidence_type: evidenceType,
        evidence_phase: "LIVE_CHECKPOINT",
        source: "fixture",
        freshness_status: "UNKNOWN",
        temporal_alignment: "UNKNOWN",
        native_available: false,
        working_limit: "1",
        acceptable_bound: null,
        fill_model: "LIMIT_TOUCH",
        fill_confidence: "HIGH",
        references: { checkpoint_id: "checkpoint-1" },
      }),
    ).toThrow("must be POST_SESSION_REGRESSION");
  });

  test("prevents historical package references from claiming fillability", () => {
    expect(() =>
      createExecutionEvidence({
        evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE",
        evidence_phase: "POST_SESSION_REGRESSION",
        source: "fixture",
        freshness_status: "FRESH",
        temporal_alignment: "ALIGNED",
        native_available: false,
        working_limit: "1",
        acceptable_bound: null,
        fill_model: "LIMIT_TOUCH",
        fill_confidence: "HIGH",
        references: { checkpoint_id: "checkpoint-1" },
      }),
    ).toThrow("must not claim a fill model or fill confidence");
  });

  test("publishes a machine-readable schema matching generated evidence", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../docs/execution-evidence.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const evidence = createExecutionEvidence({
      evidence_type: "HISTORICAL_PATH",
      evidence_phase: "POST_SESSION_REGRESSION",
      source: "fixture",
      as_of: "2026-09-24T20:00:00.000Z",
      freshness_status: "UNKNOWN",
      temporal_alignment: "ALIGNED",
      native_available: false,
      working_limit: "1",
      acceptable_bound: null,
      fill_model: "LIMIT_TOUCH",
      fill_confidence: "HIGH",
      references: { paper_order_id: "paper-1" },
    });

    expect(validate(evidence)).toBe(true);
    expect(validate({ ...evidence, contract_version: "2.0.0" })).toBe(false);
  });
});
