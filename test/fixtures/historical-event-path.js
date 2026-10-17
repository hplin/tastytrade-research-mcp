import { fixture, quote, source } from "./historical-strategy-evidence.js";
import { historicalExecutionProfileHash, historicalFeeModelHash } from "../../dist/historical-execution-model.js";
import { historicalPathInventoryId } from "../../dist/historical-event-path.js";

export const ENTRY = "2026-09-24T14:30:00.000Z";
export const EXIT = "2026-09-24T15:30:00.000Z";
const RETRIEVED = "2026-12-01T12:00:00.000Z";
export function profile(model = "QUOTE_CROSS") {
  const body = {
    profile_id: "caller-frozen-fixture", profile_version: "1",
    model, quote_source: model === "REFERENCE_COST" ? null : "ALIGNED_LEG_QUOTES",
    reference_type: model === "REFERENCE_COST" ? "CANDLE_REFERENCE" : null,
    latency_ms: 0, minimum_package_size: 1, tick_size: "0.05",
    midpoint_to_adverse_fraction: model === "QUOTE_PRICE_IMPROVEMENT" ? "0.5" : null,
    additional_cost_per_package: "0", queue_model: "NOT_MODELED", market_impact_model: "NOT_MODELED", atomic_package: true,
  };
  return { ...body, profile_hash: historicalExecutionProfileHash(body) };
}
export function fee() {
  const body = { fee_model_id: "fixture-fees", fee_model_version: "1", scope: "PER_CONTRACT_PER_LEG_PER_SIDE", amount_per_contract_per_leg_side: "0.5" };
  return { ...body, fee_model_hash: historicalFeeModelHash(body) };
}
export function risk(leg, at = ENTRY, overrides = {}) {
  return {
    provider_symbol: leg.provider_symbol, source_timestamp: at, available_at: at, retrieved_at: RETRIEVED,
    source: source("fixture-risk"), implied_volatility: "0.2", delta: "0.4", gamma: "0.01",
    theta: "-1", vega: "0.5", rho: "0.1", evidence_kind: "OBSERVED_GREEKS", ...overrides,
  };
}
export function observation(legs, at = ENTRY) {
  return {
    observed_at: at, inventory_id: historicalPathInventoryId(legs.map((leg) => ({
      provider_symbol: leg.provider_symbol,
      inventory_quantity: (leg.action === "BUY_TO_OPEN" ? 1 : -1) * leg.ratio,
    }))),
    leg_quotes: legs.map((leg, i) => ({ ...quote(leg, i, at), retrieved_at: RETRIEVED })), risk: legs.map((leg) => risk(leg, at)),
  };
}
export function event(legs, at = ENTRY, side = "OPEN", id = "entry") {
  return {
    event_id: id, kind: side === "OPEN" ? "OPEN" : "CLOSE", evidence_kind: "BROKER_FILL",
    source_timestamp: at, available_at: at, retrieved_at: RETRIEVED, source: source(`fixture-${id}`),
    fills: legs.map((leg, i) => ({ fill_id: `${id}-${i}`, provider_symbol: leg.provider_symbol, side, quantity: leg.ratio, price: String(i + 1) })),
    instruction: null, simulation_observation: null,
  };
}
export function pathFixture(family = "CDS") {
  const legacy = fixture(family);
  const { observations: ignored, expected_observation_times: times, ...selection } = legacy;
  return {
    contract_version: "1.0.0", initial_inventory: "FLAT", selection, roll_legs: [],
    calendar: {
      calendar_id: "synthetic-authoritative-calendar", available_at: selection.selection.available_at, source: source("calendar"),
      sessions: ["2026-09-24", "2026-09-25", "2026-10-16", "2026-11-20"].map((date) => ({
        session_date: date, open_at: `${date}T13:30:00.000Z`, close_at: `${date}T20:00:00.000Z`,
      })),
    },
    settlements: selection.legs.map((leg) => ({ provider_symbol: leg.provider_symbol, settles_at: `${leg.expiration}T20:00:00.000Z` })),
    policy: { frozen_at: selection.selection.selected_at, execution_profile: profile(), fee_model: fee(), settlement_fees: "ZERO", instructions: [] },
    expected_checkpoints: [ENTRY, EXIT], observations: [observation(selection.legs)], events: [event(selection.legs)], page_size: 100,
  };
}
