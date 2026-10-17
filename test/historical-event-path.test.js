import { describe, expect, test } from "@jest/globals";
import { Ajv2020 } from "ajv/dist/2020.js";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { buildHistoricalEventPath as build, HISTORICAL_EVENT_PATH_INPUT_SCHEMA, historicalPathInventoryId } from "../dist/historical-event-path.js";
import { stableEvidenceContentId } from "../dist/evidence-cache.js";
import { pathFixture, event, observation, profile, ENTRY, EXIT } from "./fixtures/historical-event-path.js";
import { families, leg, reference, quote } from "./fixtures/historical-strategy-evidence.js";

function simulated(input, kind = "OPEN", model = "QUOTE_CROSS") {
  const item = event(input.selection.legs, ENTRY);
  item.evidence_kind = "SIMULATED_FILL";
  item.kind = kind;
  item.fills.forEach((fill) => { fill.price = null; });
  item.instruction = { instruction_id: "frozen-entry", frozen_at: input.selection.selection.selected_at, window_start: ENTRY, trigger: "ENTRY", signed_limit: "10" };
  const obs = observation(input.selection.legs);
  delete obs.risk; delete obs.inventory_id;
  item.simulation_observation = obs;
  input.policy.execution_profile = profile(model);
  input.policy.instructions = [item.instruction];
  input.events = [item];
  return item;
}

describe("generic timestamp-safe exact-leg event paths", () => {
  test.each(families)("$family preserves exact 2/3/4-leg inventory, cash direction, fees and full denominators", ({ family, quantities }) => {
    const input = pathFixture(family);
    if (family === "SIC") {
      input.events = ["FIRST", "SECOND"].map((phase, i) => event(input.selection.legs.filter((leg) => leg.entry_phase === phase), ENTRY, "OPEN", `stage-${i}`));
    }
    const original = structuredClone(input);
    const result = build(input);
    expect(input).toEqual(original);
    expect(result.inventory).toHaveLength(quantities.length);
    const bySymbol = new Map(result.inventory.map((leg) => [leg.provider_symbol, leg.inventory_quantity]));
    input.selection.legs.forEach((leg, i) => expect(bySymbol.get(leg.provider_symbol)).toBe(quantities[i]));
    const contracts = quantities.reduce((n, quantity) => n + Math.abs(quantity), 0);
    expect(result.checkpoints[0].fees_dollars).toBe(String(contracts * 0.5));
    expect(result.coverage).toMatchObject({ expected_checkpoints: 2, measured_pnl_checkpoints: 1, missing_pnl_checkpoints: 1, expected_active_leg_observations: quantities.length * 2 });
    expect(result.metrics).toMatchObject({ mae_dollars: null, mfe_dollars: null, expected_samples: 2, measured_samples: 1 });
    expect(result.status).toBe("NOT_ASSESSABLE");
    expect(result.checkpoints[1].missing_reasons).toContain("MISSING_OBSERVATION");
    expect(result.provenance).toMatchObject({ cache_contents_verified: false, source_and_license_claims_verified: false, broker_fill_verified: false });
  });

  test("credit/debit signs and non-overlapping opening/partial/closing fees are exact", () => {
    const input = pathFixture();
    input.selection.legs.forEach((leg) => { leg.ratio = 2; });
    input.events = [event(input.selection.legs)];
    input.observations = [observation(input.selection.legs)];
    const partial = event(input.selection.legs.map((leg) => ({ ...leg, ratio: 1 })), "2026-09-24T15:00:00.000Z", "CLOSE", "partial");
    partial.kind = "PARTIAL_CLOSE";
    partial.fills[0].price = "2"; partial.fills[1].price = "1";
    const close = event(input.selection.legs.map((leg) => ({ ...leg, ratio: 1 })), EXIT, "CLOSE", "final");
    close.fills[0].price = "3"; close.fills[1].price = "1";
    input.events.push(partial, close);
    input.expected_checkpoints.splice(1, 0, partial.available_at);
    input.observations.push(observation(input.selection.legs.map((leg) => ({ ...leg, ratio: 1 })), partial.available_at));
    const result = build(input);
    expect(result.events.map((event) => event.signed_cost_dollars)).toEqual(["-200", "-100", "-200"]);
    expect(result.events.map((event) => event.fees_dollars)).toEqual(["2", "1", "1"]);
    expect(result.checkpoints.map((point) => point.active_inventory.length)).toEqual([2, 2, 0]);
    expect(result.metrics.net_pnl_dollars).toBe("496");
    expect(result.metrics.holding_duration_ms).toBe(3600000);
    expect(result.checkpoints[2].evidence_level).toBe("CLOSED_LEDGER");
    expect(result.coverage.complete).toBe(true);
    expect(build(input)).toEqual(result);
    const overlap = structuredClone(input);
    overlap.events[1].fills[0].fill_id = overlap.events[0].fills[0].fill_id;
    expect(() => build(overlap)).toThrow(/overlapping fill fees/);
    const duplicate = structuredClone(input);
    duplicate.events[1].event_id = duplicate.events[0].event_id;
    expect(() => build(duplicate)).toThrow(/Duplicate event ID/);
  });

  test("future partial close does not alter earlier checkpoint IDs or inventory", () => {
    const input = pathFixture();
    const before = build(input);
    const close = event(input.selection.legs, ENTRY, "CLOSE", "later-close");
    close.available_at = EXIT;
    input.events.push(close);
    const after = build(input);
    expect(after.checkpoints[0]).toEqual(before.checkpoints[0]);
    expect(after.checkpoints[1].active_inventory).toEqual([]);
  });

  test("delayed independent opens use the earliest available source entry without rewriting earlier checkpoints", () => {
    const input = pathFixture();
    const [a, b] = input.selection.legs;
    const first = "2026-09-24T14:40:00.000Z";
    input.events = [event([a], first, "OPEN", "a-open")];
    input.expected_checkpoints = [first, EXIT];
    input.observations = [observation([a], first)];
    const before = build(input);
    const delayed = event([b], ENTRY, "OPEN", "b-open");
    delayed.available_at = "2026-09-24T15:00:00.000Z";
    input.events.push(delayed);
    input.observations.push(observation([a, b], EXIT));
    const result = build(input);
    expect(result.checkpoints[0]).toEqual(before.checkpoints[0]);
    expect(result.checkpoints[1].holding_duration_ms).toBe(3600000);
    expect(result.metrics.holding_duration_ms).toBe(3600000);
  });

  test("a closed delayed independent-leg ledger ends at the latest closing source time, not receipt time", () => {
    const input = pathFixture();
    const [a, b] = input.selection.legs;
    const aClose = "2026-09-24T15:20:00.000Z";
    input.events = [
      event([a], "2026-09-24T14:40:00.000Z", "OPEN", "a-open"),
      { ...event([b], ENTRY, "OPEN", "b-open"), available_at: "2026-09-24T14:50:00.000Z" },
      { ...event([a], aClose, "CLOSE", "a-close"), kind: "PARTIAL_CLOSE" },
      { ...event([b], "2026-09-24T15:00:00.000Z", "CLOSE", "b-close"), kind: "PARTIAL_CLOSE", available_at: EXIT },
    ];
    input.expected_checkpoints = [aClose, EXIT];
    input.observations = [];
    const before = build({ ...input, events: input.events.slice(0, 3) });
    const result = build(input);
    expect(result.checkpoints[0]).toEqual(before.checkpoints[0]);
    expect(result.checkpoints[1]).toMatchObject({ active_inventory: [], evidence_level: "CLOSED_LEDGER", holding_duration_ms: 3000000 });
    expect(result.metrics.holding_duration_ms).toBe(3000000);
    const closed = build({ ...input, expected_checkpoints: [EXIT] });
    expect(closed.status).toBe("ASSESSABLE");
    expect(closed.metrics.holding_duration_ms).toBe(3000000);
  });

  test("staggered SIC changes only actual available legs and rejects SECOND before FIRST", () => {
    const input = pathFixture("SIC");
    const first = input.selection.legs.filter((leg) => leg.entry_phase === "FIRST");
    const second = input.selection.legs.filter((leg) => leg.entry_phase === "SECOND");
    input.events = [event(first), event(second, ENTRY, "OPEN", "second")];
    input.events[1].available_at = EXIT;
    input.observations = [observation(first), observation(input.selection.legs, EXIT)];
    const result = build(input);
    expect(result.checkpoints.map((point) => point.active_inventory.length)).toEqual([2, 4]);
    expect(result.checkpoints.map((point) => point.fees_dollars)).toEqual(["1", "2"]);
    input.events.shift();
    input.observations = [];
    expect(() => build(input)).toThrow(/SIC SECOND/);
  });

  test("roll preserves old close/new open quantities, source availability and fees", () => {
    const input = pathFixture();
    const replacement = leg("C", 6100, -1, "261120");
    input.roll_legs = [replacement];
    input.settlements.push({ provider_symbol: replacement.provider_symbol, settles_at: "2026-11-20T20:00:00.000Z" });
    const roll = event([input.selection.legs[1]], EXIT, "CLOSE", "roll");
    roll.kind = "ROLL";
    roll.fills.push({ fill_id: "new-short", provider_symbol: replacement.provider_symbol, side: "OPEN", quantity: 1, price: "4" });
    input.events.push(roll);
    input.observations.push(observation([input.selection.legs[0], replacement], EXIT));
    const result = build(input);
    expect(result.events[1].transaction_inventory.map((leg) => leg.inventory_quantity)).toEqual([1, -1]);
    expect(result.events[1].signed_cost_dollars).toBe("-300");
    expect(result.events[1].fees_dollars).toBe("1");
    expect(result.checkpoints[1].active_inventory.map((leg) => leg.provider_symbol)).not.toContain(input.selection.legs[1].provider_symbol);
    expect(result.checkpoints[1].active_inventory.map((leg) => leg.provider_symbol)).toContain(replacement.provider_symbol);
  });

  test("a four-leg atomic roll can close four old and open four exact replacement legs without overlapping fees", () => {
    const input = pathFixture("IC");
    const replacements = input.selection.legs.map((item) => ({
      ...item, provider_symbol: item.provider_symbol.replace("261016", "261120"), expiration: "2026-11-20",
    }));
    input.roll_legs = replacements;
    input.settlements.push(...replacements.map((leg) => ({ provider_symbol: leg.provider_symbol, settles_at: "2026-11-20T20:00:00.000Z" })));
    const roll = event(input.selection.legs, EXIT, "CLOSE", "whole-roll");
    roll.kind = "ROLL";
    roll.fills.push(...event(replacements, EXIT, "OPEN", "replacement").fills);
    input.events.push(roll);
    input.observations.push(observation(replacements, EXIT));
    const result = build(input);
    expect(result.events[1].transaction_inventory).toHaveLength(8);
    expect(result.events[1].fees_dollars).toBe("4");
    expect(result.checkpoints[1].fees_dollars).toBe("6");
    expect(result.checkpoints[1].active_inventory.map((leg) => leg.provider_symbol).sort()).toEqual(replacements.map((leg) => leg.provider_symbol).sort());
  });

  test("debit entry and reverse-direction simulated exit preserve dollars and limit convention", () => {
    const input = pathFixture();
    input.events[0].fills[0].price = "3";
    input.events[0].fills[1].price = "1";
    const close = event(input.selection.legs, EXIT, "CLOSE", "modeled-exit");
    close.evidence_kind = "SIMULATED_FILL";
    close.fills.forEach((fill) => { fill.price = null; });
    close.instruction = { instruction_id: "frozen-take-profit", frozen_at: input.selection.selection.selected_at, window_start: EXIT, trigger: "TAKE_PROFIT", signed_limit: "-2" };
    close.simulation_observation = {
      observed_at: EXIT, leg_quotes: input.selection.legs.map((leg, index) => ({
        ...quote(leg, index, EXIT), bid: index === 0 ? "4" : "1", ask: index === 0 ? "4.25" : "1.25",
      })),
    };
    input.policy.instructions.push(close.instruction);
    input.events.push(close);
    const result = build(input);
    expect(result.events.map((event) => event.signed_cost_dollars)).toEqual(["200", "-275"]);
    expect(result.metrics.net_pnl_dollars).toBe("73");
    expect(result.metrics.holding_duration_ms).toBe(3600000);
    expect(result.metrics.execution_kinds).toEqual(["BROKER_FILL", "SIMULATED_FILL"]);
    expect(result.metrics.execution_evidence_levels).toEqual(["BROKER_FILL", "ALIGNED_LEG_QUOTES"]);
  });

  test.each(["QUOTE_CROSS", "QUOTE_LIMIT_TOUCH", "QUOTE_PRICE_IMPROVEMENT", "REFERENCE_COST"])("reuses the existing %s model, never labels a touch as broker fill", (model) => {
    const input = pathFixture();
    const item = simulated(input, "OPEN", model);
    if (model === "REFERENCE_COST") item.simulation_observation.references = [reference({ signed_value: "-0.5" })];
    const result = build(input);
    expect(result.events[0]).toMatchObject({ status: "APPLIED", evidence_kind: "SIMULATED_FILL", broker_fill_verified: false });
    expect(result.events[0].simulation.status).toBe("SIMULATED_FILLED");
    expect(result.events[0].fees_dollars).toBe("1");
    expect(result.metrics.execution_kinds).toEqual(["SIMULATED_FILL"]);
    expect(result.checkpoints[0].package_natural.executable_fill).toBe(false);
    if (model === "QUOTE_LIMIT_TOUCH") expect(result.events[0].simulation.warnings).toContain("OBSERVED_RESOLUTION_DOES_NOT_PROVE_CONTINUOUS_FIRST_TOUCH");
  });

  test("missing/future leg, stale data and completed candles never interpolate quote-backed fills", () => {
    for (const mode of ["missing", "future", "stale", "skew", "reference"]) {
      const input = pathFixture();
      const item = simulated(input);
      if (mode === "missing" || mode === "reference") item.simulation_observation.leg_quotes.pop();
      if (mode === "future") item.simulation_observation.leg_quotes[0].available_at = EXIT;
      if (mode === "stale") item.simulation_observation.leg_quotes[0].source_timestamp = "2026-09-24T14:00:00.000Z";
      if (mode === "skew") item.simulation_observation.leg_quotes[0].source_timestamp = "2026-09-24T14:29:58.000Z";
      if (mode === "reference") item.simulation_observation.references = [reference()];
      input.observations = [];
      const result = build(input);
      expect(result.events[0].status).toBe("NOT_ASSESSABLE");
      expect(result.events[0].fees_dollars).toBeNull();
      expect(result.checkpoints[0].active_inventory).toEqual([]);
      expect(result.metrics.net_pnl_dollars).toBeNull();
    }
  });

  test("frozen limit, latency and no-fill remain explicit and never invent active exposure", () => {
    const input = pathFixture();
    const item = simulated(input);
    item.instruction.signed_limit = "-20";
    input.observations = [];
    const result = build(input);
    expect(result.events[0].status).toBe("NO_FILL_UNDER_MODEL");
    expect(result.events[0].fees_dollars).toBeNull();
    expect(result.checkpoints[0].active_inventory).toEqual([]);
    const late = pathFixture();
    simulated(late);
    late.policy.execution_profile.latency_ms = 1000;
    const { profile_hash: ignored, ...body } = late.policy.execution_profile;
    late.policy.execution_profile.profile_hash = stableEvidenceContentId(body);
    late.observations = [];
    expect(build(late).events[0].simulation.skipped_for_latency).toBe(1);
    late.events[0].instruction.signed_limit = "1";
    late.policy.instructions = [structuredClone(late.events[0].instruction)];
    late.events[0].instruction.signed_limit = "2";
    expect(() => build(late)).toThrow(/caller-frozen policy/);
  });

  test("reference-only P/L remains explicitly valuation-only with sampled denominators", () => {
    const input = pathFixture();
    input.observations[0].leg_quotes = [];
    input.observations[0].references = [reference({ signed_value: "1.5" })];
    const result = build(input);
    expect(result.checkpoints[0].evidence_level).toBe("CANDLE_REFERENCE");
    expect(result.checkpoints[0].package_natural).toBeNull();
    expect(result.checkpoints[0].net_pnl_dollars).toBe("249");
    expect(result.metrics.mae_dollars).toBeNull();
    expect(result.metrics.evidence_levels).toContain("CANDLE_REFERENCE");
  });

  test("front-expiry settlement is terminal and delayed availability leaves explicit unpriced exposure", () => {
    const input = pathFixture("CALL_CALENDAR");
    const at = "2026-10-16T20:00:00.000Z", after = "2026-11-20T14:00:00.000Z";
    input.expected_checkpoints.push(at, after);
    const front = input.selection.legs[0], back = input.selection.legs[1];
    const settle = event([front], at, "CLOSE", "official-settlement");
    settle.kind = "SETTLEMENT"; settle.evidence_kind = "SETTLEMENT"; settle.available_at = after;
    input.events.push(settle);
    input.observations.push(observation([back], after));
    const result = build(input);
    expect(result.checkpoints[2].net_pnl_dollars).toBeNull();
    expect(result.checkpoints[2].missing_reasons).toContain("SETTLEMENT_NOT_AVAILABLE_ACTIVE_INVENTORY_UNRESOLVED");
    expect(result.checkpoints[3].active_inventory.map((leg) => leg.provider_symbol)).toEqual([back.provider_symbol]);
    expect(result.events[1].fees_dollars).toBe("0");
    expect(result.checkpoints[3].risk[0].expiry_role).toBe("BACK");
    input.events[1].evidence_kind = "BROKER_FILL";
    expect(() => build(input)).toThrow(/Settlement evidence/);
  });

  test.each([false, true])("pending front settlement retains live back quotes and risk without package valuation (back-only quotes: %s)", (backOnly) => {
    const input = pathFixture("CALL_CALENDAR");
    const [front, back] = input.selection.legs;
    const at = "2026-10-16T20:00:00.000Z", after = "2026-11-20T14:00:00.000Z";
    input.expected_checkpoints = [at, after];
    const pending = observation(input.selection.legs, at);
    const { provider_symbol: ignoredSymbol, bid: ignoredBid, ask: ignoredAsk, ...native } = pending.leg_quotes[0];
    pending.native_package_quote = { ...native, signed_bid: "1", signed_ask: "2", price_semantics: "SIGNED_CASH_FLOW_PER_UNIT" };
    if (backOnly) pending.leg_quotes = pending.leg_quotes.filter((quote) => quote.provider_symbol === back.provider_symbol);
    pending.references = [reference({ source_timestamp: at, available_at: at, bar_end: at, signed_value: "100" })];
    input.observations = [pending];
    const before = build(input);
    const settle = event([front], at, "CLOSE", "delayed-settlement");
    settle.kind = "SETTLEMENT"; settle.evidence_kind = "SETTLEMENT"; settle.available_at = after;
    input.events.push(settle);
    input.observations.push(observation([back], after));
    const result = build(input), point = result.checkpoints[0];
    expect(point).toEqual(before.checkpoints[0]);
    expect(point).toMatchObject({
      evidence_level: "NONE", package_natural: null, liquidation_value_dollars: null, net_pnl_dollars: null,
    });
    expect(point.quote_evidence).not.toBeNull();
    expect(point.quote_evidence.leg_quotes.find((quote) => quote.provider_symbol === back.provider_symbol))
      .toMatchObject({ status: "COMPLETE", bid: "2", ask: "2.25", rejection_reasons: [] });
    const expiredQuote = point.quote_evidence.leg_quotes.find((quote) => quote.provider_symbol === front.provider_symbol);
    expect(expiredQuote.status).toBe("REJECTED");
    expect(expiredQuote.rejection_reasons).toContain("SETTLEMENT_CUTOFF_REACHED");
    for (const packageQuote of [point.quote_evidence.synthetic_package_quote, point.quote_evidence.native_package_quote]) {
      expect(packageQuote).toMatchObject({ usable_for_simulated_execution: false, signed_bid: null, signed_ask: null });
      expect(packageQuote.rejection_reasons).toContain("SETTLEMENT_CUTOFF_REACHED");
      const { evidence_id, ...packageBody } = packageQuote;
      expect(evidence_id).toBe(stableEvidenceContentId({ inventory: point.active_inventory, quote: packageBody }));
    }
    const { observation_id, ...quoteBody } = point.quote_evidence;
    expect(observation_id).toBe(stableEvidenceContentId(quoteBody));
    expect(point.risk.find((risk) => risk.provider_symbol === back.provider_symbol)).toMatchObject({
      status: "AVAILABLE", expiry_role: "BACK", implied_volatility: "0.2", delta: "0.4",
      gamma: "0.01", theta: "-1", vega: "0.5", rho: "0.1", rejection_reasons: [],
    });
    expect(point.risk.find((risk) => risk.provider_symbol === front.provider_symbol)).toMatchObject({
      status: "NOT_AVAILABLE", implied_volatility: null, rejection_reasons: ["SETTLEMENT_CUTOFF_REACHED"],
    });
    expect(point.risk_gaps.map((gap) => gap.provider_symbol)).toEqual([front.provider_symbol]);
    expect(before.coverage).toMatchObject({
      accepted_leg_quotes: 1, expected_active_leg_observations: 4,
      available_risk_leg_observations: 1, expected_risk_leg_observations: 4,
      available_risk_field_observations: 6, expected_risk_field_observations: 24,
    });
    expect(result.checkpoints[1].active_inventory.map((leg) => leg.provider_symbol)).toEqual([back.provider_symbol]);
    expect(result.checkpoints[1].evidence_level).toBe("OBSERVED_QUOTE");
    expect(result.checkpoints[1].net_pnl_dollars).not.toBeNull();
    expect(result.checkpoints[1].risk[0].status).toBe("AVAILABLE");
    expect(result.coverage).toMatchObject({
      accepted_leg_quotes: 2, expected_active_leg_observations: 3,
      available_risk_leg_observations: 2, expected_risk_leg_observations: 3,
      available_risk_field_observations: 12, expected_risk_field_observations: 18,
    });
  });

  test("overnight intervals remain unobserved and do not carry executable quotes", () => {
    const input = pathFixture();
    input.expected_checkpoints = [ENTRY, "2026-09-24T23:00:00.000Z", "2026-09-25T14:30:00.000Z"];
    const result = build(input);
    expect(result.checkpoints[1].missing_reasons).toContain("OVERNIGHT_OR_NON_SESSION_GAP");
    expect(result.checkpoints[1].package_natural).toBeNull();
    expect(result.checkpoints[2].interval.non_session_ms).toBe(52200000);
    expect(result.checkpoints[2].interval.between_checkpoint_observations_inferred).toBe(false);
    expect(result.coverage.expected_checkpoints).toBe(3);
  });

  test("front/back IV/Greeks preserve provenance; future/stale risk stays null and separate from quotes", () => {
    const input = pathFixture("DC");
    input.observations[0].risk[0].available_at = EXIT;
    input.observations[0].risk[1].evidence_kind = "MODEL_REFERENCE";
    const result = build(input);
    const rejected = result.checkpoints[0].risk.find((risk) => risk.provider_symbol === input.selection.legs[0].provider_symbol);
    expect(rejected).toMatchObject({ implied_volatility: null, delta: null, status: "NOT_AVAILABLE", rejection_reasons: ["RISK_NOT_YET_AVAILABLE"] });
    expect(new Set(result.checkpoints[0].risk.map((risk) => risk.expiry_role))).toEqual(new Set(["FRONT", "BACK"]));
    expect(result.checkpoints[0].evidence_level).toBe("OBSERVED_QUOTE");
    expect(result.coverage.available_risk_leg_observations).toBe(3);
  });

  test("pagination binds frozen full evidence and denominators, rejects tampering/drift", () => {
    const input = pathFixture();
    input.page_size = 1;
    const first = build(input);
    expect(first.pagination).toMatchObject({ offset: 0, returned: 1, total: 2 });
    const resumed = build({ ...input, cursor: first.pagination.next_cursor });
    expect(resumed.coverage).toEqual(first.coverage);
    expect(resumed.metrics).toEqual(first.metrics);
    expect(resumed.path_id).toBe(first.path_id);
    expect(resumed.checkpoints[0]).toEqual(build({ ...input, page_size: 100 }).checkpoints[1]);
    expect(resumed.pagination.next_cursor).toBeNull();
    expect(() => build({ ...input, cursor: "not json" })).toThrow(/cursor/);
    const altered = JSON.parse(Buffer.from(first.pagination.next_cursor, "base64url").toString());
    altered.offset = 0;
    expect(() => build({ ...input, cursor: Buffer.from(JSON.stringify(altered)).toString("base64url") })).toThrow(/cursor/);
    const drift = structuredClone(input);
    drift.observations[0].leg_quotes[0].bid = "0.5";
    expect(() => build({ ...drift, cursor: first.pagination.next_cursor })).toThrow(/drift/);
    expect(() => build({ ...drift, frozen_path_id: first.path_id })).toThrow(/drift/);
  });

  test("invalid inventory, calendars, profiles, post-expiry trades and unknown fields fail closed", () => {
    const mutations = [
      (x) => { x.policy.execution_profile.profile_hash = `sha256:${"0".repeat(64)}`; },
      (x) => { x.policy.fee_model.fee_model_hash = `sha256:${"0".repeat(64)}`; },
      (x) => { x.calendar.sessions.reverse(); },
      (x) => { x.settlements.pop(); },
      (x) => { x.observations[0].inventory_id = `sha256:${"0".repeat(64)}`; },
      (x) => { x.events[0].fills[0].quantity = 2; },
      (x) => { x.unknown = "forbidden"; },
      (x) => { x.page_size = 101; },
      (x) => { x.events[0].available_at = "2026-11-20T14:30:00.000Z"; },
      (x) => { x.policy.frozen_at = EXIT; },
    ];
    for (const mutate of mutations) { const input = pathFixture(); mutate(input); expect(() => build(input)).toThrow(); }
    const validate = new Ajv2020({ strict: true }).compile(HISTORICAL_EVENT_PATH_INPUT_SCHEMA);
    expect(validate({ request: pathFixture() })).toBe(true);
  });

  test("output schema validates the real MCP shape and every family without allowing fabricated verification", async () => {
    const schema = JSON.parse(await readFile(new URL("../docs/historical-event-path.schema.json", import.meta.url), "utf8"));
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    for (const { family } of families) {
      const input = pathFixture(family);
      if (family === "SIC") {
        input.events = ["FIRST", "SECOND"].map((phase, i) => event(input.selection.legs.filter((leg) => leg.entry_phase === phase), ENTRY, "OPEN", `stage-${i}`));
      }
      const result = build(input);
      expect(validate(result)).toBe(true);
      result.provenance.broker_fill_verified = true;
      expect(validate(result)).toBe(false);
    }
  });

  test("partial risk exposes missing fields and complete risk-value denominators", () => {
    const input = pathFixture();
    input.observations[0].risk[0].rho = null;
    const result = build(input);
    expect(result.checkpoints[0].risk[0]).toMatchObject({ status: "PARTIAL", missing_fields: ["rho"], rho: null });
    expect(result.coverage).toMatchObject({ expected_risk_field_observations: 24, available_risk_field_observations: 11, available_risk_leg_observations: 1 });
  });

  test("non-session supplied quotes are rejected even in nested quote evidence", () => {
    const input = pathFixture();
    const overnight = "2026-09-24T23:00:00.000Z";
    input.expected_checkpoints.push(overnight);
    input.observations.push(observation(input.selection.legs, overnight));
    const point = build(input).checkpoints[2];
    expect(point.quote_evidence.synthetic_package_quote.usable_for_simulated_execution).toBe(false);
    expect(point.quote_evidence.rejection_reasons).toContain("OUTSIDE_AUTHORITATIVE_SESSION");
    expect(point.package_natural).toBeNull();
  });

  test("closed quantities, post-cutoff trades and backward source history cannot masquerade as new fills", () => {
    const input = pathFixture();
    input.events.push(event(input.selection.legs, EXIT, "CLOSE", "close"));
    input.observations = [];
    const reopen = event(input.selection.legs, EXIT, "OPEN", "reopen");
    input.events.push(reopen);
    expect(() => build(input)).toThrow(/Cumulative opens/);
    const backwards = pathFixture();
    const close = event(backwards.selection.legs, "2026-09-24T14:00:00.000Z", "CLOSE", "before-open");
    close.available_at = EXIT;
    backwards.events.push(close);
    expect(() => build(backwards)).toThrow(/source order/);
    const expired = pathFixture();
    expired.expected_checkpoints = ["2026-10-16T20:00:00.000Z"];
    expired.events = [event(expired.selection.legs, expired.expected_checkpoints[0])];
    expired.observations = [];
    expect(() => build(expired)).toThrow(/Post-cutoff/);
  });

  test("offline real-data NOT_ASSESSABLE report is reproducible without data acquisition", async () => {
    const cwd = new URL("..", import.meta.url);
    execFileSync(process.execPath, ["scripts/report-historical-event-path.mjs", "--check"], { cwd, encoding: "utf8" });
    const report = JSON.parse(await readFile(new URL("../docs/historical-event-path-audit-issue-101.json", import.meta.url), "utf8"));
    expect(report).toMatchObject({ status: "NOT_ASSESSABLE", network_requests: 0, measured_market_results: false, licensed_vertical_slice_replayed: false });
    expect(report.gaps).toContain("AUTHORITATIVE_EVENT_PATH_CALENDAR_AND_VARIABLE_CHECKPOINTS_NOT_RETAINED");
    expect(report.metrics.net_pnl_dollars).toBeNull();
  });
});
