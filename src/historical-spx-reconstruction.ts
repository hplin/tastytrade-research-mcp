import { ExactDecimal } from "./decimal.js";
import type {
  HistoricalCandle,
  HistoricalCandlesBatchInput,
  HistoricalCandlesInput,
  HistoricalCandlesResult,
} from "./historical-candles.js";
import type {
  HistoricalSpxCandidate,
  HistoricalSpxCandidatesPlan,
} from "./historical-spx-candidates.js";
import type { OptionSide } from "./spread-adapter.js";

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

type ForwardObservation = {
  value: number;
  source_timestamp: string;
  strike: number;
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
        asOfMs - availableAtMs > MAX_OBSERVATION_AGE_MS
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
  forward: ForwardObservation,
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
