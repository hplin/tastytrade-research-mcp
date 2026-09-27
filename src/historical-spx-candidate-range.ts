import { createHash } from "node:crypto";
import {
  EvidenceCacheError,
  evidenceCacheWithContext,
  mergeEvidenceCacheSummaries,
  type EvidenceCacheRequest,
  type EvidenceCacheSummary,
} from "./evidence-cache.js";
import {
  discoverHistoricalSpxCandidates,
  prepareHistoricalSpxCandidates,
  type HistoricalCandidateBacktester,
  type HistoricalSpxCandidateExecutionOptions,
  type HistoricalSpxCandidatesInput,
  type HistoricalSpxCandidatesPlan,
  type HistoricalSpxCandidatesResult,
} from "./historical-spx-candidates.js";
import {
  HISTORICAL_SPX_CANDIDATE_PROGRESS_STAGES,
  type HistoricalSpxCandidateProgressEvent,
  type HistoricalSpxCandidateProgressSelector,
  type HistoricalSpxCandidateProgressStage,
} from "./historical-spx-candidate-progress.js";
import type { HistoricalCandidateCandles } from "./historical-spx-reconstruction.js";
import {
  normalizeDate,
  resolveCheckpoint,
  type ResolvedCheckpoint,
} from "./time.js";
import {
  providerRateLimitMetadataFromError,
  type ProviderRateLimitCause,
  type ProviderRateLimitMetadata,
  type ProviderRateLimitSource,
} from "./provider-rate-limit.js";

export const HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION = "1.0.0";

const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_MAX_CONCURRENCY = 4;
const DEFAULT_CHECKPOINT_DEADLINE_MS = 60_000;
const MAX_CHECKPOINT_DEADLINE_MS = 300_000;
const DEFAULT_MAX_CHECKPOINTS_PER_RUN = 25;
const MAX_CHECKPOINTS_PER_RUN = 50;
const DEFAULT_RETRY_MAX_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 250;
const MAX_RETRY_BACKOFF_MS = 10_000;
const MAX_TRADING_CALENDAR_SESSIONS = 400;
const RATE_LIMIT_FALLBACK_DELAYS_MS = [10_000, 30_000, 90_000] as const;
const MAX_RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
const RATE_LIMIT_JITTER_RATIO = 0.2;
const MAX_CONTINUATION_RETRY_COUNT = 1_000_000;
const FAILURE_CATEGORY_CODES: Record<
  HistoricalSpxCandidateRangeFailureCategory,
  number
> = {
  PROVIDER_TIMEOUT: 0,
  PROVIDER_RATE_LIMIT: 1,
  PROVIDER_ERROR: 2,
  CACHE_ERROR: 3,
};
const FAILURE_CATEGORIES_BY_CODE = [
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_ERROR",
  "CACHE_ERROR",
] as const satisfies readonly HistoricalSpxCandidateRangeFailureCategory[];

export type HistoricalSpxCandidateRangeRetryPolicy = {
  max_attempts?: number;
  backoff_ms?: number;
};

export type HistoricalSpxCandidateTradingCalendar = {
  timezone: string;
  local_time: string;
  session_dates: string[];
};

export type HistoricalSpxCandidatesRangeInput = Omit<
  HistoricalSpxCandidatesInput,
  "as_of" | "local_checkpoint"
> & {
  start_date: string;
  end_date: string;
  trading_calendar: HistoricalSpxCandidateTradingCalendar;
  max_concurrency?: number;
  checkpoint_deadline_ms?: number;
  max_checkpoints_per_run?: number;
  retry_policy?: HistoricalSpxCandidateRangeRetryPolicy;
  continuation_cursor?: string;
};

type RangeCompletionStatus = "AVAILABLE" | "PARTIAL" | "NOT_AVAILABLE";

export type HistoricalSpxCandidateRangeCheckpointStatus =
  | RangeCompletionStatus
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_ERROR"
  | "CACHE_ERROR";

export type HistoricalSpxCandidateRangeFailureCategory = Exclude<
  HistoricalSpxCandidateRangeCheckpointStatus,
  RangeCompletionStatus
>;

export type HistoricalSpxCandidateRangeStageDiagnostic = {
  stage: HistoricalSpxCandidateProgressStage;
  status:
    | "NOT_STARTED"
    | "IN_PROGRESS"
    | "COMPLETED"
    | "FAILED"
    | "TIMED_OUT";
  duration_ms: number;
  operation_count: number;
};

export type HistoricalSpxCandidateRangeDiagnostics = {
  elapsed_ms: number;
  timeout_stage:
    | HistoricalSpxCandidateProgressStage
    | "BEFORE_CACHE_LOOKUP"
    | null;
  selector_attempts_started: Array<{
    option_side: HistoricalSpxCandidateProgressSelector["option_side"];
    selector: Omit<
      HistoricalSpxCandidateProgressSelector,
      "option_side"
    >;
  }>;
  stages: HistoricalSpxCandidateRangeStageDiagnostic[];
};

export type HistoricalSpxCandidateRangeRetryMetadata = {
  retry_count: number;
  next_retry_at: string | null;
  last_error: HistoricalSpxCandidateRangeFailureCategory | null;
  last_retry_after_seconds: number | null;
  provider: string | null;
};

export type HistoricalSpxCandidateRangeRateLimitDiagnostics = {
  provider: string | null;
  cooldown_active: boolean;
  cooldown_until: string | null;
  last_429_at: string | null;
  retry_after_seconds: number | null;
  rate_limit_count: number;
  remaining: number | null;
  source: ProviderRateLimitSource | null;
  cause: ProviderRateLimitCause | null;
  checkpoints_retry_eligible: number;
  checkpoints_cooling_down: number;
};

export type HistoricalSpxCandidateRangeCheckpoint = {
  session_date: string;
  scheduled_checkpoint: string;
  request_id: string;
  status: HistoricalSpxCandidateRangeCheckpointStatus;
  attempt_count: number;
  result: HistoricalSpxCandidatesResult | null;
  error: {
    category: HistoricalSpxCandidateRangeFailureCategory;
    code: string | null;
    message: string;
    retryable: boolean;
    rate_limit: ProviderRateLimitMetadata | null;
  } | null;
  attempt_errors: Array<{
    attempt: number;
    category: HistoricalSpxCandidateRangeFailureCategory;
    code: string | null;
    message: string;
    retryable: boolean;
    rate_limit: ProviderRateLimitMetadata | null;
  }>;
  retry: HistoricalSpxCandidateRangeRetryMetadata;
  cache_fully_served: boolean;
  provider_access_required: boolean;
  diagnostics: HistoricalSpxCandidateRangeDiagnostics;
};

export type HistoricalSpxCandidatesRangePlan = {
  request_id: string;
  start_date: string;
  end_date: string;
  trading_calendar: HistoricalSpxCandidateTradingCalendar;
  checkpoints: Array<{
    session_date: string;
    scheduled_checkpoint: string;
    checkpoint: ResolvedCheckpoint;
    request_id: string;
  }>;
  max_concurrency: number;
  checkpoint_deadline_ms: number;
  max_checkpoints_per_run: number;
  retry_policy: {
    max_attempts: number;
    backoff_ms: number;
  };
  pending_session_dates: string[];
  unattempted_session_dates: string[];
  deferred_session_dates: string[];
  deferred_checkpoints: Array<
    HistoricalSpxCandidateRangeRetryMetadata & {
      session_date: string;
    }
  >;
  provider_rate_limit: ProviderRateLimitMetadata | null;
  previously_completed: Array<{
    session_date: string;
    status: RangeCompletionStatus;
  }>;
};

type PlannedCheckpoint = {
  session_date: string;
  scheduled_checkpoint: string;
  checkpoint: ResolvedCheckpoint;
  input: HistoricalSpxCandidatesInput;
  single_plan: HistoricalSpxCandidatesPlan;
};

type PreparedRange = {
  public_plan: HistoricalSpxCandidatesRangePlan;
  checkpoints: PlannedCheckpoint[];
};

type ContinuationCompletion = {
  session_date: string;
  status: RangeCompletionStatus;
};

type ContinuationState = {
  contract_version: typeof HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION;
  request_id: string;
  completed: ContinuationCompletion[];
  unattempted_session_dates: string[];
  deferred_checkpoints: Array<
    HistoricalSpxCandidateRangeRetryMetadata & {
      session_date: string;
    }
  >;
  provider_rate_limit: ProviderRateLimitMetadata | null;
};

type ContinuationPayloadV1 = {
  contract_version: typeof HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION;
  request_id: string;
  completed: ContinuationCompletion[];
  pending_session_dates: string[];
};

type ContinuationPayloadV2 = {
  contract_version: typeof HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION;
  request_id: string;
  completed: ContinuationCompletion[];
  unattempted_session_dates: string[];
  deferred_session_dates: string[];
};

type ContinuationPayloadV3 = {
  contract_version: typeof HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION;
  request_id: string;
  completed: Array<[string, RangeCompletionStatus]>;
  unattempted_session_dates: string[];
  deferred_checkpoints: Array<
    [
      string,
      number,
      number | null,
      number | null,
      number | null,
      string | null,
    ]
  >;
  provider_rate_limit:
    | [
        string,
        string,
        string,
        number,
        number,
        number | null,
        ProviderRateLimitSource,
        ProviderRateLimitCause,
      ]
    | null;
};

export type HistoricalSpxCandidatesRangeResult = {
  contract_version: typeof HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION;
  request_id: string;
  status: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  underlying: "SPX";
  start_date: string;
  end_date: string;
  trading_calendar: HistoricalSpxCandidateTradingCalendar;
  resolved_checkpoints: HistoricalSpxCandidatesRangePlan["checkpoints"];
  execution: {
    max_concurrency: number;
    checkpoint_deadline_ms: number;
    max_checkpoints_per_run: number;
    retry_policy: HistoricalSpxCandidatesRangePlan["retry_policy"];
  };
  checkpoints: HistoricalSpxCandidateRangeCheckpoint[];
  progress: {
    trading_sessions_requested: number;
    checkpoints_total: number;
    checkpoints_previously_completed: number;
    checkpoints_attempted: number;
    checkpoints_completed: number;
    checkpoints_completed_this_run: number;
    checkpoints_deferred: number;
    checkpoints_remaining: number;
    checkpoints_unattempted: number;
    checkpoints_awaiting_retry: number;
    checkpoints_retry_eligible: number;
    checkpoints_cooling_down: number;
  };
  coverage: {
    selector_attempts_requested: number;
    selector_attempts_scheduled_this_run: number;
    selector_attempts_attempted: number;
    selectors_found: number;
    checkpoints_available: number;
    checkpoints_partial: number;
    checkpoints_not_available: number;
    checkpoints_failed: number;
    checkpoint_retry_count: number;
    provider_timeout_count: number;
    provider_rate_limit_count: number;
    provider_error_count: number;
    cache_error_count: number;
    checkpoints_fully_served_from_cache: number;
    checkpoints_requiring_provider_access: number;
    cache: EvidenceCacheSummary | null;
    by_dte: Array<{
      dte: number;
      requested: number;
      attempted: number;
      found: number;
    }>;
    by_side: Array<{
      option_side: "CALL" | "PUT";
      requested: number;
      attempted: number;
      found: number;
    }>;
    failure_reason_counts: Array<{
      reason: string;
      count: number;
    }>;
  };
  evidence_cache: {
    summary: EvidenceCacheSummary | null;
    checkpoints_fully_served: number;
    checkpoints_requiring_provider_access: number;
  };
  rate_limit: HistoricalSpxCandidateRangeRateLimitDiagnostics;
  continuation: {
    cursor: string | null;
    completed_session_dates: string[];
    unresolved_session_dates: string[];
    unattempted_session_dates: string[];
    deferred_session_dates: string[];
    deferred_checkpoints: Array<
      HistoricalSpxCandidateRangeRetryMetadata & {
        session_date: string;
      }
    >;
    provider_rate_limit: ProviderRateLimitMetadata | null;
  } | null;
  warnings: string[];
};

export type HistoricalSpxCandidateRangeRuntime = {
  discover?: (
    backtester: HistoricalCandidateBacktester,
    input: HistoricalSpxCandidatesInput,
    candles?: HistoricalCandidateCandles,
    execution?: HistoricalSpxCandidateExecutionOptions,
  ) => Promise<HistoricalSpxCandidatesResult>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

type Failure = NonNullable<HistoricalSpxCandidateRangeCheckpoint["error"]>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function hashIdentity(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function integerInRange(
  value: number | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < min ||
    normalized > max
  ) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return normalized;
}

function normalizeTradingCalendar(
  input: HistoricalSpxCandidateTradingCalendar,
  startDate: string,
  endDate: string,
): {
  calendar: HistoricalSpxCandidateTradingCalendar;
  checkpoints: Array<{
    session_date: string;
    scheduled_checkpoint: string;
    checkpoint: ResolvedCheckpoint;
  }>;
} {
  if (
    !input ||
    !Array.isArray(input.session_dates) ||
    input.session_dates.length === 0 ||
    input.session_dates.length > MAX_TRADING_CALENDAR_SESSIONS
  ) {
    throw new Error(
      `trading_calendar.session_dates must contain 1 through ${MAX_TRADING_CALENDAR_SESSIONS} explicit sessions.`,
    );
  }

  const sessionDates = input.session_dates.map((date, index) =>
    normalizeDate(date, `trading_calendar.session_dates[${index}]`),
  );
  for (let index = 1; index < sessionDates.length; index += 1) {
    if (sessionDates[index] <= sessionDates[index - 1]) {
      throw new Error(
        "trading_calendar.session_dates must be strictly increasing and unique.",
      );
    }
  }

  const selected = sessionDates.filter(
    (date) => date >= startDate && date <= endDate,
  );
  if (selected.length === 0) {
    throw new Error(
      "The requested date range does not contain a trading session from the explicit calendar.",
    );
  }

  const checkpoints = selected.map((sessionDate) => {
    const checkpoint = resolveCheckpoint(
      undefined,
      {
        local_date: sessionDate,
        timezone: input.timezone,
        local_time: input.local_time,
      },
      "trading_calendar",
    );
    return {
      session_date: sessionDate,
      scheduled_checkpoint: checkpoint.instant,
      checkpoint,
    };
  });

  return {
    calendar: {
      timezone: checkpoints[0].checkpoint.timezone!,
      local_time: checkpoints[0].checkpoint.local_time!,
      session_dates: sessionDates,
    },
    checkpoints,
  };
}

function batchIdentity(
  input: HistoricalSpxCandidatesRangeInput,
  startDate: string,
  endDate: string,
  calendar: HistoricalSpxCandidateTradingCalendar,
  checkpoints: PlannedCheckpoint[],
): string {
  return hashIdentity({
    contract_version: HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
    underlying: input.underlying,
    start_date: startDate,
    end_date: endDate,
    trading_calendar: calendar,
    checkpoint_request_ids: checkpoints.map(
      (checkpoint) => checkpoint.single_plan.request_id,
    ),
  });
}

function encodeContinuation(payload: ContinuationState): string {
  const defaultProvider = payload.provider_rate_limit?.provider ?? null;
  const encodedPayload: ContinuationPayloadV3 = {
    contract_version: payload.contract_version,
    request_id: payload.request_id,
    completed: payload.completed.map((entry) => [
      entry.session_date,
      entry.status,
    ]),
    unattempted_session_dates: payload.unattempted_session_dates,
    deferred_checkpoints: payload.deferred_checkpoints.map((entry) => [
      entry.session_date,
      entry.retry_count,
      entry.next_retry_at === null
        ? null
        : Date.parse(entry.next_retry_at),
      entry.last_error === null
        ? null
        : FAILURE_CATEGORY_CODES[entry.last_error],
      entry.last_retry_after_seconds,
      entry.provider === defaultProvider
        ? null
        : entry.provider ?? "",
    ]),
    provider_rate_limit: payload.provider_rate_limit
      ? [
          payload.provider_rate_limit.provider,
          payload.provider_rate_limit.cooldown_until,
          payload.provider_rate_limit.last_429_at,
          payload.provider_rate_limit.retry_after_seconds,
          payload.provider_rate_limit.rate_limit_count,
          payload.provider_rate_limit.remaining,
          payload.provider_rate_limit.source,
          payload.provider_rate_limit.cause,
        ]
      : null,
  };
  const serialized = canonicalJson(encodedPayload);
  const encoded = Buffer.from(serialized, "utf8").toString("base64url");
  return `v3.${encoded}.${createHash("sha256")
    .update(serialized)
    .digest("hex")}`;
}

function completionStatuses(): Set<RangeCompletionStatus> {
  return new Set<RangeCompletionStatus>([
    "AVAILABLE",
    "PARTIAL",
    "NOT_AVAILABLE",
  ]);
}

function decodeLegacyCompletions(value: unknown): ContinuationCompletion[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "continuation_cursor does not match this logical range request.",
    );
  }
  const statusValues = completionStatuses();
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.session_date !== "string" ||
      !statusValues.has(entry.status as RangeCompletionStatus)
    ) {
      throw new Error("continuation_cursor contains an invalid completion.");
    }
    return {
      session_date: entry.session_date,
      status: entry.status as RangeCompletionStatus,
    };
  });
}

function decodeV3Completions(value: unknown): ContinuationCompletion[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "continuation_cursor does not match this logical range request.",
    );
  }
  const statusValues = completionStatuses();
  return value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !statusValues.has(entry[1] as RangeCompletionStatus)
    ) {
      throw new Error("continuation_cursor contains an invalid completion.");
    }
    return {
      session_date: entry[0],
      status: entry[1] as RangeCompletionStatus,
    };
  });
}

function decodeSessionDateQueue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "continuation_cursor does not match this logical range request.",
    );
  }
  if (
    value.some((date) => typeof date !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new Error("continuation_cursor contains duplicate or invalid dates.");
  }
  return value as string[];
}

function decodeContinuationTimestamp(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`continuation_cursor contains invalid ${field}.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`continuation_cursor contains invalid ${field}.`);
  }
  return new Date(parsed).toISOString();
}

function decodeOptionalContinuationTimestamp(
  value: unknown,
  field: string,
): string | null {
  return value === null ? null : decodeContinuationTimestamp(value, field);
}

function decodeOptionalCompactTimestamp(
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw new Error(`continuation_cursor contains invalid ${field}.`);
  }
  return new Date(value).toISOString();
}

function decodeOptionalNonNegativeInteger(
  value: unknown,
  field: string,
  maximum = MAX_CONTINUATION_RETRY_COUNT,
): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`continuation_cursor contains invalid ${field}.`);
  }
  return value;
}

function decodeOptionalProvider(
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 100
  ) {
    throw new Error(`continuation_cursor contains invalid ${field}.`);
  }
  return value;
}

function decodeCompactProvider(
  value: unknown,
  defaultProvider: string | null,
): string | null {
  if (value === null) return defaultProvider;
  if (value === "") return null;
  return decodeOptionalProvider(value, "deferred provider");
}

function decodeFailureCategory(
  value: unknown,
): HistoricalSpxCandidateRangeFailureCategory | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= FAILURE_CATEGORIES_BY_CODE.length
  ) {
    throw new Error(
      "continuation_cursor contains invalid deferred last_error.",
    );
  }
  return FAILURE_CATEGORIES_BY_CODE[value]!;
}

function decodeDeferredCheckpoints(
  value: unknown,
  defaultProvider: string | null,
): ContinuationState["deferred_checkpoints"] {
  if (!Array.isArray(value)) {
    throw new Error(
      "continuation_cursor does not match this logical range request.",
    );
  }
  return value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 6 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "number" ||
      !Number.isInteger(entry[1]) ||
      entry[1] < 0 ||
      entry[1] > MAX_CONTINUATION_RETRY_COUNT
    ) {
      throw new Error(
        "continuation_cursor contains invalid deferred retry metadata.",
      );
    }
    return {
      session_date: entry[0],
      retry_count: entry[1],
      next_retry_at: decodeOptionalCompactTimestamp(
        entry[2],
        "deferred next_retry_at",
      ),
      last_error: decodeFailureCategory(entry[3]),
      last_retry_after_seconds: decodeOptionalNonNegativeInteger(
        entry[4],
        "deferred last_retry_after_seconds",
        Number.MAX_SAFE_INTEGER,
      ),
      provider: decodeCompactProvider(entry[5], defaultProvider),
    };
  });
}

function decodeProviderRateLimit(
  value: unknown,
): ProviderRateLimitMetadata | null {
  if (value === null) return null;
  const sources = new Set<ProviderRateLimitSource>([
    "RETRY_AFTER",
    "X_RATE_LIMIT_RESET",
    "FALLBACK",
  ]);
  const causes = new Set<ProviderRateLimitCause>([
    "HTTP_429",
    "ACTIVE_COOLDOWN",
  ]);
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    typeof value[0] !== "string" ||
    !value[0].trim() ||
    value[0].length > 100 ||
    typeof value[3] !== "number" ||
    !Number.isInteger(value[3]) ||
    value[3] < 0 ||
    typeof value[4] !== "number" ||
    !Number.isInteger(value[4]) ||
    value[4] < 0 ||
    value[4] > MAX_CONTINUATION_RETRY_COUNT ||
    (value[5] !== null &&
      (typeof value[5] !== "number" ||
        !Number.isInteger(value[5]) ||
        value[5] < 0)) ||
    !sources.has(value[6] as ProviderRateLimitSource) ||
    !causes.has(value[7] as ProviderRateLimitCause)
  ) {
    throw new Error(
      "continuation_cursor contains invalid provider rate-limit metadata.",
    );
  }
  return {
    provider: value[0],
    cooldown_until: decodeContinuationTimestamp(
      value[1],
      "provider cooldown_until",
    ),
    last_429_at: decodeContinuationTimestamp(
      value[2],
      "provider last_429_at",
    ),
    retry_after_seconds: value[3],
    rate_limit_count: value[4],
    remaining: value[5],
    source: value[6] as ProviderRateLimitSource,
    cause: value[7] as ProviderRateLimitCause,
  };
}

function deferredCheckpoint(
  sessionDate: string,
): ContinuationState["deferred_checkpoints"][number] {
  return {
    session_date: sessionDate,
    retry_count: 0,
    next_retry_at: null,
    last_error: null,
    last_retry_after_seconds: null,
    provider: null,
  };
}

function validateContinuationState(
  state: ContinuationState,
  sessionDates: string[],
): ContinuationState {
  const completedDates = new Set(
    state.completed.map((entry) => entry.session_date),
  );
  const unattemptedDates = new Set(state.unattempted_session_dates);
  const deferredDates = new Set(
    state.deferred_checkpoints.map((entry) => entry.session_date),
  );
  const expected = new Set(sessionDates);
  if (
    completedDates.size !== state.completed.length ||
    deferredDates.size !== state.deferred_checkpoints.length ||
    [...completedDates].some(
      (date) =>
        !expected.has(date) ||
        unattemptedDates.has(date) ||
        deferredDates.has(date),
    ) ||
    [...unattemptedDates].some(
      (date) => !expected.has(date) || deferredDates.has(date),
    ) ||
    [...deferredDates].some((date) => !expected.has(date)) ||
    sessionDates.some(
      (date) =>
        !completedDates.has(date) &&
        !unattemptedDates.has(date) &&
        !deferredDates.has(date),
    ) ||
    state.unattempted_session_dates.some(
      (date, index) =>
        date !==
        sessionDates.filter((item) => unattemptedDates.has(item))[index],
    )
  ) {
    throw new Error(
      "continuation_cursor progress does not match this range request.",
    );
  }
  return state;
}

function decodeContinuation(
  cursor: string,
  requestId: string,
  sessionDates: string[],
): ContinuationState {
  const parts = cursor.split(".");
  if (
    parts.length !== 3 ||
    (parts[0] !== "v1" && parts[0] !== "v2" && parts[0] !== "v3")
  ) {
    throw new Error("continuation_cursor has an unsupported format.");
  }

  let serialized: string;
  try {
    serialized = Buffer.from(parts[1], "base64url").toString("utf8");
  } catch {
    throw new Error("continuation_cursor is not valid base64url.");
  }
  const digest = createHash("sha256").update(serialized).digest("hex");
  if (digest !== parts[2]) {
    throw new Error("continuation_cursor failed its integrity check.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("continuation_cursor does not contain valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("continuation_cursor payload must be an object.");
  }
  const payload = parsed as Record<string, unknown>;
  if (
    payload.contract_version !==
      HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION ||
    payload.request_id !== requestId
  ) {
    throw new Error(
      "continuation_cursor does not match this logical range request.",
    );
  }

  if (parts[0] === "v1") {
    const legacy = payload as Partial<ContinuationPayloadV1>;
    return validateContinuationState(
      {
        contract_version: HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
        request_id: requestId,
        completed: decodeLegacyCompletions(legacy.completed),
        unattempted_session_dates: decodeSessionDateQueue(
          legacy.pending_session_dates,
        ),
        deferred_checkpoints: [],
        provider_rate_limit: null,
      },
      sessionDates,
    );
  }

  if (parts[0] === "v2") {
    const legacy = payload as Partial<ContinuationPayloadV2>;
    return validateContinuationState(
      {
        contract_version: HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
        request_id: requestId,
        completed: decodeLegacyCompletions(legacy.completed),
        unattempted_session_dates: decodeSessionDateQueue(
          legacy.unattempted_session_dates,
        ),
        deferred_checkpoints: decodeSessionDateQueue(
          legacy.deferred_session_dates,
        ).map(deferredCheckpoint),
        provider_rate_limit: null,
      },
      sessionDates,
    );
  }

  const current = payload as Partial<ContinuationPayloadV3>;
  const providerRateLimit = decodeProviderRateLimit(
    current.provider_rate_limit,
  );
  return validateContinuationState(
    {
      contract_version: HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
      request_id: requestId,
      completed: decodeV3Completions(current.completed),
      unattempted_session_dates: decodeSessionDateQueue(
        current.unattempted_session_dates,
      ),
      deferred_checkpoints: decodeDeferredCheckpoints(
        current.deferred_checkpoints,
        providerRateLimit?.provider ?? null,
      ),
      provider_rate_limit: providerRateLimit,
    },
    sessionDates,
  );
}

function prepareRange(
  input: HistoricalSpxCandidatesRangeInput,
): PreparedRange {
  const startDate = normalizeDate(input.start_date, "start_date");
  const endDate = normalizeDate(input.end_date, "end_date");
  if (endDate < startDate) {
    throw new Error("end_date must not precede start_date.");
  }
  if (
    input.evidence_cache?.as_of !== undefined ||
    input.evidence_cache?.evidence_role !== undefined
  ) {
    throw new Error(
      "Range discovery assigns evidence_cache.as_of and evidence_cache.evidence_role per checkpoint.",
    );
  }

  const normalized = normalizeTradingCalendar(
    input.trading_calendar,
    startDate,
    endDate,
  );
  const {
    start_date: _startDate,
    end_date: _endDate,
    trading_calendar: _tradingCalendar,
    max_concurrency: _maxConcurrency,
    checkpoint_deadline_ms: _checkpointDeadline,
    max_checkpoints_per_run: _maxCheckpoints,
    retry_policy: _retryPolicy,
    continuation_cursor: _continuation,
    ...singleBase
  } = input;

  const checkpoints: PlannedCheckpoint[] = normalized.checkpoints.map(
    (checkpoint) => {
      const evidenceCache = evidenceCacheWithContext(
        singleBase.evidence_cache as EvidenceCacheRequest | undefined,
        {
          as_of: checkpoint.scheduled_checkpoint,
          default_role: "ENTRY",
          references: singleBase.references,
        },
      );
      const singleInput: HistoricalSpxCandidatesInput = {
        ...singleBase,
        as_of: checkpoint.scheduled_checkpoint,
        evidence_cache: evidenceCache,
      };
      const singlePlan = prepareHistoricalSpxCandidates(singleInput);
      return {
        ...checkpoint,
        input: singleInput,
        single_plan: singlePlan,
      };
    },
  );
  const requestId = batchIdentity(
    input,
    startDate,
    endDate,
    normalized.calendar,
    checkpoints,
  );
  const sessionDates = checkpoints.map((checkpoint) => checkpoint.session_date);
  const continuation = input.continuation_cursor
    ? decodeContinuation(input.continuation_cursor, requestId, sessionDates)
    : {
        contract_version:
          HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
        request_id: requestId,
        completed: [],
        unattempted_session_dates: sessionDates,
        deferred_checkpoints: [],
        provider_rate_limit: null,
      };
  const pendingSessionDates = [
    ...continuation.unattempted_session_dates,
    ...continuation.deferred_checkpoints.map(
      (entry) => entry.session_date,
    ),
  ];

  return {
    public_plan: {
      request_id: requestId,
      start_date: startDate,
      end_date: endDate,
      trading_calendar: normalized.calendar,
      checkpoints: checkpoints.map((checkpoint) => ({
        session_date: checkpoint.session_date,
        scheduled_checkpoint: checkpoint.scheduled_checkpoint,
        checkpoint: checkpoint.checkpoint,
        request_id: checkpoint.single_plan.request_id,
      })),
      max_concurrency: integerInRange(
        input.max_concurrency,
        "max_concurrency",
        DEFAULT_MAX_CONCURRENCY,
        1,
        MAX_MAX_CONCURRENCY,
      ),
      checkpoint_deadline_ms: integerInRange(
        input.checkpoint_deadline_ms,
        "checkpoint_deadline_ms",
        DEFAULT_CHECKPOINT_DEADLINE_MS,
        1,
        MAX_CHECKPOINT_DEADLINE_MS,
      ),
      max_checkpoints_per_run: integerInRange(
        input.max_checkpoints_per_run,
        "max_checkpoints_per_run",
        DEFAULT_MAX_CHECKPOINTS_PER_RUN,
        1,
        MAX_CHECKPOINTS_PER_RUN,
      ),
      retry_policy: {
        max_attempts: integerInRange(
          input.retry_policy?.max_attempts,
          "retry_policy.max_attempts",
          DEFAULT_RETRY_MAX_ATTEMPTS,
          1,
          MAX_RETRY_ATTEMPTS,
        ),
        backoff_ms: integerInRange(
          input.retry_policy?.backoff_ms,
          "retry_policy.backoff_ms",
          DEFAULT_RETRY_BACKOFF_MS,
          0,
          MAX_RETRY_BACKOFF_MS,
        ),
      },
      pending_session_dates: pendingSessionDates,
      unattempted_session_dates:
        continuation.unattempted_session_dates,
      deferred_session_dates: continuation.deferred_checkpoints.map(
        (entry) => entry.session_date,
      ),
      deferred_checkpoints: continuation.deferred_checkpoints,
      provider_rate_limit: continuation.provider_rate_limit,
      previously_completed: continuation.completed,
    },
    checkpoints,
  };
}

export function prepareHistoricalSpxCandidatesRange(
  input: HistoricalSpxCandidatesRangeInput,
): HistoricalSpxCandidatesRangePlan {
  return prepareRange(input).public_plan;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

function classifyFailure(error: unknown): Failure {
  const message = errorMessage(error);
  const code = errorCode(error);
  const normalized = `${code ?? ""} ${message}`.toUpperCase();
  const responseStatus =
    error &&
    typeof error === "object" &&
    typeof (error as { response?: { status?: unknown } }).response?.status ===
      "number"
      ? (error as { response: { status: number } }).response.status
      : null;
  const retryable = Boolean(
    error &&
    typeof error === "object" &&
      (error as { retryable?: unknown }).retryable === true,
  );
  const rateLimit = providerRateLimitMetadataFromError(error);

  if (
    responseStatus === 429 ||
    normalized.includes("RATE_LIMIT") ||
    normalized.includes("RATE LIMIT") ||
    normalized.includes("TOO MANY REQUESTS") ||
    normalized.includes("HTTP 429") ||
    /\b429\b/.test(normalized)
  ) {
    return {
      category: "PROVIDER_RATE_LIMIT",
      code,
      message,
      retryable: true,
      rate_limit: rateLimit,
    };
  }
  if (
    normalized.includes("PROVIDER_TIMEOUT") ||
    normalized.includes("ETIMEDOUT") ||
    normalized.includes("ECONNABORTED") ||
    normalized.includes("TIMEOUT") ||
    normalized.includes("TIMED OUT") ||
    normalized.includes("ABORT")
  ) {
    return {
      category: "PROVIDER_TIMEOUT",
      code,
      message,
      retryable: true,
      rate_limit: null,
    };
  }
  if (error instanceof EvidenceCacheError) {
    if (retryable && error.cause) return classifyFailure(error.cause);
    return {
      category: "CACHE_ERROR",
      code,
      message,
      retryable,
      rate_limit: null,
    };
  }
  if (
    retryable ||
    responseStatus === 408 ||
    (responseStatus !== null && responseStatus >= 500) ||
    [
      "ECONNRESET",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ERR_NETWORK",
    ].includes(code?.toUpperCase() ?? "")
  ) {
    return {
      category: "PROVIDER_ERROR",
      code,
      message,
      retryable: true,
      rate_limit: null,
    };
  }
  return {
    category: "PROVIDER_ERROR",
    code,
    message,
    retryable,
    rate_limit: null,
  };
}

function failureFromResult(
  result: HistoricalSpxCandidatesResult,
): Failure | null {
  const providerErrors = result.attempts.filter(
    (attempt) => attempt.status === "PROVIDER_ERROR",
  );
  if (providerErrors.length === 0) return null;
  const failures = providerErrors.map((attempt) => {
    const error = Object.assign(
      new Error(attempt.error ?? "Provider request failed."),
      {
        code: attempt.provider_error?.code ?? undefined,
        response:
          attempt.provider_error?.http_status === null ||
          attempt.provider_error?.http_status === undefined
            ? undefined
            : { status: attempt.provider_error.http_status },
        retryable: attempt.provider_error?.retryable ?? false,
        provider_rate_limit: attempt.provider_error?.rate_limit,
      },
    );
    return classifyFailure(error);
  });
  if (failures.every((failure) => failure.category === "PROVIDER_TIMEOUT")) {
    return failures[0];
  }
  const rateLimitFailures = failures.filter(
    (failure) => failure.category === "PROVIDER_RATE_LIMIT",
  );
  if (rateLimitFailures.length > 0) {
    return rateLimitFailures.reduce((selected, failure) => {
      const selectedUntil = selected.rate_limit
        ? Date.parse(selected.rate_limit.cooldown_until)
        : Number.NEGATIVE_INFINITY;
      const failureUntil = failure.rate_limit
        ? Date.parse(failure.rate_limit.cooldown_until)
        : Number.NEGATIVE_INFINITY;
      return failureUntil > selectedUntil ? failure : selected;
    });
  }
  return {
    category: "PROVIDER_ERROR",
    code: null,
    message: [...new Set(failures.map((failure) => failure.message))].join(
      "; ",
    ),
    retryable: failures.every((failure) => failure.retryable),
    rate_limit: null,
  };
}

function completionStatus(
  result: HistoricalSpxCandidatesResult,
): RangeCompletionStatus {
  if (result.status === "COMPLETE") return "AVAILABLE";
  if (result.status === "PARTIAL") return "PARTIAL";
  return "NOT_AVAILABLE";
}

function cacheFullyServed(
  result: HistoricalSpxCandidatesResult | null,
): boolean {
  const cache = result?.evidence_cache;
  if (!cache) return false;
  return (
    cache.cache_misses === 0 &&
    cache.refreshes === 0 &&
    cache.retryable_failures === 0 &&
    cache.retryable_failure_hits === 0 &&
    cache.provider_calls_avoided > 0 &&
    result.attempts.every(
      (attempt) =>
        attempt.status !== "CANDIDATE_FOUND" &&
        attempt.status !== "PROVIDER_ERROR" &&
        attempt.backtest_id === null,
    )
  );
}

function providerAccessRequired(
  checkpoint: PlannedCheckpoint,
  result: HistoricalSpxCandidatesResult | null,
  error: Failure | null,
): boolean {
  if (checkpoint.input.evidence_cache?.mode === "CACHE_ONLY") return false;
  if (error !== null) return true;
  if (
    result?.attempts.some(
      (attempt) =>
        attempt.status === "CANDIDATE_FOUND" ||
        attempt.status === "PROVIDER_ERROR" ||
        attempt.backtest_id !== null,
    )
  ) {
    return true;
  }
  return !cacheFullyServed(result);
}

function failureStatus(
  failure: Failure,
  bestResult: HistoricalSpxCandidatesResult | null,
): HistoricalSpxCandidateRangeCheckpointStatus {
  if (
    bestResult &&
    (bestResult.contracts.length > 0 ||
      bestResult.attempts.some(
        (attempt) => attempt.status !== "PROVIDER_ERROR",
      ))
  ) {
    return "PARTIAL";
  }
  return failure.category;
}

function emptyRetryMetadata(): HistoricalSpxCandidateRangeRetryMetadata {
  return {
    retry_count: 0,
    next_retry_at: null,
    last_error: null,
    last_retry_after_seconds: null,
    provider: null,
  };
}

function rateLimitFallbackDelay(
  retryCount: number,
  random: () => number,
): number {
  const index = Math.min(
    retryCount - 1,
    RATE_LIMIT_FALLBACK_DELAYS_MS.length - 1,
  );
  const terminal = RATE_LIMIT_FALLBACK_DELAYS_MS.at(-1) ?? 0;
  const growth =
    retryCount <= RATE_LIMIT_FALLBACK_DELAYS_MS.length
      ? RATE_LIMIT_FALLBACK_DELAYS_MS[index]
      : terminal *
        3 ** (retryCount - RATE_LIMIT_FALLBACK_DELAYS_MS.length);
  const bounded = Math.min(growth, MAX_RATE_LIMIT_FALLBACK_MS);
  const normalizedRandom = Math.min(1, Math.max(0, random()));
  const multiplier =
    1 -
    RATE_LIMIT_JITTER_RATIO +
    normalizedRandom * RATE_LIMIT_JITTER_RATIO * 2;
  return Math.min(
    MAX_RATE_LIMIT_FALLBACK_MS,
    Math.max(0, Math.round(bounded * multiplier)),
  );
}

function retryMetadataForFailure(
  previous: HistoricalSpxCandidateRangeRetryMetadata,
  failure: Failure,
  now: number,
  random: () => number,
): HistoricalSpxCandidateRangeRetryMetadata {
  const retryCount = Math.min(
    MAX_CONTINUATION_RETRY_COUNT,
    previous.retry_count + 1,
  );
  if (failure.category !== "PROVIDER_RATE_LIMIT") {
    return {
      retry_count: retryCount,
      next_retry_at: null,
      last_error: failure.category,
      last_retry_after_seconds: null,
      provider: null,
    };
  }

  const providerUntil = failure.rate_limit
    ? Date.parse(failure.rate_limit.cooldown_until)
    : Number.NaN;
  const fallbackDelay = rateLimitFallbackDelay(retryCount, random);
  const nextRetryAt = Number.isFinite(providerUntil)
    ? Math.max(now, providerUntil)
    : now + fallbackDelay;
  return {
    retry_count: retryCount,
    next_retry_at: new Date(nextRetryAt).toISOString(),
    last_error: failure.category,
    last_retry_after_seconds:
      failure.rate_limit?.retry_after_seconds ??
      Math.ceil(fallbackDelay / 1_000),
    provider:
      failure.rate_limit?.provider ?? "tastytrade-backtester",
  };
}

function retryMetadataAfterSuccess(
  previous: HistoricalSpxCandidateRangeRetryMetadata,
): HistoricalSpxCandidateRangeRetryMetadata {
  return {
    ...previous,
    next_retry_at: null,
    last_error: null,
  };
}

type MutableStageDiagnostic = HistoricalSpxCandidateRangeStageDiagnostic & {
  active_since_ms: number | null;
  last_started_sequence: number;
};

function progressSelectorKey(
  selector: HistoricalSpxCandidateProgressSelector,
): string {
  return [
    selector.option_side,
    selector.method,
    selector.value,
    selector.days_until_expiration,
  ].join(":");
}

function createProgressTracker(
  now: () => number,
  startedAt: number,
): {
  report: (event: HistoricalSpxCandidateProgressEvent) => void;
  snapshot: (
    timedOut: boolean,
    timeoutStageOverride?: HistoricalSpxCandidateProgressStage,
  ) => HistoricalSpxCandidateRangeDiagnostics;
} {
  let sequence = 0;
  const stages = new Map<
    HistoricalSpxCandidateProgressStage,
    MutableStageDiagnostic
  >(
    HISTORICAL_SPX_CANDIDATE_PROGRESS_STAGES.map((stage) => [
      stage,
      {
        stage,
        status: "NOT_STARTED",
        duration_ms: 0,
        operation_count: 0,
        active_since_ms: null,
        last_started_sequence: -1,
      },
    ]),
  );
  const selectors = new Map<
    string,
    HistoricalSpxCandidateProgressSelector
  >();

  const report = (event: HistoricalSpxCandidateProgressEvent): void => {
    const stage = stages.get(event.stage)!;
    if (event.state === "PROGRESS") {
      if (event.selector) {
        selectors.set(progressSelectorKey(event.selector), event.selector);
      }
      return;
    }

    const at = now();
    if (event.state === "STARTED") {
      if (stage.active_since_ms === null) {
        stage.active_since_ms = at;
      }
      stage.operation_count += 1;
      stage.last_started_sequence = sequence;
      sequence += 1;
      stage.status = "IN_PROGRESS";
      return;
    }

    if (stage.active_since_ms !== null) {
      stage.duration_ms += Math.max(0, at - stage.active_since_ms);
      stage.active_since_ms = null;
    }
    stage.status =
      event.state === "COMPLETED" ? "COMPLETED" : "FAILED";
  };

  const snapshot = (
    timedOut: boolean,
    timeoutStageOverride?: HistoricalSpxCandidateProgressStage,
  ): HistoricalSpxCandidateRangeDiagnostics => {
    const finishedAt = now();
    const timeoutStage = timedOut
      ? timeoutStageOverride ??
        [...stages.values()]
          .filter(
            (stage) =>
              stage.active_since_ms !== null ||
              stage.status === "FAILED",
          )
          .sort(
            (left, right) =>
              right.last_started_sequence - left.last_started_sequence,
          )[0]?.stage ??
        "BEFORE_CACHE_LOOKUP"
      : null;
    return {
      elapsed_ms: Math.max(0, finishedAt - startedAt),
      timeout_stage: timeoutStage,
      selector_attempts_started: [...selectors.values()].map(
        ({ option_side, ...selector }) => ({
          option_side,
          selector,
        }),
      ),
      stages: HISTORICAL_SPX_CANDIDATE_PROGRESS_STAGES.map(
        (stageName) => {
          const stage = stages.get(stageName)!;
          const activeDuration =
            stage.active_since_ms === null
              ? 0
              : Math.max(0, finishedAt - stage.active_since_ms);
          return {
            stage: stage.stage,
            status:
              timedOut &&
              (stage.active_since_ms !== null ||
                stage.stage === timeoutStageOverride)
                ? "TIMED_OUT"
                : stage.status,
            duration_ms: stage.duration_ms + activeDuration,
            operation_count: stage.operation_count,
          };
        },
      ),
    };
  };

  return { report, snapshot };
}

async function runCheckpoint(
  checkpoint: PlannedCheckpoint,
  backtester: HistoricalCandidateBacktester,
  candles: HistoricalCandidateCandles | undefined,
  plan: HistoricalSpxCandidatesRangePlan,
  runtime: Required<HistoricalSpxCandidateRangeRuntime>,
  previousRetry: HistoricalSpxCandidateRangeRetryMetadata,
): Promise<HistoricalSpxCandidateRangeCheckpoint> {
  const startedAt = runtime.now();
  const deadlineAt = startedAt + plan.checkpoint_deadline_ms;
  const progress = createProgressTracker(runtime.now, startedAt);
  const attemptErrors: HistoricalSpxCandidateRangeCheckpoint["attempt_errors"] =
    [];
  let bestResult: HistoricalSpxCandidatesResult | null = null;

  for (
    let attempt = 1;
    attempt <= plan.retry_policy.max_attempts;
    attempt += 1
  ) {
    const remaining = deadlineAt - runtime.now();
    if (remaining <= 0) {
      const failure: Failure = {
        category: "PROVIDER_TIMEOUT",
        code: "PROVIDER_TIMEOUT",
        message: `Checkpoint exceeded its ${plan.checkpoint_deadline_ms}ms deadline.`,
        retryable: true,
        rate_limit: null,
      };
      attemptErrors.push({ attempt, ...failure });
      return {
        session_date: checkpoint.session_date,
        scheduled_checkpoint: checkpoint.scheduled_checkpoint,
        request_id: checkpoint.single_plan.request_id,
        status: failureStatus(failure, bestResult),
        attempt_count: attempt,
        result: bestResult,
        error: failure,
        attempt_errors: attemptErrors,
        retry: retryMetadataForFailure(
          previousRetry,
          failure,
          runtime.now(),
          runtime.random,
        ),
        cache_fully_served: cacheFullyServed(bestResult),
        provider_access_required: providerAccessRequired(
          checkpoint,
          bestResult,
          failure,
        ),
        diagnostics: progress.snapshot(true),
      };
    }

    try {
      const result = await runtime.discover(
        backtester,
        checkpoint.input,
        candles,
        {
          deadline_ms: remaining,
          now: runtime.now,
          on_progress: progress.report,
        },
      );
      if (
        bestResult === null ||
        result.contracts.length > bestResult.contracts.length ||
        (result.contracts.length === bestResult.contracts.length &&
          result.attempts.length > bestResult.attempts.length)
      ) {
        bestResult = result;
      }
      const failure = failureFromResult(result);
      if (
        failure?.retryable &&
        failure.category !== "PROVIDER_RATE_LIMIT" &&
        attempt < plan.retry_policy.max_attempts
      ) {
        attemptErrors.push({ attempt, ...failure });
        if (plan.retry_policy.backoff_ms > 0) {
          await runtime.sleep(
            Math.min(
              plan.retry_policy.backoff_ms,
              Math.max(0, deadlineAt - runtime.now()),
            ),
          );
        }
        continue;
      }
      if (failure) attemptErrors.push({ attempt, ...failure });
      const status =
        failure && result.contracts.length === 0
          ? failure.category
          : completionStatus(result);
      return {
        session_date: checkpoint.session_date,
        scheduled_checkpoint: checkpoint.scheduled_checkpoint,
        request_id: checkpoint.single_plan.request_id,
        status,
        attempt_count: attempt,
        result,
        error: failure,
        attempt_errors: attemptErrors,
        retry: failure
          ? retryMetadataForFailure(
              previousRetry,
              failure,
              runtime.now(),
              runtime.random,
            )
          : retryMetadataAfterSuccess(previousRetry),
        cache_fully_served: cacheFullyServed(result),
        provider_access_required: providerAccessRequired(
          checkpoint,
          result,
          failure,
        ),
        diagnostics: progress.snapshot(
          failure?.category === "PROVIDER_TIMEOUT",
          failure?.category === "PROVIDER_TIMEOUT"
            ? "SELECTOR_EVALUATION"
            : undefined,
        ),
      };
    } catch (error) {
      const failure = classifyFailure(error);
      attemptErrors.push({ attempt, ...failure });
      if (
        failure.retryable &&
        failure.category !== "PROVIDER_RATE_LIMIT" &&
        attempt < plan.retry_policy.max_attempts &&
        runtime.now() < deadlineAt
      ) {
        if (plan.retry_policy.backoff_ms > 0) {
          await runtime.sleep(
            Math.min(
              plan.retry_policy.backoff_ms,
              Math.max(0, deadlineAt - runtime.now()),
            ),
          );
        }
        continue;
      }
      return {
        session_date: checkpoint.session_date,
        scheduled_checkpoint: checkpoint.scheduled_checkpoint,
        request_id: checkpoint.single_plan.request_id,
        status: failureStatus(failure, bestResult),
        attempt_count: attempt,
        result: bestResult,
        error: failure,
        attempt_errors: attemptErrors,
        retry: retryMetadataForFailure(
          previousRetry,
          failure,
          runtime.now(),
          runtime.random,
        ),
        cache_fully_served: cacheFullyServed(bestResult),
        provider_access_required: providerAccessRequired(
          checkpoint,
          bestResult,
          failure,
        ),
        diagnostics: progress.snapshot(
          failure.category === "PROVIDER_TIMEOUT",
        ),
      };
    }
  }

  throw new Error("Unreachable checkpoint retry state.");
}

async function runBounded(
  checkpoints: PlannedCheckpoint[],
  concurrency: number,
  operation: (
    checkpoint: PlannedCheckpoint,
  ) => Promise<HistoricalSpxCandidateRangeCheckpoint>,
): Promise<HistoricalSpxCandidateRangeCheckpoint[]> {
  const results = new Array<HistoricalSpxCandidateRangeCheckpoint>(
    checkpoints.length,
  );
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < checkpoints.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(checkpoints[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, checkpoints.length) },
      () => worker(),
    ),
  );
  return results;
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function rangeStatus(
  completed: Map<string, RangeCompletionStatus>,
  pendingCount: number,
): HistoricalSpxCandidatesRangeResult["status"] {
  if (pendingCount > 0) {
    return completed.size > 0 ? "PARTIAL" : "NOT_AVAILABLE";
  }
  const statuses = [...completed.values()];
  if (
    statuses.length > 0 &&
    statuses.every((status) => status === "AVAILABLE")
  ) {
    return "COMPLETE";
  }
  return statuses.some(
    (status) => status === "AVAILABLE" || status === "PARTIAL",
  )
    ? "PARTIAL"
    : "NOT_AVAILABLE";
}

type DeferredCheckpoint = ContinuationState["deferred_checkpoints"][number];

function isRetryEligible(
  checkpoint: DeferredCheckpoint,
  now: number,
  providerRateLimit: ProviderRateLimitMetadata | null = null,
): boolean {
  const checkpointRetryAt =
    checkpoint.next_retry_at === null
      ? 0
      : Date.parse(checkpoint.next_retry_at);
  const providerRetryAt =
    checkpoint.last_error === "PROVIDER_RATE_LIMIT" &&
    providerRateLimit !== null &&
    (checkpoint.provider === null ||
      checkpoint.provider === providerRateLimit.provider)
      ? Date.parse(providerRateLimit.cooldown_until)
      : 0;
  return Math.max(checkpointRetryAt, providerRetryAt) <= now;
}

function applyProviderCooldown(
  checkpoint: DeferredCheckpoint,
  providerRateLimit: ProviderRateLimitMetadata | null,
): DeferredCheckpoint {
  if (
    checkpoint.last_error !== "PROVIDER_RATE_LIMIT" ||
    providerRateLimit === null ||
    (checkpoint.provider !== null &&
      checkpoint.provider !== providerRateLimit.provider)
  ) {
    return checkpoint;
  }
  const checkpointRetryAt =
    checkpoint.next_retry_at === null
      ? 0
      : Date.parse(checkpoint.next_retry_at);
  const providerRetryAt = Date.parse(providerRateLimit.cooldown_until);
  if (providerRetryAt <= checkpointRetryAt) return checkpoint;
  return {
    ...checkpoint,
    next_retry_at: providerRateLimit.cooldown_until,
    provider: checkpoint.provider ?? providerRateLimit.provider,
  };
}

function laterTimestamp(
  left: string,
  right: string,
): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function mergeProviderRateLimitState(
  plan: HistoricalSpxCandidatesRangePlan,
  backtester: HistoricalCandidateBacktester,
  checkpoints: HistoricalSpxCandidateRangeCheckpoint[],
  now: number,
): ProviderRateLimitMetadata | null {
  const processState = backtester.getProviderRateLimitState?.() ?? null;
  const checkpointMetadata = checkpoints
    .map((checkpoint) => checkpoint.error?.rate_limit ?? null)
    .filter(
      (entry): entry is ProviderRateLimitMetadata => entry !== null,
    );
  const known = [
    plan.provider_rate_limit,
    processState,
    ...checkpointMetadata,
  ].filter(
    (entry): entry is ProviderRateLimitMetadata => entry !== null,
  );
  const unknownRateLimits = checkpoints.filter(
    (checkpoint) =>
      checkpoint.error?.category === "PROVIDER_RATE_LIMIT" &&
      checkpoint.error.rate_limit === null,
  );
  const previousKey = plan.provider_rate_limit
    ? [
        plan.provider_rate_limit.provider,
        plan.provider_rate_limit.last_429_at,
        plan.provider_rate_limit.rate_limit_count,
      ].join(":")
    : null;
  const currentHttp429Keys = new Set(
    checkpointMetadata
      .filter((metadata) => metadata.cause === "HTTP_429")
      .map((metadata) =>
        [
          metadata.provider,
          metadata.last_429_at,
          metadata.rate_limit_count,
        ].join(":"),
      )
      .filter((key) => key !== previousKey),
  );
  let fallbackCount =
    (plan.provider_rate_limit?.rate_limit_count ?? 0) +
    currentHttp429Keys.size;
  for (const checkpoint of unknownRateLimits) {
    fallbackCount += 1;
    const nextRetryAt =
      checkpoint.retry.next_retry_at ??
      new Date(
        now +
          rateLimitFallbackDelay(
            checkpoint.retry.retry_count,
            () => 0.5,
          ),
      ).toISOString();
    known.push({
      provider:
        checkpoint.retry.provider ?? "tastytrade-backtester",
      cooldown_until: nextRetryAt,
      last_429_at: new Date(now).toISOString(),
      retry_after_seconds:
        checkpoint.retry.last_retry_after_seconds ??
        Math.max(
          0,
          Math.ceil((Date.parse(nextRetryAt) - now) / 1_000),
        ),
      rate_limit_count: fallbackCount,
      remaining: null,
      source: "FALLBACK",
      cause: "HTTP_429",
    });
  }
  if (known.length === 0) return null;

  const selected = known.reduce((latest, candidate) =>
    Date.parse(candidate.cooldown_until) >
    Date.parse(latest.cooldown_until)
      ? candidate
      : latest,
  );
  return {
    ...selected,
    cooldown_until: known
      .map((entry) => entry.cooldown_until)
      .reduce(laterTimestamp),
    last_429_at: known
      .map((entry) => entry.last_429_at)
      .reduce(laterTimestamp),
    rate_limit_count: Math.max(
      ...known.map((entry) => entry.rate_limit_count),
      fallbackCount,
    ),
  };
}

function rateLimitDiagnostics(
  state: ProviderRateLimitMetadata | null,
  deferred: DeferredCheckpoint[],
  now: number,
): HistoricalSpxCandidateRangeRateLimitDiagnostics {
  const retryEligible = deferred.filter((checkpoint) =>
    isRetryEligible(checkpoint, now, state),
  ).length;
  return {
    provider: state?.provider ?? null,
    cooldown_active:
      state !== null && Date.parse(state.cooldown_until) > now,
    cooldown_until: state?.cooldown_until ?? null,
    last_429_at: state?.last_429_at ?? null,
    retry_after_seconds: state?.retry_after_seconds ?? null,
    rate_limit_count: state?.rate_limit_count ?? 0,
    remaining: state?.remaining ?? null,
    source: state?.source ?? null,
    cause: state?.cause ?? null,
    checkpoints_retry_eligible: retryEligible,
    checkpoints_cooling_down: deferred.length - retryEligible,
  };
}

export async function discoverHistoricalSpxCandidatesRange(
  backtester: HistoricalCandidateBacktester,
  input: HistoricalSpxCandidatesRangeInput,
  candles?: HistoricalCandidateCandles,
  runtime: HistoricalSpxCandidateRangeRuntime = {},
): Promise<HistoricalSpxCandidatesRangeResult> {
  const prepared = prepareRange(input);
  const plan = prepared.public_plan;
  const executionRuntime: Required<HistoricalSpxCandidateRangeRuntime> = {
    discover: runtime.discover ?? discoverHistoricalSpxCandidates,
    now: runtime.now ?? Date.now,
    sleep:
      runtime.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
    random: runtime.random ?? Math.random,
  };
  const schedulingTime = executionRuntime.now();
  const runningFirstPass = plan.unattempted_session_dates.length > 0;
  const naturallyEligibleDeferred = plan.deferred_checkpoints.filter(
    (checkpoint) =>
      isRetryEligible(
        checkpoint,
        schedulingTime,
        plan.provider_rate_limit,
      ),
  );
  const coolingDeferred = plan.deferred_checkpoints.filter(
    (checkpoint) =>
      !isRetryEligible(
        checkpoint,
        schedulingTime,
        plan.provider_rate_limit,
      ),
  );
  const cacheOnly = input.evidence_cache?.mode === "CACHE_ONLY";
  const schedulableDeferred = cacheOnly
    ? plan.deferred_checkpoints
    : naturallyEligibleDeferred;
  const scheduledRetries = runningFirstPass
    ? plan.unattempted_session_dates
        .slice(0, plan.max_checkpoints_per_run)
        .map((sessionDate) => ({
          session_date: sessionDate,
          ...emptyRetryMetadata(),
        }))
    : schedulableDeferred.slice(0, plan.max_checkpoints_per_run);
  const scheduledSessionDates = scheduledRetries.map(
    (entry) => entry.session_date,
  );
  const retryBySessionDate = new Map(
    scheduledRetries.map((entry) => [entry.session_date, entry]),
  );
  const checkpointsBySessionDate = new Map(
    prepared.checkpoints.map((checkpoint) => [
      checkpoint.session_date,
      checkpoint,
    ]),
  );
  const toRun = scheduledSessionDates.map((sessionDate) => {
    const checkpoint = checkpointsBySessionDate.get(sessionDate);
    if (!checkpoint) {
      throw new Error(
        `Continuation scheduled unknown session date ${sessionDate}.`,
      );
    }
    return checkpoint;
  });
  const checkpoints = await runBounded(
    toRun,
    plan.max_concurrency,
    (checkpoint) =>
      runCheckpoint(
        checkpoint,
        backtester,
        candles,
        plan,
        executionRuntime,
        retryBySessionDate.get(checkpoint.session_date) ??
          emptyRetryMetadata(),
      ),
  );
  const responseTime = executionRuntime.now();
  const providerRateLimit = mergeProviderRateLimitState(
    plan,
    backtester,
    checkpoints,
    responseTime,
  );
  if (providerRateLimit !== null) {
    for (const checkpoint of checkpoints) {
      if (checkpoint.error?.category !== "PROVIDER_RATE_LIMIT") continue;
      checkpoint.retry = {
        ...checkpoint.retry,
        next_retry_at: providerRateLimit.cooldown_until,
        last_retry_after_seconds:
          providerRateLimit.retry_after_seconds,
        provider: providerRateLimit.provider,
      };
      checkpoint.error = {
        ...checkpoint.error,
        rate_limit:
          checkpoint.error.rate_limit ?? providerRateLimit,
      };
    }
  }

  const completed = new Map(
    plan.previously_completed.map((entry) => [
      entry.session_date,
      entry.status,
    ]),
  );
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.error === null &&
      (checkpoint.status === "AVAILABLE" ||
        checkpoint.status === "PARTIAL" ||
        checkpoint.status === "NOT_AVAILABLE")
    ) {
      completed.set(checkpoint.session_date, checkpoint.status);
    }
  }
  const unresolvedAttempted = checkpoints
    .filter((checkpoint) => checkpoint.error !== null)
    .map((checkpoint) => ({
      session_date: checkpoint.session_date,
      ...checkpoint.retry,
    }));
  const unattemptedSessionDates = runningFirstPass
    ? plan.unattempted_session_dates.slice(toRun.length)
    : [];
  const unselectedDeferred = cacheOnly
    ? schedulableDeferred.slice(toRun.length)
    : [
        ...naturallyEligibleDeferred.slice(toRun.length),
        ...coolingDeferred,
      ];
  const deferredCheckpoints = (
    runningFirstPass
      ? [
          ...plan.deferred_checkpoints,
          ...unresolvedAttempted,
        ]
      : [
          ...unselectedDeferred,
          ...unresolvedAttempted,
        ]
  ).map((checkpoint) =>
    applyProviderCooldown(checkpoint, providerRateLimit),
  );
  const deferredSessionDates = deferredCheckpoints.map(
    (checkpoint) => checkpoint.session_date,
  );
  const pendingSessionDates = [
    ...unattemptedSessionDates,
    ...deferredSessionDates,
  ];
  const allSessionDates = prepared.checkpoints.map(
    (checkpoint) => checkpoint.session_date,
  );
  const completedSessionDates = allSessionDates.filter((sessionDate) =>
    completed.has(sessionDate),
  );
  const continuationPayload: ContinuationState = {
    contract_version: HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
    request_id: plan.request_id,
    completed: completedSessionDates.map((sessionDate) => ({
      session_date: sessionDate,
      status: completed.get(sessionDate) as RangeCompletionStatus,
    })),
    unattempted_session_dates: unattemptedSessionDates,
    deferred_checkpoints: deferredCheckpoints,
    provider_rate_limit: providerRateLimit,
  };

  const requestedByDte = new Map<string, number>();
  const requestedBySide = new Map<string, number>();
  for (const checkpoint of prepared.checkpoints) {
    for (const item of checkpoint.single_plan.items) {
      increment(
        requestedByDte,
        String(item.selector.days_until_expiration),
      );
      increment(requestedBySide, item.option_side);
    }
  }
  const attemptedByDte = new Map<string, number>();
  const foundByDte = new Map<string, number>();
  const attemptedBySide = new Map<string, number>();
  const foundBySide = new Map<string, number>();
  const failureReasons = new Map<string, number>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.error) {
      increment(failureReasons, checkpoint.error.category);
    }
    const attemptedSelectors = new Set<string>();
    for (const attempt of checkpoint.result?.attempts ?? []) {
      attemptedSelectors.add(
        progressSelectorKey({
          option_side: attempt.option_side,
          ...attempt.selector,
        }),
      );
      increment(
        attemptedByDte,
        String(attempt.selector.days_until_expiration),
      );
      increment(attemptedBySide, attempt.option_side);
      if (
        attempt.status === "CANDIDATE_FOUND" ||
        attempt.status === "RECONSTRUCTED_CANDIDATE_FOUND"
      ) {
        increment(
          foundByDte,
          String(attempt.selector.days_until_expiration),
        );
        increment(foundBySide, attempt.option_side);
      } else {
        increment(failureReasons, attempt.status);
      }
    }
    for (const attempt of checkpoint.diagnostics.selector_attempts_started) {
      const selector = {
        option_side: attempt.option_side,
        ...attempt.selector,
      };
      const key = progressSelectorKey(selector);
      if (attemptedSelectors.has(key)) continue;
      attemptedSelectors.add(key);
      increment(
        attemptedByDte,
        String(attempt.selector.days_until_expiration),
      );
      increment(attemptedBySide, attempt.option_side);
    }
  }
  const dtes = [...requestedByDte.keys()]
    .map(Number)
    .sort((left, right) => left - right);
  const sides = (["CALL", "PUT"] as const).filter((side) =>
    requestedBySide.has(side),
  );
  const cacheSummary = mergeEvidenceCacheSummaries(
    ...checkpoints.map((checkpoint) => checkpoint.result?.evidence_cache),
  );
  const completedThisRun = checkpoints.filter(
    (checkpoint) => checkpoint.error === null,
  ).length;
  const rateLimit = rateLimitDiagnostics(
    providerRateLimit,
    deferredCheckpoints,
    executionRuntime.now(),
  );

  return {
    contract_version: HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
    request_id: plan.request_id,
    status: rangeStatus(completed, pendingSessionDates.length),
    underlying: "SPX",
    start_date: plan.start_date,
    end_date: plan.end_date,
    trading_calendar: plan.trading_calendar,
    resolved_checkpoints: plan.checkpoints,
    execution: {
      max_concurrency: plan.max_concurrency,
      checkpoint_deadline_ms: plan.checkpoint_deadline_ms,
      max_checkpoints_per_run: plan.max_checkpoints_per_run,
      retry_policy: plan.retry_policy,
    },
    checkpoints,
    progress: {
      trading_sessions_requested: prepared.checkpoints.length,
      checkpoints_total: prepared.checkpoints.length,
      checkpoints_previously_completed: plan.previously_completed.length,
      checkpoints_attempted: checkpoints.length,
      checkpoints_completed: completed.size,
      checkpoints_completed_this_run: completedThisRun,
      checkpoints_deferred: Math.max(
        0,
        plan.pending_session_dates.length - toRun.length,
      ),
      checkpoints_remaining: pendingSessionDates.length,
      checkpoints_unattempted: unattemptedSessionDates.length,
      checkpoints_awaiting_retry: deferredSessionDates.length,
      checkpoints_retry_eligible:
        rateLimit.checkpoints_retry_eligible,
      checkpoints_cooling_down:
        rateLimit.checkpoints_cooling_down,
    },
    coverage: {
      selector_attempts_requested: [...requestedByDte.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      selector_attempts_scheduled_this_run: toRun.reduce(
        (sum, checkpoint) => sum + checkpoint.single_plan.items.length,
        0,
      ),
      selector_attempts_attempted: [...attemptedByDte.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      selectors_found: [...foundByDte.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      checkpoints_available: checkpoints.filter(
        (checkpoint) => checkpoint.status === "AVAILABLE",
      ).length,
      checkpoints_partial: checkpoints.filter(
        (checkpoint) => checkpoint.status === "PARTIAL",
      ).length,
      checkpoints_not_available: checkpoints.filter(
        (checkpoint) => checkpoint.status === "NOT_AVAILABLE",
      ).length,
      checkpoints_failed: checkpoints.filter(
        (checkpoint) => checkpoint.error !== null,
      ).length,
      checkpoint_retry_count: checkpoints.reduce(
        (sum, checkpoint) => sum + Math.max(0, checkpoint.attempt_count - 1),
        0,
      ),
      provider_timeout_count:
        failureReasons.get("PROVIDER_TIMEOUT") ?? 0,
      provider_rate_limit_count:
        failureReasons.get("PROVIDER_RATE_LIMIT") ?? 0,
      provider_error_count: failureReasons.get("PROVIDER_ERROR") ?? 0,
      cache_error_count: failureReasons.get("CACHE_ERROR") ?? 0,
      checkpoints_fully_served_from_cache: checkpoints.filter(
        (checkpoint) => checkpoint.cache_fully_served,
      ).length,
      checkpoints_requiring_provider_access: checkpoints.filter(
        (checkpoint) => checkpoint.provider_access_required,
      ).length,
      cache: cacheSummary,
      by_dte: dtes.map((dte) => ({
        dte,
        requested: requestedByDte.get(String(dte)) ?? 0,
        attempted: attemptedByDte.get(String(dte)) ?? 0,
        found: foundByDte.get(String(dte)) ?? 0,
      })),
      by_side: sides.map((optionSide) => ({
        option_side: optionSide,
        requested: requestedBySide.get(optionSide) ?? 0,
        attempted: attemptedBySide.get(optionSide) ?? 0,
        found: foundBySide.get(optionSide) ?? 0,
      })),
      failure_reason_counts: [...failureReasons.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => ({ reason, count })),
    },
    evidence_cache: {
      summary: cacheSummary,
      checkpoints_fully_served: checkpoints.filter(
        (checkpoint) => checkpoint.cache_fully_served,
      ).length,
      checkpoints_requiring_provider_access: checkpoints.filter(
        (checkpoint) => checkpoint.provider_access_required,
      ).length,
    },
    rate_limit: rateLimit,
    continuation:
      pendingSessionDates.length > 0
        ? {
            cursor: encodeContinuation(continuationPayload),
            completed_session_dates: completedSessionDates,
            unresolved_session_dates: pendingSessionDates,
            unattempted_session_dates: unattemptedSessionDates,
            deferred_session_dates: deferredSessionDates,
            deferred_checkpoints: deferredCheckpoints,
            provider_rate_limit: providerRateLimit,
          }
        : null,
    warnings: [
      "TRADING_SESSIONS_ARE_CALLER_SUPPLIED",
      "RANGE_RESULTS_PRESERVE_SINGLE_CHECKPOINT_DISCOVERY_SEMANTICS",
      "CONTINUATION_RESULTS_ARE_INCREMENTAL",
      "CONTINUATION_PRIORITIZES_FIRST_PASS_BEFORE_DEFERRED_RETRIES",
      "PROVIDER_RATE_LIMIT_COOLDOWNS_ARE_DURABLE_ACROSS_CONTINUATIONS",
    ],
  };
}
