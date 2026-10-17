import { ExactDecimal } from "./decimal.js";
import { stableEvidenceContentId } from "./evidence-cache.js";
import {
  HISTORICAL_EXECUTION_EVIDENCE_INPUT_SCHEMA,
  HISTORICAL_EVIDENCE_SOURCE_PROPERTIES,
  HISTORICAL_EVIDENCE_SOURCE_REQUIRED,
  normalizeHistoricalEvidenceObservation,
  normalizeHistoricalEvidenceReference,
  normalizeHistoricalEvidenceSource,
  normalizeHistoricalInventoryLegs,
  type HistoricalEvidenceSourceInput,
  type HistoricalEvidenceObservationInput,
  type HistoricalExecutionEvidenceInput,
  type HistoricalExecutionInventoryLegInput,
  type HistoricalExecutionInventoryLeg,
  type HistoricalReferenceInput,
} from "./historical-execution-evidence.js";
import { normalizeRfc3339 } from "./time.js";

export const HISTORICAL_STRATEGY_EVIDENCE_CONTRACT_VERSION = "2.0.0" as const;
export const HISTORICAL_STRATEGY_FAMILIES = [
  "CDS", "PDS", "PCS", "CCS", "IC", "AIC", "SIC", "RIC",
  "DD", "DC", "Hybrid", "CALL_CALENDAR", "PUT_CALENDAR", "LIB", "BWB", "SIB",
] as const;
export type HistoricalStrategyFamily = typeof HISTORICAL_STRATEGY_FAMILIES[number];
export type HistoricalEntryPhase = "ENTRY" | "FIRST" | "SECOND";
type TimedSource = {
  source_timestamp: string;
  available_at: string;
  retrieved_at: string;
  source: HistoricalEvidenceSourceInput;
};
export type HistoricalStrategyEntryInput = TimedSource & {
  execution_id: string;
  phase: HistoricalEntryPhase;
  fills: { provider_symbol: string; quantity: number; price: string | number }[];
};
export type HistoricalStrategyEvidenceInput = {
  contract_version: typeof HISTORICAL_STRATEGY_EVIDENCE_CONTRACT_VERSION;
  strategy: {
    strategy_id: string;
    family: HistoricalStrategyFamily;
    underlying: "SPX";
    root: "SPX" | "SPXW";
  };
  selection: TimedSource & {
    selected_at: string;
    reference_cost?: HistoricalReferenceInput | null;
  };
  frozen_selection_id?: string | null;
  quote_policy: HistoricalExecutionEvidenceInput["quote_policy"];
  legs: (HistoricalExecutionInventoryLegInput & { entry_phase?: HistoricalEntryPhase })[];
  expected_observation_times: string[];
  observations: HistoricalEvidenceObservationInput[];
  execution_events?: HistoricalStrategyEntryInput[] | null;
};

const legacy = HISTORICAL_EXECUTION_EVIDENCE_INPUT_SCHEMA.properties.request.properties;
const timestamp = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$" } as const;
const text = { type: "string", minLength: 1, maxLength: 200 } as const;
const phaseSchema = { type: "string", enum: ["ENTRY", "FIRST", "SECOND"] } as const;
const timedSourceProperties = {
  source_timestamp: timestamp,
  available_at: timestamp,
  retrieved_at: timestamp,
  source: {
    type: "object", properties: HISTORICAL_EVIDENCE_SOURCE_PROPERTIES,
    required: HISTORICAL_EVIDENCE_SOURCE_REQUIRED, additionalProperties: false,
  },
} as const;
const timedSourceRequired = ["source_timestamp", "available_at", "retrieved_at", "source"] as const;

export const HISTORICAL_STRATEGY_EVIDENCE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        contract_version: { const: HISTORICAL_STRATEGY_EVIDENCE_CONTRACT_VERSION },
        strategy: {
          type: "object",
          properties: {
            strategy_id: text, family: { type: "string", enum: HISTORICAL_STRATEGY_FAMILIES },
            underlying: { const: "SPX" }, root: { type: "string", enum: ["SPX", "SPXW"] },
          },
          required: ["strategy_id", "family", "underlying", "root"], additionalProperties: false,
        },
        selection: {
          type: "object",
          properties: {
            ...timedSourceProperties, selected_at: timestamp,
            reference_cost: {
              anyOf: [legacy.observations.items.properties.references.items, { type: "null" }],
            },
          },
          required: [...timedSourceRequired, "selected_at"], additionalProperties: false,
        },
        frozen_selection_id: {
          anyOf: [{ type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, { type: "null" }],
        },
        quote_policy: legacy.quote_policy,
        legs: {
          type: "array", minItems: 2, maxItems: 4,
          items: {
            ...legacy.legs.items,
            properties: { ...legacy.legs.items.properties, entry_phase: phaseSchema },
          },
        },
        expected_observation_times: legacy.expected_observation_times,
        observations: legacy.observations,
        execution_events: {
          anyOf: [
            {
              type: "array", maxItems: 10000,
              items: {
                type: "object",
                properties: {
                  ...timedSourceProperties, execution_id: text, phase: phaseSchema,
                  fills: {
                    type: "array", minItems: 1, maxItems: 4,
                    items: {
                      type: "object",
                      properties: {
                        provider_symbol: { type: "string", minLength: 21, maxLength: 21 },
                        quantity: { type: "integer", minimum: 1 },
                        price: { anyOf: [{ type: "string", pattern: "^\\+?\\d+(?:\\.\\d+)?$" }, { type: "number", minimum: 0 }] },
                      },
                      required: ["provider_symbol", "quantity", "price"], additionalProperties: false,
                    },
                  },
                },
                required: [...timedSourceRequired, "execution_id", "phase", "fills"], additionalProperties: false,
              },
            },
            { type: "null" },
          ],
        },
      },
      required: ["contract_version", "strategy", "selection", "quote_policy", "legs", "expected_observation_times", "observations"],
      additionalProperties: false,
    },
  },
  required: ["request"], additionalProperties: false,
} as const;

function requireFact(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function identifier(value: string, field: string): string {
  requireFact(typeof value === "string" && value.trim().length > 0 && value.length <= 200, `${field} must be a non-empty identifier of at most 200 characters.`);
  return value.trim();
}

function compareStrike(a: HistoricalExecutionInventoryLeg, b: HistoricalExecutionInventoryLeg): number {
  return ExactDecimal.parse(a.strike).compare(ExactDecimal.parse(b.strike));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function width(a: HistoricalExecutionInventoryLeg, b: HistoricalExecutionInventoryLeg): ExactDecimal {
  return ExactDecimal.parse(a.strike).subtract(ExactDecimal.parse(b.strike)).abs();
}

function validateShape(family: HistoricalStrategyFamily, legs: HistoricalExecutionInventoryLeg[]): void {
  const sorted = [...legs].sort(compareStrike);
  const puts = sorted.filter((leg) => leg.option_side === "PUT");
  const calls = sorted.filter((leg) => leg.option_side === "CALL");
  const expirations = [...new Set(legs.map((leg) => leg.expiration))].sort();
  const isLong = (leg: HistoricalExecutionInventoryLeg) => leg.inventory_quantity > 0;
  const uniform = () => requireFact(legs.every((leg) => leg.ratio === legs[0].ratio), `${family} requires equal leg ratios.`);
  const sameExpiry = () => requireFact(expirations.length === 1, `${family} requires one expiration.`);
  if (["CDS", "PDS", "PCS", "CCS"].includes(family)) {
    requireFact(legs.length === 2, `${family} requires two legs.`);
    sameExpiry();
    uniform();
    requireFact((family === "CDS" || family === "CCS" ? calls : puts).length === 2, `${family} has the wrong option side.`);
    requireFact(compareStrike(sorted[0], sorted[1]) < 0, `${family} requires distinct strikes.`);
    const longLow = family === "CDS" || family === "PCS";
    requireFact(isLong(sorted[0]) === longLow && isLong(sorted[1]) !== longLow, `${family} has incorrect inventory directions.`);
    return;
  }
  if (["CALL_CALENDAR", "PUT_CALENDAR", "DD", "DC", "Hybrid"].includes(family)) {
    const single = family === "CALL_CALENDAR" || family === "PUT_CALENDAR";
    requireFact(legs.length === (single ? 2 : 4) && expirations.length === 2, `${family} requires ${single ? "two" : "four"} legs across two expirations.`);
    uniform();
    if (single) {
      requireFact((family === "CALL_CALENDAR" ? calls : puts).length === 2, `${family} has the wrong option side.`);
    } else {
      requireFact(calls.length === 2 && puts.length === 2, `${family} requires one call pair and one put pair.`);
    }
    let calendars = 0;
    for (const pair of [puts, calls].filter((items) => items.length > 0)) {
      const front = pair.find((leg) => leg.expiration === expirations[0]);
      const back = pair.find((leg) => leg.expiration === expirations[1]);
      requireFact(front !== undefined && back !== undefined && !isLong(front) && isLong(back), `${family} must SELL front and BUY back for each side.`);
      if (compareStrike(front, back) === 0) calendars++;
      else requireFact(front.option_side === "PUT" ? compareStrike(back, front) < 0 : compareStrike(back, front) > 0, `${family} diagonal back leg must be the outer strike.`);
    }
    const expectedCalendars = single ? 1 : family === "DC" ? 2 : family === "Hybrid" ? 1 : 0;
    requireFact(calendars === expectedCalendars, `${family} has incorrect calendar/diagonal strike pairs.`);
    if (!single) requireFact(compareStrike(puts[1], calls[0]) < 0, `${family} requires put strikes below call strikes.`);
    return;
  }
  if (family === "BWB") {
    requireFact(legs.length === 3 && (puts.length === 3 || calls.length === 3), "BWB requires three legs of one option side.");
    sameExpiry();
    requireFact(compareStrike(sorted[0], sorted[1]) < 0 && compareStrike(sorted[1], sorted[2]) < 0, "BWB requires three distinct strikes.");
    requireFact(isLong(sorted[0]) && !isLong(sorted[1]) && isLong(sorted[2]), "BWB requires long wings and a short body.");
    requireFact(sorted[0].ratio + sorted[2].ratio === sorted[1].ratio, "BWB wing quantities must balance the short body quantity.");
    requireFact(width(sorted[0], sorted[1]).compare(width(sorted[1], sorted[2])) !== 0 || sorted[0].ratio !== sorted[2].ratio, "BWB requires asymmetric wings or ratios.");
    return;
  }
  requireFact(["IC", "AIC", "SIC", "RIC", "LIB", "SIB"].includes(family), `Unsupported strategy family: ${String(family)}.`);
  requireFact(legs.length === 4 && puts.length === 2 && calls.length === 2, `${family} requires two puts and two calls.`);
  sameExpiry();
  uniform();
  requireFact(compareStrike(puts[0], puts[1]) < 0 && compareStrike(calls[0], calls[1]) < 0, `${family} requires distinct wing strikes.`);
  const butterfly = family === "LIB" || family === "SIB";
  requireFact(butterfly ? compareStrike(puts[1], calls[0]) === 0 : compareStrike(puts[1], calls[0]) < 0, `${family} has incorrect inner strikes.`);
  const reverse = family === "RIC" || family === "LIB";
  requireFact(isLong(puts[0]) !== reverse && isLong(puts[1]) === reverse && isLong(calls[0]) === reverse && isLong(calls[1]) !== reverse, `${family} has incorrect inventory directions.`);
  const equalWings = width(puts[0], puts[1]).compare(width(calls[0], calls[1])) === 0;
  if (family === "AIC") requireFact(!equalWings, "AIC requires unequal wing widths.");
  if (family === "IC" || family === "RIC" || butterfly) requireFact(equalWings, `${family} requires equal wing widths.`);
}

function timedSource(input: TimedSource, field: string) {
  const source_timestamp = normalizeRfc3339(input.source_timestamp, `${field}.source_timestamp`);
  const available_at = normalizeRfc3339(input.available_at, `${field}.available_at`);
  const retrieved_at = normalizeRfc3339(input.retrieved_at, `${field}.retrieved_at`);
  requireFact(Date.parse(source_timestamp) <= Date.parse(available_at) && Date.parse(available_at) <= Date.parse(retrieved_at), `${field} requires source_timestamp <= available_at <= retrieved_at.`);
  return { source_timestamp, available_at, retrieved_at, source: normalizeHistoricalEvidenceSource(input.source, `${field}.source`) };
}

export function normalizeHistoricalStrategyEvidence(input: HistoricalStrategyEvidenceInput) {
  requireFact(input.contract_version === HISTORICAL_STRATEGY_EVIDENCE_CONTRACT_VERSION, "Unsupported historical strategy evidence contract_version.");
  const strategy = {
    strategy_id: identifier(input.strategy.strategy_id, "strategy.strategy_id"),
    family: input.strategy.family,
    underlying: input.strategy.underlying,
    root: input.strategy.root,
  };
  requireFact(strategy.underlying === "SPX" && ["SPX", "SPXW"].includes(strategy.root), "Only exact SPX/SPXW option roots are supported.");
  requireFact(HISTORICAL_STRATEGY_FAMILIES.includes(strategy.family), "Unsupported strategy family.");
  requireFact(input.legs.length >= 2 && input.legs.length <= 4, "Strategy inventory requires two to four legs.");
  const parsed = normalizeHistoricalInventoryLegs(input.legs);
  const inventory = parsed.map((leg, index) => {
    const root = leg.provider_symbol.slice(0, 6).trim();
    requireFact(root === strategy.root, "Every OCC root must match the frozen strategy root.");
    requireFact(ExactDecimal.parse(leg.strike).compare(ExactDecimal.zero()) > 0, "Option strikes must be positive.");
    requireFact(leg.settlement === (root === "SPXW" ? "PM" : "AM"), "Settlement does not match the SPX/SPXW root.");
    requireFact(leg.multiplier === "100", "Standard SPX/SPXW evidence requires multiplier 100.");
    const entry_phase = input.legs[index].entry_phase ?? "ENTRY";
    requireFact(strategy.family === "SIC" ? entry_phase === "FIRST" || entry_phase === "SECOND" : entry_phase === "ENTRY", "SIC requires explicit FIRST/SECOND planned phases; other families require ENTRY.");
    return { ...leg, root, entry_phase };
  }).sort((a, b) => compareText(a.provider_symbol, b.provider_symbol));
  validateShape(strategy.family, inventory);
  if (strategy.family === "SIC") {
    for (const phase of ["FIRST", "SECOND"]) {
      const phaseLegs = inventory.filter((leg) => leg.entry_phase === phase);
      requireFact(phaseLegs.length === 2 && phaseLegs[0].option_side === phaseLegs[1].option_side, "Each SIC planned phase must be one complete put or call vertical.");
    }
  }
  const quote_policy = { ...input.quote_policy };
  requireFact(quote_policy.require_sizes === true, "quote_policy.require_sizes must be true.");
  for (const duration of [quote_policy.max_quote_age_ms, quote_policy.max_temporal_skew_ms]) {
    requireFact(Number.isSafeInteger(duration) && duration >= 0, "Quote policy durations must be non-negative safe integers.");
  }
  const expected = input.expected_observation_times.map((time) => normalizeRfc3339(time, "expected_observation_times")).sort((a, b) => Date.parse(a) - Date.parse(b));
  requireFact(expected.length > 0 && expected.length <= 10000 && new Set(expected).size === expected.length, "Expected observation times must be non-empty, bounded and unique.");
  const selected_at = normalizeRfc3339(input.selection.selected_at, "selection.selected_at");
  const selectionSource = timedSource(input.selection, "selection");
  requireFact(Date.parse(selectionSource.available_at) <= Date.parse(selected_at) && Date.parse(selected_at) <= Date.parse(selectionSource.retrieved_at) && Date.parse(selected_at) <= Date.parse(expected[0]), "Selection must be available by selected_at, retrieved afterward, and frozen before all checkpoints.");
  requireFact(inventory.every((leg) => expected.every((time) => time.slice(0, 10) <= leg.expiration)), "Checkpoints must not postdate planned expiration; expiry/settlement replay is unsupported.");
  const reference_cost = input.selection.reference_cost == null ? null : normalizeHistoricalEvidenceReference(input.selection.reference_cost, 0, Date.parse(selected_at));
  if (reference_cost !== null) {
    requireFact(reference_cost.status === "AVAILABLE" && reference_cost.signed_value !== null && reference_cost.price_semantics === "SIGNED_CASH_FLOW_PER_UNIT", "Selection reference_cost must be signed and available at selection; it is not a fill.");
    requireFact(reference_cost.bar_end === null || (reference_cost.available_at !== null && Date.parse(reference_cost.bar_end) <= Date.parse(reference_cost.available_at)), "Selection reference_cost bar_end must not exceed available_at.");
  }
  const selection = { ...selectionSource, selected_at, reference_cost };
  const frozen_selection_id = stableEvidenceContentId({ strategy, inventory, selection, quote_policy });
  requireFact(input.frozen_selection_id == null || input.frozen_selection_id === frozen_selection_id, "frozen_selection_id does not match normalized selection content.");
  const events = (input.execution_events ?? []).map((event) => {
    const clock = timedSource(event, "execution_event");
    requireFact(Date.parse(clock.source_timestamp) >= Date.parse(selected_at), "Execution cannot precede frozen selection.");
    requireFact(event.fills.length > 0 && event.fills.length <= inventory.length, "Execution event must supply actual leg fills.");
    const symbols = new Set<string>();
    const fills = event.fills.map((fill) => {
      const planned = inventory.find((leg) => leg.provider_symbol === fill.provider_symbol);
      requireFact(planned !== undefined && planned.entry_phase === event.phase, "Execution fill must belong to its frozen planned entry phase.");
      requireFact(clock.source_timestamp.slice(0, 10) <= planned.expiration, "Execution facts must not postdate expiration; expiry/settlement replay is unsupported.");
      requireFact(!symbols.has(fill.provider_symbol), "Duplicate leg fill within an execution event.");
      symbols.add(fill.provider_symbol);
      requireFact(Number.isSafeInteger(fill.quantity) && fill.quantity > 0, "Actual fill quantity must be a positive safe integer.");
      const price = ExactDecimal.parse(fill.price, "execution fill price");
      requireFact(price.compare(ExactDecimal.zero()) >= 0, "Actual fill price cannot be negative.");
      const inventory_quantity = planned.action === "BUY_TO_OPEN" ? fill.quantity : -fill.quantity;
      return {
        provider_symbol: fill.provider_symbol, inventory_quantity, price: price.toString(),
        signed_cost_dollars: price.multiplyInteger(inventory_quantity).multiply(ExactDecimal.parse(planned.multiplier)).toString(),
      };
    }).sort((a, b) => compareText(a.provider_symbol, b.provider_symbol));
    const body = { ...clock, execution_id: identifier(event.execution_id, "execution_id"), phase: event.phase, fills, evidence_class: "CALLER_SUPPLIED_EXECUTION_FACT" as const, broker_fill_verified: false as const };
    return { event_id: stableEvidenceContentId(body), ...body };
  }).sort((a, b) => Date.parse(a.source_timestamp) - Date.parse(b.source_timestamp) || Date.parse(a.available_at) - Date.parse(b.available_at) || compareText(a.execution_id, b.execution_id));
  requireFact(events.length <= 10000 && new Set(events.map((event) => event.execution_id)).size === events.length, "Execution IDs must be unique and events bounded.");
  const totals = new Map<string, number>();
  let lastFirst: typeof events[number] | null = null;
  let secondStarted = false;
  for (const event of events) {
    if (event.phase === "SECOND") {
      requireFact(lastFirst !== null && inventory.filter((leg) => leg.entry_phase === "FIRST").every((leg) => totals.get(leg.provider_symbol) === leg.inventory_quantity), "SIC second entry requires actual complete first-phase fills.");
      requireFact(Date.parse(event.source_timestamp) >= Date.parse(lastFirst.source_timestamp) && Date.parse(event.available_at) >= Date.parse(lastFirst.available_at), "SIC phase timestamps must preserve source and availability order.");
      secondStarted = true;
    }
    if (event.phase === "FIRST") {
      requireFact(!secondStarted, "SIC first phase cannot resume after second phase starts.");
      if (lastFirst) requireFact(Date.parse(event.available_at) >= Date.parse(lastFirst.available_at), "SIC first-phase availability order must follow source order.");
      lastFirst = event;
    }
    for (const fill of event.fills) {
      const total = (totals.get(fill.provider_symbol) ?? 0) + fill.inventory_quantity;
      const planned = inventory.find((leg) => leg.provider_symbol === fill.provider_symbol)!;
      requireFact(Number.isSafeInteger(total) && Math.abs(total) <= planned.ratio, "Actual fills exceed frozen planned inventory.");
      totals.set(fill.provider_symbol, total);
    }
  }
  const observations = new Map<string, ReturnType<typeof normalizeHistoricalEvidenceObservation>>();
  for (const observation of input.observations) {
    for (const reference of observation.references ?? []) {
      if (reference.bar_end !== null && reference.available_at !== null) {
        requireFact(Date.parse(normalizeRfc3339(reference.bar_end, "reference.bar_end")) <= Date.parse(normalizeRfc3339(reference.available_at, "reference.available_at")), "Reference bar_end must not exceed available_at.");
      }
    }
    const normalized = normalizeHistoricalEvidenceObservation(observation, inventory, quote_policy);
    requireFact(expected.includes(normalized.observed_at) && !observations.has(normalized.observed_at), "Observations must belong to unique expected checkpoints.");
    observations.set(normalized.observed_at, normalized);
  }
  const checkpoints = expected.map((observed_at) => {
    const quote_evidence = observations.get(observed_at) ?? null;
    const activeEvents = events.filter((event) => Date.parse(event.available_at) <= Date.parse(observed_at));
    const active_inventory = inventory.map((leg) => {
      const fills = activeEvents.flatMap((event) => event.fills).filter((fill) => fill.provider_symbol === leg.provider_symbol);
      const quantity = fills.reduce((sum, fill) => sum + fill.inventory_quantity, 0);
      return {
        provider_symbol: leg.provider_symbol,
        planned_inventory_quantity: leg.inventory_quantity,
        active_inventory_quantity: fills.length === 0 ? null : quantity,
        execution_fact_status: fills.length === 0 ? "NO_SUPPLIED_FILL" as const : quantity === leg.inventory_quantity ? "PLANNED_QUANTITY_FILLED" as const : "PARTIAL_FILL" as const,
        entry_phase: leg.entry_phase,
      };
    });
    const actual_entry_cost_dollars = activeEvents.length === 0 ? null : activeEvents.flatMap((event) => event.fills).reduce((sum, fill) => sum.add(ExactDecimal.parse(fill.signed_cost_dollars)), ExactDecimal.zero()).toString();
    const executable = quote_evidence?.synthetic_package_quote.usable_for_simulated_execution === true || quote_evidence?.native_package_quote?.usable_for_simulated_execution === true;
    const evidence_level = executable ? "EXECUTABLE_QUOTE" as const : quote_evidence?.references.some((reference) => reference.status === "AVAILABLE") ? "REFERENCE_ONLY" as const : "NONE" as const;
    const body = {
      observed_at, evidence_level, quote_inventory_scope: "FROZEN_PLANNED_INVENTORY" as const,
      quote_evidence, active_inventory, actual_entry_cost_dollars,
      active_execution_event_ids: activeEvents.map((event) => event.event_id),
      first_entry_at: activeEvents.find((event) => event.phase === "FIRST" || event.phase === "ENTRY")?.source_timestamp ?? null,
      second_entry_at: activeEvents.find((event) => event.phase === "SECOND")?.source_timestamp ?? null,
      missing_observation_reason: quote_evidence === null ? "MISSING_OBSERVATION" as const : null,
    };
    return { checkpoint_id: stableEvidenceContentId(body), ...body };
  });
  const sources = [
    selection.source, ...(reference_cost ? [reference_cost.source] : []), ...events.map((event) => event.source),
    ...[...observations.values()].flatMap((observation) => [
      ...observation.leg_quotes.flatMap((quote) => quote.source ? [quote.source] : []),
      ...(observation.native_package_quote?.source && "manifest_id" in observation.native_package_quote.source ? [observation.native_package_quote.source] : []),
      ...observation.references.map((reference) => reference.source),
    ]),
  ];
  const available = checkpoints.filter((checkpoint) => checkpoint.evidence_level !== "NONE").length;
  const body = {
    contract_version: HISTORICAL_STRATEGY_EVIDENCE_CONTRACT_VERSION,
    evidence_type: "HISTORICAL_STRATEGY_EVIDENCE" as const,
    status: available === checkpoints.length ? "AVAILABLE" as const : available > 0 ? "PARTIAL" as const : "NOT_AVAILABLE" as const,
    strategy, frozen_selection_id, selection, inventory, quote_policy,
    execution_events: input.execution_events == null ? null : events,
    checkpoints,
    coverage: {
      expected_observations: expected.length, observed_observations: observations.size,
      missing_observation_times: expected.filter((time) => !observations.has(time)),
      executable_quote_observations: checkpoints.filter((checkpoint) => checkpoint.evidence_level === "EXECUTABLE_QUOTE").length,
      reference_only_observations: checkpoints.filter((checkpoint) => checkpoint.evidence_level === "REFERENCE_ONLY").length,
    },
    provenance: {
      manifest_ids: [...new Set(sources.map((source) => source.manifest_id))].sort(),
      normalized_content_ids: [...new Set(sources.map((source) => source.normalized_content_id))].sort(),
      source_and_license_claims_verified: false as const,
      cache_contents_verified: false as const,
    },
    broker_fill_verified: false as const,
    verified_global_maximum_loss_dollars: null,
    loss_certificate: null,
    limitations: [
      "CALLER_SUPPLIED_SOURCES_AND_EXECUTION_FACTS_NOT_INDEPENDENTLY_VERIFIED",
      "PLANNED_PACKAGE_QUOTES_ARE_NOT_ACTUAL_FILLS_OR_ACTIVE_INVENTORY_VALUATIONS",
      "PACKAGE_MARK_IS_NOT_GLOBAL_MAXIMUM_LOSS_OR_4000_DOLLAR_LOSS_CERTIFICATE",
      "NO_SELECTION_RECONSTRUCTION_GRADING_SIZING_PORTFOLIO_GATES_OR_TRADING_DECISIONS",
      "NO_DYNAMIC_PATH_EXIT_EXPIRY_OR_SETTLEMENT_REPLAY",
      "EXPIRATION_DATE_AND_ROOT_SETTLEMENT_CLASS_DO_NOT_VERIFY_INTRADAY_SETTLEMENT_CUTOFF",
    ],
  };
  return { evidence_id: stableEvidenceContentId(body), ...body };
}

export type HistoricalStrategyEvidence = ReturnType<typeof normalizeHistoricalStrategyEvidence>;
