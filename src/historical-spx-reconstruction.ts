import { createHash } from "node:crypto";
import { ExactDecimal } from "./decimal.js";
import type { ExecutionReferences } from "./execution-evidence.js";
import type {
  HistoricalCandle,
  HistoricalCandlesBatchInput,
  HistoricalCandlesInput,
  HistoricalCandlesResult,
} from "./historical-candles.js";
import type {
  HistoricalCandidateProvenance,
  HistoricalSpxCandidate,
  HistoricalSpxCandidatesPlan,
} from "./historical-spx-candidates.js";
import type { OptionSide } from "./spread-adapter.js";
import { normalizeRfc3339 } from "./time.js";

export type HistoricalCandidateCandles = {
  getHistoricalCandles(
    request: HistoricalCandlesInput,
  ): Promise<HistoricalCandlesResult>;
  getHistoricalCandlesBatch(
    request: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]>;
};

export type HistoricalSpxReconstruction = {
  candidates: Array<HistoricalSpxCandidate | null>;
  warnings: string[];
};

export type HistoricalSpxCandidateUniverseInput = {
  underlying: "SPX";
  as_of: string;
  min_dte?: number;
  max_dte?: number;
  strike_min: number;
  strike_max: number;
  strike_step?: number;
  option_sides?: OptionSide[];
  expirations?: string[];
  max_contracts?: number;
  max_observation_age_minutes?: number;
  phase: "REGRESSION_RESEARCH";
  references?: ExecutionReferences;
};

export type HistoricalSpxCandidateUniversePlan = {
  request_id: string;
  as_of: string;
  session_date: string;
  min_dte: number;
  max_dte: number;
  expiration_dates: string[];
  strike_min: number;
  strike_max: number;
  strike_step: number;
  strikes: number[];
  option_sides: OptionSide[];
  max_contracts: number;
  max_observation_age_minutes: number;
  requested_contract_count: number;
  references: ExecutionReferences;
};

export type HistoricalSpxUniverseContract = {
  provider_symbol: string;
  simulation_symbol: string;
  occ_symbol: string;
  underlying: "SPX";
  expiration: string;
  strike: string;
  option_side: OptionSide;
  dte_at_as_of: number;
  source_timestamp: string;
  historical_price: string;
  historical_delta: string | null;
  historical_iv: string | null;
  historical_open_interest: string | null;
  historical_volume: string | null;
  underlying_price: string;
  observation_age_ms: number;
  freshness: "FRESH" | "STALE";
  identity_source: "RECONSTRUCTED_OCC_VALIDATED_BY_DXLINK";
  confidence: "MEDIUM" | "LOW";
  provenance: HistoricalCandidateProvenance[];
  warnings: string[];
};

export type HistoricalSpxCandidateUniverseResult = {
  contract_version: "1.0.0";
  request_id: string;
  status: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE" | "PROVIDER_ERROR";
  evidence_type: "HISTORICAL_SPX_CANDIDATE_UNIVERSE";
  evidence_phase: "REGRESSION_RESEARCH";
  as_of: string;
  underlying: "SPX";
  requested_dte_range: { min: number; max: number };
  requested_strike_range: { min: string; max: string; step: string };
  expiration_dates: string[];
  option_sides: OptionSide[];
  underlying_price: string | null;
  max_observation_age_minutes: number;
  freshness_threshold_minutes: 60;
  contracts: HistoricalSpxUniverseContract[];
  coverage: {
    requested_contract_count: number;
    verified_contract_count: number;
    missing_contract_count: number;
    gaps: Array<{
      expiration: string;
      dte_at_as_of: number;
      option_side: OptionSide;
      requested_count: number;
      verified_count: number;
      missing_count: number;
      missing_strikes: string[];
      missing_strike_ranges: Array<{
        min: string;
        max: string;
        step: string;
      }>;
    }>;
    provider_errors: Array<{
      stage: "UNDERLYING" | "OPTION_BATCH";
      batch_index: number | null;
      symbols: string[];
      message: string;
    }>;
  };
  field_coverage: {
    historical_price: { available: number; missing: number };
    historical_delta: { available: number; missing: number };
    historical_iv: { available: number; missing: number };
    historical_open_interest: { available: number; missing: number };
    historical_volume: { available: number; missing: number };
  };
  capabilities: {
    historical_contract_universe_reconstructed: boolean;
    exact_provider_contract_identity: boolean;
    reconstructed_contract_identity: boolean;
    provider_returned_contract_identity: false;
    checkpoint_timestamp_safe: boolean;
    stale_pre_checkpoint_evidence_included: boolean;
    historical_price: boolean;
    historical_delta: boolean;
    historical_contract_iv: boolean;
    historical_open_interest: boolean;
    historical_volume: boolean;
    historical_bid_ask: false;
    full_historical_chain: false;
  };
  provenance: HistoricalCandidateProvenance[];
  references: ExecutionReferences;
  warnings: string[];
};

type ContractSpec = {
  option_side: OptionSide;
  expiration_date: string;
  expiration: string;
  dte: number;
  strike: number;
  occ_symbol: string;
  streamer_symbol: string;
};

type CandleObservation = {
  contract: ContractSpec;
  candle: HistoricalCandle;
  available_at: string;
  available_at_ms: number;
  age_ms: number;
  price: number;
  implied_volatility: number | null;
};

type DeltaForwardObservation = {
  value: number;
  source_timestamp: string;
};

type ForwardObservation = DeltaForwardObservation & {
  strike: number;
};

type UniverseDeltaForward = DeltaForwardObservation & {
  basis: "PUT_CALL_PARITY" | "SPOT_FORWARD_ZERO_CARRY";
};

const CANDLE_INTERVAL = "5m";
const CANDLE_INTERVAL_MS = 5 * 60_000;
const MAX_OBSERVATION_AGE_MS = 60 * 60_000;
const OPTION_BATCH_SIZE = 20;
const STRIKE_INCREMENT = 5;
const DELTA_STRIKE_RADIUS = 100;
const TARGET_STRIKE_RADIUS = 20;
const PARITY_STRIKE_RADIUS = 100;
const PARITY_STRIKE_INCREMENT = 25;
const DAY_MS = 86_400_000;
const DEFAULT_UNIVERSE_MIN_DTE = 21;
const DEFAULT_UNIVERSE_MAX_DTE = 35;
const DEFAULT_UNIVERSE_STRIKE_STEP = 25;
const DEFAULT_UNIVERSE_MAX_CONTRACTS = 500;
const MAX_UNIVERSE_CONTRACTS = 1_000;
const MAX_UNIVERSE_OBSERVATION_AGE_MINUTES = 1_440;

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDaysBetween(start: string, end: string): number {
  return Math.floor(
    (Date.parse(`${end}T00:00:00.000Z`) -
      Date.parse(`${start}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

function dateInTimezone(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function integerInRange(
  value: number | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function normalizeReferences(
  references: ExecutionReferences | undefined,
): ExecutionReferences {
  const normalized: ExecutionReferences = {};
  for (const field of [
    "checkpoint_id",
    "paper_order_id",
    "position_id",
  ] as const) {
    const value = references?.[field];
    if (value === undefined) continue;
    const text = value.trim();
    if (!text || text.length > 200) {
      throw new Error(`${field} must be 1-200 characters.`);
    }
    normalized[field] = text;
  }
  return normalized;
}

function normalizeOptionSides(sides: OptionSide[] | undefined): OptionSide[] {
  const values = sides ?? ["CALL", "PUT"];
  if (values.length === 0) throw new Error("option_sides must not be empty.");
  const normalized = [...new Set(values)];
  if (normalized.some((side) => side !== "CALL" && side !== "PUT")) {
    throw new Error("option_sides may contain only CALL and PUT.");
  }
  return normalized;
}

function stableRequestId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date.`);
  }
  return value;
}

function expirationDates(
  sessionDate: string,
  requestedDte: number,
  minDte: number,
  maxDte: number,
): string[] {
  const target = shiftDate(sessionDate, requestedDte);
  const targetDay = new Date(`${target}T00:00:00.000Z`).getUTCDay();
  const dates =
    targetDay >= 1 && targetDay <= 5
      ? [target]
      : [-1, 1, -2, 2, -3, 3]
          .map((offset) => shiftDate(target, offset))
          .filter((date) => {
            const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
            return day >= 1 && day <= 5;
          })
          .slice(0, 2);
  return dates.filter((date) => {
    const dte = calendarDaysBetween(sessionDate, date);
    return dte >= minDte && dte <= maxDte;
  });
}

function newYorkCloseTimestamp(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(Date.UTC(year, month - 1, day, 12)))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(timeZoneName ?? "");
  if (!match) {
    throw new Error(`Could not determine New York UTC offset for ${date}.`);
  }
  const direction = match[1] === "+" ? 1 : -1;
  const offsetMinutes =
    direction * (Number(match[2]) * 60 + Number(match[3]));
  return new Date(
    Date.UTC(year, month - 1, day, 16) - offsetMinutes * 60_000,
  ).toISOString();
}

function normalizedDecimal(value: string): string {
  return ExactDecimal.parse(value).toString();
}

function decimalNumber(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundedDecimal(value: number, digits = 8): string {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? "0" : rounded.toString();
}

function strikeText(strike: number): string {
  return roundedDecimal(strike, 3);
}

function occSymbol(
  expirationDate: string,
  optionSide: OptionSide,
  strike: number,
): string {
  const compactDate = expirationDate.slice(2).replaceAll("-", "");
  const scaledStrike = Math.round(strike * 1_000);
  if (scaledStrike < 0 || scaledStrike > 99_999_999) {
    throw new Error(`SPX strike is outside OCC symbol range: ${strike}.`);
  }
  return `${"SPXW".padEnd(6, " ")}${compactDate}${
    optionSide === "CALL" ? "C" : "P"
  }${scaledStrike.toString().padStart(8, "0")}`;
}

function streamerSymbol(
  expirationDate: string,
  optionSide: OptionSide,
  strike: number,
): string {
  const compactDate = expirationDate.slice(2).replaceAll("-", "");
  return `.SPXW${compactDate}${
    optionSide === "CALL" ? "C" : "P"
  }${strikeText(strike)}`;
}

function contractSpec(
  sessionDate: string,
  expirationDate: string,
  optionSide: OptionSide,
  strike: number,
): ContractSpec {
  return {
    option_side: optionSide,
    expiration_date: expirationDate,
    expiration: newYorkCloseTimestamp(expirationDate),
    dte: calendarDaysBetween(sessionDate, expirationDate),
    strike,
    occ_symbol: occSymbol(expirationDate, optionSide, strike),
    streamer_symbol: streamerSymbol(expirationDate, optionSide, strike),
  };
}

function normalCdf(value: number): number {
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp((-absolute * absolute) / 2);
  const tail =
    density *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const positive = 1 - tail;
  return value >= 0 ? positive : 1 - positive;
}

function inverseNormalCdf(probability: number): number {
  if (!(probability > 0 && probability < 1)) {
    throw new Error("Normal probability must be between zero and one.");
  }
  const a = [
    -39.69683028665376,
    220.9460984245205,
    -275.9285104469687,
    138.357751867269,
    -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406,
    161.5858368580409,
    -155.6989798598866,
    66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293,
    -0.3223964580411365,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    0.007784695709041462,
    0.3224671290700398,
    2.445134137142996,
    3.754408661907416,
  ];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (probability < lower) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (probability > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r +
      a[5]) *
    q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r +
      1)
  );
}

function strikeCenterForDelta(
  underlyingPrice: number,
  underlyingIv: number,
  targetDelta: number,
  optionSide: OptionSide,
  yearsToExpiration: number,
): number | null {
  const probability =
    optionSide === "CALL" ? targetDelta / 100 : 1 - targetDelta / 100;
  if (
    !(underlyingPrice > 0) ||
    !(underlyingIv > 0) ||
    !(yearsToExpiration > 0) ||
    !(probability > 0 && probability < 1)
  ) {
    return null;
  }
  const z = inverseNormalCdf(probability);
  const volatilityTime = underlyingIv * Math.sqrt(yearsToExpiration);
  const strike =
    underlyingPrice *
    Math.exp(
      0.5 * underlyingIv * underlyingIv * yearsToExpiration -
        z * volatilityTime,
    );
  return Math.round(strike / STRIKE_INCREMENT) * STRIKE_INCREMENT;
}

function addStrikeRange(
  strikes: Set<number>,
  center: number,
  radius: number,
  increment: number,
): void {
  const normalizedCenter = Math.round(center / increment) * increment;
  for (
    let strike = normalizedCenter - radius;
    strike <= normalizedCenter + radius;
    strike += increment
  ) {
    if (strike > 0) strikes.add(strike);
  }
}

function contractKey(contract: ContractSpec): string {
  return contract.occ_symbol;
}

function itemKey(
  item: HistoricalSpxCandidatesPlan["items"][number],
): string {
  return `${item.option_side}:${item.selector.method}:${item.selector.value}:${item.selector.days_until_expiration}`;
}

function completeObservation(
  contract: ContractSpec,
  result: HistoricalCandlesResult,
  asOfMs: number,
  maxObservationAgeMs = MAX_OBSERVATION_AGE_MS,
): CandleObservation | null {
  if (!result.snapshot_complete || result.snapshot_truncated) return null;
  const candidates = result.candles
    .map((candle) => {
      const sourceMs = Date.parse(candle.source_time);
      const availableAtMs = sourceMs + CANDLE_INTERVAL_MS;
      const price = decimalNumber(candle.close);
      if (
        !Number.isFinite(sourceMs) ||
        price === null ||
        price <= 0 ||
        availableAtMs > asOfMs ||
        asOfMs - availableAtMs > maxObservationAgeMs
      ) {
        return null;
      }
      return {
        contract,
        candle,
        available_at: new Date(availableAtMs).toISOString(),
        available_at_ms: availableAtMs,
        age_ms: asOfMs - availableAtMs,
        price,
        implied_volatility: decimalNumber(candle.implied_volatility),
      };
    })
    .filter((value): value is CandleObservation => value !== null)
    .sort((left, right) => right.available_at_ms - left.available_at_ms);
  return candidates[0] ?? null;
}

function forwardByExpiration(
  observations: Map<string, CandleObservation>,
  contracts: ContractSpec[],
  underlyingPrice: number,
): Map<string, ForwardObservation> {
  const result = new Map<string, ForwardObservation>();
  const expirations = [...new Set(contracts.map((item) => item.expiration_date))];
  for (const expirationDate of expirations) {
    const strikes = [
      ...new Set(
        contracts
          .filter((item) => item.expiration_date === expirationDate)
          .map((item) => item.strike),
      ),
    ];
    const pairs: Array<{
      forward: ForwardObservation;
      age_ms: number;
      distance: number;
    }> = [];
    for (const strike of strikes) {
      const call = contracts.find(
        (item) =>
          item.expiration_date === expirationDate &&
          item.option_side === "CALL" &&
          item.strike === strike,
      );
      const put = contracts.find(
        (item) =>
          item.expiration_date === expirationDate &&
          item.option_side === "PUT" &&
          item.strike === strike,
      );
      if (!call || !put) continue;
      const callObservation = observations.get(contractKey(call));
      const putObservation = observations.get(contractKey(put));
      if (
        !callObservation ||
        !putObservation ||
        callObservation.available_at !== putObservation.available_at
      ) {
        continue;
      }
      const value = strike + callObservation.price - putObservation.price;
      if (!(value > 0)) continue;
      pairs.push({
        forward: {
          value,
          source_timestamp: callObservation.available_at,
          strike,
        },
        age_ms: Math.max(callObservation.age_ms, putObservation.age_ms),
        distance: Math.abs(strike - underlyingPrice),
      });
    }
    pairs.sort(
      (left, right) =>
        left.age_ms - right.age_ms ||
        left.distance - right.distance ||
        left.forward.strike - right.forward.strike,
    );
    if (pairs[0]) result.set(expirationDate, pairs[0].forward);
  }
  return result;
}

function historicalDelta(
  observation: CandleObservation,
  forward: DeltaForwardObservation,
  asOfMs: number,
): number | null {
  const volatility = observation.implied_volatility;
  const expirationMs = Date.parse(observation.contract.expiration);
  const yearsToExpiration = (expirationMs - asOfMs) / (365 * DAY_MS);
  if (
    volatility === null ||
    !(volatility > 0) ||
    !(forward.value > 0) ||
    !(yearsToExpiration > 0)
  ) {
    return null;
  }
  const denominator = volatility * Math.sqrt(yearsToExpiration);
  const d1 =
    (Math.log(forward.value / observation.contract.strike) +
      0.5 * volatility * volatility * yearsToExpiration) /
    denominator;
  const callDelta = normalCdf(d1);
  return observation.contract.option_side === "CALL"
    ? callDelta * 100
    : (callDelta - 1) * 100;
}

function universeDeltaForward(
  parityForward: ForwardObservation | undefined,
  underlyingPrice: number,
  underlyingTimestamp: string,
): UniverseDeltaForward {
  if (parityForward) {
    return {
      ...parityForward,
      basis: "PUT_CALL_PARITY",
    };
  }
  return {
    value: underlyingPrice,
    source_timestamp: underlyingTimestamp,
    basis: "SPOT_FORWARD_ZERO_CARRY",
  };
}

function selectorScore(
  item: HistoricalSpxCandidatesPlan["items"][number],
  observation: CandleObservation,
  delta: number | null,
  underlyingPrice: number,
): number | null {
  const selectorValue = Number(item.selector.value);
  if (!Number.isFinite(selectorValue)) return null;
  if (item.selector.method === "DELTA") {
    return delta === null
      ? null
      : Math.abs(Math.abs(delta) - Math.abs(selectorValue));
  }
  if (item.selector.method === "PERCENTAGE_OTM") {
    const percentage =
      item.option_side === "CALL"
        ? observation.contract.strike / underlyingPrice - 1
        : 1 - observation.contract.strike / underlyingPrice;
    return Math.abs(percentage - selectorValue);
  }
  return null;
}

function buildCandidate(
  plan: HistoricalSpxCandidatesPlan,
  item: HistoricalSpxCandidatesPlan["items"][number],
  observation: CandleObservation,
  underlyingPriceText: string,
  underlyingTimestamp: string,
  delta: number | null,
  forward: ForwardObservation | undefined,
): HistoricalSpxCandidate {
  const optionFields = ["historical_price", "selected_historical_iv"];
  if (observation.candle.volume !== null) {
    optionFields.push("historical_volume");
  }
  if (observation.candle.open_interest !== null) {
    optionFields.push("historical_open_interest");
  }
  return {
    provider_symbol: observation.contract.occ_symbol,
    simulation_symbol: observation.contract.occ_symbol,
    occ_symbol: observation.contract.occ_symbol,
    underlying: "SPX",
    expiration: observation.contract.expiration,
    strike: strikeText(observation.contract.strike),
    option_side: observation.contract.option_side,
    selected_at: plan.as_of,
    requested_dte: item.selector.days_until_expiration,
    selected_dte: observation.contract.dte,
    dte_at_as_of: observation.contract.dte,
    selection_method: item.selector.method,
    selector_value: item.selector.value,
    backtester_fill_price: null,
    historical_price: normalizedDecimal(observation.candle.close),
    historical_price_effect: "DEBIT",
    selected_historical_delta:
      delta === null ? null : roundedDecimal(delta, 6),
    selected_historical_iv:
      observation.candle.implied_volatility === null
        ? null
        : normalizedDecimal(observation.candle.implied_volatility),
    historical_volume:
      observation.candle.volume === null
        ? null
        : normalizedDecimal(observation.candle.volume),
    historical_open_interest:
      observation.candle.open_interest === null
        ? null
        : normalizedDecimal(observation.candle.open_interest),
    underlying_price: underlyingPriceText,
    observation_age_ms: observation.age_ms,
    confidence: "MEDIUM",
    provenance: [
      {
        source: "tastytrade-research-mcp:request",
        source_timestamp: plan.as_of,
        fields: [
          "underlying",
          "requested_dte",
          "selection_method",
          "selector_value",
        ],
        documented_contract: true,
      },
      {
        source: "tastytrade-dxlink:SPX{=5m}",
        source_timestamp: underlyingTimestamp,
        fields: ["underlying_price"],
        documented_contract: true,
      },
      {
        source: `tastytrade-dxlink:${observation.contract.streamer_symbol}{=5m}`,
        source_timestamp: observation.available_at,
        fields: optionFields,
        documented_contract: true,
      },
      {
        source: "tastytrade-research-mcp:derived",
        source_timestamp: plan.as_of,
        fields: [
          "provider_symbol",
          "simulation_symbol",
          "occ_symbol",
          "expiration",
          "strike",
          "option_side",
          "selected_at",
          "selected_dte",
          "dte_at_as_of",
          "observation_age_ms",
          ...(delta === null ? [] : ["selected_historical_delta"]),
        ],
        documented_contract: true,
      },
      ...(forward
        ? [
            {
              source: "tastytrade-research-mcp:put-call-parity",
              source_timestamp: forward.source_timestamp,
              fields: ["selected_historical_delta"],
              documented_contract: true,
            },
          ]
        : []),
    ],
    warnings: [
      "CONTRACT_IDENTITY_RECONSTRUCTED_FROM_OCC_SYMBOLOGY",
      "CONTRACT_EXISTENCE_INFERRED_FROM_HISTORICAL_CANDLE",
      "HISTORICAL_OPTION_CANDLE_IS_TRADE_AGGREGATE",
      ...(observation.age_ms > 0
        ? ["OPTION_OBSERVATION_PRECEDES_CHECKPOINT"]
        : []),
      ...(delta !== null
        ? ["DELTA_DERIVED_FROM_CANDLE_IV_AND_PUT_CALL_PARITY_FORWARD"]
        : []),
    ],
  };
}

export async function reconstructHistoricalSpxCandidates(
  plan: HistoricalSpxCandidatesPlan,
  candles: HistoricalCandidateCandles,
): Promise<HistoricalSpxReconstruction> {
  const asOfMs = Date.parse(plan.as_of);
  const warnings = [
    "HISTORICAL_CONTRACT_UNIVERSE_RECONSTRUCTED_FROM_DXLINK",
    "OPTION_CANDLE_SOURCE_TIME_IS_INTERVAL_START",
    "CONTRACT_EXISTENCE_INFERRED_FROM_HISTORICAL_CANDLE",
    "OPTION_OBSERVATION_MAX_AGE_MINUTES:60",
  ];
  const candidates: Array<HistoricalSpxCandidate | null> = plan.items.map(
    () => null,
  );

  const underlyingResult = await candles.getHistoricalCandles({
    symbol: "SPX",
    streamer_symbol: "SPX",
    instrument_type: "INDEX",
    interval: CANDLE_INTERVAL,
    start_time: new Date(asOfMs - 2 * CANDLE_INTERVAL_MS).toISOString(),
    end_time: plan.as_of,
    session: { kind: "ALL", timezone: "UTC" },
    max_candles: 20_000,
  });
  const underlyingContract = contractSpec(
    plan.session_date,
    shiftDate(plan.session_date, plan.min_dte),
    "CALL",
    1,
  );
  const underlying = completeObservation(
    underlyingContract,
    underlyingResult,
    asOfMs,
  );
  if (!underlying) {
    warnings.push("NO_COMPLETE_SPX_CANDLE_AT_OR_BEFORE_AS_OF");
    for (const item of plan.items) {
      warnings.push(`${itemKey(item)}:NO_TIMESTAMP_SAFE_RECONSTRUCTED_CANDIDATE`);
    }
    return { candidates, warnings };
  }

  const underlyingPrice = underlying.price;
  const underlyingPriceText = normalizedDecimal(underlying.candle.close);
  const underlyingIv = underlying.implied_volatility;
  const supportedItems = new Set<number>();
  const eligibleContracts = plan.items.map(() => new Set<string>());
  const contractsByKey = new Map<string, ContractSpec>();

  for (const [index, item] of plan.items.entries()) {
    if (
      item.selector.method !== "DELTA" &&
      item.selector.method !== "PERCENTAGE_OTM"
    ) {
      warnings.push(
        `${itemKey(item)}:SELECTOR_METHOD_NOT_SUPPORTED_BY_RECONSTRUCTION`,
      );
      continue;
    }
    const dates = expirationDates(
      plan.session_date,
      item.selector.days_until_expiration,
      plan.min_dte,
      plan.max_dte,
    );
    for (const expirationDate of dates) {
      const strikes = new Set<number>();
      if (item.selector.method === "PERCENTAGE_OTM") {
        const percentage = Number(item.selector.value);
        const target =
          item.option_side === "CALL"
            ? underlyingPrice * (1 + percentage)
            : underlyingPrice * (1 - percentage);
        addStrikeRange(
          strikes,
          target,
          TARGET_STRIKE_RADIUS,
          STRIKE_INCREMENT,
        );
      } else if (underlyingIv !== null) {
        const expiration = newYorkCloseTimestamp(expirationDate);
        const yearsToExpiration =
          (Date.parse(expiration) - asOfMs) / (365 * DAY_MS);
        const center = strikeCenterForDelta(
          underlyingPrice,
          underlyingIv,
          Number(item.selector.value),
          item.option_side,
          yearsToExpiration,
        );
        if (center !== null) {
          addStrikeRange(
            strikes,
            center,
            DELTA_STRIKE_RADIUS,
            STRIKE_INCREMENT,
          );
        }
      }
      for (const strike of strikes) {
        const contract = contractSpec(
          plan.session_date,
          expirationDate,
          item.option_side,
          strike,
        );
        const key = contractKey(contract);
        contractsByKey.set(key, contract);
        eligibleContracts[index].add(key);
      }
      if (strikes.size > 0) supportedItems.add(index);

      const parityStrikes = new Set<number>();
      addStrikeRange(
        parityStrikes,
        underlyingPrice,
        PARITY_STRIKE_RADIUS,
        PARITY_STRIKE_INCREMENT,
      );
      for (const strike of parityStrikes) {
        for (const optionSide of ["CALL", "PUT"] as const) {
          const contract = contractSpec(
            plan.session_date,
            expirationDate,
            optionSide,
            strike,
          );
          contractsByKey.set(contractKey(contract), contract);
        }
      }
    }
  }

  const contracts = [...contractsByKey.values()];
  const observations = new Map<string, CandleObservation>();
  const optionStart = new Date(
    asOfMs - MAX_OBSERVATION_AGE_MS - CANDLE_INTERVAL_MS,
  ).toISOString();
  for (let offset = 0; offset < contracts.length; offset += OPTION_BATCH_SIZE) {
    const batch = contracts.slice(offset, offset + OPTION_BATCH_SIZE);
    const results = await candles.getHistoricalCandlesBatch({
      instruments: batch.map((contract) => ({
        symbol: contract.occ_symbol,
        streamer_symbol: contract.streamer_symbol,
        instrument_type: "OPTION",
      })),
      interval: CANDLE_INTERVAL,
      start_time: optionStart,
      end_time: plan.as_of,
      session: { kind: "ALL", timezone: "UTC" },
      max_candles: 20_000,
    });
    if (results.length !== batch.length) {
      throw new Error(
        `DXLink option batch returned ${results.length} results for ${batch.length} contracts.`,
      );
    }
    for (const [index, result] of results.entries()) {
      const observation = completeObservation(batch[index], result, asOfMs);
      if (observation) {
        observations.set(contractKey(batch[index]), observation);
      }
    }
  }

  const forwards = forwardByExpiration(
    observations,
    contracts,
    underlyingPrice,
  );
  if (forwards.size > 0) {
    warnings.push(
      "DELTA_DERIVED_FROM_CANDLE_IV_AND_PUT_CALL_PARITY_FORWARD",
      "PUT_CALL_PARITY_FORWARD_OMITS_DISCOUNT_FACTOR",
    );
  }

  for (const [index, item] of plan.items.entries()) {
    if (!supportedItems.has(index)) {
      warnings.push(`${itemKey(item)}:NO_TIMESTAMP_SAFE_RECONSTRUCTED_CANDIDATE`);
      continue;
    }
    const ranked = contracts
      .filter(
        (contract) =>
          eligibleContracts[index].has(contractKey(contract)) &&
          contract.option_side === item.option_side &&
          contract.dte >= plan.min_dte &&
          contract.dte <= plan.max_dte,
      )
      .map((contract) => {
        const observation = observations.get(contractKey(contract));
        if (!observation) return null;
        const forward = forwards.get(contract.expiration_date);
        const delta = forward
          ? historicalDelta(observation, forward, asOfMs)
          : null;
        const score = selectorScore(
          item,
          observation,
          delta,
          underlyingPrice,
        );
        if (score === null) return null;
        return {
          observation,
          forward,
          delta,
          score,
          dte_distance: Math.abs(
            contract.dte - item.selector.days_until_expiration,
          ),
        };
      })
      .filter(
        (
          value,
        ): value is {
          observation: CandleObservation;
          forward: ForwardObservation | undefined;
          delta: number | null;
          score: number;
          dte_distance: number;
        } => value !== null,
      )
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.observation.age_ms - right.observation.age_ms ||
          left.dte_distance - right.dte_distance ||
          left.observation.contract.strike -
            right.observation.contract.strike,
      );
    const selected = ranked[0];
    if (!selected) {
      warnings.push(`${itemKey(item)}:NO_TIMESTAMP_SAFE_RECONSTRUCTED_CANDIDATE`);
      continue;
    }
    candidates[index] = buildCandidate(
      plan,
      item,
      selected.observation,
      underlyingPriceText,
      underlying.available_at,
      selected.delta,
      selected.forward,
    );
  }

  return { candidates, warnings };
}

export function prepareHistoricalSpxCandidateUniverse(
  input: HistoricalSpxCandidateUniverseInput,
): HistoricalSpxCandidateUniversePlan {
  if (input.underlying !== "SPX") {
    throw new Error("Historical candidate universe currently supports SPX.");
  }
  if (input.phase !== "REGRESSION_RESEARCH") {
    throw new Error("phase must be REGRESSION_RESEARCH.");
  }

  const asOf = normalizeRfc3339(input.as_of, "as_of");
  const minDte = integerInRange(
    input.min_dte,
    DEFAULT_UNIVERSE_MIN_DTE,
    "min_dte",
    1,
    365,
  );
  const maxDte = integerInRange(
    input.max_dte,
    DEFAULT_UNIVERSE_MAX_DTE,
    "max_dte",
    1,
    365,
  );
  if (maxDte < minDte) throw new Error("max_dte must be >= min_dte.");
  const strikeMin = integerInRange(
    input.strike_min,
    0,
    "strike_min",
    1,
    100_000,
  );
  const strikeMax = integerInRange(
    input.strike_max,
    0,
    "strike_max",
    1,
    100_000,
  );
  if (strikeMax < strikeMin) {
    throw new Error("strike_max must be >= strike_min.");
  }
  const strikeStep = integerInRange(
    input.strike_step,
    DEFAULT_UNIVERSE_STRIKE_STEP,
    "strike_step",
    1,
    1_000,
  );
  const maxContracts = integerInRange(
    input.max_contracts,
    DEFAULT_UNIVERSE_MAX_CONTRACTS,
    "max_contracts",
    1,
    MAX_UNIVERSE_CONTRACTS,
  );
  const maxObservationAgeMinutes = integerInRange(
    input.max_observation_age_minutes,
    MAX_OBSERVATION_AGE_MS / 60_000,
    "max_observation_age_minutes",
    5,
    MAX_UNIVERSE_OBSERVATION_AGE_MINUTES,
  );
  const optionSides = normalizeOptionSides(input.option_sides);
  const sessionDate = dateInTimezone(asOf, "America/New_York");

  let expirationDatesValue: string[];
  if (input.expirations !== undefined) {
    if (
      !Array.isArray(input.expirations) ||
      input.expirations.length < 1 ||
      input.expirations.length > 20
    ) {
      throw new Error("expirations must contain between 1 and 20 dates.");
    }
    expirationDatesValue = [
      ...new Set(
        input.expirations.map((value, index) =>
          normalizedDate(value, `expirations[${index}]`),
        ),
      ),
    ];
    for (const expirationDate of expirationDatesValue) {
      const dte = calendarDaysBetween(sessionDate, expirationDate);
      if (dte < minDte || dte > maxDte) {
        throw new Error(
          `expiration ${expirationDate} is outside the requested DTE range.`,
        );
      }
    }
    expirationDatesValue.sort();
  } else {
    const midpointDte = Math.floor((minDte + maxDte) / 2);
    expirationDatesValue = [
      ...new Set(
        [minDte, midpointDte, maxDte].flatMap((dte) =>
          expirationDates(sessionDate, dte, minDte, maxDte),
        ),
      ),
    ].sort();
  }
  if (expirationDatesValue.length === 0) {
    throw new Error("No eligible expiration dates exist in the DTE range.");
  }

  const strikes: number[] = [];
  const firstStrike = Math.ceil(strikeMin / strikeStep) * strikeStep;
  for (
    let strike = firstStrike;
    strike <= strikeMax;
    strike += strikeStep
  ) {
    strikes.push(strike);
  }
  if (strikes.length === 0) {
    throw new Error("The strike range does not contain an aligned strike.");
  }
  const requestedContractCount =
    strikes.length * expirationDatesValue.length * optionSides.length;
  if (requestedContractCount > maxContracts) {
    throw new Error(
      `requested universe contains ${requestedContractCount} contracts, exceeding max_contracts=${maxContracts}.`,
    );
  }
  const references = normalizeReferences(input.references);
  const requestIdentity = {
    underlying: "SPX",
    as_of: asOf,
    min_dte: minDte,
    max_dte: maxDte,
    expiration_dates: expirationDatesValue,
    strike_min: strikeMin,
    strike_max: strikeMax,
    strike_step: strikeStep,
    option_sides: optionSides,
    max_contracts: maxContracts,
    max_observation_age_minutes: maxObservationAgeMinutes,
    references,
  };
  return {
    request_id: stableRequestId(requestIdentity),
    as_of: asOf,
    session_date: sessionDate,
    min_dte: minDte,
    max_dte: maxDte,
    expiration_dates: expirationDatesValue,
    strike_min: strikeMin,
    strike_max: strikeMax,
    strike_step: strikeStep,
    strikes,
    option_sides: optionSides,
    max_contracts: maxContracts,
    max_observation_age_minutes: maxObservationAgeMinutes,
    requested_contract_count: requestedContractCount,
    references,
  };
}

function universeContract(
  plan: HistoricalSpxCandidateUniversePlan,
  observation: CandleObservation,
  underlyingPrice: string,
  underlyingTimestamp: string,
  forward: UniverseDeltaForward,
  asOfMs: number,
): HistoricalSpxUniverseContract {
  const delta = historicalDelta(observation, forward, asOfMs);
  const stale = observation.age_ms > MAX_OBSERVATION_AGE_MS;
  const optionFields = ["historical_price", "source_timestamp"];
  if (observation.candle.implied_volatility !== null) {
    optionFields.push("historical_iv");
  }
  if (observation.candle.open_interest !== null) {
    optionFields.push("historical_open_interest");
  }
  if (observation.candle.volume !== null) {
    optionFields.push("historical_volume");
  }
  return {
    provider_symbol: observation.contract.occ_symbol,
    simulation_symbol: observation.contract.occ_symbol,
    occ_symbol: observation.contract.occ_symbol,
    underlying: "SPX",
    expiration: observation.contract.expiration,
    strike: strikeText(observation.contract.strike),
    option_side: observation.contract.option_side,
    dte_at_as_of: observation.contract.dte,
    source_timestamp: observation.available_at,
    historical_price: normalizedDecimal(observation.candle.close),
    historical_delta:
      delta === null ? null : roundedDecimal(delta, 6),
    historical_iv:
      observation.candle.implied_volatility === null
        ? null
        : normalizedDecimal(observation.candle.implied_volatility),
    historical_open_interest:
      observation.candle.open_interest === null
        ? null
        : normalizedDecimal(observation.candle.open_interest),
    historical_volume:
      observation.candle.volume === null
        ? null
        : normalizedDecimal(observation.candle.volume),
    underlying_price: underlyingPrice,
    observation_age_ms: observation.age_ms,
    freshness: stale ? "STALE" : "FRESH",
    identity_source: "RECONSTRUCTED_OCC_VALIDATED_BY_DXLINK",
    confidence: stale ? "LOW" : "MEDIUM",
    provenance: [
      {
        source: "tastytrade-research-mcp:request",
        source_timestamp: plan.as_of,
        fields: [
          "underlying",
          "expiration",
          "strike",
          "option_side",
        ],
        documented_contract: true,
      },
      {
        source: "tastytrade-dxlink:SPX{=5m}",
        source_timestamp: underlyingTimestamp,
        fields: ["underlying_price"],
        documented_contract: true,
      },
      {
        source: `tastytrade-dxlink:${observation.contract.streamer_symbol}{=5m}`,
        source_timestamp: observation.available_at,
        fields: optionFields,
        documented_contract: true,
      },
      {
        source: "tastytrade-research-mcp:derived",
        source_timestamp: plan.as_of,
        fields: [
          "provider_symbol",
          "simulation_symbol",
          "occ_symbol",
          "dte_at_as_of",
          "identity_source",
          "observation_age_ms",
          ...(delta === null ? [] : ["historical_delta"]),
        ],
        documented_contract: true,
      },
      ...(delta !== null
        ? [
            {
              source:
                forward.basis === "PUT_CALL_PARITY"
                  ? "tastytrade-research-mcp:put-call-parity"
                  : "tastytrade-research-mcp:spot-forward-zero-carry",
              source_timestamp: forward.source_timestamp,
              fields: ["historical_delta"],
              documented_contract: true,
            },
          ]
        : []),
    ],
    warnings: [
      "CONTRACT_IDENTITY_RECONSTRUCTED_FROM_OCC_SYMBOLOGY",
      "CONTRACT_EXISTENCE_INFERRED_FROM_HISTORICAL_CANDLE",
      "HISTORICAL_OPTION_CANDLE_IS_TRADE_AGGREGATE",
      ...(observation.age_ms > 0
        ? ["OPTION_OBSERVATION_PRECEDES_CHECKPOINT"]
        : []),
      ...(stale ? ["STALE_PRE_CHECKPOINT_OBSERVATION"] : []),
      ...(delta !== null
        ? forward.basis === "PUT_CALL_PARITY"
          ? ["DELTA_DERIVED_FROM_CANDLE_IV_AND_PUT_CALL_PARITY_FORWARD"]
          : [
              "DELTA_DERIVED_FROM_CANDLE_IV_AND_SPOT_FORWARD_APPROXIMATION",
              "SPOT_FORWARD_APPROXIMATION_ASSUMES_ZERO_CARRY",
            ]
        : []),
    ],
  };
}

type UniverseProviderError =
  HistoricalSpxCandidateUniverseResult["coverage"]["provider_errors"][number];

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

function missingStrikeRanges(
  missing: number[],
  step: number,
): Array<{ min: string; max: string; step: string }> {
  if (missing.length === 0) return [];
  const ranges: Array<{ min: string; max: string; step: string }> = [];
  let start = missing[0];
  let end = missing[0];
  for (const strike of missing.slice(1)) {
    if (strike === end + step) {
      end = strike;
      continue;
    }
    ranges.push({
      min: strikeText(start),
      max: strikeText(end),
      step: strikeText(step),
    });
    start = strike;
    end = strike;
  }
  ranges.push({
    min: strikeText(start),
    max: strikeText(end),
    step: strikeText(step),
  });
  return ranges;
}

function universeCoverageGaps(
  plan: HistoricalSpxCandidateUniversePlan,
  contracts: HistoricalSpxUniverseContract[],
): HistoricalSpxCandidateUniverseResult["coverage"]["gaps"] {
  const gaps: HistoricalSpxCandidateUniverseResult["coverage"]["gaps"] = [];
  for (const expirationDate of plan.expiration_dates) {
    const expiration = newYorkCloseTimestamp(expirationDate);
    for (const optionSide of plan.option_sides) {
      const verified = new Set(
        contracts
          .filter(
            (contract) =>
              contract.expiration === expiration &&
              contract.option_side === optionSide,
          )
          .map((contract) => Number(contract.strike)),
      );
      const missing = plan.strikes.filter((strike) => !verified.has(strike));
      if (missing.length === 0) continue;
      gaps.push({
        expiration,
        dte_at_as_of: calendarDaysBetween(
          plan.session_date,
          expirationDate,
        ),
        option_side: optionSide,
        requested_count: plan.strikes.length,
        verified_count: verified.size,
        missing_count: missing.length,
        missing_strikes: missing.map(strikeText),
        missing_strike_ranges: missingStrikeRanges(
          missing,
          plan.strike_step,
        ),
      });
    }
  }
  return gaps;
}

function universeFieldCoverage(
  contracts: HistoricalSpxUniverseContract[],
): HistoricalSpxCandidateUniverseResult["field_coverage"] {
  const coverage = (
    available: number,
  ): { available: number; missing: number } => ({
    available,
    missing: contracts.length - available,
  });
  return {
    historical_price: coverage(contracts.length),
    historical_delta: coverage(
      contracts.filter((contract) => contract.historical_delta !== null)
        .length,
    ),
    historical_iv: coverage(
      contracts.filter((contract) => contract.historical_iv !== null).length,
    ),
    historical_open_interest: coverage(
      contracts.filter(
        (contract) => contract.historical_open_interest !== null,
      ).length,
    ),
    historical_volume: coverage(
      contracts.filter((contract) => contract.historical_volume !== null)
        .length,
    ),
  };
}

function emptyUniverseResult(
  plan: HistoricalSpxCandidateUniversePlan,
  status: "NOT_AVAILABLE" | "PROVIDER_ERROR",
  warnings: string[],
  providerErrors: UniverseProviderError[],
): HistoricalSpxCandidateUniverseResult {
  return {
    contract_version: "1.0.0",
    request_id: plan.request_id,
    status,
    evidence_type: "HISTORICAL_SPX_CANDIDATE_UNIVERSE",
    evidence_phase: "REGRESSION_RESEARCH",
    as_of: plan.as_of,
    underlying: "SPX",
    requested_dte_range: { min: plan.min_dte, max: plan.max_dte },
    requested_strike_range: {
      min: strikeText(plan.strike_min),
      max: strikeText(plan.strike_max),
      step: strikeText(plan.strike_step),
    },
    expiration_dates: plan.expiration_dates,
    option_sides: plan.option_sides,
    underlying_price: null,
    max_observation_age_minutes: plan.max_observation_age_minutes,
    freshness_threshold_minutes: 60,
    contracts: [],
    coverage: {
      requested_contract_count: plan.requested_contract_count,
      verified_contract_count: 0,
      missing_contract_count: plan.requested_contract_count,
      gaps: universeCoverageGaps(plan, []),
      provider_errors: providerErrors,
    },
    field_coverage: universeFieldCoverage([]),
    capabilities: {
      historical_contract_universe_reconstructed: true,
      exact_provider_contract_identity: false,
      reconstructed_contract_identity: false,
      provider_returned_contract_identity: false,
      checkpoint_timestamp_safe: true,
      stale_pre_checkpoint_evidence_included: false,
      historical_price: false,
      historical_delta: false,
      historical_contract_iv: false,
      historical_open_interest: false,
      historical_volume: false,
      historical_bid_ask: false,
      full_historical_chain: false,
    },
    provenance: [],
    references: plan.references,
    warnings,
  };
}

export async function getHistoricalSpxCandidateUniverse(
  candles: HistoricalCandidateCandles,
  input: HistoricalSpxCandidateUniverseInput,
): Promise<HistoricalSpxCandidateUniverseResult> {
  const plan = prepareHistoricalSpxCandidateUniverse(input);
  const asOfMs = Date.parse(plan.as_of);
  const warnings = [
    "HISTORICAL_CONTRACT_UNIVERSE_RECONSTRUCTED_FROM_DXLINK",
    "HISTORICAL_CONTRACT_UNIVERSE_IS_BOUNDED_NOT_FULL_CHAIN",
    "OPTION_CANDLE_SOURCE_TIME_IS_INTERVAL_START",
    `OPTION_OBSERVATION_MAX_AGE_MINUTES:${plan.max_observation_age_minutes}`,
    "HISTORICAL_BID_ASK_NOT_AVAILABLE",
  ];
  const providerErrors: UniverseProviderError[] = [];

  let underlyingResult: HistoricalCandlesResult;
  try {
    underlyingResult = await candles.getHistoricalCandles({
      symbol: "SPX",
      streamer_symbol: "SPX",
      instrument_type: "INDEX",
      interval: CANDLE_INTERVAL,
      start_time: new Date(asOfMs - 2 * CANDLE_INTERVAL_MS).toISOString(),
      end_time: plan.as_of,
      session: { kind: "ALL", timezone: "UTC" },
      max_candles: 20_000,
    });
  } catch (error) {
    const message = errorMessage(error);
    providerErrors.push({
      stage: "UNDERLYING",
      batch_index: null,
      symbols: ["SPX"],
      message,
    });
    return emptyUniverseResult(
      plan,
      "PROVIDER_ERROR",
      [...warnings, `UNDERLYING_PROVIDER_ERROR:${message}`],
      providerErrors,
    );
  }
  const underlyingContract = contractSpec(
    plan.session_date,
    plan.expiration_dates[0],
    "CALL",
    1,
  );
  const underlying = completeObservation(
    underlyingContract,
    underlyingResult,
    asOfMs,
  );
  if (!underlying) {
    return emptyUniverseResult(
      plan,
      "NOT_AVAILABLE",
      [...warnings, "NO_COMPLETE_SPX_CANDLE_AT_OR_BEFORE_AS_OF"],
      providerErrors,
    );
  }

  const requestedContracts = plan.expiration_dates.flatMap((expirationDate) =>
    plan.option_sides.flatMap((optionSide) =>
      plan.strikes.map((strike) =>
        contractSpec(
          plan.session_date,
          expirationDate,
          optionSide,
          strike,
        ),
      ),
    ),
  );
  const contractsByKey = new Map(
    requestedContracts.map((contract) => [contractKey(contract), contract]),
  );
  for (const expirationDate of plan.expiration_dates) {
    const parityStrikes = new Set<number>();
    addStrikeRange(
      parityStrikes,
      underlying.price,
      PARITY_STRIKE_RADIUS,
      PARITY_STRIKE_INCREMENT,
    );
    for (const strike of parityStrikes) {
      for (const optionSide of ["CALL", "PUT"] as const) {
        const contract = contractSpec(
          plan.session_date,
          expirationDate,
          optionSide,
          strike,
        );
        contractsByKey.set(contractKey(contract), contract);
      }
    }
  }

  const fetchContracts = [...contractsByKey.values()];
  const observations = new Map<string, CandleObservation>();
  const optionStart = new Date(
    asOfMs -
      plan.max_observation_age_minutes * 60_000 -
      CANDLE_INTERVAL_MS,
  ).toISOString();
  for (
    let offset = 0;
    offset < fetchContracts.length;
    offset += OPTION_BATCH_SIZE
  ) {
    const batch = fetchContracts.slice(offset, offset + OPTION_BATCH_SIZE);
    let results: HistoricalCandlesResult[];
    try {
      results = await candles.getHistoricalCandlesBatch({
        instruments: batch.map((contract) => ({
          symbol: contract.occ_symbol,
          streamer_symbol: contract.streamer_symbol,
          instrument_type: "OPTION",
        })),
        interval: CANDLE_INTERVAL,
        start_time: optionStart,
        end_time: plan.as_of,
        session: { kind: "ALL", timezone: "UTC" },
        max_candles: 20_000,
      });
      if (results.length !== batch.length) {
        throw new Error(
          `DXLink option batch returned ${results.length} results for ${batch.length} contracts.`,
        );
      }
    } catch (error) {
      providerErrors.push({
        stage: "OPTION_BATCH",
        batch_index: offset / OPTION_BATCH_SIZE,
        symbols: batch.map((contract) => contract.occ_symbol),
        message: errorMessage(error),
      });
      continue;
    }
    for (const [index, result] of results.entries()) {
      const observation = completeObservation(
        batch[index],
        result,
        asOfMs,
        plan.max_observation_age_minutes * 60_000,
      );
      if (observation) {
        observations.set(contractKey(batch[index]), observation);
      }
    }
  }

  const forwards = forwardByExpiration(
    observations,
    fetchContracts,
    underlying.price,
  );
  const underlyingPrice = normalizedDecimal(underlying.candle.close);
  const contracts = requestedContracts
    .map((contract) => {
      const observation = observations.get(contractKey(contract));
      if (!observation) return null;
      return universeContract(
        plan,
        observation,
        underlyingPrice,
        underlying.available_at,
        universeDeltaForward(
          forwards.get(contract.expiration_date),
          underlying.price,
          underlying.available_at,
        ),
        asOfMs,
      );
    })
    .filter(
      (contract): contract is HistoricalSpxUniverseContract =>
        contract !== null,
    )
    .sort(
      (left, right) =>
        Date.parse(left.expiration) - Date.parse(right.expiration) ||
        left.option_side.localeCompare(right.option_side) ||
        Number(left.strike) - Number(right.strike),
    );
  if (
    contracts.some((contract) =>
      contract.warnings.includes(
        "DELTA_DERIVED_FROM_CANDLE_IV_AND_PUT_CALL_PARITY_FORWARD",
      ),
    )
  ) {
    warnings.push(
      "DELTA_DERIVED_FROM_CANDLE_IV_AND_PUT_CALL_PARITY_FORWARD",
      "PUT_CALL_PARITY_FORWARD_OMITS_DISCOUNT_FACTOR",
    );
  }
  if (
    contracts.some((contract) =>
      contract.warnings.includes(
        "DELTA_DERIVED_FROM_CANDLE_IV_AND_SPOT_FORWARD_APPROXIMATION",
      ),
    )
  ) {
    warnings.push(
      "DELTA_DERIVED_FROM_CANDLE_IV_AND_SPOT_FORWARD_APPROXIMATION",
      "SPOT_FORWARD_APPROXIMATION_ASSUMES_ZERO_CARRY",
    );
  }
  const verifiedContractCount = contracts.length;
  const missingContractCount =
    plan.requested_contract_count - verifiedContractCount;
  if (missingContractCount > 0) {
    warnings.push(`TIMESTAMP_SAFE_CONTRACTS_MISSING:${missingContractCount}`);
  }
  if (contracts.some((contract) => contract.historical_delta === null)) {
    warnings.push("HISTORICAL_DELTA_PARTIALLY_AVAILABLE");
  }
  if (contracts.some((contract) => contract.freshness === "STALE")) {
    warnings.push("STALE_PRE_CHECKPOINT_EVIDENCE_INCLUDED");
  }
  if (providerErrors.length > 0) {
    warnings.push(`OPTION_BATCH_PROVIDER_ERRORS:${providerErrors.length}`);
  }
  const gaps = universeCoverageGaps(plan, contracts);
  const fieldCoverage = universeFieldCoverage(contracts);
  const status =
    verifiedContractCount === 0
      ? providerErrors.length > 0
        ? "PROVIDER_ERROR"
        : "NOT_AVAILABLE"
      : missingContractCount === 0
        ? "COMPLETE"
        : "PARTIAL";
  return {
    contract_version: "1.0.0",
    request_id: plan.request_id,
    status,
    evidence_type: "HISTORICAL_SPX_CANDIDATE_UNIVERSE",
    evidence_phase: "REGRESSION_RESEARCH",
    as_of: plan.as_of,
    underlying: "SPX",
    requested_dte_range: { min: plan.min_dte, max: plan.max_dte },
    requested_strike_range: {
      min: strikeText(plan.strike_min),
      max: strikeText(plan.strike_max),
      step: strikeText(plan.strike_step),
    },
    expiration_dates: plan.expiration_dates,
    option_sides: plan.option_sides,
    underlying_price: underlyingPrice,
    max_observation_age_minutes: plan.max_observation_age_minutes,
    freshness_threshold_minutes: 60,
    contracts,
    coverage: {
      requested_contract_count: plan.requested_contract_count,
      verified_contract_count: verifiedContractCount,
      missing_contract_count: missingContractCount,
      gaps,
      provider_errors: providerErrors,
    },
    field_coverage: fieldCoverage,
    capabilities: {
      historical_contract_universe_reconstructed: true,
      exact_provider_contract_identity: verifiedContractCount > 0,
      reconstructed_contract_identity: verifiedContractCount > 0,
      provider_returned_contract_identity: false,
      checkpoint_timestamp_safe: true,
      stale_pre_checkpoint_evidence_included: contracts.some(
        (contract) => contract.freshness === "STALE",
      ),
      historical_price: verifiedContractCount > 0,
      historical_delta:
        verifiedContractCount > 0 &&
        fieldCoverage.historical_delta.missing === 0,
      historical_contract_iv:
        verifiedContractCount > 0 &&
        fieldCoverage.historical_iv.missing === 0,
      historical_open_interest:
        verifiedContractCount > 0 &&
        fieldCoverage.historical_open_interest.missing === 0,
      historical_volume:
        verifiedContractCount > 0 &&
        fieldCoverage.historical_volume.missing === 0,
      historical_bid_ask: false,
      full_historical_chain: false,
    },
    provenance: [
      {
        source: "tastytrade-research-mcp:request",
        source_timestamp: plan.as_of,
        fields: [
          "requested_dte_range",
          "requested_strike_range",
          "expiration_dates",
          "option_sides",
        ],
        documented_contract: true,
      },
      {
        source: "tastytrade-dxlink:SPX{=5m}",
        source_timestamp: underlying.available_at,
        fields: ["underlying_price"],
        documented_contract: true,
      },
    ],
    references: plan.references,
    warnings,
  };
}
