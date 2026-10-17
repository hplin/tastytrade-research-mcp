import { Ajv2020 } from "ajv/dist/2020.js";
import { ExactDecimal, type DecimalInput } from "./decimal.js";
import { stableEvidenceContentId } from "./evidence-cache.js";
import {
  HISTORICAL_EXECUTION_EVIDENCE_INPUT_SCHEMA,
  HISTORICAL_EVIDENCE_SOURCE_PROPERTIES,
  HISTORICAL_EVIDENCE_SOURCE_REQUIRED,
  normalizeHistoricalEvidenceObservation,
  normalizeHistoricalEvidenceSource,
  normalizeHistoricalInventoryLegs,
  type HistoricalEvidenceObservationInput,
  type HistoricalEvidenceSourceInput,
  type HistoricalExecutionInventoryLegInput,
} from "./historical-execution-evidence.js";
import {
  HISTORICAL_EXECUTION_MODEL_INPUT_SCHEMA,
  evaluateHistoricalExecutionTransaction,
  normalizeHistoricalExecutionProfile,
  normalizeHistoricalFeeModel,
  type HistoricalExecutionProfileInput,
  type HistoricalFeeModelInput,
} from "./historical-execution-model.js";
import {
  HISTORICAL_STRATEGY_EVIDENCE_INPUT_SCHEMA,
  normalizeHistoricalStrategyEvidence,
  type HistoricalStrategyEvidenceInput,
} from "./historical-strategy-evidence.js";
import { normalizeDate, normalizeRfc3339 } from "./time.js";

export const HISTORICAL_EVENT_PATH_VERSION = "1.0.0" as const;
type Selection = Pick<HistoricalStrategyEvidenceInput, "contract_version" | "strategy" | "selection" | "legs" | "quote_policy" | "frozen_selection_id">;
type Clock = { source_timestamp: string; available_at: string; retrieved_at: string; source: HistoricalEvidenceSourceInput };
type Risk = Clock & {
  provider_symbol: string;
  implied_volatility: DecimalInput | null;
  delta: DecimalInput | null; gamma: DecimalInput | null; theta: DecimalInput | null;
  vega: DecimalInput | null; rho: DecimalInput | null;
  evidence_kind: "OBSERVED_GREEKS" | "MODEL_REFERENCE";
};
type Fill = { fill_id: string; provider_symbol: string; side: "OPEN" | "CLOSE"; quantity: number; price: DecimalInput | null };
type Instruction = {
  instruction_id: string; frozen_at: string; window_start: string;
  trigger: "ENTRY" | "STAGE" | "TAKE_PROFIT" | "CLOSE" | "ROLL_REVIEW" | "ROLL";
  signed_limit: DecimalInput;
};
export type HistoricalPathEventInput = Clock & {
  event_id: string;
  kind: "OPEN" | "PARTIAL_CLOSE" | "CLOSE" | "ROLL" | "SETTLEMENT";
  evidence_kind: "BROKER_FILL" | "SIMULATED_FILL" | "SETTLEMENT";
  fills: Fill[];
  instruction: Instruction | null;
  simulation_observation: HistoricalEvidenceObservationInput | null;
};
export type HistoricalEventPathInput = {
  contract_version: typeof HISTORICAL_EVENT_PATH_VERSION;
  initial_inventory: "FLAT";
  selection: Selection;
  roll_legs: HistoricalExecutionInventoryLegInput[];
  calendar: {
    calendar_id: string; available_at: string; source: HistoricalEvidenceSourceInput;
    sessions: { session_date: string; open_at: string; close_at: string }[];
  };
  settlements: { provider_symbol: string; settles_at: string }[];
  policy: {
    frozen_at: string;
    execution_profile: HistoricalExecutionProfileInput;
    fee_model: HistoricalFeeModelInput;
    settlement_fees: "PER_CONTRACT" | "ZERO";
    instructions: Instruction[];
  };
  expected_checkpoints: string[];
  observations: (HistoricalEvidenceObservationInput & {
    inventory_id: string; risk: Risk[];
  })[];
  events: HistoricalPathEventInput[];
  page_size: number;
  cursor?: string | null;
  frozen_path_id?: string | null;
};

const v1 = HISTORICAL_EXECUTION_EVIDENCE_INPUT_SCHEMA.properties.request.properties;
const v2 = HISTORICAL_STRATEGY_EVIDENCE_INPUT_SCHEMA.properties.request.properties;
const model = HISTORICAL_EXECUTION_MODEL_INPUT_SCHEMA.properties.request.properties;
const ts = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$" } as const;
const text = { type: "string", minLength: 1, maxLength: 200 } as const;
const hash = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } as const;
const decimal = { anyOf: [{ type: "string", maxLength: 80, pattern: "^[+-]?\\d{1,30}(?:\\.\\d{1,20})?$" }, { type: "number" }] } as const;
const nullableDecimal = { anyOf: [decimal, { type: "null" }] } as const;
const source = { type: "object", properties: HISTORICAL_EVIDENCE_SOURCE_PROPERTIES, required: HISTORICAL_EVIDENCE_SOURCE_REQUIRED, additionalProperties: false } as const;
const clock = { source_timestamp: ts, available_at: ts, retrieved_at: ts, source } as const;
const clockRequired = ["source_timestamp", "available_at", "retrieved_at", "source"] as const;
const instructionSchema = {
  type: "object", properties: {
    instruction_id: text, frozen_at: ts, window_start: ts,
    trigger: { enum: ["ENTRY", "STAGE", "TAKE_PROFIT", "CLOSE", "ROLL_REVIEW", "ROLL"] },
    signed_limit: decimal,
  }, required: ["instruction_id", "frozen_at", "window_start", "trigger", "signed_limit"], additionalProperties: false,
} as const;
const requestSchema = {
  type: "object",
  properties: {
    contract_version: { const: HISTORICAL_EVENT_PATH_VERSION },
    initial_inventory: { const: "FLAT" },
    selection: {
      type: "object", properties: {
        contract_version: v2.contract_version, strategy: v2.strategy, selection: v2.selection,
        legs: v2.legs, quote_policy: v2.quote_policy, frozen_selection_id: v2.frozen_selection_id,
      }, required: ["contract_version", "strategy", "selection", "legs", "quote_policy"], additionalProperties: false,
    },
    roll_legs: { type: "array", maxItems: 28, items: v1.legs.items },
    calendar: {
      type: "object", properties: {
        calendar_id: text, available_at: ts, source,
        sessions: {
          type: "array", minItems: 1, maxItems: 400,
          items: { type: "object", properties: { session_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, open_at: ts, close_at: ts }, required: ["session_date", "open_at", "close_at"], additionalProperties: false },
        },
      }, required: ["calendar_id", "available_at", "source", "sessions"], additionalProperties: false,
    },
    settlements: {
      type: "array", minItems: 2, maxItems: 32,
      items: { type: "object", properties: { provider_symbol: text, settles_at: ts }, required: ["provider_symbol", "settles_at"], additionalProperties: false },
    },
    policy: {
      type: "object", properties: {
        frozen_at: ts, execution_profile: model.execution_profile, fee_model: model.fee_model.anyOf[0],
        settlement_fees: { enum: ["PER_CONTRACT", "ZERO"] },
        instructions: { type: "array", maxItems: 500, items: instructionSchema },
      }, required: ["frozen_at", "execution_profile", "fee_model", "settlement_fees", "instructions"], additionalProperties: false,
    },
    expected_checkpoints: { type: "array", minItems: 1, maxItems: 2000, uniqueItems: true, items: ts },
    observations: {
      type: "array", maxItems: 2000,
      items: {
        type: "object", properties: {
          ...v1.observations.items.properties, inventory_id: hash,
          risk: {
            type: "array", maxItems: 32,
            items: {
              type: "object", properties: {
                ...clock, provider_symbol: text, implied_volatility: nullableDecimal,
                delta: nullableDecimal, gamma: nullableDecimal, theta: nullableDecimal, vega: nullableDecimal, rho: nullableDecimal,
                evidence_kind: { enum: ["OBSERVED_GREEKS", "MODEL_REFERENCE"] },
              }, required: [...clockRequired, "provider_symbol", "implied_volatility", "delta", "gamma", "theta", "vega", "rho", "evidence_kind"], additionalProperties: false,
            },
          },
        }, required: ["observed_at", "leg_quotes", "inventory_id", "risk"], additionalProperties: false,
      },
    },
    events: {
      type: "array", maxItems: 500,
      items: {
        type: "object", properties: {
          ...clock, event_id: text,
          kind: { enum: ["OPEN", "PARTIAL_CLOSE", "CLOSE", "ROLL", "SETTLEMENT"] },
          evidence_kind: { enum: ["BROKER_FILL", "SIMULATED_FILL", "SETTLEMENT"] },
          fills: {
            type: "array", minItems: 1, maxItems: 8,
            items: { type: "object", properties: {
              fill_id: text, provider_symbol: text, side: { enum: ["OPEN", "CLOSE"] },
              quantity: { type: "integer", minimum: 1, maximum: 1000000 }, price: nullableDecimal,
            }, required: ["fill_id", "provider_symbol", "side", "quantity", "price"], additionalProperties: false },
          },
          instruction: { anyOf: [instructionSchema, { type: "null" }] },
          simulation_observation: { anyOf: [{
            ...v1.observations.items,
            properties: {
              ...v1.observations.items.properties,
              leg_quotes: { ...v1.observations.items.properties.leg_quotes, maxItems: 8 },
            },
          }, { type: "null" }] },
        }, required: [...clockRequired, "event_id", "kind", "evidence_kind", "fills", "instruction", "simulation_observation"], additionalProperties: false,
      },
    },
    page_size: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { anyOf: [{ type: "string", minLength: 1, maxLength: 1000 }, { type: "null" }] },
    frozen_path_id: { anyOf: [hash, { type: "null" }] },
  },
  required: ["contract_version", "initial_inventory", "selection", "roll_legs", "calendar", "settlements", "policy", "expected_checkpoints", "observations", "events", "page_size"],
  additionalProperties: false,
} as const;
export const HISTORICAL_EVENT_PATH_INPUT_SCHEMA = {
  type: "object", properties: { request: requestSchema }, required: ["request"], additionalProperties: false,
} as const;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(requestSchema);
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function time(value: string) { return normalizeRfc3339(value, "event path timestamp"); }
function clockValue(input: Clock) {
  const source_timestamp = time(input.source_timestamp), available_at = time(input.available_at), retrieved_at = time(input.retrieved_at);
  need(source_timestamp <= available_at && available_at <= retrieved_at, "Require source_timestamp <= available_at <= retrieved_at.");
  return { source_timestamp, available_at, retrieved_at, source: normalizeHistoricalEvidenceSource(input.source, "event path source") };
}
function dec(value: DecimalInput) { return ExactDecimal.parse(value); }
function sum(values: ExactDecimal[]) { return values.reduce((a, b) => a.add(b), ExactDecimal.zero()); }
function unique<T>(values: T[], message: string) { need(new Set(values).size === values.length, message); }
function compareText(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
export function historicalPathInventoryId(inventory: { provider_symbol: string; inventory_quantity: number }[]) {
  return stableEvidenceContentId(inventory.filter((leg) => leg.inventory_quantity !== 0)
    .map(({ provider_symbol, inventory_quantity }) => ({ provider_symbol, inventory_quantity }))
    .sort((a, b) => compareText(a.provider_symbol, b.provider_symbol)));
}

export function buildHistoricalEventPath(input: HistoricalEventPathInput) {
  need(validate(input), `Invalid historical event path request: ${JSON.stringify(validate.errors)}`);
  const selection = normalizeHistoricalStrategyEvidence({
    ...input.selection, expected_observation_times: [input.selection.selection.selected_at], observations: [],
  });
  const selectedAt = selection.selection.selected_at;
  const policyAt = time(input.policy.frozen_at);
  need(policyAt <= selectedAt, "Policy must be frozen no later than selection.");
  const execution_profile = normalizeHistoricalExecutionProfile(input.policy.execution_profile);
  const fee_model = normalizeHistoricalFeeModel(input.policy.fee_model)!;
  const instructions = input.policy.instructions.map((item) => {
    const frozen_at = time(item.frozen_at), window_start = time(item.window_start);
    need(frozen_at <= selectedAt && window_start >= frozen_at, "Instructions and limits must be frozen before selection and their execution window.");
    return { ...item, frozen_at, window_start, signed_limit: dec(item.signed_limit).toString() };
  }).sort((a, b) => compareText(a.instruction_id, b.instruction_id));
  unique(instructions.map((item) => item.instruction_id), "Duplicate instruction ID.");
  const extra = input.roll_legs.length ? normalizeHistoricalInventoryLegs(input.roll_legs) : [];
  const inventory = [...selection.inventory, ...extra].sort((a, b) => compareText(a.provider_symbol, b.provider_symbol));
  unique(inventory.map((leg) => leg.provider_symbol), "Duplicate frozen inventory symbol.");
  need(inventory.every((leg) => leg.provider_symbol.slice(0, 6).trim() === selection.strategy.root &&
    leg.settlement === (selection.strategy.root === "SPXW" ? "PM" : "AM") && leg.multiplier === "100" && dec(leg.strike).compare(dec(0)) > 0), "Roll legs must preserve exact root, settlement and multiplier.");
  const sessions = input.calendar.sessions.map((session) => ({
    session_date: normalizeDate(session.session_date, "session_date"), open_at: time(session.open_at), close_at: time(session.close_at),
  }));
  sessions.forEach((session, index) => {
    need(session.open_at < session.close_at && (!index || sessions[index - 1].close_at < session.open_at) &&
      (!index || sessions[index - 1].session_date < session.session_date), "Authoritative sessions must be ordered, unique and non-overlapping.");
  });
  const calendar = {
    calendar_id: input.calendar.calendar_id, available_at: time(input.calendar.available_at),
    source: normalizeHistoricalEvidenceSource(input.calendar.source, "calendar.source"), sessions,
    authority: "CALLER_SUPPLIED_AUTHORITATIVE" as const, independently_verified: false as const,
  };
  need(calendar.available_at <= selectedAt, "Calendar must be available at selection.");
  const expected = input.expected_checkpoints.map(time).sort();
  unique(expected, "Duplicate normalized checkpoint.");
  need(expected[0] >= selectedAt && expected[0] >= sessions[0].open_at && expected.at(-1)! <= sessions.at(-1)!.close_at, "Checkpoints must follow selection and lie within the supplied calendar range.");
  const settlements = input.settlements.map((item) => ({ ...item, settles_at: time(item.settles_at) })).sort((a, b) => compareText(a.provider_symbol, b.provider_symbol));
  unique(settlements.map((item) => item.provider_symbol), "Duplicate settlement schedule.");
  need(settlements.length === inventory.length && inventory.every((leg) => settlements.some((item) =>
    item.provider_symbol === leg.provider_symbol && item.settles_at.slice(0, 10) === leg.expiration)), "Every exact leg requires a frozen expiry-day settlement cutoff.");
  const cutoff = (symbol: string) => settlements.find((item) => item.provider_symbol === symbol)!.settles_at;
  const frontExpiry = [...new Set(inventory.map((leg) => leg.expiration))].sort()[0];
  const inSession = (at: string) => sessions.find((session) => session.open_at <= at && at <= session.close_at) ?? null;
  const observations = input.observations.map((item) => ({ ...item, observed_at: time(item.observed_at) })).sort((a, b) => compareText(a.observed_at, b.observed_at));
  unique(observations.map((item) => item.observed_at), "Duplicate path observation.");
  need(observations.every((item) => expected.includes(item.observed_at)), "Observations must match frozen checkpoints.");
  const events = input.events.map((item) => ({ ...item, ...clockValue(item) }))
    .sort((a, b) => compareText(a.available_at, b.available_at) || compareText(a.source_timestamp, b.source_timestamp) || compareText(a.event_id, b.event_id));
  unique(events.map((item) => item.event_id), "Duplicate event ID; fees cannot be counted twice.");
  unique(events.flatMap((item) => item.fills.map((fill) => fill.fill_id)), "Duplicate fill ID; overlapping fill fees rejected.");
  const frozenBody = {
    contract_version: input.contract_version, initial_inventory: input.initial_inventory, frozen_selection_id: selection.frozen_selection_id, inventory,
    calendar, settlements, policy: { frozen_at: policyAt, execution_profile, fee_model, settlement_fees: input.policy.settlement_fees, instructions },
    expected_checkpoints: expected, observations, events,
  };
  const path_id = stableEvidenceContentId(frozenBody);
  need(input.frozen_path_id == null || input.frozen_path_id === path_id, "Frozen path drift.");
  let offset = 0;
  if (input.cursor != null) {
    let parsed: { path_id?: unknown; offset?: unknown; checksum?: unknown };
    try { parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
    catch { throw new Error("Invalid event path cursor."); }
    need(parsed !== null && typeof parsed === "object" && Object.keys(parsed).sort().join(",") === "checksum,offset,path_id", "Invalid event path cursor shape.");
    need(parsed.path_id === path_id && Number.isSafeInteger(parsed.offset) && Number(parsed.offset) > 0 &&
      Number(parsed.offset) < expected.length && parsed.checksum === stableEvidenceContentId({ path_id, offset: parsed.offset }), "Invalid cursor or frozen path drift.");
    offset = Number(parsed.offset);
  }
  const quantities = new Map(inventory.map((leg) => [leg.provider_symbol, 0]));
  const opened = new Map(inventory.map((leg) => [leg.provider_symbol, 0]));
  const lastSourceTime = new Map<string, string>();
  const eventResults: ReturnType<typeof applyEvent>[] = [];
  let cash = ExactDecimal.zero(), fees = ExactDecimal.zero(), hasEntry = false;
  let firstEntry: string | null = null, lastExit: string | null = null;
  function applyEvent(event: typeof events[number]) {
    need(event.source_timestamp >= selectedAt && event.available_at <= expected.at(-1)!, "Events must follow selection and be available within the frozen path.");
    need(event.kind === "SETTLEMENT" ? event.evidence_kind === "SETTLEMENT" : event.evidence_kind !== "SETTLEMENT", "Settlement evidence and event kind must agree.");
    need(event.kind === "SETTLEMENT" || inSession(event.source_timestamp) !== null, "Trading events require an authoritative session.");
    const isOpen = event.fills.some((fill) => fill.side === "OPEN"), isClose = event.fills.some((fill) => fill.side === "CLOSE");
    need(event.kind === "ROLL" ? isOpen && isClose : event.kind === "OPEN" ? isOpen && !isClose : isClose && !isOpen, "Event kind must agree with exact inventory changes.");
    unique(event.fills.map((fill) => fill.provider_symbol), "Duplicate symbol within event.");
    const transaction = event.fills.map((fill) => {
      const leg = inventory.find((leg) => leg.provider_symbol === fill.provider_symbol);
      need(leg, "Event leg must belong to frozen inventory.");
      const sign = Math.sign(leg.inventory_quantity), delta = sign * fill.quantity * (fill.side === "OPEN" ? 1 : -1);
      const active = quantities.get(fill.provider_symbol)!;
      need(!lastSourceTime.has(fill.provider_symbol) || lastSourceTime.get(fill.provider_symbol)! <= event.source_timestamp, "Execution source order cannot run backward for an exact leg.");
      need(fill.side === "OPEN" ? Math.abs(active) + fill.quantity <= leg.ratio : Math.sign(active) === sign && fill.quantity <= Math.abs(active), "Event exceeds exact active/frozen inventory.");
      need(event.kind === "SETTLEMENT" ? event.source_timestamp === cutoff(fill.provider_symbol) && fill.quantity === Math.abs(active) :
        event.source_timestamp < cutoff(fill.provider_symbol) && event.available_at < cutoff(fill.provider_symbol), "Post-cutoff trades forbidden; settlement must close the exact remainder at its authoritative cutoff.");
      if (fill.side === "OPEN" && selection.strategy.family === "SIC") {
        const planned = selection.inventory.find((leg) => leg.provider_symbol === fill.provider_symbol);
        if (planned?.entry_phase === "SECOND") need(selection.inventory.filter((leg) => leg.entry_phase === "FIRST")
          .every((leg) => opened.get(leg.provider_symbol) === leg.ratio && lastSourceTime.get(leg.provider_symbol)! <= event.source_timestamp), "SIC SECOND requires actual complete FIRST opens available beforehand.");
        if (planned?.entry_phase === "FIRST") need(selection.inventory.filter((leg) => leg.entry_phase === "SECOND")
          .every((leg) => opened.get(leg.provider_symbol) === 0), "SIC FIRST cannot resume after SECOND.");
      }
      if (fill.side === "OPEN") need(opened.get(fill.provider_symbol)! + fill.quantity <= leg.ratio, "Cumulative opens exceed frozen leg allocation; freeze a separate lifecycle instead of recycling fills.");
      return { ...leg, ratio: fill.quantity, inventory_quantity: delta, action: delta > 0 ? "BUY_TO_OPEN" as const : "SELL_TO_OPEN" as const };
    });
    let signedCost: ExactDecimal | null = null;
    let simulation: ReturnType<typeof evaluateHistoricalExecutionTransaction> | null = null;
    if (event.evidence_kind === "SIMULATED_FILL") {
      need(event.instruction !== null && event.fills.every((fill) => fill.price === null), "Simulated fills require a frozen instruction and cannot supply invented per-leg prices.");
      const instruction = instructions.find((item) => item.instruction_id === event.instruction!.instruction_id);
      need(instruction && stableEvidenceContentId(instruction) === stableEvidenceContentId({
        ...event.instruction, frozen_at: time(event.instruction.frozen_at), window_start: time(event.instruction.window_start), signed_limit: dec(event.instruction.signed_limit).toString(),
      }), "Event instruction must match the caller-frozen policy.");
      need(instruction.window_start >= selectedAt && instruction.frozen_at <= instruction.window_start, "Simulation window cannot precede selection or policy freeze.");
      const observation = event.simulation_observation === null ? null : normalizeObservation(event.simulation_observation, transaction);
      simulation = evaluateHistoricalExecutionTransaction({
        execution_profile, window_start: instruction.window_start, evaluated_at: event.source_timestamp,
        signed_limit: instruction.signed_limit, observation,
      });
      if (simulation.status === "SIMULATED_FILLED") signedCost = dec(simulation.fill_price!).multiply(dec(100));
    } else {
      need(event.instruction === null && event.simulation_observation === null, "Supplied execution/settlement facts cannot masquerade as modeled fills.");
      signedCost = sum(event.fills.map((fill, index) => {
        need(fill.price !== null && dec(fill.price).compare(dec(0)) >= 0, "Execution and settlement facts require non-negative exact per-leg prices.");
        return dec(fill.price).multiplyInteger(transaction[index].inventory_quantity).multiply(dec(100));
      }));
    }
    const charged = signedCost === null ? null : event.kind === "SETTLEMENT" && input.policy.settlement_fees === "ZERO" ? dec(0) :
      dec(fee_model.amount_per_contract_per_leg_side).multiplyInteger(event.fills.reduce((n, fill) => n + fill.quantity, 0));
    if (signedCost !== null) {
      for (const [index, fill] of event.fills.entries()) {
        quantities.set(fill.provider_symbol, quantities.get(fill.provider_symbol)! + transaction[index].inventory_quantity);
        lastSourceTime.set(fill.provider_symbol, event.source_timestamp);
        if (fill.side === "OPEN") opened.set(fill.provider_symbol, opened.get(fill.provider_symbol)! + fill.quantity);
      }
      need([...quantities.values()].filter((quantity) => quantity !== 0).length <= 4, "Active inventory is bounded to four exact legs.");
      if (isOpen) { hasEntry = true; firstEntry ??= event.source_timestamp; }
      if ([...quantities.values()].every((quantity) => quantity === 0) && hasEntry) lastExit = event.source_timestamp;
      else lastExit = null;
      cash = cash.subtract(signedCost);
      fees = fees.add(charged!);
      if (event.kind === "CLOSE") need([...quantities.values()].every((quantity) => quantity === 0), "CLOSE must flatten inventory; use PARTIAL_CLOSE for a remainder.");
    }
    const body = { ...event, transaction_inventory: transaction, status: signedCost === null ? simulation!.status : "APPLIED",
      signed_cost_dollars: signedCost?.toString() ?? null, fees_dollars: charged?.toString() ?? null,
      fee_basis: "CALLER_FROZEN_FEE_MODEL" as const,
      simulation, broker_fill_verified: false as const };
    return { ...body, content_id: stableEvidenceContentId(body) };
  }
  function normalizeObservation(observation: HistoricalEvidenceObservationInput, active: typeof inventory) {
    for (const ref of observation.references ?? []) need(ref.bar_end === null || ref.available_at === null || time(ref.bar_end) <= time(ref.available_at), "Completed reference bars must be available before evaluation.");
    const normalized = normalizeHistoricalEvidenceObservation(observation, active, selection.quote_policy);
    if (inSession(normalized.observed_at)) return normalized;
    const reject = (quote: typeof normalized.synthetic_package_quote) => {
      const { evidence_id: ignored, ...body } = quote;
      const rejected = { ...body, usable_for_simulated_execution: false, rejection_reasons: [...body.rejection_reasons, "OUTSIDE_AUTHORITATIVE_SESSION"] };
      return { evidence_id: stableEvidenceContentId({ inventory: active, quote: rejected }), ...rejected };
    };
    const { observation_id: ignored, ...body } = normalized;
    const rejected = {
      ...body, status: "REJECTED" as const, quote_coverage: "NONE" as const,
      synthetic_package_quote: reject(body.synthetic_package_quote),
      native_package_quote: body.native_package_quote ? reject(body.native_package_quote) : null,
      rejection_reasons: [...body.rejection_reasons, "OUTSIDE_AUTHORITATIVE_SESSION"],
    };
    return { observation_id: stableEvidenceContentId(rejected), ...rejected };
  }
  let eventIndex = 0;
  const checkpoints = expected.map((observed_at, checkpointIndex) => {
    while (eventIndex < events.length && events[eventIndex].available_at <= observed_at) eventResults.push(applyEvent(events[eventIndex++]));
    const active = inventory.filter((leg) => quantities.get(leg.provider_symbol) !== 0).map((leg) => ({
      ...leg, inventory_quantity: quantities.get(leg.provider_symbol)!, ratio: Math.abs(quantities.get(leg.provider_symbol)!),
    }));
    const inventory_id = historicalPathInventoryId(active);
    const raw = observations.find((item) => item.observed_at === observed_at);
    if (raw) need(raw.inventory_id === inventory_id, "Observation inventory_id does not match exact active inventory.");
    const session = inSession(observed_at);
    const expired = active.some((leg) => observed_at >= cutoff(leg.provider_symbol));
    const quote_evidence = raw && active.length && !expired ? normalizeObservation(raw, active) : null;
    const natural = quote_evidence?.synthetic_package_quote;
    const quoteUsable = session !== null && !expired && natural?.usable_for_simulated_execution === true;
    const reference = quote_evidence?.references.find((ref) => ref.status === "AVAILABLE" && ref.price_semantics === "SIGNED_CASH_FLOW_PER_UNIT");
    const evidence_level = active.length === 0 && hasEntry ? "CLOSED_LEDGER" : quoteUsable ? "OBSERVED_QUOTE" : reference?.evidence_type ?? "NONE";
    const liquidation = !hasEntry ? null : active.length === 0 ? dec(0) : quoteUsable ? dec(natural!.signed_bid!).multiply(dec(100)) :
      reference?.signed_value != null ? dec(reference.signed_value).multiply(dec(100)) : null;
    const net = liquidation === null ? null : cash.add(liquidation).subtract(fees);
    const missing_reasons = [
      ...(!hasEntry ? ["NO_ENTRY_FACT"] : []),
      ...(active.length && !raw ? ["MISSING_OBSERVATION"] : []),
      ...(active.length && !session ? ["OVERNIGHT_OR_NON_SESSION_GAP"] : []),
      ...(expired ? ["SETTLEMENT_NOT_AVAILABLE_ACTIVE_INVENTORY_UNRESOLVED"] : []),
      ...(active.length && !quoteUsable ? natural?.rejection_reasons ?? ["NO_EXECUTABLE_EXACT_LEG_QUOTE"] : []),
    ];
    const risks = (raw?.risk ?? []).map((risk) => {
      need(active.some((leg) => leg.provider_symbol === risk.provider_symbol), "Risk must belong to active exact inventory.");
      const clock = clockValue(risk);
      const reasons = clock.available_at > observed_at ? ["RISK_NOT_YET_AVAILABLE"] :
        Date.parse(observed_at) - Date.parse(clock.source_timestamp) > selection.quote_policy.max_quote_age_ms ? ["RISK_STALE"] : [];
      if (expired) reasons.push("SETTLEMENT_CUTOFF_REACHED");
      const fields = ["implied_volatility", "delta", "gamma", "theta", "vega", "rho"] as const;
      const fieldValue = (field: typeof fields[number]): string | null => {
        const value = risk[field] === null ? null : dec(risk[field]).toString();
        if (field === "implied_volatility" && value !== null) need(dec(value).compare(dec(0)) >= 0, "IV cannot be negative.");
        return reasons.length ? null : value;
      };
      const values = {
        implied_volatility: fieldValue("implied_volatility"), delta: fieldValue("delta"), gamma: fieldValue("gamma"),
        theta: fieldValue("theta"), vega: fieldValue("vega"), rho: fieldValue("rho"),
      };
      const missing_fields = fields.filter((field) => values[field] === null);
      return { provider_symbol: risk.provider_symbol, ...clock, ...values, evidence_kind: risk.evidence_kind,
        expiry_role: inventory.find((leg) => leg.provider_symbol === risk.provider_symbol)!.expiration === frontExpiry ? "FRONT" : "BACK",
        status: reasons.length ? "NOT_AVAILABLE" : missing_fields.length ? "PARTIAL" : "AVAILABLE", missing_fields, rejection_reasons: reasons };
    });
    unique(risks.map((risk) => risk.provider_symbol), "Duplicate risk symbol.");
    const previous = checkpointIndex === 0 ? null : expected[checkpointIndex - 1];
    const elapsed = previous === null ? null : Date.parse(observed_at) - Date.parse(previous);
    const sessionOverlap = previous === null ? 0 : sessions.reduce((n, session) =>
      n + Math.max(0, Math.min(Date.parse(observed_at), Date.parse(session.close_at)) - Math.max(Date.parse(previous), Date.parse(session.open_at))), 0);
    const body = {
      observed_at, session_date: session?.session_date ?? null, inventory_id, active_inventory: active,
      interval: {
        previous_checkpoint_at: previous, elapsed_ms: elapsed,
        non_session_ms: elapsed === null ? null : elapsed - sessionOverlap,
        between_checkpoint_observations_inferred: false,
      },
      available_event_ids: eventResults.map((event) => event.content_id),
      quote_evidence, risk: risks,
      risk_gaps: active.filter((leg) => !risks.some((risk) => risk.provider_symbol === leg.provider_symbol && risk.status === "AVAILABLE"))
        .map((leg) => ({ provider_symbol: leg.provider_symbol, reason: "MISSING_OR_REJECTED_RISK" })),
      evidence_level, missing_reasons: [...new Set(missing_reasons)],
      package_natural: quoteUsable ? { signed_bid: natural!.signed_bid, signed_ask: natural!.signed_ask, executable_fill: false } : null,
      cash_flow_dollars: hasEntry ? cash.toString() : null, fees_dollars: hasEntry ? fees.toString() : null,
      liquidation_value_dollars: liquidation?.toString() ?? null, net_pnl_dollars: net?.toString() ?? null,
      holding_duration_ms: firstEntry ? Date.parse(lastExit ?? observed_at) - Date.parse(firstEntry) : null,
      holding_duration_basis: "WALL_CLOCK_FIRST_ENTRY_TO_CHECKPOINT_OR_FINAL_CLOSE" as const,
      metric_evidence: {
        valuation: evidence_level,
        execution_kinds: [...new Set(eventResults.filter((event) => event.status === "APPLIED").map((event) => event.evidence_kind))],
        execution_evidence_levels: [...new Set(eventResults.filter((event) => event.status === "APPLIED").map((event) => event.simulation?.evidence_kind ?? event.evidence_kind))],
      },
    };
    return { checkpoint_id: stableEvidenceContentId(body), ...body };
  });
  need(eventIndex === events.length, "Events outside the frozen path are forbidden.");
  const measured = checkpoints.filter((checkpoint) => checkpoint.net_pnl_dollars !== null);
  const complete = measured.length === expected.length && !eventResults.some((event) => event.status === "NOT_ASSESSABLE");
  const values = measured.map((checkpoint) => dec(checkpoint.net_pnl_dollars!));
  const minimum = values.reduce((a, b) => a.compare(b) < 0 ? a : b, dec(0));
  const maximum = values.reduce((a, b) => a.compare(b) > 0 ? a : b, dec(0));
  const nextOffset = offset + input.page_size;
  const next_cursor = nextOffset < checkpoints.length ? Buffer.from(JSON.stringify({
    path_id, offset: nextOffset, checksum: stableEvidenceContentId({ path_id, offset: nextOffset }),
  })).toString("base64url") : null;
  const sources = [
    selection.selection.source, calendar.source, ...eventResults.map((event) => event.source),
    ...observations.flatMap((observation) => [
      ...observation.leg_quotes, ...(observation.native_package_quote ? [observation.native_package_quote] : []),
      ...(observation.references ?? []), ...observation.risk.map((risk) => risk.source),
    ]),
    ...events.flatMap((event) => event.simulation_observation ? [
      ...event.simulation_observation.leg_quotes,
      ...(event.simulation_observation.native_package_quote ? [event.simulation_observation.native_package_quote] : []),
      ...(event.simulation_observation.references ?? []),
    ] : []),
  ].map((item) => normalizeHistoricalEvidenceSource(item, "path lineage"));
  return {
    contract_version: HISTORICAL_EVENT_PATH_VERSION, evidence_type: "HISTORICAL_EVENT_PATH" as const,
    initial_inventory: input.initial_inventory, mutates_broker_or_paper_state: false,
    path_id, status: complete ? "ASSESSABLE" : "NOT_ASSESSABLE",
    frozen_selection_id: selection.frozen_selection_id, calendar, inventory, settlements, policy: frozenBody.policy,
    events: eventResults, checkpoints: checkpoints.slice(offset, nextOffset),
    pagination: { offset, returned: Math.min(input.page_size, checkpoints.length - offset), total: checkpoints.length, next_cursor },
    coverage: {
      expected_checkpoints: expected.length, supplied_observations: observations.length,
      quote_backed_checkpoints: checkpoints.filter((point) => point.evidence_level === "OBSERVED_QUOTE").length,
      measured_pnl_checkpoints: measured.length, missing_pnl_checkpoints: expected.length - measured.length,
      expected_active_leg_observations: checkpoints.reduce((n, point) => n + point.active_inventory.length, 0),
      accepted_leg_quotes: checkpoints.reduce((n, point) => n + (point.quote_evidence?.leg_quotes.filter((quote) => quote.status === "COMPLETE").length ?? 0), 0),
      expected_risk_leg_observations: checkpoints.reduce((n, point) => n + point.active_inventory.length, 0),
      available_risk_leg_observations: checkpoints.reduce((n, point) => n + point.risk.filter((risk) => risk.status === "AVAILABLE").length, 0),
      expected_risk_field_observations: checkpoints.reduce((n, point) => n + point.active_inventory.length * 6, 0),
      available_risk_field_observations: checkpoints.reduce((n, point) => n + point.risk.reduce((n, risk) => n + 6 - risk.missing_fields.length, 0), 0),
      unresolved_simulated_events: eventResults.filter((event) => event.status === "NOT_ASSESSABLE").length,
      gaps: checkpoints.filter((point) => point.missing_reasons.length).map((point) => ({ observed_at: point.observed_at, reasons: point.missing_reasons })),
      complete: complete,
    },
    metrics: {
      net_pnl_dollars: checkpoints.at(-1)!.net_pnl_dollars,
      mae_dollars: complete ? minimum.toString() : null, mfe_dollars: complete ? maximum.toString() : null,
      observed_sample_mae_dollars: values.length ? minimum.toString() : null,
      observed_sample_mfe_dollars: values.length ? maximum.toString() : null,
      holding_duration_ms: checkpoints.at(-1)!.holding_duration_ms,
      expected_samples: expected.length, measured_samples: measured.length,
      continuous_path_extrema_verified: false,
      evidence_levels: [...new Set(checkpoints.map((point) => point.evidence_level))],
      execution_kinds: [...new Set(eventResults.filter((event) => event.status === "APPLIED").map((event) => event.evidence_kind))],
      execution_evidence_levels: [...new Set(eventResults.filter((event) => event.status === "APPLIED").map((event) => event.simulation?.evidence_kind ?? event.evidence_kind))],
    },
    provenance: {
      source_and_license_claims_verified: false, cache_contents_verified: false, broker_fill_verified: false,
      immutable_input_id: path_id,
      manifest_ids: [...new Set([...selection.provenance.manifest_ids, ...sources.map((item) => item.manifest_id)])].sort(),
      normalized_content_ids: [...new Set([...selection.provenance.normalized_content_ids, ...sources.map((item) => item.normalized_content_id)])].sort(),
    },
    limitations: [
      "CALLER_SUPPLIED_CALENDAR_SOURCE_LICENSE_AND_EXECUTION_FACTS_NOT_INDEPENDENTLY_VERIFIED",
      "OBSERVED_QUOTE_IS_NOT_FILL_MIDPOINT_IS_NOT_EXECUTABLE",
      "SIMULATED_FILL_IS_MODEL_OUTPUT_NOT_BROKER_FILL",
      "NO_FORWARD_FILL_INTERPOLATION_PROVIDER_FETCH_LIVE_ACTION_OR_PARAMETER_OPTIMIZATION",
      "METRICS_ARE_FROZEN_CHECKPOINT_SAMPLES_NOT_CONTINUOUS_PATH_EXTREMA",
      "SETTLEMENT_IS_CALLER_SUPPLIED_OFFICIAL_CASH_FACT_NOT_AN_EXECUTABLE_QUOTE",
    ],
  };
}
export type HistoricalEventPath = ReturnType<typeof buildHistoricalEventPath>;
