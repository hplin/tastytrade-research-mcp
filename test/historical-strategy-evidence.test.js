import { describe, expect, test } from "@jest/globals";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { stableEvidenceContentId } from "../dist/evidence-cache.js";
import { normalizeHistoricalExecutionEvidence } from "../dist/historical-execution-evidence.js";
import {
  HISTORICAL_STRATEGY_EVIDENCE_INPUT_SCHEMA,
  HISTORICAL_STRATEGY_FAMILIES,
  normalizeHistoricalStrategyEvidence,
} from "../dist/historical-strategy-evidence.js";
import { CHECKPOINT, SECOND_CHECKPOINT, families, fixture, hash, leg, quote, reference, entry } from "./fixtures/historical-strategy-evidence.js";

const normalize = normalizeHistoricalStrategyEvidence;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(HISTORICAL_STRATEGY_EVIDENCE_INPUT_SCHEMA);

describe("versioned generic historical strategy evidence", () => {
  test("fixtures cover every declared family exactly once", () => {
    expect(families.map((item) => item.family)).toEqual(HISTORICAL_STRATEGY_FAMILIES);
  });

  test("result JSON schema validates all families, actual fills, references, gaps, and explicit nulls", async () => {
    const schemas = await Promise.all(["historical-execution-evidence", "historical-strategy-evidence"].map(async (name) => JSON.parse(await readFile(new URL(`../docs/${name}.schema.json`, import.meta.url), "utf8"))));
    const outputValidator = new Ajv2020({ allErrors: true, strict: true, strictTypes: false }).addSchema(schemas[0]).compile(schemas[1]);
    for (const { family } of families) {
      const input = fixture(family);
      input.selection.reference_cost = reference();
      input.expected_observation_times.push(SECOND_CHECKPOINT);
      input.execution_events = [entry(input, family === "SIC" ? "FIRST" : "ENTRY", CHECKPOINT)];
      const result = normalize(input);
      expect(outputValidator(result)).toBe(true);
      result.loss_certificate = "4000";
      expect(outputValidator(result)).toBe(false);
      result.loss_certificate = null;
      delete result.execution_events;
      expect(outputValidator(result)).toBe(false);
    }
  });

  test.each([
    ["CDS", "DEBIT_VERTICAL", "sha256:21b4f5933e0bbbe9caa76771ae5bd15bb760f78891da3fef7df0700761a2b85d"],
    ["CCS", "CREDIT_VERTICAL", "sha256:b0c16a4da032bcee3162d786fb01ba03350356eced41110f9d21495091491e24"],
    ["IC", "IRON_CONDOR", "sha256:ccada2060c631ca67c75b0afaf5f3e1e332e336115c2456f1e04f1ff73717b84"],
    ["DD", "DOUBLE_DIAGONAL", "sha256:896f1bb18316df5345f6a9a4f28b4b9f6d96b1ea2c404af6b89b28ae7e3de4f3"],
  ])("%s preserves the exact V1 hash from base a69bde0", (family, legacyFamily, expectedHash) => {
    const input = fixture(family);
    expect(normalizeHistoricalExecutionEvidence({
      scope: "SNAPSHOT", family: legacyFamily, underlying: "SPX",
      candidate_fingerprint: "immutable-v1-base-regression", quote_policy: input.quote_policy,
      legs: input.legs, expected_observation_times: input.expected_observation_times, observations: input.observations,
    }).evidence_id).toBe(expectedHash);
  });

  test.each(families)("$family freezes exact signs, ratios, expirations, settlement and natural cashflows", ({ family, legs, quantities }) => {
    const input = fixture(family);
    expect(validate({ request: input })).toBe(true);
    const output = normalize(input);
    expect(output.contract_version).toBe("2.0.0");
    expect(output.status).toBe("AVAILABLE");
    const bySymbol = new Map(output.inventory.map((item) => [item.provider_symbol, item]));
    legs.forEach((planned, index) => {
      expect(bySymbol.get(planned.provider_symbol)).toMatchObject({
        action: planned.action, inventory_quantity: quantities[index], ratio: Math.abs(quantities[index]),
        expiration: planned.expiration, settlement: "PM", multiplier: "100", root: "SPXW",
        option_side: planned.provider_symbol[12] === "C" ? "CALL" : "PUT",
        strike: String(Number(planned.provider_symbol.slice(13)) / 1000),
      });
    });
    let bid = 0;
    let ask = 0;
    quantities.forEach((quantity, index) => {
      bid += quantity * (quantity > 0 ? index + 1 : index + 1.25);
      ask += quantity * (quantity > 0 ? index + 1.25 : index + 1);
    });
    expect(output.checkpoints[0].quote_evidence.synthetic_package_quote).toMatchObject({
      signed_bid: String(bid), signed_ask: String(ask),
      usable_for_simulated_execution: true,
      bid_size: Math.floor(30 / Math.max(...quantities.map(Math.abs))),
    });
    expect(output.checkpoints[0].evidence_level).toBe("EXECUTABLE_QUOTE");
    expect(output.execution_events).toBeNull();
    expect(output.selection.reference_cost).toBeNull();
    expect(output.checkpoints[0].actual_entry_cost_dollars).toBeNull();
    expect(output.checkpoints[0].active_inventory.every((item) => item.active_inventory_quantity === null)).toBe(true);
    expect(output.verified_global_maximum_loss_dollars).toBeNull();
    expect(output.loss_certificate).toBeNull();
    expect(output.broker_fill_verified).toBe(false);
  });

  test("two-leg calendars and four-leg double calendars cannot be relabeled", () => {
    const single = fixture("CALL_CALENDAR");
    single.strategy.family = "DC";
    expect(() => normalize(single)).toThrow(/four legs/);
    const double = fixture("DC");
    double.strategy.family = "PUT_CALENDAR";
    expect(() => normalize(double)).toThrow(/two legs/);
    expect(normalize(fixture("DC")).inventory).toHaveLength(4);
    const wrongStrike = fixture("CALL_CALENDAR");
    wrongStrike.legs[1] = leg("C", 6050, 1, "261120");
    expect(() => normalize(wrongStrike)).toThrow(/strike pairs/);
    const reverse = fixture("PUT_CALENDAR");
    reverse.legs.forEach((item) => { item.action = item.action === "BUY_TO_OPEN" ? "SELL_TO_OPEN" : "BUY_TO_OPEN"; });
    expect(() => normalize(reverse)).toThrow(/SELL front and BUY back/);
  });

  test.each([
    ["CDS", (x) => { x.legs[0].action = "SELL_TO_OPEN"; }, /directions/],
    ["PDS", (x) => { x.strategy.family = "CDS"; }, /option side/],
    ["PCS", (x) => { x.legs[0].ratio = 2; }, /equal leg ratios/],
    ["CCS", (x) => { x.legs[0] = leg("C", 6050, 1, "261120"); }, /one expiration/],
    ["IC", (x) => { x.strategy.family = "RIC"; }, /directions/],
    ["AIC", (x) => { x.strategy.family = "IC"; }, /equal wing/],
    ["IC", (x) => { x.strategy.family = "AIC"; }, /unequal wing/],
    ["IC", (x) => { x.strategy.family = "SIB"; }, /inner strikes/],
    ["LIB", (x) => { x.strategy.family = "SIB"; }, /directions/],
    ["DD", (x) => { x.strategy.family = "DC"; }, /strike pairs/],
    ["DC", (x) => { x.strategy.family = "Hybrid"; }, /strike pairs/],
    ["Hybrid", (x) => { x.strategy.family = "DD"; }, /strike pairs/],
    ["SIC", (x) => { delete x.legs[0].entry_phase; }, /explicit FIRST/],
    ["SIC", (x) => { x.legs[0].entry_phase = "SECOND"; }, /complete put or call vertical/],
    ["BWB", (x) => { x.legs[1].ratio = 2; }, /balance/],
    ["BWB", (x) => { x.legs[0].action = "SELL_TO_OPEN"; }, /long wings/],
  ])("%s rejects meaningful shape violations", (family, mutate, error) => {
    const input = fixture(family);
    mutate(input);
    expect(() => normalize(input)).toThrow(error);
  });

  test("BWB supports broken widths and asymmetric ratios, but not a relabeled symmetric butterfly", () => {
    for (const legs of [
      [leg("C", 5800, 1), leg("C", 5850, -2), leg("C", 5950, 1)],
      [leg("C", 5800, 2), leg("C", 5850, -3), leg("C", 5900, 1)],
    ]) {
      const input = fixture("BWB");
      input.legs = legs;
      input.observations[0].leg_quotes = legs.map((item, index) => quote(item, index));
      expect(normalize(input).checkpoints[0].evidence_level).toBe("EXECUTABLE_QUOTE");
    }
    const symmetric = fixture("BWB");
    symmetric.legs = [leg("C", 5800, 1), leg("C", 5850, -2), leg("C", 5900, 1)];
    expect(() => normalize(symmetric)).toThrow(/asymmetric/);
  });

  test.each([
    [(x) => { x.legs[0].ratio = 0; }, /positive integer/],
    [(x) => { x.legs[0].ratio = 1.5; }, /positive integer/],
    [(x) => { x.legs[0].ratio = Number.MAX_SAFE_INTEGER + 1; }, /positive integer/],
    [(x) => { x.legs[0].multiplier = "50"; }, /multiplier 100/],
    [(x) => { x.legs[0].settlement = "AM"; }, /Settlement/],
    [(x) => { x.legs[0].expiration = "2026-11-20"; }, /OCC expiration/],
    [(x) => { x.legs[0].provider_symbol = "SPXW  261332C06000000"; }, /Invalid OCC expiration/],
    [(x) => { x.legs[0].provider_symbol = leg("C", 0, 1).provider_symbol; }, /strikes must be positive/],
    [(x) => { x.legs[1] = { ...x.legs[0] }; }, /Duplicate leg/],
    [(x) => { x.legs[0].provider_symbol = x.legs[0].provider_symbol.replace("SPXW  ", "SPX   "); x.legs[0].settlement = "AM"; }, /root/],
    [(x) => { x.quote_policy.require_sizes = false; }, /require_sizes/],
    [(x) => { x.quote_policy.max_quote_age_ms = -1; }, /durations/],
  ])("rejects malformed exact inventory or policy %#", (mutate, error) => {
    const input = fixture();
    mutate(input);
    expect(() => normalize(input)).toThrow(error);
  });

  test("SPX AM identity is explicit and not inferred from SPXW quotes", () => {
    const input = fixture();
    input.strategy.root = "SPX";
    for (const item of input.legs) {
      item.provider_symbol = item.provider_symbol.replace("SPXW  ", "SPX   ");
      item.settlement = "AM";
    }
    input.observations[0].leg_quotes = input.legs.map((item, index) => quote(item, index));
    expect(normalize(input).inventory.every((item) => item.root === "SPX" && item.settlement === "AM")).toBe(true);
  });

  test("SIC preserves actual first vertical without a hypothetical second credit or quote-derived fill", () => {
    const input = fixture("SIC");
    input.expected_observation_times.push(SECOND_CHECKPOINT);
    input.observations.push({ observed_at: SECOND_CHECKPOINT, leg_quotes: input.legs.map((item, index) => quote(item, index, SECOND_CHECKPOINT)) });
    input.execution_events = [entry(input, "FIRST", "2026-09-24T14:15:00.000Z")];
    const firstOnly = normalize(input);
    expect(firstOnly.checkpoints.map((item) => item.actual_entry_cost_dollars)).toEqual(["-200", "-200"]);
    expect(firstOnly.checkpoints.every((item) => item.second_entry_at === null)).toBe(true);
    for (const checkpoint of firstOnly.checkpoints) {
      expect(checkpoint.active_inventory.filter((item) => item.entry_phase === "FIRST").map((item) => item.active_inventory_quantity).sort()).toEqual([-1, 1]);
      expect(checkpoint.active_inventory.filter((item) => item.entry_phase === "SECOND").map((item) => item.active_inventory_quantity)).toEqual([null, null]);
    }
    input.execution_events.push(entry(input, "SECOND", "2026-09-24T15:00:00.000Z"));
    const both = normalize(input);
    expect(both.checkpoints[0]).toEqual(firstOnly.checkpoints[0]);
    expect(both.checkpoints[1].actual_entry_cost_dollars).toBe("-400");
    expect(both.checkpoints[1].second_entry_at).toBe("2026-09-24T15:00:00.000Z");
    expect(both.checkpoints[1].active_inventory.every((item) => item.execution_fact_status === "PLANNED_QUANTITY_FILLED")).toBe(true);
    expect(both.execution_events.every((item) => item.evidence_class === "CALLER_SUPPLIED_EXECUTION_FACT" && item.broker_fill_verified === false)).toBe(true);
  });

  test("actual entry facts are independently available_at gated and preserve partial quantities", () => {
    const input = fixture("BWB");
    const event = entry(input, "ENTRY", "2026-09-24T14:15:00.000Z");
    event.fills = [{ ...event.fills[1], quantity: 1 }];
    input.execution_events = [event];
    const partial = normalize(input).checkpoints[0];
    expect(partial.active_inventory.find((item) => item.active_inventory_quantity !== null)).toMatchObject({ active_inventory_quantity: -1, planned_inventory_quantity: -3, execution_fact_status: "PARTIAL_FILL" });
    expect(partial.actual_entry_cost_dollars).toBe("-300");
    event.available_at = "2026-09-24T15:00:00.000Z";
    const unavailable = normalize(input).checkpoints[0];
    expect(unavailable.actual_entry_cost_dollars).toBeNull();
    expect(unavailable.active_execution_event_ids).toEqual([]);
    expect(unavailable.active_inventory.every((item) => item.active_inventory_quantity === null)).toBe(true);
  });

  test("SIC allows call-first staged inventory without moving the planned put exposure into phase one", () => {
    const input = fixture("SIC");
    input.legs.forEach((item) => { item.entry_phase = item.entry_phase === "FIRST" ? "SECOND" : "FIRST"; });
    input.execution_events = [entry(input, "FIRST", "2026-09-24T14:15:00.000Z")];
    const result = normalize(input);
    expect(result.checkpoints[0].actual_entry_cost_dollars).toBe("-200");
    for (const planned of result.inventory) {
      const active = result.checkpoints[0].active_inventory.find((item) => item.provider_symbol === planned.provider_symbol);
      expect(active.active_inventory_quantity).toBe(planned.option_side === "CALL" ? planned.inventory_quantity : null);
    }
  });

  test.each([
    [(x) => { x.execution_events = [entry(x, "SECOND", "2026-09-24T14:20:00.000Z")]; }, /complete first/],
    [(x) => { x.execution_events[0].fills.pop(); x.execution_events.push(entry(x, "SECOND", "2026-09-24T14:20:00.000Z")); }, /complete first/],
    [(x) => { x.execution_events[0].available_at = "2026-09-24T15:00:00.000Z"; x.execution_events.push(entry(x, "SECOND", "2026-09-24T14:20:00.000Z")); }, /availability order/],
    [(x) => { x.execution_events[0].fills[0].quantity = 2; }, /exceed/],
    [(x) => { x.execution_events[0].fills[0].quantity = 1.1; }, /positive safe/],
    [(x) => { x.execution_events[0].fills[0].price = "-1"; }, /negative/],
    [(x) => { x.execution_events[0].fills[0].provider_symbol = x.legs[2].provider_symbol; }, /planned entry phase/],
    [(x) => { x.execution_events[0].fills.push(x.execution_events[0].fills[0]); }, /Duplicate leg fill/],
    [(x) => { x.execution_events[0].source_timestamp = "2026-09-24T13:30:00.000Z"; }, /precede frozen selection/],
    [(x) => { x.execution_events[0].available_at = "2026-09-24T14:00:00.000Z"; }, /source_timestamp <= available_at/],
    [(x) => { x.execution_events.push(structuredClone(x.execution_events[0])); }, /IDs must be unique/],
    [(x) => { x.execution_events[0].source.manifest_id = "missing"; }, /sha256/],
  ])("SIC execution ledger rejects fabricated or unordered facts %#", (mutate, error) => {
    const input = fixture("SIC");
    input.execution_events = [entry(input, "FIRST", "2026-09-24T14:15:00.000Z")];
    mutate(input);
    expect(() => normalize(input)).toThrow(error);
  });

  test.each([
    ["FUTURE_AVAILABLE_AT", { available_at: "2026-09-24T14:30:01.000Z" }],
    ["FUTURE_SOURCE_TIMESTAMP", { source_timestamp: "2026-09-24T14:30:01.000Z" }],
    ["STALE_QUOTE", { source_timestamp: "2026-09-24T14:00:00.000Z" }],
    ["TEMPORAL_SKEW_EXCEEDED", { source_timestamp: "2026-09-24T14:29:58.400Z" }],
    ["MIXED_QUOTE_COHORT", { dataset_id: "different" }],
    ["CROSSED_LEG_QUOTE", { bid: "10", ask: "1" }],
    ["MISSING_LEG_SIZE", { bid_size: null }],
  ])("shared quote rejection remains fail-closed: %s", (reason, overrides) => {
    const input = fixture("DC");
    Object.assign(input.observations[0].leg_quotes[0], overrides);
    const checkpoint = normalize(input).checkpoints[0];
    expect(checkpoint.evidence_level).toBe("NONE");
    expect(checkpoint.quote_evidence.synthetic_package_quote.usable_for_simulated_execution).toBe(false);
    expect(checkpoint.quote_evidence.rejection_reasons).toContain(reason);
    expect(checkpoint.actual_entry_cost_dollars).toBeNull();
  });

  test("partial exact-leg coverage cannot manufacture a package mark; explicit gaps remain null", () => {
    const input = fixture("DD");
    input.observations[0].leg_quotes.pop();
    input.expected_observation_times.push(SECOND_CHECKPOINT);
    const result = normalize(input);
    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.checkpoints[0].quote_evidence.synthetic_package_quote).toMatchObject({ signed_bid: null, signed_ask: null, usable_for_simulated_execution: false });
    expect(result.checkpoints[1]).toMatchObject({ quote_evidence: null, evidence_level: "NONE", missing_observation_reason: "MISSING_OBSERVATION" });
    expect(result.coverage.missing_observation_times).toEqual([SECOND_CHECKPOINT]);
    expect(result.checkpoints[0].quote_evidence.native_package_quote).toBeNull();
  });

  test("reference-only evidence never becomes an executable quote, fill, or maximum-loss certificate", () => {
    const input = fixture("Hybrid");
    input.observations[0].leg_quotes = [];
    input.observations[0].references = [reference()];
    const result = normalize(input);
    expect(result.checkpoints[0].evidence_level).toBe("REFERENCE_ONLY");
    expect(result.coverage.reference_only_observations).toBe(1);
    expect(result.checkpoints[0].actual_entry_cost_dollars).toBeNull();
    expect(result.verified_global_maximum_loss_dollars).toBeNull();
    expect(result.loss_certificate).toBeNull();
    input.observations[0].references[0].available_at = SECOND_CHECKPOINT;
    expect(normalize(input).checkpoints[0].evidence_level).toBe("NONE");
  });

  test("native signed multi-expiry quotes remain distinct, source-linked evidence, not actual fills or loss certificates", () => {
    const input = fixture("DC");
    const native = { ...input.observations[0].leg_quotes[0] };
    delete native.provider_symbol;
    delete native.bid;
    delete native.ask;
    input.observations[0].native_package_quote = {
      ...native, signed_bid: "-4.5", signed_ask: "-4",
      price_semantics: "SIGNED_CASH_FLOW_PER_UNIT", manifest_id: hash("d"),
    };
    const result = normalize(input);
    expect(result.checkpoints[0].quote_evidence.native_package_quote).toMatchObject({
      signed_bid: "-4.5", signed_ask: "-4", quote_origin: "NATIVE_PACKAGE",
      usable_for_simulated_execution: true,
    });
    expect(result.checkpoints[0].quote_evidence.synthetic_package_quote.quote_origin).toBe("ALIGNED_LEG_QUOTES");
    expect(result.provenance.manifest_ids).toEqual([hash("a"), hash("d")]);
    expect(result.execution_events).toBeNull();
    expect(result.loss_certificate).toBeNull();
    expect(result.verified_global_maximum_loss_dollars).toBeNull();
  });

  test("expiry-day evidence is retained without intraday cutoff claims; post-expiry evidence is rejected", () => {
    const input = fixture();
    input.legs.forEach((item) => {
      item.provider_symbol = item.provider_symbol.replace("261016", "260924");
      item.expiration = "2026-09-24";
    });
    input.observations[0].leg_quotes = input.legs.map((item, index) => quote(item, index));
    expect(normalize(input).limitations).toContain("EXPIRATION_DATE_AND_ROOT_SETTLEMENT_CLASS_DO_NOT_VERIFY_INTRADAY_SETTLEMENT_CUTOFF");
    input.expected_observation_times.push("2026-09-25T14:30:00.000Z");
    expect(() => normalize(input)).toThrow(/postdate planned expiration/);
  });

  test("selection identity and reference cost are frozen without future-data reconstruction", () => {
    const input = fixture("DC");
    input.selection.reference_cost = reference();
    const result = normalize(input);
    expect(result.selection.reference_cost.signed_value).toBe("-1.5");
    input.frozen_selection_id = result.frozen_selection_id;
    expect(normalize(input)).toEqual(result);
    input.observations[0].leg_quotes[0].bid = "0.5";
    expect(normalize(input).frozen_selection_id).toBe(result.frozen_selection_id);
    input.selection.reference_cost.signed_value = "-2";
    expect(() => normalize(input)).toThrow(/frozen_selection_id/);
    delete input.frozen_selection_id;
    input.selection.reference_cost.available_at = CHECKPOINT;
    expect(() => normalize(input)).toThrow(/available at selection/);
  });

  test.each([
    [(x) => { x.selection.available_at = CHECKPOINT; }, /Selection must be available/],
    [(x) => { x.selection.selected_at = SECOND_CHECKPOINT; }, /frozen before/],
    [(x) => { x.selection.source_timestamp = CHECKPOINT; }, /source_timestamp <= available_at/],
    [(x) => { x.selection.source.normalized_content_id = "bad"; }, /sha256/],
    [(x) => { x.frozen_selection_id = hash("f"); }, /frozen_selection_id/],
    [(x) => { x.expected_observation_times.push(CHECKPOINT); }, /unique/],
    [(x) => { x.observations.push(structuredClone(x.observations[0])); }, /unique expected/],
    [(x) => { x.observations[0].observed_at = SECOND_CHECKPOINT; }, /unique expected/],
    [(x) => { x.observations[0].references = [reference({ bar_end: "2026-09-24T14:00:00.000Z" })]; }, /bar_end must not exceed/],
    [(x) => { x.selection.reference_cost = reference({ bar_end: "2026-09-24T14:00:00.000Z" }); }, /bar_end must not exceed/],
    [(x) => { x.observations[0].leg_quotes[0].provider_symbol = leg("C", 6100, 1).provider_symbol; }, /does not belong to frozen inventory/],
  ])("rejects invalid selection, lineage, or checkpoint ordering %#", (mutate, error) => {
    const input = fixture();
    mutate(input);
    expect(() => normalize(input)).toThrow(error);
  });

  test("immutable IDs link exact cache claims and are reproducible across equivalent leg/quote ordering", () => {
    const input = fixture("BWB");
    input.selection.reference_cost = reference();
    input.execution_events = [entry(input, "ENTRY", "2026-09-24T14:15:00.000Z")];
    const result = normalize(input);
    expect(normalize(JSON.parse(JSON.stringify(input)))).toEqual(result);
    input.legs.reverse();
    input.observations[0].leg_quotes.reverse();
    input.execution_events[0].fills.reverse();
    expect(normalize(input)).toEqual(result);
    const { evidence_id, ...body } = result;
    expect(stableEvidenceContentId(body)).toBe(evidence_id);
    const { checkpoint_id, ...checkpoint } = result.checkpoints[0];
    expect(stableEvidenceContentId(checkpoint)).toBe(checkpoint_id);
    expect(result.provenance).toEqual({
      manifest_ids: [hash("a")], normalized_content_ids: [hash("b")],
      source_and_license_claims_verified: false, cache_contents_verified: false,
    });
    input.observations[0].leg_quotes[0].manifest_id = hash("c");
    const revised = normalize(input);
    expect(revised.evidence_id).not.toBe(result.evidence_id);
    expect(revised.frozen_selection_id).toBe(result.frozen_selection_id);
    expect(revised.provenance.manifest_ids).toEqual([hash("a"), hash("c")]);
  });

  test("schema rejects unknown fields rather than accepting grading, sizing, or implicit actual fills", () => {
    for (const field of ["grade", "position_size", "portfolio_gate", "trading_decision", "simulated_fills"]) {
      const input = fixture();
      input[field] = true;
      expect(validate({ request: input })).toBe(false);
    }
    const input = fixture("SIC");
    input.execution_events = [entry(input, "FIRST", CHECKPOINT)];
    expect(validate({ request: input })).toBe(true);
    delete input.execution_events[0].fills;
    expect(validate({ request: input })).toBe(false);
  });
});
