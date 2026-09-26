import { createHash } from "node:crypto";
import type { JsonObject } from "./backtester-client.js";
import {
  normalizeBacktestSelector,
  type BacktestStrikeSelector,
} from "./backtest-selector.js";
import { ExactDecimal } from "./decimal.js";
import type { ExecutionReferences } from "./execution-evidence.js";
import {
  reconstructHistoricalSpxCandidates,
  type HistoricalCandidateCandles,
} from "./historical-spx-reconstruction.js";
import {
  normalizeCandidateConstructionProfile,
  normalizeResolutionProfile,
  withEffectiveAggregation,
  type CandidateConstructionProfile,
  type ResolutionProfile,
  type ResolutionProfileInput,
} from "./resolution-profile.js";
import type { OptionSide } from "./spread-adapter.js";
import {
  normalizeRfc3339,
  resolveCheckpoint,
  type LocalCheckpointInput,
  type ResolvedCheckpoint,
} from "./time.js";

export type HistoricalCandidateSelector = BacktestStrikeSelector & {
  days_until_expiration: number;
};

export type HistoricalSpxCandidatesInput = {
  underlying: "SPX";
  as_of?: string;
  local_checkpoint?: LocalCheckpointInput;
  min_dte?: number;
  max_dte?: number;
  sides?: OptionSide[];
  selector_grid: HistoricalCandidateSelector[];
  lookback_calendar_days?: number;
  resolution_profile?: ResolutionProfileInput;
  candidate_construction_profile?: Record<string, unknown>;
  phase: "REGRESSION_RESEARCH";
  references?: ExecutionReferences;
};

export type NormalizedHistoricalCandidateSelector = {
  method: BacktestStrikeSelector["method"];
  value: string;
  days_until_expiration: number;
};

export type HistoricalCandidateProvenance = {
  source: string;
  source_timestamp: string;
  fields: string[];
  documented_contract: boolean;
};

export type HistoricalSpxCandidate = {
  provider_symbol: string;
  simulation_symbol: string;
  occ_symbol: string | null;
  underlying: "SPX";
  expiration: string;
  strike: string;
  option_side: OptionSide;
  selected_at: string;
  requested_dte: number;
  selected_dte: number;
  dte_at_as_of: number;
  selection_method: BacktestStrikeSelector["method"];
  selector_value: string;
  backtester_fill_price: string | null;
  historical_price: string | null;
  historical_price_effect: "DEBIT" | "CREDIT" | null;
  selected_historical_delta: string | null;
  selected_historical_iv: string | null;
  historical_volume: string | null;
  historical_open_interest: string | null;
  underlying_price: string | null;
  bar_start: string | null;
  bar_end: string | null;
  available_at: string | null;
  retrieved_at: string | null;
  observation_age_ms: number;
  confidence: "MEDIUM";
  provenance: HistoricalCandidateProvenance[];
  warnings: string[];
};

export type HistoricalCandidateAttempt = {
  option_side: OptionSide;
  selector: NormalizedHistoricalCandidateSelector;
  backtest_id: string | null;
  status:
    | "CANDIDATE_FOUND"
    | "RECONSTRUCTED_CANDIDATE_FOUND"
    | "NO_ELIGIBLE_TRIAL"
    | "INVALID_PROVIDER_LOGS"
    | "PROVIDER_ERROR";
  error: string | null;
};

export type HistoricalSpxCandidatesResult = {
  contract_version: "1.0.0";
  request_id: string;
  status: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  evidence_type: "HISTORICAL_SELECTOR_CANDIDATE_SET";
  evidence_phase: "REGRESSION_RESEARCH";
  as_of: string;
  checkpoint: ResolvedCheckpoint;
  retrieved_at: string | null;
  underlying: "SPX";
  requested_dte_range: {
    min: number;
    max: number;
  };
  lookback_calendar_days: number;
  contracts: HistoricalSpxCandidate[];
  surface: {
    atm_iv: null;
    skew: null;
    term_structure: null;
  };
  provenance: HistoricalCandidateProvenance[];
  capabilities: {
    full_historical_chain: false;
    exact_provider_contract_identity: boolean;
    exact_leg_simulation: boolean;
    historical_bid_ask: false;
    historical_contract_iv: boolean;
    historical_iv_surface: false;
    historical_skew: false;
    historical_term_structure: false;
    historical_open_interest: boolean;
    historical_volume: boolean;
    backtester_entry_time_configurable: false;
    exact_checkpoint_selection: boolean;
    exact_checkpoint_simulation: boolean;
    deterministic_checkpoint_reconstruction: boolean;
    historical_contract_universe_reconstructed: boolean;
    forward_outcomes_included: false;
  };
  attempts: HistoricalCandidateAttempt[];
  resolution_profile: ResolutionProfile;
  candidate_construction_profile: CandidateConstructionProfile | null;
  references: ExecutionReferences;
  warnings: string[];
};

export type HistoricalCandidateBacktester = {
  createBacktest(request: JsonObject): Promise<unknown>;
  getBacktest(id: string): Promise<unknown>;
  getBacktestLogs(id: string): Promise<unknown>;
  simulateTrade(request: JsonObject): Promise<unknown>;
};

export type CandidatePlanItem = {
  option_side: OptionSide;
  selector: NormalizedHistoricalCandidateSelector;
  backtest_request: JsonObject;
};

export type HistoricalSpxCandidatesPlan = {
  request_id: string;
  as_of: string;
  checkpoint: ResolvedCheckpoint;
  session_date: string;
  start_date: string;
  min_dte: number;
  max_dte: number;
  lookback_calendar_days: number;
  items: CandidatePlanItem[];
  resolution_profile: ResolutionProfile;
  candidate_construction_profile: CandidateConstructionProfile | null;
  references: ExecutionReferences;
};

type CandidateExtraction = {
  candidate: HistoricalSpxCandidate | null;
  future_trials_excluded: number;
  stale_trials_excluded: number;
  invalid_logs: boolean;
  warnings: string[];
};

type TrialCandidateExtraction = {
  candidate: HistoricalSpxCandidate | null;
  invalid_logs: boolean;
  warning: string | null;
};

const DEFAULT_MIN_DTE = 21;
const DEFAULT_MAX_DTE = 35;
const DEFAULT_LOOKBACK_CALENDAR_DAYS = 7;
const MAX_LOOKBACK_CALENDAR_DAYS = 30;
const MAX_CANDIDATE_REQUESTS = 12;
const MAX_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1_000;
const NEW_YORK_TIMEZONE = "America/New_York";

const LIMITATION_WARNINGS = [
  "HISTORICAL_SELECTOR_CANDIDATE_SET_NOT_FULL_CHAIN",
  "HISTORICAL_BID_ASK_NOT_AVAILABLE",
  "HISTORICAL_IV_SURFACE_NOT_AVAILABLE",
  "HISTORICAL_SKEW_NOT_AVAILABLE",
  "HISTORICAL_TERM_STRUCTURE_NOT_AVAILABLE",
  "FORWARD_OUTCOMES_EXCLUDED_FROM_CANDIDATE_DISCOVERY",
] as const;

const BACKTESTER_LIMITATION_WARNINGS = [
  "BACKTEST_LOG_IDENTITY_FIELDS_ARE_UNDOCUMENTED",
  "BACKTESTER_ENTRY_TIME_NOT_CONFIGURABLE",
  "CHECKPOINT_SELECTION_REQUIRES_EXACT_TIMESTAMP",
] as const;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedTimestamp(value: unknown, field: string): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeRfc3339(value, field);
  } catch {
    return null;
  }
}

function normalizedDecimal(value: unknown, field: string): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    return ExactDecimal.parse(value, field).toString();
  } catch {
    return null;
  }
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

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDaysBetween(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  return Math.floor((endTime - startTime) / 86_400_000);
}

function stableRequestId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function normalizeSides(sides: OptionSide[] | undefined): OptionSide[] {
  const values = sides ?? ["CALL", "PUT"];
  if (values.length === 0) throw new Error("sides must not be empty.");
  const normalized = [...new Set(values)];
  if (normalized.some((side) => side !== "CALL" && side !== "PUT")) {
    throw new Error("sides may contain only CALL and PUT.");
  }
  return normalized;
}

function attemptKey(item: CandidatePlanItem): string {
  return [
    item.option_side,
    item.selector.method,
    item.selector.value,
    item.selector.days_until_expiration,
  ].join(":");
}

export function prepareHistoricalSpxCandidates(
  input: HistoricalSpxCandidatesInput,
): HistoricalSpxCandidatesPlan {
  if (input.underlying !== "SPX") {
    throw new Error("Historical option candidate discovery currently supports SPX.");
  }
  if (input.phase !== "REGRESSION_RESEARCH") {
    throw new Error("phase must be REGRESSION_RESEARCH.");
  }

  const checkpoint = resolveCheckpoint(
    input.as_of,
    input.local_checkpoint,
    "historical_spx_candidates",
  );
  const asOf = checkpoint.instant;
  const resolutionProfile = normalizeResolutionProfile(
    input.resolution_profile,
    {
      default_requested_aggregation: "5m",
      default_max_observation_age_minutes: 60,
      default_max_temporal_skew_minutes: 0,
      default_fallback_aggregations: [],
    },
  );
  if (resolutionProfile.fallback_policy.allowed) {
    throw new Error(
      "Historical SPX selector reconstruction does not support resolution fallback; request a single cohort explicitly.",
    );
  }
  const candidateConstructionProfile =
    normalizeCandidateConstructionProfile(
      input.candidate_construction_profile,
    );
  const minDte = integerInRange(
    input.min_dte,
    DEFAULT_MIN_DTE,
    "min_dte",
    1,
    365,
  );
  const maxDte = integerInRange(
    input.max_dte,
    DEFAULT_MAX_DTE,
    "max_dte",
    1,
    365,
  );
  if (maxDte < minDte) throw new Error("max_dte must be >= min_dte.");
  const lookbackCalendarDays = integerInRange(
    input.lookback_calendar_days,
    DEFAULT_LOOKBACK_CALENDAR_DAYS,
    "lookback_calendar_days",
    0,
    MAX_LOOKBACK_CALENDAR_DAYS,
  );
  if (!Array.isArray(input.selector_grid) || input.selector_grid.length === 0) {
    throw new Error("selector_grid must contain at least one selector.");
  }

  const sessionDate = dateInTimezone(asOf, NEW_YORK_TIMEZONE);
  const startDate = shiftDate(sessionDate, -lookbackCalendarDays);
  const sides = normalizeSides(input.sides);
  const selectors = input.selector_grid.map((selector, index) => {
    if (
      !Number.isSafeInteger(selector.days_until_expiration) ||
      selector.days_until_expiration < minDte ||
      selector.days_until_expiration > maxDte
    ) {
      throw new Error(
        `selector_grid[${index}].days_until_expiration must be between min_dte and max_dte.`,
      );
    }
    const provider = normalizeBacktestSelector(
      selector,
      `selector_grid[${index}]`,
    );
    return {
      normalized: {
        method: provider.method,
        value: provider.value,
        days_until_expiration: selector.days_until_expiration,
      },
      provider,
    };
  });

  const duplicateKeys = new Set<string>();
  for (const selector of selectors) {
    const key = [
      selector.normalized.method,
      selector.normalized.value,
      selector.normalized.days_until_expiration,
    ].join(":");
    if (duplicateKeys.has(key)) {
      throw new Error(`selector_grid contains a duplicate selector: ${key}.`);
    }
    duplicateKeys.add(key);
  }

  if (selectors.length * sides.length > MAX_CANDIDATE_REQUESTS) {
    throw new Error(
      `selector_grid x sides may create at most ${MAX_CANDIDATE_REQUESTS} candidate requests.`,
    );
  }

  const items: CandidatePlanItem[] = [];
  for (const side of sides) {
    for (const selector of selectors) {
      items.push({
        option_side: side,
        selector: selector.normalized,
        backtest_request: {
          symbol: "SPX",
          startDate,
          endDate: sessionDate,
          legs: [
            {
              type: "equity-option",
              direction: "long",
              side: side.toLowerCase(),
              quantity: 1,
              ...selector.provider.provider_fields,
              daysUntilExpiration:
                selector.normalized.days_until_expiration,
            },
          ],
          entryConditions: {
            frequency: "every day",
            maximumActiveTrials: Math.min(
              MAX_LOOKBACK_CALENDAR_DAYS + 1,
              lookbackCalendarDays + 1,
            ),
            maximumActiveTrialsBehavior: "don't enter",
          },
          exitConditions: {
            afterDaysInTrade: 1,
          },
        },
      });
    }
  }

  const references = normalizeReferences(input.references);
  return {
    request_id: stableRequestId({
      underlying: "SPX",
      as_of: asOf,
      min_dte: minDte,
      max_dte: maxDte,
      lookback_calendar_days: lookbackCalendarDays,
      items: items.map((item) => ({
        option_side: item.option_side,
        selector: item.selector,
        backtest_request: item.backtest_request,
      })),
      checkpoint,
      resolution_profile: resolutionProfile,
      candidate_construction_profile: candidateConstructionProfile,
      references,
    }),
    as_of: asOf,
    checkpoint,
    session_date: sessionDate,
    start_date: startDate,
    min_dte: minDte,
    max_dte: maxDte,
    lookback_calendar_days: lookbackCalendarDays,
    items,
    resolution_profile: resolutionProfile,
    candidate_construction_profile: candidateConstructionProfile,
    references,
  };
}

function backtestId(value: unknown): string | null {
  const response = objectValue(value);
  return typeof response?.id === "string" && response.id.trim()
    ? response.id
    : null;
}

function backtestStatus(value: unknown): string | null {
  const response = objectValue(value);
  return typeof response?.status === "string" ? response.status : null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCompletedBacktest(
  backtester: HistoricalCandidateBacktester,
  initial: unknown,
): Promise<{ id: string; response: unknown }> {
  const id = backtestId(initial);
  if (!id) throw new Error("Backtester create response did not include an id.");
  let current = initial;
  if (backtestStatus(current) === "completed") {
    return { id, response: current };
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    current = await backtester.getBacktest(id);
    const status = backtestStatus(current);
    if (status === "completed") return { id, response: current };
    if (status !== null && status !== "pending" && status !== "running") {
      throw new Error(`Backtest ${id} returned unsupported status: ${status}.`);
    }
    if (attempt < MAX_POLL_ATTEMPTS - 1) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`Backtest ${id} did not complete within 30 seconds.`);
}

function baseCandidateFromTrial(
  trial: Record<string, unknown>,
  item: CandidatePlanItem,
  backtestIdValue: string,
  asOf: string,
  minDte: number,
  maxDte: number,
): TrialCandidateExtraction {
  const asOfTime = Date.parse(asOf);
  const orders = Array.isArray(trial.orders) ? trial.orders : [];
  for (const rawOrder of orders) {
    const order = objectValue(rawOrder);
    if (!order) continue;
    const selectedAt = normalizedTimestamp(
      order.datetime,
      "logs.trials.orders.datetime",
    );
    if (!selectedAt || Date.parse(selectedAt) !== asOfTime) continue;
    const legs = Array.isArray(order.legs) ? order.legs : [];
    for (const rawLeg of legs) {
      const leg = objectValue(rawLeg);
      const action =
        typeof leg?.action === "string" ? leg.action.toLowerCase() : "";
      if (!leg || !action.endsWith("to open")) continue;
      const instrument = objectValue(leg.instrument);
      if (!instrument || instrument.type !== "equity-option") continue;
      const optionSide =
        instrument.side === "call"
          ? "CALL"
          : instrument.side === "put"
            ? "PUT"
            : null;
      if (optionSide !== item.option_side) continue;
      if (
        instrument.underlyingSymbol !== "SPX" &&
        instrument.symbol !== "SPX"
      ) {
        continue;
      }
      const providerSymbol =
        typeof instrument.internalSymbol === "string"
          ? instrument.internalSymbol.trim()
          : "";
      const expiration = normalizedTimestamp(
        instrument.expiration,
        "logs.trials.orders.legs.instrument.expiration",
      );
      const strike = normalizedDecimal(
        instrument.strike,
        "logs.trials.orders.legs.instrument.strike",
      );
      if (!providerSymbol || !expiration || strike === null) continue;

      const selectedDate = dateInTimezone(selectedAt, NEW_YORK_TIMEZONE);
      const checkpointDate = dateInTimezone(asOf, NEW_YORK_TIMEZONE);
      const expirationDate = dateInTimezone(
        expiration,
        NEW_YORK_TIMEZONE,
      );
      const selectedDte = calendarDaysBetween(selectedDate, expirationDate);
      const dteAtAsOf = calendarDaysBetween(
        checkpointDate,
        expirationDate,
      );
      if (dteAtAsOf < minDte || dteAtAsOf > maxDte) {
        return {
          candidate: null,
          invalid_logs: false,
          warning: "SELECTED_CONTRACT_DTE_OUTSIDE_REQUESTED_RANGE_AT_AS_OF",
        };
      }

      const warnings = [
        "BACKTEST_LOG_IDENTITY_FIELDS_ARE_UNDOCUMENTED",
        "OCC_SYMBOL_NOT_EXPOSED_BY_BACKTEST_LOGS",
      ];
      if (selectedDte !== item.selector.days_until_expiration) {
        warnings.push("PROVIDER_SELECTED_DTE_DIFFERS_FROM_REQUESTED_DTE");
      }
      if (selectedDate !== checkpointDate) {
        warnings.push("LATEST_PROVIDER_SELECTION_PRECEDES_CHECKPOINT_DATE");
      }
      const source = `tastytrade-backtester:/backtests/${backtestIdValue}/logs`;
      return {
        invalid_logs: false,
        warning: null,
        candidate: {
          provider_symbol: providerSymbol,
          simulation_symbol: providerSymbol,
          occ_symbol: null,
          underlying: "SPX",
          expiration,
          strike,
          option_side: optionSide,
          selected_at: selectedAt,
          requested_dte: item.selector.days_until_expiration,
          selected_dte: selectedDte,
          dte_at_as_of: dteAtAsOf,
          selection_method: item.selector.method,
          selector_value: item.selector.value,
          backtester_fill_price: normalizedDecimal(
            leg.fillPrice,
            "logs.trials.orders.legs.fillPrice",
          ),
          historical_price: null,
          historical_price_effect: null,
          selected_historical_delta: null,
          selected_historical_iv: null,
          historical_volume: null,
          historical_open_interest: null,
          underlying_price: normalizedDecimal(
            trial.underlyingPriceAtOpen,
            "logs.trials.underlyingPriceAtOpen",
          ),
          bar_start: null,
          bar_end: null,
          available_at: selectedAt,
          retrieved_at: null,
          observation_age_ms: asOfTime - Date.parse(selectedAt),
          confidence: "MEDIUM",
          provenance: [
            {
              source: "tastytrade-research-mcp:request",
              source_timestamp: asOf,
              fields: [
                "underlying",
                "requested_dte",
                "selection_method",
                "selector_value",
              ],
              documented_contract: true,
            },
            {
              source,
              source_timestamp: selectedAt,
              fields: [
                "provider_symbol",
                "expiration",
                "strike",
                "option_side",
                "selected_at",
                "backtester_fill_price",
                "underlying_price",
              ],
              documented_contract: false,
            },
            {
              source: "tastytrade-research-mcp:derived",
              source_timestamp: selectedAt,
              fields: [
                "simulation_symbol",
                "selected_dte",
                "confidence",
              ],
              documented_contract: true,
            },
            {
              source: "tastytrade-research-mcp:derived",
              source_timestamp: asOf,
              fields: [
                "dte_at_as_of",
                "observation_age_ms",
              ],
              documented_contract: true,
            },
          ],
          warnings,
        },
      };
    }
  }
  return {
    candidate: null,
    invalid_logs: true,
    warning: "ELIGIBLE_TRIAL_DID_NOT_EXPOSE_EXACT_CONTRACT_IDENTITY",
  };
}

function extractCandidate(
  logs: unknown,
  item: CandidatePlanItem,
  backtestIdValue: string,
  plan: HistoricalSpxCandidatesPlan,
): CandidateExtraction {
  const response = objectValue(logs);
  if (!response || !Array.isArray(response.trials)) {
    return {
      candidate: null,
      future_trials_excluded: 0,
      stale_trials_excluded: 0,
      invalid_logs: true,
      warnings: ["BACKTEST_LOGS_DID_NOT_CONTAIN_TRIALS"],
    };
  }

  const asOfTime = Date.parse(plan.as_of);
  const checkpointTrials: Array<{
    opened_at: string;
    trial: Record<string, unknown>;
  }> = [];
  let futureTrialsExcluded = 0;
  let staleTrialsExcluded = 0;
  let malformedTrials = 0;
  for (const [index, rawTrial] of response.trials.entries()) {
    const trial = objectValue(rawTrial);
    if (!trial) {
      malformedTrials += 1;
      continue;
    }
    const openedAt = normalizedTimestamp(
      trial.openDateTime,
      `logs.trials[${index}].openDateTime`,
    );
    if (!openedAt) {
      malformedTrials += 1;
      continue;
    }
    if (Date.parse(openedAt) > asOfTime) {
      futureTrialsExcluded += 1;
      continue;
    }
    if (Date.parse(openedAt) < asOfTime) {
      staleTrialsExcluded += 1;
      continue;
    }
    checkpointTrials.push({ opened_at: openedAt, trial });
  }

  if (checkpointTrials.length > 1) {
    return {
      candidate: null,
      future_trials_excluded: futureTrialsExcluded,
      stale_trials_excluded: staleTrialsExcluded,
      invalid_logs: true,
      warnings: ["MULTIPLE_BACKTEST_TRIALS_AT_EXACT_AS_OF"],
    };
  }

  const checkpointTrial = checkpointTrials[0];
  if (checkpointTrial) {
    const extraction = baseCandidateFromTrial(
      checkpointTrial.trial,
      item,
      backtestIdValue,
      plan.as_of,
      plan.min_dte,
      plan.max_dte,
    );
    return {
      candidate: extraction.candidate,
      future_trials_excluded: futureTrialsExcluded,
      stale_trials_excluded: staleTrialsExcluded,
      invalid_logs: extraction.invalid_logs,
      warnings: extraction.warning ? [extraction.warning] : [],
    };
  }

  return {
    candidate: null,
    future_trials_excluded: futureTrialsExcluded,
    stale_trials_excluded: staleTrialsExcluded,
    invalid_logs:
      malformedTrials > 0 &&
      futureTrialsExcluded === 0 &&
      staleTrialsExcluded === 0,
    warnings: [
      ...(malformedTrials > 0
        ? ["BACKTEST_LOGS_CONTAINED_MALFORMED_TRIALS"]
        : []),
      "NO_BACKTEST_TRIAL_AT_EXACT_AS_OF",
    ],
  };
}

function exactSimulationSnapshot(
  raw: unknown,
  selectedAt: string,
): Record<string, unknown> | null {
  const response = objectValue(raw);
  const snapshots = Array.isArray(raw) ? raw : response?.snapshots;
  if (!Array.isArray(snapshots)) return null;
  return (
    snapshots
      .map(objectValue)
      .find(
        (snapshot) =>
          normalizedTimestamp(
            snapshot?.dateTime,
            "simulate_trade.snapshots.dateTime",
          ) === selectedAt,
      ) ?? null
  );
}

async function enrichCandidate(
  backtester: HistoricalCandidateBacktester,
  candidate: HistoricalSpxCandidate,
): Promise<HistoricalSpxCandidate> {
  const raw = await backtester.simulateTrade({
    underlying: "SPX",
    startTime: candidate.selected_at,
    endTime: candidate.selected_at,
    legs: [
      {
        symbol: candidate.simulation_symbol,
        direction: "long",
        quantity: 1,
      },
    ],
  });
  const snapshot = exactSimulationSnapshot(raw, candidate.selected_at);
  if (!snapshot) {
    return {
      ...candidate,
      warnings: [
        ...candidate.warnings,
        "SIMULATE_TRADE_DID_NOT_RETURN_SELECTION_TIMESTAMP",
      ],
    };
  }

  const price = normalizedDecimal(
    snapshot.price,
    "simulate_trade.snapshots.price",
  );
  const delta = normalizedDecimal(
    snapshot.delta,
    "simulate_trade.snapshots.delta",
  );
  const effect =
    snapshot.effect === "debit"
      ? "DEBIT"
      : snapshot.effect === "credit"
        ? "CREDIT"
        : null;
  const fields: string[] = [];
  if (price !== null) fields.push("historical_price");
  if (effect !== null) fields.push("historical_price_effect");
  if (delta !== null) fields.push("selected_historical_delta");

  return {
    ...candidate,
    historical_price: price,
    historical_price_effect: effect,
    selected_historical_delta: delta,
    provenance:
      fields.length === 0
        ? candidate.provenance
        : [
            ...candidate.provenance,
            {
              source: "tastytrade-backtester:/simulate-trade",
              source_timestamp: candidate.selected_at,
              fields,
              documented_contract: true,
            },
          ],
    warnings:
      fields.length === 0
        ? [...candidate.warnings, "SIMULATE_TRADE_POINT_FIELDS_UNAVAILABLE"]
        : candidate.warnings,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

export async function discoverHistoricalSpxCandidates(
  backtester: HistoricalCandidateBacktester,
  input: HistoricalSpxCandidatesInput,
  candles?: HistoricalCandidateCandles,
): Promise<HistoricalSpxCandidatesResult> {
  const plan = prepareHistoricalSpxCandidates(input);
  const contracts: HistoricalSpxCandidate[] = [];
  const attempts: HistoricalCandidateAttempt[] = [];
  const warnings: string[] = [...LIMITATION_WARNINGS];
  let reconstructedCandidates: Array<HistoricalSpxCandidate | null> =
    plan.items.map(() => null);
  let reconstructedCount = 0;
  let usedBacktester = false;

  if (candles) {
    try {
      const reconstruction = await reconstructHistoricalSpxCandidates(
        plan,
        candles,
      );
      reconstructedCandidates = reconstruction.candidates;
      warnings.push(...reconstruction.warnings);
    } catch (error) {
      warnings.push(
        `CHECKPOINT_RECONSTRUCTION_FAILED:${errorMessage(error)}`,
      );
    }
  }

  for (const [itemIndex, item] of plan.items.entries()) {
    const reconstructed = reconstructedCandidates[itemIndex];
    if (reconstructed) {
      reconstructedCount += 1;
      contracts.push(reconstructed);
      attempts.push({
        option_side: item.option_side,
        selector: item.selector,
        backtest_id: null,
        status: "RECONSTRUCTED_CANDIDATE_FOUND",
        error: null,
      });
      continue;
    }

    if (!usedBacktester) {
      warnings.push(...BACKTESTER_LIMITATION_WARNINGS);
      usedBacktester = true;
    }
    let id: string | null = null;
    try {
      const created = await backtester.createBacktest(item.backtest_request);
      const completed = await waitForCompletedBacktest(backtester, created);
      id = completed.id;
      const logs = await backtester.getBacktestLogs(id);
      const extraction = extractCandidate(logs, item, id, plan);
      if (extraction.future_trials_excluded > 0) {
        warnings.push(
          `${attemptKey(item)}:FUTURE_TRIALS_EXCLUDED:${extraction.future_trials_excluded}`,
        );
      }
      if (extraction.stale_trials_excluded > 0) {
        warnings.push(
          `${attemptKey(item)}:STALE_TRIALS_EXCLUDED:${extraction.stale_trials_excluded}`,
        );
      }
      warnings.push(
        ...extraction.warnings.map(
          (warning) => `${attemptKey(item)}:${warning}`,
        ),
      );
      if (!extraction.candidate) {
        attempts.push({
          option_side: item.option_side,
          selector: item.selector,
          backtest_id: id,
          status: extraction.invalid_logs
            ? "INVALID_PROVIDER_LOGS"
            : "NO_ELIGIBLE_TRIAL",
          error: null,
        });
        continue;
      }

      let candidate = extraction.candidate;
      try {
        candidate = await enrichCandidate(backtester, candidate);
      } catch (error) {
        candidate = {
          ...candidate,
          warnings: [
            ...candidate.warnings,
            `SIMULATE_TRADE_ENRICHMENT_FAILED:${errorMessage(error)}`,
          ],
        };
      }
      contracts.push(candidate);
      attempts.push({
        option_side: item.option_side,
        selector: item.selector,
        backtest_id: id,
        status: "CANDIDATE_FOUND",
        error: null,
      });
    } catch (error) {
      const message = errorMessage(error);
      warnings.push(`${attemptKey(item)}:PROVIDER_ERROR:${message}`);
      attempts.push({
        option_side: item.option_side,
        selector: item.selector,
        backtest_id: id,
        status: "PROVIDER_ERROR",
        error: message,
      });
    }
  }

  const complete =
    contracts.length === plan.items.length &&
    contracts.every(
      (candidate) =>
        candidate.historical_price !== null &&
        candidate.historical_price_effect !== null &&
        candidate.selected_historical_delta !== null,
    );
  const status =
    contracts.length === 0
      ? "NOT_AVAILABLE"
      : complete
        ? "COMPLETE"
        : "PARTIAL";
  const provenance = contracts.flatMap((candidate) => candidate.provenance);
  if (
    contracts.length === 0 ||
    contracts.every((candidate) => candidate.selected_historical_iv === null)
  ) {
    warnings.push("HISTORICAL_CONTRACT_IV_NOT_AVAILABLE");
  }
  if (
    contracts.length === 0 ||
    contracts.every((candidate) => candidate.historical_open_interest === null)
  ) {
    warnings.push("HISTORICAL_OPEN_INTEREST_NOT_AVAILABLE");
  }
  if (
    contracts.length === 0 ||
    contracts.every((candidate) => candidate.historical_volume === null)
  ) {
    warnings.push("HISTORICAL_VOLUME_NOT_AVAILABLE");
  }

  return {
    contract_version: "1.0.0",
    request_id: plan.request_id,
    status,
    evidence_type: "HISTORICAL_SELECTOR_CANDIDATE_SET",
    evidence_phase: "REGRESSION_RESEARCH",
    as_of: plan.as_of,
    checkpoint: plan.checkpoint,
    retrieved_at:
      contracts
        .map((contract) => contract.retrieved_at)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null,
    underlying: "SPX",
    requested_dte_range: {
      min: plan.min_dte,
      max: plan.max_dte,
    },
    lookback_calendar_days: plan.lookback_calendar_days,
    contracts,
    surface: {
      atm_iv: null,
      skew: null,
      term_structure: null,
    },
    provenance,
    capabilities: {
      full_historical_chain: false,
      exact_provider_contract_identity: contracts.length > 0,
      exact_leg_simulation: contracts.length > 0,
      historical_bid_ask: false,
      historical_contract_iv: contracts.some(
        (candidate) => candidate.selected_historical_iv !== null,
      ),
      historical_iv_surface: false,
      historical_skew: false,
      historical_term_structure: false,
      historical_open_interest: contracts.some(
        (candidate) => candidate.historical_open_interest !== null,
      ),
      historical_volume: contracts.some(
        (candidate) => candidate.historical_volume !== null,
      ),
      backtester_entry_time_configurable: false,
      exact_checkpoint_selection: contracts.length > 0,
      exact_checkpoint_simulation:
        contracts.length > 0 &&
        reconstructedCount === 0 &&
        contracts.every(
          (candidate) =>
            candidate.historical_price !== null &&
            candidate.selected_historical_delta !== null,
        ),
      deterministic_checkpoint_reconstruction: reconstructedCount > 0,
      historical_contract_universe_reconstructed: reconstructedCount > 0,
      forward_outcomes_included: false,
    },
    attempts,
    resolution_profile: withEffectiveAggregation(
      plan.resolution_profile,
      reconstructedCount > 0
        ? plan.resolution_profile.requested_aggregation
        : null,
    ),
    candidate_construction_profile:
      plan.candidate_construction_profile,
    references: plan.references,
    warnings: [...new Set(warnings)],
  };
}
