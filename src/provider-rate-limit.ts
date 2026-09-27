const DEFAULT_FALLBACK_DELAYS_MS = [10_000, 30_000, 90_000] as const;
const DEFAULT_MAX_FALLBACK_DELAY_MS = 15 * 60_000;
const DEFAULT_JITTER_RATIO = 0.2;

export type ProviderRateLimitSource =
  | "RETRY_AFTER"
  | "X_RATE_LIMIT_RESET"
  | "FALLBACK";

export type ProviderRateLimitCause = "HTTP_429" | "ACTIVE_COOLDOWN";

export type ProviderRateLimitMetadata = {
  provider: string;
  cooldown_until: string;
  last_429_at: string;
  retry_after_seconds: number;
  rate_limit_count: number;
  remaining: number | null;
  source: ProviderRateLimitSource;
  cause: ProviderRateLimitCause;
};

export type ProviderRateLimitState = ProviderRateLimitMetadata & {
  cooldown_active: boolean;
};

export type ProviderRateLimiterOptions = {
  provider: string;
  min_interval_ms?: number;
  fallback_delays_ms?: readonly number[];
  max_fallback_delay_ms?: number;
  jitter_ratio?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

type HeaderCollection = {
  get?: (name: string) => unknown;
  [key: string]: unknown;
};

type RateLimitedErrorShape = {
  provider_rate_limit?: unknown;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Provider request was rate limited.";
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const collection = headers as HeaderCollection;
  if (typeof collection.get === "function") {
    const value = collection.get(name);
    if (Array.isArray(value)) return value.join(", ");
    if (value !== undefined && value !== null) return String(value);
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(collection)) {
    if (key.toLowerCase() !== target || value === undefined || value === null) {
      continue;
    }
    return Array.isArray(value) ? value.join(", ") : String(value);
  }
  return null;
}

function responseHeaders(error: unknown): unknown {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return null;
  return (response as { headers?: unknown }).headers ?? null;
}

function retryAfterTime(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = finiteNonNegative(value);
  if (seconds !== null) return now + Math.ceil(seconds * 1_000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(now, parsed) : null;
}

function resetTime(value: string | null, now: number): number | null {
  const numeric = finiteNonNegative(value);
  if (numeric === null) return null;
  if (numeric >= 10_000_000_000) return Math.max(now, Math.ceil(numeric));
  if (numeric >= 1_000_000_000) {
    return Math.max(now, Math.ceil(numeric * 1_000));
  }
  return now + Math.ceil(numeric * 1_000);
}

function remainingRequests(headers: unknown): number | null {
  const value = finiteNonNegative(
    headerValue(headers, "x-ratelimit-remaining"),
  );
  return value === null ? null : Math.floor(value);
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizedInteger(
  value: unknown,
  minimum: number,
): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function normalizedMetadata(value: unknown): ProviderRateLimitMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const provider =
    typeof candidate.provider === "string" && candidate.provider.trim()
      ? candidate.provider
      : null;
  const cooldownUntil = normalizedTimestamp(candidate.cooldown_until);
  const last429At = normalizedTimestamp(candidate.last_429_at);
  const retryAfterSeconds = finiteNonNegative(
    candidate.retry_after_seconds,
  );
  const rateLimitCount = normalizedInteger(candidate.rate_limit_count, 0);
  const remaining =
    candidate.remaining === null
      ? null
      : normalizedInteger(candidate.remaining, 0);
  const sourceValues = new Set<ProviderRateLimitSource>([
    "RETRY_AFTER",
    "X_RATE_LIMIT_RESET",
    "FALLBACK",
  ]);
  const causeValues = new Set<ProviderRateLimitCause>([
    "HTTP_429",
    "ACTIVE_COOLDOWN",
  ]);
  if (
    provider === null ||
    cooldownUntil === null ||
    last429At === null ||
    retryAfterSeconds === null ||
    rateLimitCount === null ||
    (candidate.remaining !== null && remaining === null) ||
    !sourceValues.has(candidate.source as ProviderRateLimitSource) ||
    !causeValues.has(candidate.cause as ProviderRateLimitCause)
  ) {
    return null;
  }
  return {
    provider,
    cooldown_until: cooldownUntil,
    last_429_at: last429At,
    retry_after_seconds: retryAfterSeconds,
    rate_limit_count: rateLimitCount,
    remaining,
    source: candidate.source as ProviderRateLimitSource,
    cause: candidate.cause as ProviderRateLimitCause,
  };
}

export function providerRateLimitMetadataFromError(
  error: unknown,
): ProviderRateLimitMetadata | null {
  if (!error || typeof error !== "object") return null;
  return normalizedMetadata(
    (error as RateLimitedErrorShape).provider_rate_limit,
  );
}

export class ProviderRateLimitError extends Error {
  readonly code = "PROVIDER_RATE_LIMIT";
  readonly retryable = true;
  readonly response = { status: 429 };

  constructor(
    message: string,
    readonly provider_rate_limit: ProviderRateLimitMetadata,
  ) {
    super(message);
    this.name = "ProviderRateLimitError";
  }
}

class ProviderRequestAbortedError extends Error {
  readonly code = "ERR_CANCELED";
  readonly retryable = true;

  constructor() {
    super("Provider request was aborted before it started.");
    this.name = "ProviderRequestAbortedError";
  }
}

function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ProviderRequestAbortedError());
  }
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ProviderRequestAbortedError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class ProviderRateLimiter {
  private readonly provider: string;
  private readonly minIntervalMs: number;
  private readonly fallbackDelaysMs: readonly number[];
  private readonly maxFallbackDelayMs: number;
  private readonly jitterRatio: number;
  private readonly now: () => number;
  private readonly sleep: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  private readonly random: () => number;
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private cooldownUntil = 0;
  private last429At: number | null = null;
  private retryAfterSeconds = 0;
  private rateLimitCount = 0;
  private consecutiveRateLimits = 0;
  private remaining: number | null = null;
  private source: ProviderRateLimitSource = "FALLBACK";

  constructor(options: ProviderRateLimiterOptions) {
    if (!options.provider.trim()) {
      throw new Error("provider must be non-empty.");
    }
    this.provider = options.provider;
    this.minIntervalMs = this.nonNegativeInteger(
      options.min_interval_ms ?? 0,
      "min_interval_ms",
    );
    this.fallbackDelaysMs =
      options.fallback_delays_ms ?? DEFAULT_FALLBACK_DELAYS_MS;
    if (
      this.fallbackDelaysMs.length === 0 ||
      this.fallbackDelaysMs.some(
        (value) => !Number.isInteger(value) || value < 0,
      )
    ) {
      throw new Error(
        "fallback_delays_ms must contain non-negative integers.",
      );
    }
    this.maxFallbackDelayMs = this.nonNegativeInteger(
      options.max_fallback_delay_ms ??
        DEFAULT_MAX_FALLBACK_DELAY_MS,
      "max_fallback_delay_ms",
    );
    if (
      typeof options.jitter_ratio === "number" &&
      (!Number.isFinite(options.jitter_ratio) ||
        options.jitter_ratio < 0 ||
        options.jitter_ratio > 1)
    ) {
      throw new Error("jitter_ratio must be between 0 and 1.");
    }
    this.jitterRatio = options.jitter_ratio ?? DEFAULT_JITTER_RATIO;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
  }

  private nonNegativeInteger(value: number, field: string): number {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer.`);
    }
    return value;
  }

  private fallbackDelay(): number {
    const index = Math.min(
      this.consecutiveRateLimits - 1,
      this.fallbackDelaysMs.length - 1,
    );
    const terminal = this.fallbackDelaysMs.at(-1) ?? 0;
    const growth =
      this.consecutiveRateLimits <= this.fallbackDelaysMs.length
        ? this.fallbackDelaysMs[index]
        : terminal *
          3 **
            (this.consecutiveRateLimits - this.fallbackDelaysMs.length);
    const bounded = Math.min(growth, this.maxFallbackDelayMs);
    const random = Math.min(1, Math.max(0, this.random()));
    const multiplier =
      1 - this.jitterRatio + random * this.jitterRatio * 2;
    return Math.min(
      this.maxFallbackDelayMs,
      Math.max(0, Math.round(bounded * multiplier)),
    );
  }

  private metadata(cause: ProviderRateLimitCause): ProviderRateLimitMetadata {
    const now = this.now();
    return {
      provider: this.provider,
      cooldown_until: new Date(this.cooldownUntil).toISOString(),
      last_429_at: new Date(this.last429At ?? now).toISOString(),
      retry_after_seconds: this.retryAfterSeconds,
      rate_limit_count: this.rateLimitCount,
      remaining: this.remaining,
      source: this.source,
      cause,
    };
  }

  private activeCooldownError(): ProviderRateLimitError {
    return new ProviderRateLimitError(
      `${this.provider} is cooling down until ${new Date(
        this.cooldownUntil,
      ).toISOString()}.`,
      this.metadata("ACTIVE_COOLDOWN"),
    );
  }

  private async start<T>(
    operation: () => T,
    signal?: AbortSignal,
  ): Promise<T> {
    let release = () => {};
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (signal?.aborted) throw new ProviderRequestAbortedError();
      let now = this.now();
      if (this.cooldownUntil > now) throw this.activeCooldownError();
      const delay = Math.max(0, this.nextRequestAt - now);
      if (delay > 0) await this.sleep(delay, signal);
      now = this.now();
      if (this.cooldownUntil > now) throw this.activeCooldownError();
      this.nextRequestAt = Math.max(this.nextRequestAt, now) +
        this.minIntervalMs;
      return operation();
    } finally {
      release();
    }
  }

  async waitForPermission(signal?: AbortSignal): Promise<void> {
    await this.start(() => undefined, signal);
  }

  async run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.start(operation, signal);
  }

  recordRateLimit(error: unknown): ProviderRateLimitError {
    const observedAt = this.now();
    const headers = responseHeaders(error);
    const retryAfter = retryAfterTime(
      headerValue(headers, "retry-after"),
      observedAt,
    );
    const reset = resetTime(
      headerValue(headers, "x-ratelimit-reset"),
      observedAt,
    );
    this.consecutiveRateLimits += 1;
    this.rateLimitCount += 1;
    this.remaining = remainingRequests(headers);

    let proposedUntil: number;
    let source: ProviderRateLimitSource;
    if (retryAfter !== null) {
      proposedUntil = retryAfter;
      source = "RETRY_AFTER";
    } else if (reset !== null) {
      proposedUntil = reset;
      source = "X_RATE_LIMIT_RESET";
    } else {
      proposedUntil = observedAt + this.fallbackDelay();
      source = "FALLBACK";
    }

    if (proposedUntil >= this.cooldownUntil) {
      this.cooldownUntil = proposedUntil;
      this.source = source;
    }
    this.last429At = observedAt;
    this.retryAfterSeconds = Math.max(
      0,
      Math.ceil((this.cooldownUntil - observedAt) / 1_000),
    );
    return new ProviderRateLimitError(
      errorMessage(error),
      this.metadata("HTTP_429"),
    );
  }

  recordSuccess(headers?: unknown): void {
    this.consecutiveRateLimits = 0;
    const remaining = remainingRequests(headers);
    if (remaining !== null) this.remaining = remaining;
  }

  getState(): ProviderRateLimitState | null {
    if (this.last429At === null) return null;
    return {
      ...this.metadata("HTTP_429"),
      cooldown_active: this.cooldownUntil > this.now(),
    };
  }
}
