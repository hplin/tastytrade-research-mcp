export const CHECKPOINT = "2026-09-24T14:30:00.000Z";
export const SECOND_CHECKPOINT = "2026-09-24T15:30:00.000Z";
export const RETRIEVED = "2026-10-01T12:00:00.000Z";
export const hash = (character) => `sha256:${character.repeat(64)}`;

export function source(id = "fixture") {
  return {
    source_id: id, provider_id: "fixture-only", dataset_id: "deterministic-options",
    license_scope_id: "caller-declared-not-verified",
    resolution_profile: {
      profile_id: "QUOTE_TICK", profile_version: "1.0.0",
      native_resolution: "tick", effective_resolution: "tick",
    },
    source_revision: "fixture/1", revision: 1,
    manifest_id: hash("a"), normalized_content_id: hash("b"),
  };
}

export function leg(side, strike, quantity, expiry = "261016", entry_phase) {
  return {
    provider_symbol: `SPXW  ${expiry}${side}${String(strike * 1000).padStart(8, "0")}`,
    action: quantity > 0 ? "BUY_TO_OPEN" : "SELL_TO_OPEN",
    ratio: Math.abs(quantity),
    expiration: `20${expiry.slice(0, 2)}-${expiry.slice(2, 4)}-${expiry.slice(4, 6)}`,
    settlement: "PM", multiplier: "100",
    ...(entry_phase ? { entry_phase } : {}),
  };
}

const condor = (putHigh = 5850, callLow = 6150, callHigh = 6200, reverse = false) => [
  leg("P", 5800, reverse ? -1 : 1), leg("P", putHigh, reverse ? 1 : -1),
  leg("C", callLow, reverse ? 1 : -1), leg("C", callHigh, reverse ? -1 : 1),
];

// Literal signed quantities are independent expectations, not derived from normalization.
export const families = [
  { family: "CDS", legs: [leg("C", 6000, 1), leg("C", 6050, -1)], quantities: [1, -1] },
  { family: "PDS", legs: [leg("P", 6000, 1), leg("P", 5950, -1)], quantities: [1, -1] },
  { family: "PCS", legs: [leg("P", 5950, 1), leg("P", 6000, -1)], quantities: [1, -1] },
  { family: "CCS", legs: [leg("C", 6050, 1), leg("C", 6000, -1)], quantities: [1, -1] },
  { family: "IC", legs: condor(), quantities: [1, -1, -1, 1] },
  { family: "AIC", legs: condor(5850, 6150, 6250), quantities: [1, -1, -1, 1] },
  {
    family: "SIC",
    legs: condor().map((item, index) => ({ ...item, entry_phase: index < 2 ? "FIRST" : "SECOND" })),
    quantities: [1, -1, -1, 1],
  },
  { family: "RIC", legs: condor(5850, 6150, 6200, true), quantities: [-1, 1, 1, -1] },
  {
    family: "DD",
    legs: [leg("P", 5850, -1), leg("P", 5800, 1, "261120"), leg("C", 6150, -1), leg("C", 6200, 1, "261120")],
    quantities: [-1, 1, -1, 1],
  },
  {
    family: "DC",
    legs: [leg("P", 5850, -1), leg("P", 5850, 1, "261120"), leg("C", 6150, -1), leg("C", 6150, 1, "261120")],
    quantities: [-1, 1, -1, 1],
  },
  {
    family: "Hybrid",
    legs: [leg("P", 5850, -1), leg("P", 5850, 1, "261120"), leg("C", 6150, -1), leg("C", 6200, 1, "261120")],
    quantities: [-1, 1, -1, 1],
  },
  { family: "CALL_CALENDAR", legs: [leg("C", 6000, -1), leg("C", 6000, 1, "261120")], quantities: [-1, 1] },
  { family: "PUT_CALENDAR", legs: [leg("P", 6000, -1), leg("P", 6000, 1, "261120")], quantities: [-1, 1] },
  { family: "LIB", legs: condor(6000, 6000, 6200, true), quantities: [-1, 1, 1, -1] },
  { family: "BWB", legs: [leg("P", 5800, 1), leg("P", 5850, -3), leg("P", 5950, 2)], quantities: [1, -3, 2] },
  { family: "SIB", legs: condor(6000, 6000, 6200), quantities: [1, -1, -1, 1] },
];

export function quote(item, index, observed_at = CHECKPOINT) {
  const source_timestamp = new Date(Date.parse(observed_at) - 1000).toISOString();
  return {
    provider_symbol: item.provider_symbol,
    bid: String(index + 1), ask: `${index + 1}.25`,
    bid_size: 30, ask_size: 30, quote_kind: "NBBO", quote_status: "NORMAL",
    price_semantics: "OPTION_PREMIUM_PER_UNIT",
    source_timestamp, available_at: source_timestamp, bar_end: null, retrieved_at: RETRIEVED,
    ...source(`quote-${index}`),
  };
}

export function fixture(family = "CDS") {
  const shape = families.find((item) => item.family === family);
  return {
    contract_version: "2.0.0",
    strategy: { strategy_id: `frozen-${family}`, family, underlying: "SPX", root: "SPXW" },
    selection: {
      selected_at: "2026-09-24T14:00:00.000Z",
      source_timestamp: "2026-09-24T13:59:00.000Z",
      available_at: "2026-09-24T13:59:01.000Z",
      retrieved_at: RETRIEVED, source: source("selection"),
    },
    quote_policy: { max_quote_age_ms: 2000, max_temporal_skew_ms: 500, require_sizes: true },
    legs: structuredClone(shape.legs),
    expected_observation_times: [CHECKPOINT],
    observations: [{ observed_at: CHECKPOINT, leg_quotes: shape.legs.map((item, index) => quote(item, index)) }],
  };
}

export function reference(overrides = {}) {
  return {
    ...source("reference"), evidence_type: "CANDLE_REFERENCE", signed_value: "-1.5",
    price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
    source_timestamp: "2026-09-24T13:58:00.000Z", available_at: "2026-09-24T13:59:00.000Z",
    retrieved_at: RETRIEVED, bar_end: "2026-09-24T13:59:00.000Z", model_version: null,
    ...overrides,
  };
}

export function entry(input, phase, time) {
  return {
    execution_id: `actual-${phase}`, phase,
    source_timestamp: time, available_at: time, retrieved_at: RETRIEVED, source: source(`fill-${phase}`),
    fills: input.legs.filter((item) => item.entry_phase === phase || (phase === "ENTRY" && !item.entry_phase)).map((item) => ({
      provider_symbol: item.provider_symbol, quantity: item.ratio,
      price: item.action === "BUY_TO_OPEN" ? "1" : "3",
    })),
  };
}
