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
import type { HistoricalCandidateCandles } from "./historical-spx-reconstruction.js";
import {
  normalizeDate,
  resolveCheckpoint,
  type ResolvedCheckpoint,
} from "./time.js";

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
  } | null;
  attempt_errors: Array<{
    attempt: number;
    category: HistoricalSpxCandidateRangeFailureCategory;
    code: string | null;
    message: string;
    retryable: boolean;
  }>;
  cache_fully_served: boolean;
  provider_access_required: boolean;
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

type ContinuationPayload = {
  contract_version: typeof HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION;
  request_id: string;
  completed: Array<{
    session_date: string;
    status: RangeCompletionStatus;
  }>;
  pending_session_dates: string[];
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
  continuation: {
    cursor: string | null;
    completed_session_dates: string[];
    unresolved_session_dates: string[];
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

function encodeContinuation(payload: ContinuationPayload): string {
  const serialized = canonicalJson(payload);
  const encoded = Buffer.from(serialized, "utf8").toString("base64url");
  return `v1.${encoded}.${createHash("sha256")
    .update(serialized)
    .digest("hex")}`;
}

function decodeContinuation(
  cursor: string,
  requestId: string,
  sessionDates: string[],
): ContinuationPayload {
  const parts = cursor.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
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
  const payload = parsed as Partial<ContinuationPayload>;
  if (
    payload.contract_version !==
      HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION ||
    payload.request_id !== requestId ||
    !Array.isArray(payload.completed) ||
    !Array.isArray(payload.pending_session_dates)
  ) {
    throw new Error(
      "continuation_cursor does not match this logical range request.",
    );
  }

  const statusValues = new Set<RangeCompletionStatus>([
    "AVAILABLE",
    "PARTIAL",
    "NOT_AVAILABLE",
  ]);
  const completed = payload.completed.map((entry) => {
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
  const pendingSessionDates = payload.pending_session_dates;
  if (
    pendingSessionDates.some((date) => typeof date !== "string") ||
    new Set(pendingSessionDates).size !== pendingSessionDates.length ||
    new Set(completed.map((entry) => entry.session_date)).size !==
      completed.length
  ) {
    throw new Error("continuation_cursor contains duplicate or invalid dates.");
  }

  const completedDates = new Set(completed.map((entry) => entry.session_date));
  const pendingDates = new Set(pendingSessionDates);
  const expected = new Set(sessionDates);
  if (
    [...completedDates].some(
      (date) => !expected.has(date) || pendingDates.has(date),
    ) ||
    [...pendingDates].some((date) => !expected.has(date)) ||
    sessionDates.some(
      (date) => !completedDates.has(date) && !pendingDates.has(date),
    ) ||
    pendingSessionDates.some(
      (date, index) =>
        date !== sessionDates.filter((item) => pendingDates.has(item))[index],
    )
  ) {
    throw new Error(
      "continuation_cursor progress does not match this range request.",
    );
  }

  return {
    contract_version: HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
    request_id: requestId,
    completed,
    pending_session_dates: pendingSessionDates,
  };
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
        pending_session_dates: sessionDates,
      };

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
      pending_session_dates: continuation.pending_session_dates,
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
    };
  }
  if (error instanceof EvidenceCacheError) {
    if (retryable && error.cause) return classifyFailure(error.cause);
    return {
      category: "CACHE_ERROR",
      code,
      message,
      retryable,
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
    };
  }
  return {
    category: "PROVIDER_ERROR",
    code,
    message,
    retryable,
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
      },
    );
    return classifyFailure(error);
  });
  if (failures.every((failure) => failure.category === "PROVIDER_TIMEOUT")) {
    return failures[0];
  }
  if (
    failures.every(
      (failure) => failure.category === "PROVIDER_RATE_LIMIT",
    )
  ) {
    return failures[0];
  }
  return {
    category: "PROVIDER_ERROR",
    code: null,
    message: [...new Set(failures.map((failure) => failure.message))].join(
      "; ",
    ),
    retryable: failures.every((failure) => failure.retryable),
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

async function runCheckpoint(
  checkpoint: PlannedCheckpoint,
  backtester: HistoricalCandidateBacktester,
  candles: HistoricalCandidateCandles | undefined,
  plan: HistoricalSpxCandidatesRangePlan,
  runtime: Required<HistoricalSpxCandidateRangeRuntime>,
): Promise<HistoricalSpxCandidateRangeCheckpoint> {
  const deadlineAt = runtime.now() + plan.checkpoint_deadline_ms;
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
        cache_fully_served: cacheFullyServed(bestResult),
        provider_access_required: providerAccessRequired(
          checkpoint,
          bestResult,
          failure,
        ),
      };
    }

    try {
      const result = await runtime.discover(
        backtester,
        checkpoint.input,
        candles,
        { deadline_ms: remaining },
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
        cache_fully_served: cacheFullyServed(result),
        provider_access_required: providerAccessRequired(
          checkpoint,
          result,
          failure,
        ),
      };
    } catch (error) {
      const failure = classifyFailure(error);
      attemptErrors.push({ attempt, ...failure });
      if (
        failure.retryable &&
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
        cache_fully_served: cacheFullyServed(bestResult),
        provider_access_required: providerAccessRequired(
          checkpoint,
          bestResult,
          failure,
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
  };
  const pendingAtStart = new Set(plan.pending_session_dates);
  const toRun = prepared.checkpoints
    .filter((checkpoint) => pendingAtStart.has(checkpoint.session_date))
    .slice(0, plan.max_checkpoints_per_run);
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
      ),
  );

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
  const allSessionDates = prepared.checkpoints.map(
    (checkpoint) => checkpoint.session_date,
  );
  const pendingSessionDates = allSessionDates.filter(
    (sessionDate) => !completed.has(sessionDate),
  );
  const completedSessionDates = allSessionDates.filter((sessionDate) =>
    completed.has(sessionDate),
  );
  const continuationPayload: ContinuationPayload = {
    contract_version: HISTORICAL_SPX_CANDIDATE_RANGE_CONTRACT_VERSION,
    request_id: plan.request_id,
    completed: completedSessionDates.map((sessionDate) => ({
      session_date: sessionDate,
      status: completed.get(sessionDate) as RangeCompletionStatus,
    })),
    pending_session_dates: pendingSessionDates,
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
    for (const attempt of checkpoint.result?.attempts ?? []) {
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
    continuation:
      pendingSessionDates.length > 0
        ? {
            cursor: encodeContinuation(continuationPayload),
            completed_session_dates: completedSessionDates,
            unresolved_session_dates: pendingSessionDates,
          }
        : null,
    warnings: [
      "TRADING_SESSIONS_ARE_CALLER_SUPPLIED",
      "RANGE_RESULTS_PRESERVE_SINGLE_CHECKPOINT_DISCOVERY_SEMANTICS",
      "CONTINUATION_RESULTS_ARE_INCREMENTAL",
    ],
  };
}
