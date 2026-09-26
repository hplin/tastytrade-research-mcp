import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ExactDecimal } from "./decimal.js";
import type {
  CandleSession,
  HistoricalCandle,
  HistoricalCandleInstrument,
  HistoricalCandlesBatchInput,
  HistoricalCandlesFailureReason,
  HistoricalCandlesInput,
  HistoricalCandlesResult,
  InstrumentType,
} from "./historical-candles.js";
import { edgeCoverageWarnings } from "./historical-candles.js";
import {
  candleSessionForResolutionProfile,
  normalizeResolutionProfile,
  resolutionMilliseconds,
  withEffectiveAggregation,
  type ResolutionProfile,
  type ResolutionProfileSession,
} from "./resolution-profile.js";
import {
  normalizeRfc3339,
  resolveCheckpoint,
  type LocalCheckpointInput,
} from "./time.js";

export const BOUNDED_HISTORY_CONTRACT_VERSION = "1.0.0" as const;
export const BOUNDED_HISTORY_PAGE_CONTRACT_VERSION = "1.0.0" as const;

export type BoundedHistoryField =
  | "OHLC"
  | "TRADE_PRICE"
  | "IMPLIED_VOLATILITY"
  | "DELTA"
  | "BID_ASK"
  | "OPEN_INTEREST"
  | "VOLUME";

export type BoundedHistoryEntitlement =
  | "CONFIRMED"
  | "UNCONFIRMED"
  | "UNAVAILABLE";

export type BoundedHistoryAuthorization =
  | {
      status: "NOT_APPROVED";
      reason: string;
    }
  | {
      status: "APPROVED";
      approval_reference: string;
      approved_at: string;
      provider_id: string;
      dataset_id: string;
      license_scope_id: string;
    };

export type BoundedHistoryProviderConfig = {
  provider_id: string;
  dataset_id: string;
  license_scope_id: string;
  source_revision: string;
  endpoint: string;
  allowed_hosts: string[];
  credential_environment_variables: string[];
  authorization: BoundedHistoryAuthorization;
  capabilities: {
    maximum_window_ms: number;
    maximum_total_window_ms: number;
    maximum_symbols_per_request: number;
    maximum_pages_per_shard: number;
    maximum_records_per_request: number;
    page_size: number;
    supports_session_filtering: boolean;
    expired_symbol_coverage: BoundedHistoryEntitlement;
    cache_reuse: BoundedHistoryEntitlement;
    field_entitlements: Record<
      BoundedHistoryField,
      BoundedHistoryEntitlement
    >;
    native_field_allowlist: Partial<
      Record<BoundedHistoryField, string[]>
    >;
    earliest_available_at: string | null;
  };
  retry: {
    maximum_attempts: number;
    base_delay_ms: number;
    maximum_delay_ms: number;
    request_timeout_ms: number;
  };
};

export type BoundedHistoryInstrument = {
  exact_symbol: string;
  native_symbol?: string;
  instrument_type: InstrumentType;
  lifecycle: "ACTIVE" | "EXPIRED" | "UNKNOWN";
};

type BoundedHistoryWindowInput =
  | {
      start_time: string;
      end_time: string;
      local_start?: never;
      local_end?: never;
    }
  | {
      start_time?: never;
      end_time?: never;
      local_start: LocalCheckpointInput;
      local_end: LocalCheckpointInput;
    };

export type BoundedHistoryRequestInput = BoundedHistoryWindowInput & {
  instruments: BoundedHistoryInstrument[];
  resolution: string;
  requested_fields: BoundedHistoryField[];
  as_of: string;
  session?: CandleSession;
  maximum_records?: number;
  maximum_response_bytes?: number;
  deadline_ms?: number;
};

export type BoundedHistoryWindow = {
  index: number;
  start: string;
  stop_exclusive: string;
};

export type NormalizedBoundedHistoryRequest = {
  contract_version: typeof BOUNDED_HISTORY_CONTRACT_VERSION;
  request_id: string;
  provider_id: string;
  dataset_id: string;
  license_scope_id: string;
  source_revision: string;
  endpoint: string;
  approval_reference: string;
  instruments: Array<{
    exact_symbol: string;
    native_symbol: string;
    instrument_type: InstrumentType;
    lifecycle: "ACTIVE" | "EXPIRED" | "UNKNOWN";
  }>;
  resolution: string;
  requested_fields: BoundedHistoryField[];
  requested_range: {
    start: string;
    stop_exclusive: string;
  };
  as_of: string;
  session: CandleSession;
  maximum_records: number;
  maximum_response_bytes: number;
  deadline_ms: number;
  shards: BoundedHistoryWindow[];
};

export type BoundedHistoryNativeValue =
  | string
  | number
  | boolean
  | null;

export type BoundedHistoryNormalizedValuesInput = {
  open: string | number | null;
  high: string | number | null;
  low: string | number | null;
  close: string | number | null;
  trade_price: string | number | null;
  volume: string | number | null;
  vwap: string | number | null;
  bid_volume: string | number | null;
  ask_volume: string | number | null;
  implied_volatility: string | number | null;
  delta: string | number | null;
  bid_price: string | number | null;
  ask_price: string | number | null;
  open_interest: string | number | null;
};

export type BoundedHistoryProviderRecordInput = {
  exact_symbol: string;
  native_symbol: string;
  instrument_type: InstrumentType;
  resolution: string;
  source_time: string;
  bar_start: string;
  bar_end: string;
  available_at: string;
  revision: string;
  method: string;
  field_methods: Partial<Record<BoundedHistoryField, string>>;
  native_fields: Record<string, BoundedHistoryNativeValue>;
  normalized: BoundedHistoryNormalizedValuesInput;
  warnings?: string[];
};

export type BoundedHistoryProviderPageInput = {
  contract_version: typeof BOUNDED_HISTORY_PAGE_CONTRACT_VERSION;
  provider_id: string;
  dataset_id: string;
  source_revision: string;
  window: {
    start: string;
    stop_exclusive: string;
  };
  records: BoundedHistoryProviderRecordInput[];
  next_cursor: string | null;
  partial: boolean;
  warnings: string[];
};

export type BoundedHistoryPageRequest = {
  contract_version: typeof BOUNDED_HISTORY_CONTRACT_VERSION;
  provider_id: string;
  dataset_id: string;
  source_revision: string;
  endpoint: string;
  redirect_policy: "ERROR";
  window: BoundedHistoryWindow;
  instruments: NormalizedBoundedHistoryRequest["instruments"];
  resolution: string;
  requested_fields: BoundedHistoryField[];
  session: CandleSession;
  cursor: string | null;
  page_size: number;
};

export type BoundedHistoryTransport = {
  fetchPage(
    request: BoundedHistoryPageRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
};

export type BoundedHistoryRecord = {
  exact_symbol: string;
  native_symbol: string;
  instrument_type: InstrumentType;
  resolution: string;
  source_time: string;
  bar_start: string;
  bar_end: string;
  available_at: string;
  retrieved_at: string;
  revision: string;
  method: string;
  field_methods: Partial<Record<BoundedHistoryField, string>>;
  native_fields: Record<string, BoundedHistoryNativeValue>;
  normalized: {
    open: string | null;
    high: string | null;
    low: string | null;
    close: string | null;
    trade_price: string | null;
    volume: string | null;
    vwap: string | null;
    bid_volume: string | null;
    ask_volume: string | null;
    implied_volatility: string | null;
    delta: string | null;
    bid_price: string | null;
    ask_price: string | null;
    open_interest: string | null;
  };
  warnings: string[];
};

export type BoundedHistoryFailureCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_TEMPORARY_FAILURE"
  | "PROVIDER_ERROR"
  | "PROVIDER_SCHEMA_MISMATCH"
  | "PROVIDER_PARTIAL_RESPONSE"
  | "PAGE_LIMIT_EXCEEDED"
  | "MAXIMUM_RECORDS_EXCEEDED"
  | "MAXIMUM_RESPONSE_BYTES_EXCEEDED"
  | "DEADLINE_EXCEEDED";

export type BoundedHistoryShardResult = BoundedHistoryWindow & {
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  pages: number;
  records: number;
  failure_code: BoundedHistoryFailureCode | null;
  warnings: string[];
};

export type BoundedHistoryResult = {
  contract_version: typeof BOUNDED_HISTORY_CONTRACT_VERSION;
  request_id: string;
  status: "COMPLETE" | "PARTIAL" | "NOT_AVAILABLE";
  provider_id: string;
  dataset_id: string;
  license_scope_id: string;
  source_revision: string;
  approval_reference: string;
  requested_range: {
    start: string;
    stop_exclusive: string;
  };
  as_of: string;
  resolution: string;
  requested_fields: BoundedHistoryField[];
  records: BoundedHistoryRecord[];
  shards: BoundedHistoryShardResult[];
  coverage: {
    requested_symbols: number;
    symbols_with_records: number;
    records: number;
    fields: Record<
      BoundedHistoryField,
      {
        available: number;
        missing: number;
      }
    >;
  };
  resource_usage: {
    pages: number;
    received_records: number;
    received_bytes: number;
  };
  retrieved_at: string;
  warnings: string[];
};

export class BoundedHistoryError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_NOT_APPROVED"
      | "APPROVAL_SCOPE_MISMATCH"
      | "UNTRUSTED_PROVIDER_HOST"
      | "TASTYTRADE_CREDENTIAL_REUSE_FORBIDDEN"
      | "FIELD_ENTITLEMENT_UNCONFIRMED"
      | "EXPIRED_SYMBOL_COVERAGE_UNCONFIRMED"
      | "CACHE_REUSE_NOT_APPROVED"
      | "REQUEST_WINDOW_TOO_LARGE"
      | "INVALID_PROVIDER_CONFIG"
      | BoundedHistoryFailureCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BoundedHistoryError";
  }
}

type NormalizedConfig = Omit<
  BoundedHistoryProviderConfig,
  "authorization" | "endpoint" | "allowed_hosts"
> & {
  endpoint: string;
  allowed_hosts: string[];
  authorization: Extract<
    BoundedHistoryAuthorization,
    { status: "APPROVED" }
  >;
};

type NormalizedPage = {
  records: BoundedHistoryRecord[];
  nextCursor: string | null;
  partial: boolean;
  warnings: string[];
};

const ALL_FIELDS: BoundedHistoryField[] = [
  "OHLC",
  "TRADE_PRICE",
  "IMPLIED_VOLATILITY",
  "DELTA",
  "BID_ASK",
  "OPEN_INTEREST",
  "VOLUME",
];
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SENSITIVE_NATIVE_FIELD_PATTERN =
  /(^|_)(authorization|access_token|refresh_token|client_secret|password|api_key|quote_token)($|_)/i;
const SENSITIVE_NATIVE_VALUE_PATTERN =
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|\b(?:access_token|refresh_token|client_secret|api_key|password)=|(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:$|[^A-Za-z0-9_-])/i;
const MAX_DEADLINE_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const INSTRUMENT_TYPES = new Set<InstrumentType>([
  "EQUITY",
  "INDEX",
  "OPTION",
  "FUTURE",
  "FUTURE_OPTION",
  "CRYPTO",
]);
const INSTRUMENT_LIFECYCLES = new Set([
  "ACTIVE",
  "EXPIRED",
  "UNKNOWN",
] as const);
const RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_TEMPORARY_FAILURE",
]);

function stableId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedIdentifier(
  value: string,
  field: string,
  maximum = 200,
): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    !IDENTIFIER_PATTERN.test(normalized)
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      `${field} must be a non-sensitive 1-${maximum} character identifier.`,
    );
  }
  return normalized;
}

function positiveInteger(
  value: number,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      `${field} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function nonnegativeInteger(
  value: number,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      `${field} must be an integer between 0 and ${maximum}.`,
    );
  }
  return value;
}

function normalizedHost(value: string, field: string): string {
  const host = value.trim().toLowerCase();
  if (
    !host ||
    host.includes("/") ||
    host.includes("@") ||
    host.includes(":") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    isIP(host) !== 0
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      `${field} must be a public hostname without credentials, path, or port.`,
    );
  }
  return host;
}

function sensitiveNativeFieldName(value: string): boolean {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    SENSITIVE_NATIVE_FIELD_PATTERN.test(value) ||
    [
      "authorization",
      "accesstoken",
      "refreshtoken",
      "clientsecret",
      "password",
      "secret",
      "apikey",
      "quotetoken",
      "token",
      "credential",
      "cookie",
    ].some((term) => compact.includes(term))
  );
}

function normalizedNativeFieldName(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      `${field} must be a native field name.`,
    );
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    sensitiveNativeFieldName(normalized)
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      `${field} must be a non-sensitive 1-200 character native field name.`,
    );
  }
  return normalized;
}

function normalizeConfig(
  input: BoundedHistoryProviderConfig,
): NormalizedConfig {
  const providerId = normalizedIdentifier(
    input.provider_id,
    "provider_id",
  );
  const datasetId = normalizedIdentifier(input.dataset_id, "dataset_id");
  const licenseScopeId = normalizedIdentifier(
    input.license_scope_id,
    "license_scope_id",
  );
  const sourceRevision = normalizedIdentifier(
    input.source_revision,
    "source_revision",
  );
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new BoundedHistoryError(
      "UNTRUSTED_PROVIDER_HOST",
      "Historical provider endpoint must be an absolute HTTPS URL.",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.port && endpoint.port !== "443") ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new BoundedHistoryError(
      "UNTRUSTED_PROVIDER_HOST",
      "Historical provider endpoint must use HTTPS without embedded credentials, query, fragment, or a nonstandard port.",
    );
  }
  if (
    !Array.isArray(input.allowed_hosts) ||
    input.allowed_hosts.length === 0
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      "allowed_hosts must contain at least one fixed provider hostname.",
    );
  }
  const allowedHosts = [
    ...new Set(
      input.allowed_hosts.map((host, index) =>
        normalizedHost(host, `allowed_hosts[${index}]`),
      ),
    ),
  ].sort();
  if (!allowedHosts.includes(endpoint.hostname.toLowerCase())) {
    throw new BoundedHistoryError(
      "UNTRUSTED_PROVIDER_HOST",
      `Historical provider host ${endpoint.hostname} is not allowlisted.`,
    );
  }
  if (!Array.isArray(input.credential_environment_variables)) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      "credential_environment_variables must be an array.",
    );
  }
  const credentialEnvironmentVariables = [
    ...new Set(
      input.credential_environment_variables.map((name, index) => {
        const normalized = name.trim();
        if (!ENV_NAME_PATTERN.test(normalized)) {
          throw new BoundedHistoryError(
            "INVALID_PROVIDER_CONFIG",
            `credential_environment_variables[${index}] must be an environment variable name.`,
          );
        }
        if (normalized.startsWith("TASTYTRADE_")) {
          throw new BoundedHistoryError(
            "TASTYTRADE_CREDENTIAL_REUSE_FORBIDDEN",
            `Historical provider credentials must not reuse ${normalized}.`,
          );
        }
        return normalized;
      }),
    ),
  ];
  if (input.authorization.status !== "APPROVED") {
    throw new BoundedHistoryError(
      "PROVIDER_NOT_APPROVED",
      input.authorization.reason.trim() ||
        "Historical provider use has not been approved.",
    );
  }
  const approval = {
    status: "APPROVED" as const,
    approval_reference: normalizedIdentifier(
      input.authorization.approval_reference,
      "authorization.approval_reference",
    ),
    approved_at: normalizeRfc3339(
      input.authorization.approved_at,
      "authorization.approved_at",
    ),
    provider_id: normalizedIdentifier(
      input.authorization.provider_id,
      "authorization.provider_id",
    ),
    dataset_id: normalizedIdentifier(
      input.authorization.dataset_id,
      "authorization.dataset_id",
    ),
    license_scope_id: normalizedIdentifier(
      input.authorization.license_scope_id,
      "authorization.license_scope_id",
    ),
  };
  if (
    approval.provider_id !== providerId ||
    approval.dataset_id !== datasetId ||
    approval.license_scope_id !== licenseScopeId
  ) {
    throw new BoundedHistoryError(
      "APPROVAL_SCOPE_MISMATCH",
      "Approval must exactly match provider_id, dataset_id, and license_scope_id.",
    );
  }
  const capabilities = {
    maximum_window_ms: positiveInteger(
      input.capabilities.maximum_window_ms,
      "capabilities.maximum_window_ms",
    ),
    maximum_total_window_ms: positiveInteger(
      input.capabilities.maximum_total_window_ms,
      "capabilities.maximum_total_window_ms",
    ),
    maximum_symbols_per_request: positiveInteger(
      input.capabilities.maximum_symbols_per_request,
      "capabilities.maximum_symbols_per_request",
      1_000,
    ),
    maximum_pages_per_shard: positiveInteger(
      input.capabilities.maximum_pages_per_shard,
      "capabilities.maximum_pages_per_shard",
      10_000,
    ),
    maximum_records_per_request: positiveInteger(
      input.capabilities.maximum_records_per_request,
      "capabilities.maximum_records_per_request",
      1_000_000,
    ),
    page_size: positiveInteger(
      input.capabilities.page_size,
      "capabilities.page_size",
      100_000,
    ),
    supports_session_filtering:
      input.capabilities.supports_session_filtering,
    expired_symbol_coverage:
      input.capabilities.expired_symbol_coverage,
    cache_reuse: input.capabilities.cache_reuse,
    field_entitlements: { ...input.capabilities.field_entitlements },
    native_field_allowlist: {} as Partial<
      Record<BoundedHistoryField, string[]>
    >,
    earliest_available_at:
      input.capabilities.earliest_available_at === null
        ? null
        : normalizeRfc3339(
            input.capabilities.earliest_available_at,
            "capabilities.earliest_available_at",
          ),
  };
  if (
    capabilities.maximum_window_ms >
    capabilities.maximum_total_window_ms
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      "maximum_window_ms must not exceed maximum_total_window_ms.",
    );
  }
  if (typeof capabilities.supports_session_filtering !== "boolean") {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      "capabilities.supports_session_filtering must be boolean.",
    );
  }
  if (
    !["CONFIRMED", "UNCONFIRMED", "UNAVAILABLE"].includes(
      capabilities.expired_symbol_coverage,
    ) ||
    !["CONFIRMED", "UNCONFIRMED", "UNAVAILABLE"].includes(
      capabilities.cache_reuse,
    )
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      "Historical symbol and cache entitlements must be explicit.",
    );
  }
  for (const field of ALL_FIELDS) {
    if (
      !["CONFIRMED", "UNCONFIRMED", "UNAVAILABLE"].includes(
        capabilities.field_entitlements[field],
      )
    ) {
      throw new BoundedHistoryError(
        "INVALID_PROVIDER_CONFIG",
        `capabilities.field_entitlements.${field} is invalid.`,
      );
    }
  }
  if (
    !input.capabilities.native_field_allowlist ||
    typeof input.capabilities.native_field_allowlist !== "object" ||
    Array.isArray(input.capabilities.native_field_allowlist)
  ) {
    throw new BoundedHistoryError(
      "INVALID_PROVIDER_CONFIG",
      "capabilities.native_field_allowlist must be an object.",
    );
  }
  const nativeFieldAllowlist: Partial<
    Record<BoundedHistoryField, string[]>
  > = {};
  const assignedNativeFields = new Set<string>();
  for (const field of ALL_FIELDS) {
    const configured =
      input.capabilities.native_field_allowlist[field] ?? [];
    if (!Array.isArray(configured)) {
      throw new BoundedHistoryError(
        "INVALID_PROVIDER_CONFIG",
        `capabilities.native_field_allowlist.${field} must be an array.`,
      );
    }
    const names = [
      ...new Set(
        configured.map((name, index) =>
          normalizedNativeFieldName(
            name,
            `capabilities.native_field_allowlist.${field}[${index}]`,
          ),
        ),
      ),
    ];
    for (const name of names) {
      if (assignedNativeFields.has(name)) {
        throw new BoundedHistoryError(
          "INVALID_PROVIDER_CONFIG",
          `Native field ${name} must map to exactly one normalized field entitlement.`,
        );
      }
      assignedNativeFields.add(name);
    }
    nativeFieldAllowlist[field] = names;
  }
  capabilities.native_field_allowlist = nativeFieldAllowlist;
  return {
    provider_id: providerId,
    dataset_id: datasetId,
    license_scope_id: licenseScopeId,
    source_revision: sourceRevision,
    endpoint: endpoint.toString(),
    allowed_hosts: allowedHosts,
    credential_environment_variables: credentialEnvironmentVariables,
    authorization: approval,
    capabilities,
    retry: {
      maximum_attempts: positiveInteger(
        input.retry.maximum_attempts,
        "retry.maximum_attempts",
        10,
      ),
      base_delay_ms: nonnegativeInteger(
        input.retry.base_delay_ms,
        "retry.base_delay_ms",
        60_000,
      ),
      maximum_delay_ms: nonnegativeInteger(
        input.retry.maximum_delay_ms,
        "retry.maximum_delay_ms",
        60_000,
      ),
      request_timeout_ms: positiveInteger(
        input.retry.request_timeout_ms,
        "retry.request_timeout_ms",
        MAX_DEADLINE_MS,
      ),
    },
  };
}

export function splitBoundedHistoryWindow(
  start: string,
  stopExclusive: string,
  maximumWindowMs: number,
): BoundedHistoryWindow[] {
  const normalizedStart = normalizeRfc3339(start, "start");
  const normalizedStop = normalizeRfc3339(
    stopExclusive,
    "stop_exclusive",
  );
  const startMs = Date.parse(normalizedStart);
  const stopMs = Date.parse(normalizedStop);
  if (stopMs <= startMs) {
    throw new Error("stop_exclusive must be later than start.");
  }
  positiveInteger(maximumWindowMs, "maximum_window_ms");
  const windows: BoundedHistoryWindow[] = [];
  let cursor = startMs;
  while (cursor < stopMs) {
    const next = Math.min(cursor + maximumWindowMs, stopMs);
    windows.push({
      index: windows.length,
      start: new Date(cursor).toISOString(),
      stop_exclusive: new Date(next).toISOString(),
    });
    cursor = next;
  }
  return windows;
}

function normalizeSession(input: CandleSession | undefined): CandleSession {
  const timezone = (value: string, field: string): string => {
    const normalized = value.trim();
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: normalized,
      }).format(new Date(0));
    } catch {
      throw new Error(`${field} must be a valid IANA timezone.`);
    }
    return normalized;
  };
  if (!input || input.kind === "ALL") {
    return {
      kind: "ALL",
      timezone: timezone(input?.timezone ?? "UTC", "session.timezone"),
    };
  }
  if (input.kind === "REGULAR") {
    return {
      kind: "REGULAR",
      timezone: timezone(
        input.timezone ?? "America/New_York",
        "session.timezone",
      ),
    };
  }
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.start_time) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.end_time)
  ) {
    throw new Error(
      "CUSTOM session start_time and end_time must use HH:mm.",
    );
  }
  return {
    kind: "CUSTOM",
    timezone: timezone(input.timezone, "session.timezone"),
    start_time: input.start_time,
    end_time: input.end_time,
  };
}

function resolvedWindow(input: BoundedHistoryRequestInput): {
  start: string;
  stopExclusive: string;
} {
  if ("local_start" in input) {
    return {
      start: resolveCheckpoint(
        undefined,
        input.local_start,
        "bounded_history.start",
      ).instant,
      stopExclusive: resolveCheckpoint(
        undefined,
        input.local_end,
        "bounded_history.end",
      ).instant,
    };
  }
  return {
    start: normalizeRfc3339(
      input.start_time,
      "bounded_history.start_time",
    ),
    stopExclusive: normalizeRfc3339(
      input.end_time,
      "bounded_history.end_time",
    ),
  };
}

function normalizeInstruments(
  instruments: BoundedHistoryInstrument[],
  maximum: number,
): NormalizedBoundedHistoryRequest["instruments"] {
  if (
    !Array.isArray(instruments) ||
    instruments.length === 0 ||
    instruments.length > maximum
  ) {
    throw new Error(
      `instruments must contain between 1 and ${maximum} exact symbols.`,
    );
  }
  const normalized = instruments.map((instrument, index) => {
    if (!instrument || typeof instrument !== "object") {
      throw new Error(`instruments[${index}] must be an object.`);
    }
    if (
      typeof instrument.exact_symbol !== "string" ||
      (instrument.native_symbol !== undefined &&
        typeof instrument.native_symbol !== "string")
    ) {
      throw new Error(
        `instruments[${index}] exact_symbol and native_symbol must be strings.`,
      );
    }
    const exactSymbol = instrument.exact_symbol.trim();
    const nativeSymbol = (instrument.native_symbol ?? exactSymbol).trim();
    if (
      !exactSymbol ||
      !nativeSymbol ||
      exactSymbol.length > 512 ||
      nativeSymbol.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(exactSymbol) ||
      /[\u0000-\u001f\u007f]/.test(nativeSymbol)
    ) {
      throw new Error(
        `instruments[${index}] exact_symbol and native_symbol must be printable 1-512 character values.`,
      );
    }
    if (!INSTRUMENT_TYPES.has(instrument.instrument_type)) {
      throw new Error(
        `instruments[${index}].instrument_type is unsupported.`,
      );
    }
    if (!INSTRUMENT_LIFECYCLES.has(instrument.lifecycle)) {
      throw new Error(
        `instruments[${index}].lifecycle must be ACTIVE, EXPIRED, or UNKNOWN.`,
      );
    }
    return {
      exact_symbol: exactSymbol,
      native_symbol: nativeSymbol,
      instrument_type: instrument.instrument_type,
      lifecycle: instrument.lifecycle,
    };
  });
  if (
    new Set(normalized.map((instrument) => instrument.exact_symbol)).size !==
    normalized.length
  ) {
    throw new Error("instruments must contain unique exact_symbol values.");
  }
  if (
    new Set(normalized.map((instrument) => instrument.native_symbol)).size !==
    normalized.length
  ) {
    throw new Error("instruments must contain unique native_symbol values.");
  }
  return normalized;
}

function normalizeRequestedFields(
  fields: BoundedHistoryField[],
  config: NormalizedConfig,
): BoundedHistoryField[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("requested_fields must not be empty.");
  }
  for (const field of fields) {
    if (!ALL_FIELDS.includes(field)) {
      throw new Error(`Unsupported historical field ${String(field)}.`);
    }
  }
  const requested = new Set(fields);
  const normalized = ALL_FIELDS.filter((field) => requested.has(field));
  for (const field of normalized) {
    if (config.capabilities.field_entitlements[field] !== "CONFIRMED") {
      throw new BoundedHistoryError(
        "FIELD_ENTITLEMENT_UNCONFIRMED",
        `Provider entitlement for ${field} is not confirmed.`,
      );
    }
  }
  return normalized;
}

function normalizeBoundedHistoryRequestWithConfig(
  input: BoundedHistoryRequestInput,
  config: NormalizedConfig,
): NormalizedBoundedHistoryRequest {
  const range = resolvedWindow(input);
  const startMs = Date.parse(range.start);
  const stopMs = Date.parse(range.stopExclusive);
  if (stopMs <= startMs) {
    throw new Error("Historical stop time must be later than start time.");
  }
  if (
    stopMs - startMs >
    config.capabilities.maximum_total_window_ms
  ) {
    throw new BoundedHistoryError(
      "REQUEST_WINDOW_TOO_LARGE",
      "Historical request exceeds the approved total window.",
    );
  }
  const asOf = normalizeRfc3339(input.as_of, "bounded_history.as_of");
  if (stopMs > Date.parse(asOf)) {
    throw new Error(
      "Historical request stop must not be later than as_of.",
    );
  }
  if (
    config.capabilities.earliest_available_at !== null &&
    startMs <
      Date.parse(config.capabilities.earliest_available_at)
  ) {
    throw new BoundedHistoryError(
      "REQUEST_WINDOW_TOO_LARGE",
      "Historical request starts before the approved retention boundary.",
    );
  }
  const instruments = normalizeInstruments(
    input.instruments,
    config.capabilities.maximum_symbols_per_request,
  );
  if (config.capabilities.expired_symbol_coverage !== "CONFIRMED") {
    throw new BoundedHistoryError(
      "EXPIRED_SYMBOL_COVERAGE_UNCONFIRMED",
      "This adapter is blocked until the provider confirms expired-symbol coverage required by the historical research scope.",
    );
  }
  const session = normalizeSession(input.session);
  if (
    session.kind !== "ALL" &&
    !config.capabilities.supports_session_filtering
  ) {
    throw new BoundedHistoryError(
      "FIELD_ENTITLEMENT_UNCONFIRMED",
      "The approved provider contract does not support session filtering.",
    );
  }
  const requestedFields = normalizeRequestedFields(
    input.requested_fields,
    config,
  );
  const resolution = input.resolution.trim().toLowerCase();
  resolutionMilliseconds(resolution);
  const maximumRecords = positiveInteger(
    input.maximum_records ??
      config.capabilities.maximum_records_per_request,
    "maximum_records",
    config.capabilities.maximum_records_per_request,
  );
  const maximumResponseBytes = positiveInteger(
    input.maximum_response_bytes ?? MAX_RESPONSE_BYTES,
    "maximum_response_bytes",
    MAX_RESPONSE_BYTES,
  );
  const deadlineMs = positiveInteger(
    input.deadline_ms ?? MAX_DEADLINE_MS,
    "deadline_ms",
    MAX_DEADLINE_MS,
  );
  const shards = splitBoundedHistoryWindow(
    range.start,
    range.stopExclusive,
    config.capabilities.maximum_window_ms,
  );
  const identity = {
    contract_version: BOUNDED_HISTORY_CONTRACT_VERSION,
    provider_id: config.provider_id,
    dataset_id: config.dataset_id,
    license_scope_id: config.license_scope_id,
    source_revision: config.source_revision,
    approval_reference: config.authorization.approval_reference,
    instruments,
    resolution,
    requested_fields: requestedFields,
    requested_range: {
      start: range.start,
      stop_exclusive: range.stopExclusive,
    },
    as_of: asOf,
    session,
    maximum_records: maximumRecords,
    maximum_response_bytes: maximumResponseBytes,
    deadline_ms: deadlineMs,
    shards,
  };
  return {
    ...identity,
    request_id: stableId(identity),
    endpoint: config.endpoint,
  };
}

function errorCode(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function failureCode(error: unknown): BoundedHistoryFailureCode {
  const code = errorCode(error);
  if (code === "PROVIDER_TIMEOUT" || code === "ETIMEDOUT") {
    return "PROVIDER_TIMEOUT";
  }
  if (code === "PROVIDER_RATE_LIMIT" || code === "RATE_LIMITED") {
    return "PROVIDER_RATE_LIMIT";
  }
  if (code === "PROVIDER_SCHEMA_MISMATCH") {
    return "PROVIDER_SCHEMA_MISMATCH";
  }
  if (code === "PAGE_LIMIT_EXCEEDED") return "PAGE_LIMIT_EXCEEDED";
  if (code === "MAXIMUM_RECORDS_EXCEEDED") {
    return "MAXIMUM_RECORDS_EXCEEDED";
  }
  if (code === "MAXIMUM_RESPONSE_BYTES_EXCEEDED") {
    return "MAXIMUM_RESPONSE_BYTES_EXCEEDED";
  }
  if (code === "DEADLINE_EXCEEDED") return "DEADLINE_EXCEEDED";
  if (
    code === "PROVIDER_TEMPORARY_FAILURE" ||
    (code !== null && RETRYABLE_CODES.has(code)) ||
    (error &&
      typeof error === "object" &&
      "retryable" in error &&
      error.retryable === true)
  ) {
    return "PROVIDER_TEMPORARY_FAILURE";
  }
  return "PROVIDER_ERROR";
}

function retryable(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "retryable" in error &&
    error.retryable === true
  ) {
    return true;
  }
  const code = errorCode(error);
  return code !== null && RETRYABLE_CODES.has(code);
}

function message(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : String(error);
}

function recordObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `${field} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `${field} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function safeProviderString(
  value: unknown,
  field: string,
  maximum = 500,
): string {
  const normalized = requiredString(value, field);
  if (
    normalized.length > maximum ||
    SENSITIVE_NATIVE_VALUE_PATTERN.test(normalized)
  ) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `${field} is too long or contains credential-shaped data.`,
    );
  }
  return normalized;
}

function nullableDecimal(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `${field} must be a decimal or null.`,
    );
  }
  try {
    return ExactDecimal.parse(value, field).toString();
  } catch (error) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      message(error),
    );
  }
}

function normalizedWarnings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `${field} must be an array.`,
    );
  }
  return [
    ...new Set(
      value.map((warning, index) =>
        safeProviderString(warning, `${field}[${index}]`),
      ),
    ),
  ];
}

function normalizeNativeFields(
  value: unknown,
  field: string,
  allowedFields: ReadonlySet<string>,
): Record<string, BoundedHistoryNativeValue> {
  const object = recordObject(value, field);
  const normalized: Record<string, BoundedHistoryNativeValue> = {};
  for (const [key, item] of Object.entries(object)) {
    if (
      !key.trim() ||
      key.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(key) ||
      sensitiveNativeFieldName(key)
    ) {
      throw new BoundedHistoryError(
        "PROVIDER_SCHEMA_MISMATCH",
        `${field} contains an empty or sensitive field name.`,
      );
    }
    if (!allowedFields.has(key)) {
      throw new BoundedHistoryError(
        "PROVIDER_SCHEMA_MISMATCH",
        `${field}.${key} is not allowlisted for the requested fields.`,
      );
    }
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new BoundedHistoryError(
        "PROVIDER_SCHEMA_MISMATCH",
        `${field}.${key} must be a scalar or null.`,
      );
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new BoundedHistoryError(
        "PROVIDER_SCHEMA_MISMATCH",
        `${field}.${key} must be finite.`,
      );
    }
    if (
      typeof item === "string" &&
      (item.length > 10_000 ||
        SENSITIVE_NATIVE_VALUE_PATTERN.test(item))
    ) {
      throw new BoundedHistoryError(
        "PROVIDER_SCHEMA_MISMATCH",
        `${field}.${key} contains a credential-shaped value.`,
      );
    }
    normalized[key] = item;
  }
  return normalized;
}

function normalizeFieldMethods(
  value: unknown,
  field: string,
): Partial<Record<BoundedHistoryField, string>> {
  const object = recordObject(value, field);
  const normalized: Partial<Record<BoundedHistoryField, string>> = {};
  for (const [key, item] of Object.entries(object)) {
    if (!ALL_FIELDS.includes(key as BoundedHistoryField)) {
      throw new BoundedHistoryError(
        "PROVIDER_SCHEMA_MISMATCH",
        `${field}.${key} is not a supported field.`,
      );
    }
    normalized[key as BoundedHistoryField] = safeProviderString(
      item,
      `${field}.${key}`,
    );
  }
  return normalized;
}

function fieldPresent(
  record: Pick<BoundedHistoryRecord, "normalized">,
  field: BoundedHistoryField,
): boolean {
  const values = record.normalized;
  if (field === "OHLC") {
    return [values.open, values.high, values.low, values.close].some(
      (value) => value !== null,
    );
  }
  if (field === "TRADE_PRICE") return values.trade_price !== null;
  if (field === "IMPLIED_VOLATILITY") {
    return values.implied_volatility !== null;
  }
  if (field === "DELTA") return values.delta !== null;
  if (field === "BID_ASK") {
    return values.bid_price !== null || values.ask_price !== null;
  }
  if (field === "OPEN_INTEREST") {
    return values.open_interest !== null;
  }
  return [
    values.volume,
    values.vwap,
    values.bid_volume,
    values.ask_volume,
  ].some((value) => value !== null);
}

function availableField(
  record: Pick<BoundedHistoryRecord, "normalized">,
  field: BoundedHistoryField,
): boolean {
  const values = record.normalized;
  if (field === "OHLC") {
    return (
      values.open !== null &&
      values.high !== null &&
      values.low !== null &&
      values.close !== null
    );
  }
  if (field === "TRADE_PRICE") return values.trade_price !== null;
  if (field === "IMPLIED_VOLATILITY") {
    return values.implied_volatility !== null;
  }
  if (field === "DELTA") return values.delta !== null;
  if (field === "BID_ASK") {
    return values.bid_price !== null && values.ask_price !== null;
  }
  if (field === "OPEN_INTEREST") {
    return values.open_interest !== null;
  }
  return values.volume !== null;
}

function normalizeRecord(
  value: unknown,
  index: number,
  request: NormalizedBoundedHistoryRequest,
  window: BoundedHistoryWindow,
  retrievedAt: string,
  config: NormalizedConfig,
): BoundedHistoryRecord {
  const input = recordObject(value, `records[${index}]`);
  const exactSymbol = requiredString(
    input.exact_symbol,
    `records[${index}].exact_symbol`,
  );
  const requestedInstrument = request.instruments.find(
    (instrument) => instrument.exact_symbol === exactSymbol,
  );
  if (!requestedInstrument) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `records[${index}].exact_symbol was not requested.`,
    );
  }
  const nativeSymbol = requiredString(
    input.native_symbol,
    `records[${index}].native_symbol`,
  );
  if (nativeSymbol !== requestedInstrument.native_symbol) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `records[${index}].native_symbol does not match the request.`,
    );
  }
  const instrumentType = requiredString(
    input.instrument_type,
    `records[${index}].instrument_type`,
  );
  if (instrumentType !== requestedInstrument.instrument_type) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `records[${index}].instrument_type does not match the request.`,
    );
  }
  const resolution = requiredString(
    input.resolution,
    `records[${index}].resolution`,
  ).toLowerCase();
  if (resolution !== request.resolution) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `records[${index}].resolution does not match the request.`,
    );
  }
  const sourceTime = normalizeRfc3339(
    requiredString(
      input.source_time,
      `records[${index}].source_time`,
    ),
    `records[${index}].source_time`,
  );
  const availableAt = normalizeRfc3339(
    requiredString(
      input.available_at,
      `records[${index}].available_at`,
    ),
    `records[${index}].available_at`,
  );
  const barStart = normalizeRfc3339(
    requiredString(
      input.bar_start,
      `records[${index}].bar_start`,
    ),
    `records[${index}].bar_start`,
  );
  const barEnd = normalizeRfc3339(
    requiredString(
      input.bar_end,
      `records[${index}].bar_end`,
    ),
    `records[${index}].bar_end`,
  );
  if (
    Date.parse(sourceTime) < Date.parse(window.start) ||
    Date.parse(sourceTime) >= Date.parse(window.stop_exclusive)
  ) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `records[${index}].source_time is outside its requested shard.`,
    );
  }
  if (
    Date.parse(barStart) > Date.parse(sourceTime) ||
    Date.parse(barEnd) <= Date.parse(barStart) ||
    Date.parse(availableAt) < Date.parse(sourceTime) ||
    Date.parse(availableAt) < Date.parse(barEnd) ||
    Date.parse(availableAt) > Date.parse(request.as_of)
  ) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      `records[${index}].available_at is not timestamp-safe.`,
    );
  }
  const normalizedInput = recordObject(
    input.normalized,
    `records[${index}].normalized`,
  );
  const normalized = {
    open: nullableDecimal(
      normalizedInput.open,
      `records[${index}].normalized.open`,
    ),
    high: nullableDecimal(
      normalizedInput.high,
      `records[${index}].normalized.high`,
    ),
    low: nullableDecimal(
      normalizedInput.low,
      `records[${index}].normalized.low`,
    ),
    close: nullableDecimal(
      normalizedInput.close,
      `records[${index}].normalized.close`,
    ),
    trade_price: nullableDecimal(
      normalizedInput.trade_price,
      `records[${index}].normalized.trade_price`,
    ),
    volume: nullableDecimal(
      normalizedInput.volume,
      `records[${index}].normalized.volume`,
    ),
    vwap: nullableDecimal(
      normalizedInput.vwap,
      `records[${index}].normalized.vwap`,
    ),
    bid_volume: nullableDecimal(
      normalizedInput.bid_volume,
      `records[${index}].normalized.bid_volume`,
    ),
    ask_volume: nullableDecimal(
      normalizedInput.ask_volume,
      `records[${index}].normalized.ask_volume`,
    ),
    implied_volatility: nullableDecimal(
      normalizedInput.implied_volatility,
      `records[${index}].normalized.implied_volatility`,
    ),
    delta: nullableDecimal(
      normalizedInput.delta,
      `records[${index}].normalized.delta`,
    ),
    bid_price: nullableDecimal(
      normalizedInput.bid_price,
      `records[${index}].normalized.bid_price`,
    ),
    ask_price: nullableDecimal(
      normalizedInput.ask_price,
      `records[${index}].normalized.ask_price`,
    ),
    open_interest: nullableDecimal(
      normalizedInput.open_interest,
      `records[${index}].normalized.open_interest`,
    ),
  };
  const fieldMethods = normalizeFieldMethods(
    input.field_methods,
    `records[${index}].field_methods`,
  );
  const allowedNativeFields = new Set(
    request.requested_fields.flatMap(
      (field) =>
        config.capabilities.native_field_allowlist[field] ?? [],
    ),
  );
  const provisional = { normalized };
  for (const field of ALL_FIELDS) {
    const present = fieldPresent(provisional, field);
    if (present && !request.requested_fields.includes(field)) {
      throw new BoundedHistoryError(
        "PROVIDER_SCHEMA_MISMATCH",
        `records[${index}] contains non-requested ${field} data.`,
      );
    }
    if (present && !fieldMethods[field]) {
      throw new BoundedHistoryError(
        "PROVIDER_SCHEMA_MISMATCH",
        `records[${index}] has ${field} data without a declared method.`,
      );
    }
  }
  return {
    exact_symbol: exactSymbol,
    native_symbol: nativeSymbol,
    instrument_type:
      instrumentType as InstrumentType,
    resolution,
    source_time: sourceTime,
    bar_start: barStart,
    bar_end: barEnd,
    available_at: availableAt,
    retrieved_at: retrievedAt,
    revision: safeProviderString(
      input.revision,
      `records[${index}].revision`,
    ),
    method: safeProviderString(
      input.method,
      `records[${index}].method`,
    ),
    field_methods: fieldMethods,
    native_fields: normalizeNativeFields(
      input.native_fields,
      `records[${index}].native_fields`,
      allowedNativeFields,
    ),
    normalized,
    warnings: normalizedWarnings(
      input.warnings ?? [],
      `records[${index}].warnings`,
    ),
  };
}

function normalizePage(
  value: unknown,
  request: NormalizedBoundedHistoryRequest,
  window: BoundedHistoryWindow,
  retrievedAt: string,
  pageSize: number,
  config: NormalizedConfig,
): NormalizedPage {
  const input = recordObject(value, "provider page");
  if (
    input.contract_version !== BOUNDED_HISTORY_PAGE_CONTRACT_VERSION ||
    input.provider_id !== request.provider_id ||
    input.dataset_id !== request.dataset_id ||
    input.source_revision !== request.source_revision
  ) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      "Provider page identity does not match the approved request.",
    );
  }
  const pageWindow = recordObject(input.window, "provider page.window");
  if (
    pageWindow.start !== window.start ||
    pageWindow.stop_exclusive !== window.stop_exclusive
  ) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      "Provider page window does not match the requested shard.",
    );
  }
  if (
    !Array.isArray(input.records) ||
    input.records.length > pageSize
  ) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      "Provider page records exceed the declared page size.",
    );
  }
  if (
    input.next_cursor !== null &&
    (typeof input.next_cursor !== "string" ||
      !input.next_cursor.trim())
  ) {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      "Provider page next_cursor must be null or a non-empty string.",
    );
  }
  if (typeof input.partial !== "boolean") {
    throw new BoundedHistoryError(
      "PROVIDER_SCHEMA_MISMATCH",
      "Provider page partial must be boolean.",
    );
  }
  return {
    records: input.records.map((record, index) =>
      normalizeRecord(
        record,
        index,
        request,
        window,
        retrievedAt,
        config,
      ),
    ),
    nextCursor:
      input.next_cursor === null ? null : input.next_cursor.trim(),
    partial: input.partial,
    warnings: normalizedWarnings(
      input.warnings,
      "provider page.warnings",
    ),
  };
}

function recordKey(record: BoundedHistoryRecord): string {
  return [
    record.exact_symbol,
    record.native_symbol,
    record.resolution,
    record.source_time,
  ].join("\u0000");
}

function fieldCoverage(
  records: BoundedHistoryRecord[],
): BoundedHistoryResult["coverage"]["fields"] {
  return Object.fromEntries(
    ALL_FIELDS.map((field) => {
      const available = records.filter((record) =>
        availableField(record, field),
      ).length;
      return [
        field,
        {
          available,
          missing: records.length - available,
        },
      ];
    }),
  ) as BoundedHistoryResult["coverage"]["fields"];
}

function delayForAttempt(
  attempt: number,
  config: NormalizedConfig,
): number {
  return Math.min(
    config.retry.base_delay_ms * 2 ** Math.max(0, attempt - 1),
    config.retry.maximum_delay_ms,
  );
}

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(
        new BoundedHistoryError(
          "PROVIDER_TIMEOUT",
          `Historical provider request exceeded ${timeoutMs}ms.`,
          true,
        ),
      );
    }, timeoutMs);
    operation(controller.signal).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function directSession(
  session: CandleSession | undefined,
): ResolutionProfileSession {
  const normalized = normalizeSession(session);
  if (normalized.kind === "ALL") {
    return {
      kind: "ALL",
      timezone: normalized.timezone ?? "UTC",
      start_time: null,
      end_time: null,
    };
  }
  if (normalized.kind === "REGULAR") {
    return {
      kind: "REGULAR",
      timezone: normalized.timezone ?? "America/New_York",
      start_time: "09:30",
      end_time: "16:00",
    };
  }
  return {
    kind: "CUSTOM",
    timezone: normalized.timezone,
    start_time: normalized.start_time,
    end_time: normalized.end_time,
  };
}

function compatibilityProfile(
  input: HistoricalCandlesBatchInput,
  providerId: string,
): ResolutionProfile {
  const interval = input.interval.trim().toLowerCase();
  const session = directSession(input.session);
  const profile = normalizeResolutionProfile(
    input.resolution_profile,
    {
      default_requested_aggregation: interval,
      default_provider_id: providerId,
      default_max_observation_age_minutes: 0,
      default_max_temporal_skew_minutes: 0,
      default_fallback_aggregations: [],
      default_profile_id: input.resolution_profile
        ? undefined
        : "DIRECT_CANDLE_REQUEST",
      direct_session: session,
      direct_alignment:
        session.kind === "ALL" ? "MIDNIGHT" : "SESSION",
    },
  );
  if (profile.provider_id !== providerId) {
    throw new BoundedHistoryError(
      "APPROVAL_SCOPE_MISMATCH",
      `resolution_profile.provider_id must match approved provider ${providerId}.`,
    );
  }
  if (
    input.resolution_profile &&
    profile.requested_aggregation !== interval &&
    !profile.fallback_policy.aggregations.includes(interval)
  ) {
    throw new Error(
      "interval must match the requested aggregation or an allowed fallback.",
    );
  }
  if (
    input.resolution_profile &&
    input.session &&
    JSON.stringify(session) !== JSON.stringify(profile.session)
  ) {
    throw new Error(
      "session must match the selected resolution_profile session.",
    );
  }
  return withEffectiveAggregation(profile, interval);
}

function historicalFailureReasons(
  result: BoundedHistoryResult,
): HistoricalCandlesFailureReason[] {
  const reasons: HistoricalCandlesFailureReason[] = [];
  for (const shard of result.shards) {
    let mapped: HistoricalCandlesFailureReason | null;
    switch (shard.failure_code) {
      case null:
        mapped = null;
        break;
      case "PROVIDER_TIMEOUT":
      case "DEADLINE_EXCEEDED":
        mapped = "PROVIDER_TIMEOUT";
        break;
      case "PROVIDER_RATE_LIMIT":
        mapped = "PROVIDER_RATE_LIMIT";
        break;
      case "PROVIDER_TEMPORARY_FAILURE":
        mapped = "PROVIDER_TEMPORARY_FAILURE";
        break;
      case "PROVIDER_SCHEMA_MISMATCH":
        mapped = "PROVIDER_SCHEMA_MISMATCH";
        break;
      case "MAXIMUM_RECORDS_EXCEEDED":
        mapped = "LOCAL_RECEIVE_BUDGET_EXCEEDED";
        break;
      case "MAXIMUM_RESPONSE_BYTES_EXCEEDED":
        mapped = "LOCAL_BUFFER_BUDGET_EXCEEDED";
        break;
      default:
        mapped = "PROVIDER_PARTIAL_RESPONSE";
    }
    if (mapped !== null && !reasons.includes(mapped)) reasons.push(mapped);
  }
  return reasons;
}

export class BoundedHistoricalProviderAdapter {
  private readonly config: NormalizedConfig;

  constructor(
    config: BoundedHistoryProviderConfig,
    private readonly transport: BoundedHistoryTransport,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly elapsedClock: () => number = Date.now,
  ) {
    this.config = normalizeConfig(config);
  }

  normalizeRequest(
    input: BoundedHistoryRequestInput,
  ): NormalizedBoundedHistoryRequest {
    return normalizeBoundedHistoryRequestWithConfig(input, this.config);
  }

  assertEvidenceCacheAllowed(
    request: HistoricalCandlesBatchInput,
  ): void {
    if (this.config.capabilities.cache_reuse !== "CONFIRMED") {
      throw new BoundedHistoryError(
        "CACHE_REUSE_NOT_APPROVED",
        "Immutable cache storage/reuse is blocked until the provider license explicitly permits it.",
      );
    }
    if (
      request.resolution_profile?.provider_id !==
        this.config.provider_id ||
      request.evidence_cache?.dataset_id !== this.config.dataset_id ||
      request.evidence_cache?.license_scope_id !==
        this.config.license_scope_id ||
      request.evidence_cache?.source_revision !==
        this.config.source_revision ||
      request.evidence_cache?.as_of === undefined ||
      normalizeRfc3339(
        request.evidence_cache.as_of,
        "evidence_cache.as_of",
      ) !== normalizeRfc3339(request.end_time, "end_time") ||
      request.instruments.some(
        (instrument) => instrument.lifecycle === undefined,
      )
    ) {
      throw new BoundedHistoryError(
        "APPROVAL_SCOPE_MISMATCH",
        "Cached bounded-history requests must explicitly match the approved provider, dataset, license scope, source revision, end-time as_of, and instrument lifecycle.",
      );
    }
  }

  async getBoundedHistory(
    input: BoundedHistoryRequestInput,
  ): Promise<BoundedHistoryResult> {
    const request = this.normalizeRequest(input);
    const startedAt = this.elapsedClock();
    const records = new Map<string, BoundedHistoryRecord>();
    const shards: BoundedHistoryShardResult[] = [];
    const warnings: string[] = [];
    let pageCount = 0;
    let receivedRecords = 0;
    let receivedBytes = 0;
    let stop = false;

    for (const window of request.shards) {
      if (stop) break;
      const shardWarnings: string[] = [];
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      let pages = 0;
      let shardRecords = 0;
      let shardFailure: BoundedHistoryFailureCode | null = null;
      let partial = false;

      while (pages < this.config.capabilities.maximum_pages_per_shard) {
        const elapsed = this.elapsedClock() - startedAt;
        const remaining = request.deadline_ms - elapsed;
        if (remaining <= 0) {
          shardFailure = "DEADLINE_EXCEEDED";
          shardWarnings.push("BOUNDED_HISTORY_DEADLINE_EXCEEDED");
          stop = true;
          break;
        }
        let rawPage: unknown;
        let attempts = 0;
        try {
          while (true) {
            attempts += 1;
            const attemptRemaining =
              request.deadline_ms -
              (this.elapsedClock() - startedAt);
            if (attemptRemaining <= 0) {
              throw new BoundedHistoryError(
                "DEADLINE_EXCEEDED",
                "Historical provider request exceeded its total deadline.",
              );
            }
            try {
              rawPage = await withTimeout(
                (signal) =>
                  this.transport.fetchPage(
                    {
                      contract_version:
                        BOUNDED_HISTORY_CONTRACT_VERSION,
                      provider_id: request.provider_id,
                      dataset_id: request.dataset_id,
                      source_revision: request.source_revision,
                      endpoint: request.endpoint,
                      redirect_policy: "ERROR",
                      window,
                      instruments: request.instruments,
                      resolution: request.resolution,
                      requested_fields: request.requested_fields,
                      session: request.session,
                      cursor,
                      page_size: this.config.capabilities.page_size,
                    },
                    signal,
                  ),
                Math.min(
                  this.config.retry.request_timeout_ms,
                  attemptRemaining,
                ),
              );
              break;
            } catch (error) {
              if (
                !retryable(error) ||
                attempts >= this.config.retry.maximum_attempts
              ) {
                throw error;
              }
              const delay = delayForAttempt(attempts, this.config);
              const retryRemaining =
                request.deadline_ms -
                (this.elapsedClock() - startedAt);
              if (delay >= retryRemaining) {
                throw new BoundedHistoryError(
                  "DEADLINE_EXCEEDED",
                  "Historical provider retry would exceed the total deadline.",
                );
              }
              if (delay > 0) await this.sleep(delay);
            }
          }
          if (
            this.elapsedClock() - startedAt >=
            request.deadline_ms
          ) {
            throw new BoundedHistoryError(
              "DEADLINE_EXCEEDED",
              "Historical provider request exceeded its total deadline.",
            );
          }
          const pageRetrievedAt = new Date(this.clock()).toISOString();
          let rawPageBytes: number;
          try {
            rawPageBytes = Buffer.byteLength(
              JSON.stringify(rawPage),
              "utf8",
            );
          } catch {
            throw new BoundedHistoryError(
              "PROVIDER_SCHEMA_MISMATCH",
              "Provider page must be JSON serializable.",
            );
          }
          if (
            receivedBytes + rawPageBytes >
            request.maximum_response_bytes
          ) {
            throw new BoundedHistoryError(
              "MAXIMUM_RESPONSE_BYTES_EXCEEDED",
              "Historical provider response exceeded maximum_response_bytes.",
            );
          }
          const page = normalizePage(
            rawPage,
            request,
            window,
            pageRetrievedAt,
            this.config.capabilities.page_size,
            this.config,
          );
          if (
            this.elapsedClock() - startedAt >=
            request.deadline_ms
          ) {
            throw new BoundedHistoryError(
              "DEADLINE_EXCEEDED",
              "Historical provider response processing exceeded its total deadline.",
            );
          }
          if (
            receivedRecords + page.records.length >
            request.maximum_records
          ) {
            throw new BoundedHistoryError(
              "MAXIMUM_RECORDS_EXCEEDED",
              "Historical provider response exceeded maximum_records.",
            );
          }
          pages += 1;
          pageCount += 1;
          receivedBytes += rawPageBytes;
          receivedRecords += page.records.length;
          partial ||= page.partial;
          shardWarnings.push(...page.warnings);
          const pageRecords = new Map<string, BoundedHistoryRecord>();
          for (const record of page.records) {
            const key = recordKey(record);
            const previous = pageRecords.get(key) ?? records.get(key);
            if (
              previous &&
              JSON.stringify(previous) !== JSON.stringify(record)
            ) {
              throw new BoundedHistoryError(
                "PROVIDER_SCHEMA_MISMATCH",
                `Provider returned conflicting revisions for ${record.exact_symbol} at ${record.source_time}.`,
              );
            }
            if (!previous) pageRecords.set(key, record);
          }
          for (const [key, record] of pageRecords) {
            records.set(key, record);
            shardRecords += 1;
          }
          if (page.nextCursor === null) {
            cursor = null;
            break;
          }
          if (seenCursors.has(page.nextCursor)) {
            throw new BoundedHistoryError(
              "PROVIDER_SCHEMA_MISMATCH",
              "Provider pagination cursor repeated.",
            );
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        } catch (error) {
          shardFailure = failureCode(error);
          shardWarnings.push(shardFailure);
          if (
            shardFailure === "MAXIMUM_RECORDS_EXCEEDED" ||
            shardFailure === "MAXIMUM_RESPONSE_BYTES_EXCEEDED" ||
            shardFailure === "DEADLINE_EXCEEDED"
          ) {
            stop = true;
          }
          break;
        }
      }
      if (
        shardFailure === null &&
        cursor !== null &&
        pages >= this.config.capabilities.maximum_pages_per_shard
      ) {
        shardFailure = "PAGE_LIMIT_EXCEEDED";
        shardWarnings.push("BOUNDED_HISTORY_PAGE_LIMIT_EXCEEDED");
      }
      if (partial && shardFailure === null) {
        shardFailure = "PROVIDER_PARTIAL_RESPONSE";
        shardWarnings.push("PROVIDER_REPORTED_PARTIAL_RESPONSE");
      }
      warnings.push(...shardWarnings);
      shards.push({
        ...window,
        status:
          shardFailure === null
            ? "COMPLETE"
            : shardRecords > 0
              ? "PARTIAL"
              : "FAILED",
        pages,
        records: shardRecords,
        failure_code: shardFailure,
        warnings: [...new Set(shardWarnings)],
      });
    }

    const orderedRecords = [...records.values()].sort(
      (left, right) =>
        left.source_time.localeCompare(right.source_time) ||
        left.exact_symbol.localeCompare(right.exact_symbol) ||
        left.native_symbol.localeCompare(right.native_symbol),
    );
    const symbolsWithRecords = new Set(
      orderedRecords.map((record) => record.exact_symbol),
    ).size;
    const coverageFields = fieldCoverage(orderedRecords);
    if (symbolsWithRecords < request.instruments.length) {
      warnings.push("REQUESTED_SYMBOLS_WITHOUT_RECORDS");
    }
    if (shards.length < request.shards.length) {
      warnings.push("BOUNDED_HISTORY_SHARDS_NOT_ATTEMPTED");
    }
    if (
      request.requested_fields.some(
        (field) => coverageFields[field].missing > 0,
      )
    ) {
      warnings.push("REQUESTED_FIELDS_HAVE_NULLS");
    }
    const complete =
      shards.length === request.shards.length &&
      shards.every((shard) => shard.status === "COMPLETE") &&
      symbolsWithRecords === request.instruments.length &&
      request.requested_fields.every(
        (field) => coverageFields[field].missing === 0,
      );
    return {
      contract_version: BOUNDED_HISTORY_CONTRACT_VERSION,
      request_id: request.request_id,
      status:
        complete
          ? "COMPLETE"
          : orderedRecords.length > 0
            ? "PARTIAL"
            : "NOT_AVAILABLE",
      provider_id: request.provider_id,
      dataset_id: request.dataset_id,
      license_scope_id: request.license_scope_id,
      source_revision: request.source_revision,
      approval_reference: request.approval_reference,
      requested_range: request.requested_range,
      as_of: request.as_of,
      resolution: request.resolution,
      requested_fields: request.requested_fields,
      records: orderedRecords,
      shards,
      coverage: {
        requested_symbols: request.instruments.length,
        symbols_with_records: symbolsWithRecords,
        records: orderedRecords.length,
        fields: coverageFields,
      },
      resource_usage: {
        pages: pageCount,
        received_records: receivedRecords,
        received_bytes: receivedBytes,
      },
      retrieved_at: new Date(this.clock()).toISOString(),
      warnings: [...new Set(warnings)],
    };
  }

  async getHistoricalCandles(
    input: HistoricalCandlesInput,
  ): Promise<HistoricalCandlesResult> {
    const [result] = await this.getHistoricalCandlesBatch({
      instruments: [
        {
          symbol: input.symbol,
          streamer_symbol: input.streamer_symbol,
          instrument_type: input.instrument_type,
          lifecycle: input.lifecycle,
        },
      ],
      interval: input.interval,
      start_time: input.start_time,
      end_time: input.end_time,
      session: input.session,
      resolution_profile: input.resolution_profile,
      deadline_ms: input.deadline_ms,
      max_output_candles: input.max_output_candles,
      max_received_events: input.max_received_events,
      max_buffer_bytes: input.max_buffer_bytes,
      timeout_ms: input.timeout_ms,
      max_candles: input.max_candles,
      evidence_cache: input.evidence_cache,
    });
    return result;
  }

  async getHistoricalCandlesBatch(
    input: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]> {
    if (
      input.evidence_cache &&
      input.evidence_cache.mode !== "BYPASS"
    ) {
      throw new Error(
        "Evidence cache modes require CachedHistoricalCandlesService.",
      );
    }
    const profile = compatibilityProfile(input, this.config.provider_id);
    const maxOutput = positiveInteger(
      input.max_output_candles ?? input.max_candles ?? 10_000,
      "max_output_candles",
      250_000,
    );
    const deadline = positiveInteger(
      input.deadline_ms ?? input.timeout_ms ?? 15_000,
      "deadline_ms",
      MAX_DEADLINE_MS,
    );
    const maxReceived = positiveInteger(
      input.max_received_events ?? 10_000,
      "max_received_events",
      10_000_000,
    );
    const maxBufferBytes = positiveInteger(
      input.max_buffer_bytes ?? 16 * 1024 * 1024,
      "max_buffer_bytes",
      MAX_RESPONSE_BYTES,
    );
    const requestedFields = (
      [
        "OHLC",
        "IMPLIED_VOLATILITY",
        "DELTA",
        "BID_ASK",
        "OPEN_INTEREST",
        "VOLUME",
      ] as BoundedHistoryField[]
    ).filter(
      (field) =>
        field === "OHLC" ||
        this.config.capabilities.field_entitlements[field] ===
          "CONFIRMED",
    );
    const normalizedInstruments = input.instruments.map((instrument) => ({
      exact_symbol: instrument.symbol.trim().toUpperCase(),
      native_symbol:
        instrument.streamer_symbol?.trim() ??
        instrument.symbol.trim().toUpperCase(),
      instrument_type: instrument.instrument_type,
      lifecycle: instrument.lifecycle ?? "UNKNOWN",
    }));
    const normalizedSession =
      candleSessionForResolutionProfile(profile);
    const bounded = await this.getBoundedHistory({
      instruments: normalizedInstruments,
      resolution: input.interval,
      start_time: input.start_time,
      end_time: input.end_time,
      as_of: input.evidence_cache?.as_of ?? input.end_time,
      requested_fields: requestedFields,
      session: normalizedSession,
      maximum_records: Math.min(
        this.config.capabilities.maximum_records_per_request,
        maxReceived,
      ),
      maximum_response_bytes: maxBufferBytes,
      deadline_ms: deadline,
    });
    const allReceivedSymbols = [
      ...new Set(
        bounded.records.map((record) => record.native_symbol),
      ),
    ].sort();
    const failureReasons = historicalFailureReasons(bounded);
    const requestedSlots =
      Math.ceil(
        (Date.parse(input.end_time) - Date.parse(input.start_time)) /
          resolutionMilliseconds(input.interval),
      );

    return input.instruments.map((instrument, instrumentIndex) => {
      const normalizedInstrument =
        normalizedInstruments[instrumentIndex];
      const exactSymbol = normalizedInstrument.exact_symbol;
      const matching = bounded.records.filter(
        (record) => record.exact_symbol === exactSymbol,
      );
      const skipped = matching.filter(
        (record) => !availableField(record, "OHLC"),
      );
      const allCandles: HistoricalCandle[] = matching
        .filter((record) => availableField(record, "OHLC"))
        .map((record) => ({
          source_time: record.source_time,
          bar_start: record.bar_start,
          bar_end: record.bar_end,
          available_at: record.available_at,
          retrieved_at: record.retrieved_at,
          open: record.normalized.open!,
          high: record.normalized.high!,
          low: record.normalized.low!,
          close: record.normalized.close!,
          volume: record.normalized.volume,
          vwap: record.normalized.vwap,
          bid_volume: record.normalized.bid_volume,
          ask_volume: record.normalized.ask_volume,
          implied_volatility:
            record.normalized.implied_volatility,
          open_interest: record.normalized.open_interest,
          provider_evidence: {
            dataset_id: bounded.dataset_id,
            revision: record.revision,
            method: record.method,
            native_symbol: record.native_symbol,
            native_fields: record.native_fields,
            bid_price: record.normalized.bid_price,
            ask_price: record.normalized.ask_price,
            delta: record.normalized.delta,
            warnings: record.warnings,
          },
        }))
        .sort((left, right) =>
          left.source_time.localeCompare(right.source_time),
        );
      const outputTruncated = allCandles.length > maxOutput;
      const candles = allCandles.slice(0, maxOutput);
      const reasons = [...failureReasons];
      const warnings = [...bounded.warnings];
      const coverageWarnings = edgeCoverageWarnings(
        allCandles,
        Date.parse(bounded.requested_range.start),
        Date.parse(bounded.requested_range.stop_exclusive),
        resolutionMilliseconds(input.interval),
      );
      warnings.push(...coverageWarnings);
      if (
        coverageWarnings.length > 0 &&
        !reasons.includes("REQUESTED_WINDOW_NOT_COVERED")
      ) {
        reasons.push("REQUESTED_WINDOW_NOT_COVERED");
      }
      if (skipped.length > 0) {
        if (!reasons.includes("PROVIDER_PARTIAL_RESPONSE")) {
          reasons.push("PROVIDER_PARTIAL_RESPONSE");
        }
        warnings.push(
          `PROVIDER_RECORDS_WITHOUT_COMPLETE_OHLC:${skipped.length}`,
        );
      }
      if (outputTruncated) {
        reasons.push("LOCAL_OUTPUT_BUDGET_EXCEEDED");
        warnings.push("LOCAL_OUTPUT_BUDGET_EXCEEDED");
      }
      if (candles.length === 0) {
        reasons.push("MISSING_CONTRACT_EVIDENCE");
        warnings.push("NO_CANDLES_IN_REQUESTED_RANGE_AND_SESSION");
      }
      const uniqueReasons = [...new Set(reasons)];
      const snapshotComplete =
        bounded.status === "COMPLETE" &&
        skipped.length === 0 &&
        coverageWarnings.length === 0 &&
        !outputTruncated &&
        candles.length > 0;
      const bytes = Buffer.byteLength(
        JSON.stringify(matching),
        "utf8",
      );
      const counters = {
        received_events: matching.length,
        valid_candle_events: candles.length,
        unique_observations: candles.length,
        retained_rows: candles.length,
        retained_bytes: bytes,
        returned_rows: candles.length,
      };
      return {
        contract_version: "1.0.0",
        request_id: bounded.request_id,
        status:
          snapshotComplete && uniqueReasons.length === 0
            ? "AVAILABLE"
            : candles.length > 0
              ? "PARTIAL"
              : "NOT_AVAILABLE",
        symbol: exactSymbol,
        streamer_symbol:
          normalizedInstrument.native_symbol,
        instrument_type: normalizedInstrument.instrument_type,
        interval: input.interval.trim().toLowerCase(),
        requested_range: {
          start: bounded.requested_range.start,
          end: bounded.requested_range.stop_exclusive,
        },
        actual_range:
          candles.length === 0
            ? null
            : {
                start: candles[0].source_time,
                end: candles.at(-1)!.source_time,
              },
        timezone: profile.session.timezone,
        session: profile.session.kind,
        retrieved_at: bounded.retrieved_at,
        resolution_profile: profile,
        source: bounded.provider_id,
        source_timestamp_unit: "RFC3339",
        snapshot_complete: snapshotComplete,
        snapshot_truncated:
          bounded.shards.some(
            (shard) =>
              shard.failure_code === "PAGE_LIMIT_EXCEEDED" ||
              shard.failure_code === "MAXIMUM_RECORDS_EXCEEDED" ||
              shard.failure_code ===
                "MAXIMUM_RESPONSE_BYTES_EXCEEDED" ||
              shard.failure_code === "PROVIDER_PARTIAL_RESPONSE",
          ) ||
          skipped.length > 0 ||
          outputTruncated,
        provider_snapshot_complete:
          bounded.shards.every(
            (shard) => shard.status === "COMPLETE",
          ),
        failure_reasons: uniqueReasons,
        resource_usage: {
          limits: {
            max_output_candles_per_symbol: maxOutput,
            max_received_events_per_request:
              maxReceived,
            max_buffer_bytes_per_request:
              maxBufferBytes,
            deadline_ms_per_request: deadline,
            max_candles_compatibility_applied:
              input.max_output_candles === undefined &&
              input.max_candles !== undefined,
            timeout_ms_compatibility_applied:
              input.deadline_ms === undefined &&
              input.timeout_ms !== undefined,
          },
          request: {
            ...counters,
            received_events:
              bounded.resource_usage.received_records,
            valid_candle_events: bounded.records.filter((record) =>
              availableField(record, "OHLC"),
            ).length,
            unique_observations: bounded.records.length,
            retained_rows: bounded.records.length,
            returned_rows: bounded.records.filter((record) =>
              availableField(record, "OHLC"),
            ).length,
            unmatched_received_events: 0,
            unmatched_symbol_count: 0,
            peak_buffer_bytes: bounded.resource_usage.received_bytes,
          },
          symbol: counters,
        },
        transport_diagnostics: {
          requested_symbol:
            normalizedInstrument.native_symbol,
          canonical_requested_symbol:
            normalizedInstrument.native_symbol,
          received_symbols: allReceivedSymbols,
          canonical_received_symbols: allReceivedSymbols,
          unmatched_received_symbols: [],
          oldest_received_timestamp:
            candles[0]?.source_time ?? null,
          newest_received_timestamp:
            candles.at(-1)?.source_time ?? null,
          snapshot_begin_seen: bounded.records.length > 0,
          snapshot_end_seen:
            bounded.shards.every(
              (shard) => shard.status === "COMPLETE",
            ),
          snapshot_snip_seen:
            bounded.shards.some(
              (shard) =>
                shard.failure_code === "PROVIDER_PARTIAL_RESPONSE",
            ),
          timeout_stage: null,
        },
        advisory: {
          requested_window_candle_slots_per_symbol: requestedSlots,
          continuous_calendar_replay_slots_per_symbol:
            requestedSlots,
          continuous_calendar_replay_is_provider_fact: false,
        },
        resampled: false,
        candles,
        warnings: [...new Set(warnings)],
        bounded_history: {
          contract_version: BOUNDED_HISTORY_CONTRACT_VERSION,
          provider_id: bounded.provider_id,
          dataset_id: bounded.dataset_id,
          source_revision: bounded.source_revision,
          approval_reference: bounded.approval_reference,
          shard_count: bounded.shards.length,
          completed_shards: bounded.shards.filter(
            (shard) => shard.status === "COMPLETE",
          ).length,
          failed_shards: bounded.shards.filter(
            (shard) => shard.status !== "COMPLETE",
          ).length,
          page_count: bounded.shards.reduce(
            (total, shard) => total + shard.pages,
            0,
          ),
          requested_fields: bounded.requested_fields,
        },
      };
    });
  }
}
