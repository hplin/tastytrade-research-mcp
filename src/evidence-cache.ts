import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExecutionReferences } from "./execution-evidence.js";
import type {
  CandleSession,
  HistoricalCandlesBatchInput,
  HistoricalCandlesInput,
  HistoricalCandlesResult,
} from "./historical-candles.js";
import {
  normalizeResolutionProfile,
  withEffectiveAggregation,
  type ResolutionProfileSession,
} from "./resolution-profile.js";
import { normalizeRfc3339 } from "./time.js";

export const EVIDENCE_CACHE_CONTRACT_VERSION = "1.0.0" as const;

export type EvidenceCacheMode =
  | "BYPASS"
  | "READ_WRITE"
  | "REFRESH"
  | "CACHE_ONLY";

export type EvidenceRole =
  | "ENTRY"
  | "REFERENCE"
  | "REFERENCE_PATH"
  | "OUTCOME_3_TRADING_DAYS"
  | "OUTCOME_5_TRADING_DAYS";

export type EvidenceCacheRequest = {
  mode: EvidenceCacheMode;
  manifest_ids?: string[];
  dataset_id?: string;
  license_scope_id?: string;
  normalization_version?: string;
  model_version?: string;
  source_revision?: string;
  as_of?: string;
  evidence_role?: EvidenceRole;
  references?: ExecutionReferences;
};

export type EvidenceCacheRecord = {
  contract_version: typeof EVIDENCE_CACHE_CONTRACT_VERSION;
  cache_status:
    | "MISS"
    | "REFRESH"
    | "HIT"
    | "CACHE_ONLY_HIT"
    | "RETRYABLE_FAILURE"
    | "RETRYABLE_FAILURE_HIT";
  manifest_id: string;
  manifest_set_id: string | null;
  request_fingerprint: string;
  revision: number;
  evidence_role: EvidenceRole;
  provider_payload_content_id: string;
  normalized_content_id: string;
  bytes_read: number;
  bytes_written: number;
  provider_calls_avoided: number;
};

export type EvidenceCacheSummary = {
  contract_version: typeof EVIDENCE_CACHE_CONTRACT_VERSION;
  manifest_ids: string[];
  normalized_content_ids: string[];
  provider_payload_content_ids: string[];
  cache_hits: number;
  cache_misses: number;
  cache_only_hits: number;
  refreshes: number;
  retryable_failures: number;
  retryable_failure_hits: number;
  provider_calls_avoided: number;
  bytes_read: number;
  bytes_written: number;
};

export type FileEvidenceCacheConfig = {
  directory: string;
  maxBytes?: number;
  maxConcurrency?: number;
  retryableFailureTtlMs?: number;
  defaultMode?: Exclude<EvidenceCacheMode, "CACHE_ONLY">;
  datasetId?: string;
  licenseScopeId?: string;
  normalizationVersion?: string;
  modelVersion?: string;
  sourceRevision?: string;
  clock?: () => number;
};

type NormalizedEvidenceCacheRequest = {
  mode: EvidenceCacheMode;
  manifestIds: string[];
  datasetId: string;
  licenseScopeId: string;
  normalizationVersion: string;
  modelVersion: string;
  sourceRevision: string;
  asOf: string;
  evidenceRole: EvidenceRole;
  references: ExecutionReferences;
};

type SourceIdentity = {
  provider_id: string;
  dataset_id: string;
  license_scope_id: string;
  exact_symbols: Array<{
    symbol: string;
    streamer_symbol: string;
    instrument_type: string;
    lifecycle?: string;
  }>;
  aggregation: {
    requested: string;
    native: string;
    effective: string;
  };
  session: ResolutionProfileSession;
  alignment: "MIDNIGHT" | "SESSION";
  price_type: "LAST";
  request_range: {
    start: string;
    end: string;
  };
  as_of: string;
  resolution_profile: ReturnType<typeof withEffectiveAggregation>;
  resource_policy: {
    deadline_ms: number;
    max_output_candles: number;
    max_received_events: number;
    max_buffer_bytes: number;
    max_candles_compatibility_applied: boolean;
    timeout_ms_compatibility_applied: boolean;
  };
  normalization_version: string;
  model_version: string;
  source_revision: string;
};

type EvidenceContext = {
  evidence_role: EvidenceRole;
  references: ExecutionReferences;
};

type EvidenceObjectType =
  | "SANITIZED_PROVIDER_PAYLOAD"
  | "NORMALIZED_RESULT";

type EvidenceObjectReference = {
  object_type: EvidenceObjectType;
  content_id: string;
  checksum: string;
  byte_length: number;
  derived_from: string[];
};

type EvidenceObjectEnvelope = {
  contract_version: typeof EVIDENCE_CACHE_CONTRACT_VERSION;
  object_type: EvidenceObjectType;
  content_id: string;
  checksum: string;
  payload: unknown;
};

export type HistoricalSourceEvidenceManifest = {
  contract_version: typeof EVIDENCE_CACHE_CONTRACT_VERSION;
  manifest_type: "HISTORICAL_SOURCE_EVIDENCE";
  manifest_id: string;
  request_fingerprint: string;
  revision: number;
  recorded_at: string;
  retrieved_at: string[];
  source_identity: SourceIdentity;
  context: EvidenceContext;
  status: {
    freshness_policy: {
      max_observation_age_minutes: number;
      max_temporal_skew_minutes: number;
    };
    temporal_skew_minutes: number | null;
    results: Array<{
      symbol: string;
      streamer_symbol: string;
      status: HistoricalCandlesResult["status"];
      requested_range: HistoricalCandlesResult["requested_range"];
      actual_range: HistoricalCandlesResult["actual_range"];
      provider_snapshot_complete: boolean;
      snapshot_complete: boolean;
      snapshot_truncated: boolean;
      failure_reasons: HistoricalCandlesResult["failure_reasons"];
      warnings: string[];
      latest_available_at: string | null;
      observation_age_minutes: number | null;
    }>;
  };
  objects: {
    provider_payload: EvidenceObjectReference;
    normalized_result: EvidenceObjectReference;
  };
  lineage: {
    normalized_result_derived_from: string[];
    preserves_bar_fields: [
      "source_time",
      "bar_start",
      "bar_end",
      "available_at",
      "retrieved_at",
    ];
    retrieved_at_is_not_availability: true;
  };
  diff: {
    previous_manifest_id: string | null;
    provider_payload_changed: boolean;
    normalized_result_changed: boolean;
    changed_symbols: string[];
  };
  reused_evidence_from_manifest_id: string | null;
  cache_eligibility: "VALID_EVIDENCE" | "RETRYABLE_FAILURE";
  retryable_until: string | null;
};

export type HistoricalSourceFailureManifest = {
  contract_version: typeof EVIDENCE_CACHE_CONTRACT_VERSION;
  manifest_type: "HISTORICAL_SOURCE_FAILURE";
  manifest_id: string;
  request_fingerprint: string;
  recorded_at: string;
  expires_at: string | null;
  retryable: boolean;
  source_identity: SourceIdentity;
  context: EvidenceContext;
  error: {
    name: string;
    message: string;
    code: string | null;
  };
};

export type EvidenceManifestSet = {
  contract_version: typeof EVIDENCE_CACHE_CONTRACT_VERSION;
  manifest_type: "EVIDENCE_MANIFEST_SET";
  manifest_id: string;
  label: string;
  entry_as_of: string;
  created_at: string;
  manifests: Array<{
    evidence_role: EvidenceRole;
    manifest_id: string;
  }>;
};

export type EvidenceManifest =
  | HistoricalSourceEvidenceManifest
  | HistoricalSourceFailureManifest
  | EvidenceManifestSet;

type RequestIndex = {
  contract_version: typeof EVIDENCE_CACHE_CONTRACT_VERSION;
  index_type: "REQUEST_REVISIONS";
  request_fingerprint: string;
  updated_at: string;
  manifest_ids: string[];
  checksum: string;
};

type FailureIndex = {
  contract_version: typeof EVIDENCE_CACHE_CONTRACT_VERSION;
  index_type: "RETRYABLE_FAILURE";
  request_fingerprint: string;
  manifest_id: string;
  expires_at: string;
  updated_at: string;
  checksum: string;
};

type CachePlan = {
  cache: NormalizedEvidenceCacheRequest;
  sourceIdentity: SourceIdentity;
  requestFingerprint: string;
  context: EvidenceContext;
};

export type EvidenceCacheMetrics = {
  cache_hits: number;
  cache_misses: number;
  cache_only_hits: number;
  refreshes: number;
  retryable_failures: number;
  retryable_failure_hits: number;
  failure_cache_hits: number;
  provider_calls: number;
  provider_calls_avoided: number;
  bytes_read: number;
  bytes_written: number;
};

type HistoricalCandlesProvider = {
  assertEvidenceCacheAllowed?(
    request: HistoricalCandlesBatchInput,
  ): void;
  getHistoricalCandles(
    request: HistoricalCandlesInput,
  ): Promise<HistoricalCandlesResult>;
  getHistoricalCandlesBatch?(
    request: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]>;
};

type StoredEvidence = {
  manifest: HistoricalSourceEvidenceManifest;
  results: HistoricalCandlesResult[];
  bytesRead: number;
  bytesWritten: number;
  manifestSetId: string | null;
};

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_RETRYABLE_FAILURE_TTL_MS = 30_000;
const DEFAULT_DATASET_ID = "tastytrade-dxlink-candles";
const DEFAULT_LICENSE_SCOPE_ID = "private-research";
const DEFAULT_NORMALIZATION_VERSION = "historical-candles/1.0.0";
const DEFAULT_MODEL_VERSION = "no-model/1.0.0";
const DEFAULT_SOURCE_REVISION = "dxlink-indexed-candle/1";
const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CANDLES = 10_000;
const DEFAULT_MAX_RECEIVED_EVENTS = 10_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const LEGACY_MAX_CANDLES = 20_000;
const MANIFEST_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SENSITIVE_KEY_PATTERN =
  /(^|_)(access_token|refresh_token|client_secret|authorization|quote_token|account_id|account_number|auth_url|oauth_url)($|_)/i;
const SENSITIVE_VALUE_PATTERN =
  /\b(?:bearer\s+[A-Za-z0-9._~+/=-]+|access_token=|refresh_token=|client_secret=)|https?:\/\/\S*(?:oauth|authorize|token)\S*/i;
const RETRYABLE_RESULT_FAILURES = new Set([
  "LOCAL_RECEIVE_BUDGET_EXCEEDED",
  "LOCAL_BUFFER_BUDGET_EXCEEDED",
  "LOCAL_OUTPUT_BUDGET_EXCEEDED",
  "SNAPSHOT_TIMEOUT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_TEMPORARY_FAILURE",
]);

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Evidence cache values must contain finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) =>
        item === undefined ? "null" : canonicalJson(item),
      )
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item)}`,
      )
      .join(",")}}`;
  }
  throw new Error(
    `Evidence cache cannot serialize ${typeof value} values.`,
  );
}

export function stableEvidenceContentId(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function serialized(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

function isRetryableError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "retryable" in error &&
    error.retryable === true
  ) {
    return true;
  }
  const code = errorCode(error);
  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH"
  );
}

function identifier(
  value: string | undefined,
  fallback: string,
  field: string,
): string {
  const normalized = value?.trim() || fallback;
  if (
    normalized.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)
  ) {
    throw new Error(
      `${field} must be a non-sensitive 1-200 character identifier.`,
    );
  }
  return normalized;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return normalized;
}

function manifestHex(id: string, field = "manifest_id"): string {
  if (!MANIFEST_ID_PATTERN.test(id)) {
    throw new Error(`${field} must be a sha256 content ID.`);
  }
  return id.slice("sha256:".length);
}

function normalizeReferences(
  references: ExecutionReferences | undefined,
): ExecutionReferences {
  if (references === undefined) return {};
  assertNoSensitiveData(references, "evidence_cache.references");
  const allowed = new Set([
    "checkpoint_id",
    "paper_order_id",
    "position_id",
  ]);
  for (const key of Object.keys(references)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Unsupported evidence cache reference field: ${key}.`,
      );
    }
  }
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

function assertNoSensitiveData(
  value: unknown,
  path = "payload",
): void {
  if (
    typeof value === "string" &&
    SENSITIVE_VALUE_PATTERN.test(value)
  ) {
    throw new EvidenceCacheError(
      "EVIDENCE_CACHE_SENSITIVE_DATA_REJECTED",
      `Evidence cache refuses sensitive string data at ${path}.`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSensitiveData(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const normalizedKey = key.replace(/[^A-Za-z0-9]+/g, "_");
    if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_SENSITIVE_DATA_REJECTED",
        `Evidence cache refuses sensitive field ${path}.${key}.`,
      );
    }
    if (
      (key === "url" || key.endsWith("_url")) &&
      typeof item === "string" &&
      /(oauth|authorize|token)/i.test(item)
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_SENSITIVE_DATA_REJECTED",
        `Evidence cache refuses authentication URL ${path}.${key}.`,
      );
    }
    assertNoSensitiveData(item, `${path}.${key}`);
  }
}

function resolutionSession(
  session: CandleSession | undefined,
): ResolutionProfileSession {
  if (!session || session.kind === "ALL") {
    return {
      kind: "ALL",
      timezone: session?.timezone ?? "UTC",
      start_time: null,
      end_time: null,
    };
  }
  if (session.kind === "REGULAR") {
    return {
      kind: "REGULAR",
      timezone: session.timezone ?? "America/New_York",
      start_time: "09:30",
      end_time: "16:00",
    };
  }
  return {
    kind: "CUSTOM",
    timezone: session.timezone,
    start_time: session.start_time,
    end_time: session.end_time,
  };
}

function normalizeResourcePolicy(
  input: HistoricalCandlesBatchInput,
): SourceIdentity["resource_policy"] {
  if (
    input.max_candles !== undefined &&
    (input.max_output_candles !== undefined ||
      input.max_received_events !== undefined)
  ) {
    throw new Error(
      "max_candles cannot be combined with max_output_candles or max_received_events; migrate to the explicit budgets.",
    );
  }
  if (input.deadline_ms !== undefined && input.timeout_ms !== undefined) {
    throw new Error(
      "deadline_ms cannot be combined with deprecated timeout_ms.",
    );
  }
  const legacy = input.max_candles;
  if (
    legacy !== undefined &&
    (!Number.isSafeInteger(legacy) ||
      legacy <= 0 ||
      legacy > LEGACY_MAX_CANDLES)
  ) {
    throw new Error(
      `max_candles must be a positive integer <= ${LEGACY_MAX_CANDLES}.`,
    );
  }
  return {
    deadline_ms: positiveInteger(
      input.deadline_ms ?? input.timeout_ms,
      DEFAULT_DEADLINE_MS,
      input.deadline_ms === undefined ? "timeout_ms" : "deadline_ms",
    ),
    max_output_candles:
      legacy ??
      positiveInteger(
        input.max_output_candles,
        DEFAULT_MAX_OUTPUT_CANDLES,
        "max_output_candles",
      ),
    max_received_events:
      legacy ??
      positiveInteger(
        input.max_received_events,
        DEFAULT_MAX_RECEIVED_EVENTS,
        "max_received_events",
      ),
    max_buffer_bytes: positiveInteger(
      input.max_buffer_bytes,
      DEFAULT_MAX_BUFFER_BYTES,
      "max_buffer_bytes",
    ),
    max_candles_compatibility_applied: legacy !== undefined,
    timeout_ms_compatibility_applied:
      input.timeout_ms !== undefined,
  };
}

function contextMatches(
  left: EvidenceContext,
  right: EvidenceContext,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function withoutCacheMetadata(
  result: HistoricalCandlesResult,
): HistoricalCandlesResult {
  const { evidence_cache: _evidenceCache, ...normalized } = result;
  return normalized as HistoricalCandlesResult;
}

function resultKey(result: HistoricalCandlesResult): string {
  return `${result.symbol}\u0000${result.streamer_symbol}`;
}

function changedSymbols(
  previous: HistoricalCandlesResult[],
  current: HistoricalCandlesResult[],
): string[] {
  const previousByKey = new Map(
    previous.map((result) => [
      resultKey(result),
      stableEvidenceContentId(withoutCacheMetadata(result)),
    ]),
  );
  const currentByKey = new Map(
    current.map((result) => [
      resultKey(result),
      stableEvidenceContentId(withoutCacheMetadata(result)),
    ]),
  );
  const keys = new Set([
    ...previousByKey.keys(),
    ...currentByKey.keys(),
  ]);
  return [...keys]
    .filter((key) => previousByKey.get(key) !== currentByKey.get(key))
    .map((key) => key.split("\u0000", 1)[0])
    .sort();
}

function normalizedResults(
  results: HistoricalCandlesResult[],
): HistoricalCandlesResult[] {
  return results.map(withoutCacheMetadata);
}

function hasRetryableResultFailure(
  results: HistoricalCandlesResult[],
): boolean {
  return results.some((result) =>
    result.failure_reasons.some((reason) =>
      RETRYABLE_RESULT_FAILURES.has(reason),
    ),
  );
}

function providerPayload(
  sourceIdentity: SourceIdentity,
  results: HistoricalCandlesResult[],
): unknown {
  return {
    contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
    provider_id: sourceIdentity.provider_id,
    dataset_id: sourceIdentity.dataset_id,
    license_scope_id: sourceIdentity.license_scope_id,
    source_revision: sourceIdentity.source_revision,
    results: results.map((result) => ({
      symbol: result.symbol,
      streamer_symbol: result.streamer_symbol,
      instrument_type: result.instrument_type,
      source: result.source,
      source_timestamp_unit: result.source_timestamp_unit,
      interval: result.interval,
      requested_range: result.requested_range,
      actual_range: result.actual_range,
      retrieved_at: result.retrieved_at,
      snapshot_complete: result.snapshot_complete,
      snapshot_truncated: result.snapshot_truncated,
      provider_snapshot_complete: result.provider_snapshot_complete,
      failure_reasons: result.failure_reasons,
      resource_usage: result.resource_usage,
      transport_diagnostics: result.transport_diagnostics,
      candles: result.candles,
      warnings: result.warnings,
      bounded_history: result.bounded_history,
    })),
  };
}

function objectEnvelope(
  objectType: EvidenceObjectType,
  payload: unknown,
): {
  envelope: EvidenceObjectEnvelope;
  reference: EvidenceObjectReference;
  bytes: Buffer;
} {
  assertNoSensitiveData(payload);
  const contentId = stableEvidenceContentId(payload);
  const envelope: EvidenceObjectEnvelope = {
    contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
    object_type: objectType,
    content_id: contentId,
    checksum: contentId,
    payload,
  };
  const bytes = serialized(envelope);
  return {
    envelope,
    reference: {
      object_type: objectType,
      content_id: contentId,
      checksum: contentId,
      byte_length: bytes.byteLength,
      derived_from: [],
    },
    bytes,
  };
}

function manifestWithId<T extends Omit<EvidenceManifest, "manifest_id">>(
  body: T,
): T & { manifest_id: string } {
  return {
    ...body,
    manifest_id: stableEvidenceContentId(body),
  };
}

function indexWithChecksum<T extends Omit<RequestIndex, "checksum">>(
  body: T,
): T & { checksum: string };
function indexWithChecksum<T extends Omit<FailureIndex, "checksum">>(
  body: T,
): T & { checksum: string };
function indexWithChecksum(
  body:
    | Omit<RequestIndex, "checksum">
    | Omit<FailureIndex, "checksum">,
): RequestIndex | FailureIndex {
  return {
    ...body,
    checksum: stableEvidenceContentId(body),
  } as RequestIndex | FailureIndex;
}

function cloneResults(
  results: HistoricalCandlesResult[],
): HistoricalCandlesResult[] {
  return structuredClone(results);
}

function metadataRecord(
  stored: StoredEvidence,
  cacheStatus: EvidenceCacheRecord["cache_status"],
  evidenceRole: EvidenceRole,
  providerCallsAvoided: number,
): EvidenceCacheRecord {
  return {
    contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
    cache_status: cacheStatus,
    manifest_id: stored.manifest.manifest_id,
    manifest_set_id: stored.manifestSetId,
    request_fingerprint: stored.manifest.request_fingerprint,
    revision: stored.manifest.revision,
    evidence_role: evidenceRole,
    provider_payload_content_id:
      stored.manifest.objects.provider_payload.content_id,
    normalized_content_id:
      stored.manifest.objects.normalized_result.content_id,
    bytes_read: stored.bytesRead,
    bytes_written: stored.bytesWritten,
    provider_calls_avoided: providerCallsAvoided,
  };
}

function attachMetadata(
  stored: StoredEvidence,
  cacheStatus: EvidenceCacheRecord["cache_status"],
  evidenceRole: EvidenceRole,
  providerCallsAvoided: number,
): HistoricalCandlesResult[] {
  const record = metadataRecord(
    stored,
    cacheStatus,
    evidenceRole,
    providerCallsAvoided,
  );
  return cloneResults(stored.results).map((result) => ({
    ...result,
    evidence_cache: record,
  }));
}

export function summarizeEvidenceCacheRecords(
  values: Array<
    HistoricalCandlesResult | EvidenceCacheRecord | null | undefined
  >,
): EvidenceCacheSummary | null {
  const records = values
    .map((value) => {
      if (!value) return null;
      return "cache_status" in value
        ? value
        : value.evidence_cache ?? null;
    })
    .filter((value): value is EvidenceCacheRecord => value !== null);
  const unique = new Map(
    records.map((record) => [record.manifest_id, record]),
  );
  if (unique.size === 0) return null;
  const selected = [...unique.values()];
  return {
    contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
    manifest_ids: selected.map((record) => record.manifest_id),
    normalized_content_ids: [
      ...new Set(
        selected.map((record) => record.normalized_content_id),
      ),
    ],
    provider_payload_content_ids: [
      ...new Set(
        selected.map(
          (record) => record.provider_payload_content_id,
        ),
      ),
    ],
    cache_hits: selected.filter(
      (record) => record.cache_status === "HIT",
    ).length,
    cache_misses: selected.filter(
      (record) => record.cache_status === "MISS",
    ).length,
    cache_only_hits: selected.filter(
      (record) => record.cache_status === "CACHE_ONLY_HIT",
    ).length,
    refreshes: selected.filter(
      (record) => record.cache_status === "REFRESH",
    ).length,
    retryable_failures: selected.filter(
      (record) => record.cache_status === "RETRYABLE_FAILURE",
    ).length,
    retryable_failure_hits: selected.filter(
      (record) => record.cache_status === "RETRYABLE_FAILURE_HIT",
    ).length,
    provider_calls_avoided: selected.reduce(
      (total, record) => total + record.provider_calls_avoided,
      0,
    ),
    bytes_read: selected.reduce(
      (total, record) => total + record.bytes_read,
      0,
    ),
    bytes_written: selected.reduce(
      (total, record) => total + record.bytes_written,
      0,
    ),
  };
}

export function mergeEvidenceCacheSummaries(
  ...summaries: Array<EvidenceCacheSummary | null | undefined>
): EvidenceCacheSummary | null {
  const selected = summaries.filter(
    (summary): summary is EvidenceCacheSummary => summary !== null &&
      summary !== undefined,
  );
  if (selected.length === 0) return null;
  return {
    contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
    manifest_ids: [
      ...new Set(selected.flatMap((summary) => summary.manifest_ids)),
    ],
    normalized_content_ids: [
      ...new Set(
        selected.flatMap(
          (summary) => summary.normalized_content_ids,
        ),
      ),
    ],
    provider_payload_content_ids: [
      ...new Set(
        selected.flatMap(
          (summary) => summary.provider_payload_content_ids,
        ),
      ),
    ],
    cache_hits: selected.reduce(
      (total, summary) => total + summary.cache_hits,
      0,
    ),
    cache_misses: selected.reduce(
      (total, summary) => total + summary.cache_misses,
      0,
    ),
    cache_only_hits: selected.reduce(
      (total, summary) => total + summary.cache_only_hits,
      0,
    ),
    refreshes: selected.reduce(
      (total, summary) => total + summary.refreshes,
      0,
    ),
    retryable_failures: selected.reduce(
      (total, summary) => total + summary.retryable_failures,
      0,
    ),
    retryable_failure_hits: selected.reduce(
      (total, summary) => total + summary.retryable_failure_hits,
      0,
    ),
    provider_calls_avoided: selected.reduce(
      (total, summary) => total + summary.provider_calls_avoided,
      0,
    ),
    bytes_read: selected.reduce(
      (total, summary) => total + summary.bytes_read,
      0,
    ),
    bytes_written: selected.reduce(
      (total, summary) => total + summary.bytes_written,
      0,
    ),
  };
}

export function evidenceCacheWithContext(
  request: EvidenceCacheRequest | undefined,
  context: {
    as_of: string;
    default_role: EvidenceRole;
    references?: ExecutionReferences;
  },
): EvidenceCacheRequest | undefined {
  if (!request) return undefined;
  const asOf = normalizeRfc3339(context.as_of, "evidence_cache.as_of");
  if (
    request.as_of &&
    normalizeRfc3339(request.as_of, "evidence_cache.as_of") !== asOf
  ) {
    throw new Error(
      "evidence_cache.as_of must match the source evaluation checkpoint.",
    );
  }
  return {
    ...request,
    as_of: asOf,
    evidence_role: request.evidence_role ?? context.default_role,
    references: normalizeReferences(
      context.references ?? request.references,
    ),
  };
}

export class EvidenceCacheError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly cached: boolean;
  readonly failure_manifest_id: string | null;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      cached?: boolean;
      failureManifestId?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EvidenceCacheError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cached = options.cached ?? false;
    this.failure_manifest_id = options.failureManifestId ?? null;
  }
}

export class FileEvidenceCache {
  readonly directory: string;
  readonly maxBytes: number;
  readonly maxConcurrency: number;
  readonly retryableFailureTtlMs: number;
  readonly defaultMode: Exclude<EvidenceCacheMode, "CACHE_ONLY">;

  private readonly clock: () => number;
  private readonly defaults: {
    datasetId: string;
    licenseScopeId: string;
    normalizationVersion: string;
    modelVersion: string;
    sourceRevision: string;
  };
  private initialized = false;
  private activeProviders = 0;
  private readonly providerWaiters: Array<() => void> = [];
  private storageTail: Promise<void> = Promise.resolve();
  private readonly requestTails = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<string, Promise<StoredEvidence>>();
  private readonly metrics: EvidenceCacheMetrics = {
    cache_hits: 0,
    cache_misses: 0,
    cache_only_hits: 0,
    refreshes: 0,
    retryable_failures: 0,
    retryable_failure_hits: 0,
    failure_cache_hits: 0,
    provider_calls: 0,
    provider_calls_avoided: 0,
    bytes_read: 0,
    bytes_written: 0,
  };

  constructor(config: FileEvidenceCacheConfig) {
    const directory = config.directory.trim();
    if (!directory) {
      throw new Error("Evidence cache directory must be non-empty.");
    }
    this.directory = resolve(directory);
    this.maxBytes = positiveInteger(
      config.maxBytes,
      DEFAULT_MAX_BYTES,
      "evidence cache maxBytes",
    );
    this.maxConcurrency = positiveInteger(
      config.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
      "evidence cache maxConcurrency",
    );
    this.retryableFailureTtlMs = positiveInteger(
      config.retryableFailureTtlMs,
      DEFAULT_RETRYABLE_FAILURE_TTL_MS,
      "evidence cache retryableFailureTtlMs",
    );
    this.defaultMode = config.defaultMode ?? "BYPASS";
    if (
      this.defaultMode !== "BYPASS" &&
      this.defaultMode !== "READ_WRITE" &&
      this.defaultMode !== "REFRESH"
    ) {
      throw new Error(
        "Evidence cache defaultMode must be BYPASS, READ_WRITE, or REFRESH.",
      );
    }
    this.clock = config.clock ?? (() => Date.now());
    this.defaults = {
      datasetId: identifier(
        config.datasetId,
        DEFAULT_DATASET_ID,
        "evidence cache datasetId",
      ),
      licenseScopeId: identifier(
        config.licenseScopeId,
        DEFAULT_LICENSE_SCOPE_ID,
        "evidence cache licenseScopeId",
      ),
      normalizationVersion: identifier(
        config.normalizationVersion,
        DEFAULT_NORMALIZATION_VERSION,
        "evidence cache normalizationVersion",
      ),
      modelVersion: identifier(
        config.modelVersion,
        DEFAULT_MODEL_VERSION,
        "evidence cache modelVersion",
      ),
      sourceRevision: identifier(
        config.sourceRevision,
        DEFAULT_SOURCE_REVISION,
        "evidence cache sourceRevision",
      ),
    };
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (const path of [
      join(this.directory, "objects", "sha256"),
      join(this.directory, "manifests", "sha256"),
      join(this.directory, "indexes", "requests"),
      join(this.directory, "failures", "requests"),
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
    this.initialized = true;
  }

  manifestPath(id: string): string {
    const hex = manifestHex(id);
    return join(
      this.directory,
      "manifests",
      "sha256",
      hex.slice(0, 2),
      `${hex}.json`,
    );
  }

  objectPath(id: string): string {
    const hex = manifestHex(id, "content_id");
    return join(
      this.directory,
      "objects",
      "sha256",
      hex.slice(0, 2),
      `${hex}.json`,
    );
  }

  private requestIndexPath(requestFingerprint: string): string {
    const hex = manifestHex(requestFingerprint, "request_fingerprint");
    return join(
      this.directory,
      "indexes",
      "requests",
      `${hex}.json`,
    );
  }

  private failureIndexPath(requestFingerprint: string): string {
    const hex = manifestHex(requestFingerprint, "request_fingerprint");
    return join(
      this.directory,
      "failures",
      "requests",
      `${hex}.json`,
    );
  }

  private async pathStat(path: string) {
    try {
      return await stat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private async readBytes(
    path: string,
    missingCode: string,
    description: string,
  ): Promise<Buffer> {
    try {
      return await readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new EvidenceCacheError(
          missingCode,
          `${description} is missing.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async readJson<T>(
    path: string,
    missingCode: string,
    description: string,
  ): Promise<{ value: T; bytes: number }> {
    const bytes = await this.readBytes(path, missingCode, description);
    try {
      return {
        value: JSON.parse(bytes.toString("utf8")) as T,
        bytes: bytes.byteLength,
      };
    } catch (error) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
        `${description} is not valid JSON.`,
        { cause: error },
      );
    }
  }

  private async verifyExactFile(
    path: string,
    expected: Buffer,
    description: string,
  ): Promise<void> {
    const actual = await this.readBytes(
      path,
      "EVIDENCE_CACHE_SHARD_MISSING",
      description,
    );
    if (!actual.equals(expected)) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
        `${description} failed read-back verification.`,
      );
    }
  }

  private async writeImmutable(
    path: string,
    bytes: Buffer,
    description: string,
  ): Promise<number> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const existing = await this.pathStat(path);
    if (existing) {
      await this.verifyExactFile(path, bytes, description);
      return 0;
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let published = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.verifyExactFile(temporary, bytes, `${description} temp file`);
      try {
        await link(temporary, path);
        await chmod(path, 0o600);
        published = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      await this.verifyExactFile(path, bytes, description);
      return published ? bytes.byteLength : 0;
    } finally {
      if (handle) await handle.close();
      await rm(temporary, { force: true });
    }
  }

  private async writeMutable(
    path: string,
    bytes: Buffer,
    description: string,
  ): Promise<number> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const previous = await this.pathStat(path);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.verifyExactFile(temporary, bytes, `${description} temp file`);
      await rename(temporary, path);
      await chmod(path, 0o600);
      await this.verifyExactFile(path, bytes, description);
      return bytes.byteLength - (previous?.size ?? 0);
    } finally {
      if (handle) await handle.close();
      await rm(temporary, { force: true });
    }
  }

  private async withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.storageTail;
    let release!: () => void;
    this.storageTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withRequestLock<T>(
    requestFingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.requestTails.get(requestFingerprint) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const tail = previous.then(() => current);
    this.requestTails.set(requestFingerprint, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.requestTails.get(requestFingerprint) === tail) {
        this.requestTails.delete(requestFingerprint);
      }
    }
  }

  private async diskUsage(path = this.directory): Promise<number> {
    const current = await this.pathStat(path);
    if (!current) return 0;
    if (current.isFile()) return current.size;
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await this.diskUsage(join(path, entry.name));
    }
    return total;
  }

  private async commit(
    immutableFiles: Array<{
      path: string;
      bytes: Buffer;
      description: string;
    }>,
    mutableFiles: Array<{
      path: string;
      bytes: Buffer;
      description: string;
    }>,
  ): Promise<number> {
    return this.withStorageLock(async () => {
      await this.initialize();
      const usage = await this.diskUsage();
      let delta = 0;
      for (const file of immutableFiles) {
        const existing = await this.pathStat(file.path);
        if (existing) {
          await this.verifyExactFile(
            file.path,
            file.bytes,
            file.description,
          );
        } else {
          delta += file.bytes.byteLength;
        }
      }
      for (const file of mutableFiles) {
        const existing = await this.pathStat(file.path);
        delta += file.bytes.byteLength - (existing?.size ?? 0);
      }
      if (usage + delta > this.maxBytes) {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_QUOTA_EXCEEDED",
          `Evidence cache write requires ${Math.max(0, delta)} bytes with ${usage}/${this.maxBytes} bytes already used.`,
        );
      }
      let written = 0;
      for (const file of immutableFiles) {
        written += await this.writeImmutable(
          file.path,
          file.bytes,
          file.description,
        );
      }
      for (const file of mutableFiles) {
        written += await this.writeMutable(
          file.path,
          file.bytes,
          file.description,
        );
      }
      this.metrics.bytes_written += Math.max(0, written);
      return Math.max(0, written);
    });
  }

  private normalizeCacheRequest(
    request: HistoricalCandlesBatchInput,
  ): NormalizedEvidenceCacheRequest {
    const input = request.evidence_cache;
    assertNoSensitiveData(input, "evidence_cache");
    const mode = input?.mode ?? this.defaultMode;
    if (
      mode !== "BYPASS" &&
      mode !== "READ_WRITE" &&
      mode !== "REFRESH" &&
      mode !== "CACHE_ONLY"
    ) {
      throw new Error(
        "evidence_cache.mode must be BYPASS, READ_WRITE, REFRESH, or CACHE_ONLY.",
      );
    }
    if (
      input?.manifest_ids !== undefined &&
      !Array.isArray(input.manifest_ids)
    ) {
      throw new Error("evidence_cache.manifest_ids must be an array.");
    }
    const manifestIds = input?.manifest_ids ?? [];
    if (
      mode === "CACHE_ONLY" &&
      (manifestIds.length === 0 || manifestIds.length > 500)
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_MANIFEST_REQUIRED",
        "CACHE_ONLY requires between 1 and 500 exact manifest IDs.",
      );
    }
    if (mode !== "CACHE_ONLY" && manifestIds.length > 0) {
      throw new Error(
        "evidence_cache.manifest_ids may be used only with CACHE_ONLY.",
      );
    }
    for (const [index, id] of manifestIds.entries()) {
      manifestHex(id, `evidence_cache.manifest_ids[${index}]`);
    }
    const evidenceRole = input?.evidence_role ?? "REFERENCE";
    if (
      evidenceRole !== "ENTRY" &&
      evidenceRole !== "REFERENCE" &&
      evidenceRole !== "REFERENCE_PATH" &&
      evidenceRole !== "OUTCOME_3_TRADING_DAYS" &&
      evidenceRole !== "OUTCOME_5_TRADING_DAYS"
    ) {
      throw new Error("Unsupported evidence_cache.evidence_role.");
    }
    return {
      mode,
      manifestIds: [...new Set(manifestIds)],
      datasetId: identifier(
        input?.dataset_id,
        this.defaults.datasetId,
        "evidence_cache.dataset_id",
      ),
      licenseScopeId: identifier(
        input?.license_scope_id,
        this.defaults.licenseScopeId,
        "evidence_cache.license_scope_id",
      ),
      normalizationVersion: identifier(
        input?.normalization_version,
        this.defaults.normalizationVersion,
        "evidence_cache.normalization_version",
      ),
      modelVersion: identifier(
        input?.model_version,
        this.defaults.modelVersion,
        "evidence_cache.model_version",
      ),
      sourceRevision: identifier(
        input?.source_revision,
        this.defaults.sourceRevision,
        "evidence_cache.source_revision",
      ),
      asOf: normalizeRfc3339(
        input?.as_of ?? request.end_time,
        "evidence_cache.as_of",
      ),
      evidenceRole,
      references: normalizeReferences(input?.references),
    };
  }

  private plan(request: HistoricalCandlesBatchInput): CachePlan {
    const cache = this.normalizeCacheRequest(request);
    const interval = request.interval.trim().toLowerCase();
    const directSession = resolutionSession(request.session);
    const normalizedProfile = normalizeResolutionProfile(
      request.resolution_profile,
      {
        default_requested_aggregation: interval,
        default_max_observation_age_minutes: 0,
        default_max_temporal_skew_minutes: 0,
        default_fallback_aggregations: [],
        default_profile_id: "DIRECT_CANDLE_REQUEST",
        direct_session: directSession,
        direct_alignment:
          directSession.kind === "ALL" ? "MIDNIGHT" : "SESSION",
      },
    );
    if (
      request.resolution_profile &&
      normalizedProfile.requested_aggregation !== interval &&
      !normalizedProfile.fallback_policy.aggregations.includes(interval)
    ) {
      throw new Error(
        `interval must match the requested aggregation or an allowed fallback in resolution_profile ${normalizedProfile.profile_id}.`,
      );
    }
    if (
      request.resolution_profile &&
      request.session &&
      canonicalJson(directSession) !==
        canonicalJson(normalizedProfile.session)
    ) {
      throw new Error(
        "session must match the selected resolution_profile session.",
      );
    }
    const resolutionProfile = withEffectiveAggregation(
      normalizedProfile,
      interval,
    );
    const sourceIdentity: SourceIdentity = {
      provider_id: resolutionProfile.provider_id,
      dataset_id: cache.datasetId,
      license_scope_id: cache.licenseScopeId,
      exact_symbols: request.instruments.map((instrument, index) => {
        const symbol = instrument.symbol.trim().toUpperCase();
        const streamerSymbol = (
          instrument.streamer_symbol ?? symbol
        ).trim();
        if (!symbol || !streamerSymbol) {
          throw new Error(
            `instruments[${index}].symbol and streamer_symbol must be non-empty.`,
          );
        }
        return {
          symbol,
          streamer_symbol: streamerSymbol,
          instrument_type: instrument.instrument_type,
          lifecycle: instrument.lifecycle,
        };
      }),
      aggregation: {
        requested: resolutionProfile.requested_aggregation,
        native: resolutionProfile.native_aggregation,
        effective: interval,
      },
      session: resolutionProfile.session,
      alignment: resolutionProfile.alignment,
      price_type: "LAST",
      request_range: {
        start: normalizeRfc3339(request.start_time, "start_time"),
        end: normalizeRfc3339(request.end_time, "end_time"),
      },
      as_of: cache.asOf,
      resolution_profile: resolutionProfile,
      resource_policy: normalizeResourcePolicy(request),
      normalization_version: cache.normalizationVersion,
      model_version: cache.modelVersion,
      source_revision: cache.sourceRevision,
    };
    const requestFingerprint = stableEvidenceContentId(sourceIdentity);
    return {
      cache,
      sourceIdentity,
      requestFingerprint,
      context: {
        evidence_role: cache.evidenceRole,
        references: cache.references,
      },
    };
  }

  private async readRequestIndex(
    requestFingerprint: string,
  ): Promise<{ value: RequestIndex; bytes: number } | null> {
    const path = this.requestIndexPath(requestFingerprint);
    const existing = await this.pathStat(path);
    if (!existing) return null;
    const loaded = await this.readJson<RequestIndex>(
      path,
      "EVIDENCE_CACHE_INDEX_MISSING",
      "Evidence cache request index",
    );
    const { checksum, ...body } = loaded.value;
    if (
      checksum !== stableEvidenceContentId(body) ||
      loaded.value.request_fingerprint !== requestFingerprint ||
      loaded.value.index_type !== "REQUEST_REVISIONS"
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_INDEX_CORRUPT",
        "Evidence cache request index checksum or identity does not match.",
      );
    }
    return loaded;
  }

  private async readFailureIndex(
    requestFingerprint: string,
  ): Promise<{ value: FailureIndex; bytes: number } | null> {
    const path = this.failureIndexPath(requestFingerprint);
    const existing = await this.pathStat(path);
    if (!existing) return null;
    const loaded = await this.readJson<FailureIndex>(
      path,
      "EVIDENCE_CACHE_INDEX_MISSING",
      "Evidence cache retryable-failure index",
    );
    const { checksum, ...body } = loaded.value;
    if (
      checksum !== stableEvidenceContentId(body) ||
      loaded.value.request_fingerprint !== requestFingerprint ||
      loaded.value.index_type !== "RETRYABLE_FAILURE"
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_INDEX_CORRUPT",
        "Evidence cache retryable-failure index checksum or identity does not match.",
      );
    }
    return loaded;
  }

  async readManifest(id: string): Promise<EvidenceManifest> {
    await this.initialize();
    const loaded = await this.readJson<EvidenceManifest>(
      this.manifestPath(id),
      "EVIDENCE_CACHE_MANIFEST_NOT_FOUND",
      `Evidence manifest ${id}`,
    );
    const { manifest_id: manifestId, ...body } = loaded.value;
    if (
      manifestId !== id ||
      stableEvidenceContentId(body) !== id ||
      loaded.value.contract_version !== EVIDENCE_CACHE_CONTRACT_VERSION
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
        `Evidence manifest ${id} failed checksum verification.`,
      );
    }
    if (loaded.value.manifest_type !== "EVIDENCE_MANIFEST_SET") {
      if (
        stableEvidenceContentId(loaded.value.source_identity) !==
        loaded.value.request_fingerprint
      ) {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
          `Evidence manifest ${id} has an invalid request fingerprint.`,
        );
      }
      if (
        loaded.value.manifest_type ===
          "HISTORICAL_SOURCE_EVIDENCE" &&
        ((loaded.value.cache_eligibility === "VALID_EVIDENCE" &&
          loaded.value.retryable_until !== null) ||
          (loaded.value.cache_eligibility === "RETRYABLE_FAILURE" &&
            loaded.value.retryable_until === null))
      ) {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
          `Evidence manifest ${id} has inconsistent cache eligibility.`,
        );
      }
      if (
        loaded.value.manifest_type ===
          "HISTORICAL_SOURCE_FAILURE" &&
        loaded.value.retryable !==
          (loaded.value.expires_at !== null)
      ) {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
          `Evidence manifest ${id} has inconsistent failure expiry.`,
        );
      }
    }
    this.metrics.bytes_read += loaded.bytes;
    return loaded.value;
  }

  private async readObject(
    reference: EvidenceObjectReference,
  ): Promise<{ payload: unknown; bytes: number }> {
    const loaded = await this.readJson<EvidenceObjectEnvelope>(
      this.objectPath(reference.content_id),
      "EVIDENCE_CACHE_SHARD_MISSING",
      `Evidence object ${reference.content_id}`,
    );
    if (
      loaded.value.contract_version !==
        EVIDENCE_CACHE_CONTRACT_VERSION ||
      loaded.value.object_type !== reference.object_type ||
      loaded.value.content_id !== reference.content_id ||
      loaded.value.checksum !== reference.checksum ||
      stableEvidenceContentId(loaded.value.payload) !==
        reference.content_id ||
      loaded.bytes !== reference.byte_length
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
        `Evidence object ${reference.content_id} failed checksum verification.`,
      );
    }
    assertNoSensitiveData(loaded.value.payload);
    this.metrics.bytes_read += loaded.bytes;
    return { payload: loaded.value.payload, bytes: loaded.bytes };
  }

  private async loadEvidence(
    manifest: HistoricalSourceEvidenceManifest,
    manifestSetId: string | null = null,
  ): Promise<StoredEvidence> {
    const provider = await this.readObject(
      manifest.objects.provider_payload,
    );
    const normalized = await this.readObject(
      manifest.objects.normalized_result,
    );
    if (
      !manifest.objects.normalized_result.derived_from.includes(
        manifest.objects.provider_payload.content_id,
      ) ||
      !Array.isArray(normalized.payload)
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
        `Evidence manifest ${manifest.manifest_id} has invalid normalized-result lineage.`,
      );
    }
    return {
      manifest,
      results: normalized.payload as HistoricalCandlesResult[],
      bytesRead:
        provider.bytes +
        normalized.bytes +
        serialized(manifest).byteLength,
      bytesWritten: 0,
      manifestSetId,
    };
  }

  private validateProviderResults(
    plan: CachePlan,
    results: HistoricalCandlesResult[],
  ): HistoricalCandlesResult[] {
    if (
      !Array.isArray(results) ||
      results.length !== plan.sourceIdentity.exact_symbols.length
    ) {
      throw new Error(
        `Historical candle provider returned ${Array.isArray(results) ? results.length : "non-array"} results for ${plan.sourceIdentity.exact_symbols.length} exact symbols.`,
      );
    }
    const normalized = normalizedResults(results);
    assertNoSensitiveData(normalized);
    for (const [index, result] of normalized.entries()) {
      const expected = plan.sourceIdentity.exact_symbols[index];
      if (
        result.symbol !== expected.symbol ||
        result.streamer_symbol !== expected.streamer_symbol ||
        result.instrument_type !== expected.instrument_type ||
        result.interval !== plan.sourceIdentity.aggregation.effective ||
        normalizeRfc3339(
          result.requested_range.start,
          `results[${index}].requested_range.start`,
        ) !== plan.sourceIdentity.request_range.start ||
        normalizeRfc3339(
          result.requested_range.end,
          `results[${index}].requested_range.end`,
        ) !== plan.sourceIdentity.request_range.end ||
        result.session !== plan.sourceIdentity.session.kind ||
        result.timezone !== plan.sourceIdentity.session.timezone ||
        canonicalJson(result.resolution_profile) !==
          canonicalJson(plan.sourceIdentity.resolution_profile)
      ) {
        throw new Error(
          `Historical candle result ${index} does not match its exact cache identity.`,
        );
      }
      normalizeRfc3339(result.retrieved_at, "result.retrieved_at");
      for (const [barIndex, candle] of result.candles.entries()) {
        for (const field of [
          "source_time",
          "bar_start",
          "bar_end",
          "available_at",
          "retrieved_at",
        ] as const) {
          normalizeRfc3339(
            candle[field],
            `results[${index}].candles[${barIndex}].${field}`,
          );
        }
      }
    }
    return normalized;
  }

  private status(
    plan: CachePlan,
    results: HistoricalCandlesResult[],
  ): HistoricalSourceEvidenceManifest["status"] {
    const asOfMs = Date.parse(plan.sourceIdentity.as_of);
    const latestByResult = results.map((result) => {
      const available = result.candles
        .map((candle) => candle.available_at)
        .sort()
        .at(-1) ?? null;
      return {
        available,
        milliseconds:
          available === null ? null : Date.parse(available),
      };
    });
    const latestMilliseconds = latestByResult
      .map((value) => value.milliseconds)
      .filter((value): value is number => value !== null);
    const temporalSkewMinutes =
      latestMilliseconds.length < 2
        ? latestMilliseconds.length === 1
          ? 0
          : null
        : (Math.max(...latestMilliseconds) -
            Math.min(...latestMilliseconds)) /
          60_000;
    return {
      freshness_policy: {
        max_observation_age_minutes:
          plan.sourceIdentity.resolution_profile
            .max_observation_age_minutes,
        max_temporal_skew_minutes:
          plan.sourceIdentity.resolution_profile
            .max_temporal_skew_minutes,
      },
      temporal_skew_minutes: temporalSkewMinutes,
      results: results.map((result, index) => ({
        symbol: result.symbol,
        streamer_symbol: result.streamer_symbol,
        status: result.status,
        requested_range: result.requested_range,
        actual_range: result.actual_range,
        provider_snapshot_complete: result.provider_snapshot_complete,
        snapshot_complete: result.snapshot_complete,
        snapshot_truncated: result.snapshot_truncated,
        failure_reasons: result.failure_reasons,
        warnings: result.warnings,
        latest_available_at: latestByResult[index].available,
        observation_age_minutes:
          latestByResult[index].milliseconds === null
            ? null
            : (asOfMs - latestByResult[index].milliseconds!) /
              60_000,
      })),
    };
  }

  private async previousEvidence(
    index: RequestIndex | null,
  ): Promise<{
    manifest: HistoricalSourceEvidenceManifest;
    results: HistoricalCandlesResult[];
  } | null> {
    const previousId = index?.manifest_ids.at(-1);
    if (!previousId) return null;
    const manifest = await this.readManifest(previousId);
    if (
      manifest.manifest_type !== "HISTORICAL_SOURCE_EVIDENCE" ||
      manifest.cache_eligibility !== "VALID_EVIDENCE"
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_INDEX_CORRUPT",
        "A valid-evidence request index referenced a non-evidence manifest.",
      );
    }
    const loaded = await this.loadEvidence(manifest);
    return { manifest, results: loaded.results };
  }

  private async writeEvidence(
    plan: CachePlan,
    results: HistoricalCandlesResult[],
    reusedEvidence:
      | {
          manifest: HistoricalSourceEvidenceManifest;
          results: HistoricalCandlesResult[];
        }
      | null = null,
    cacheEligibility:
        | "VALID_EVIDENCE"
        | "RETRYABLE_FAILURE" = "VALID_EVIDENCE",
    retryableUntilOverride: string | null = null,
  ): Promise<StoredEvidence> {
    return this.withRequestLock(plan.requestFingerprint, async () => {
      const requestIndex = await this.readRequestIndex(
        plan.requestFingerprint,
      );
      const previous =
        reusedEvidence ??
        (await this.previousEvidence(requestIndex?.value ?? null));
      const normalized = this.validateProviderResults(plan, results);
      const providerObject = objectEnvelope(
        "SANITIZED_PROVIDER_PAYLOAD",
        providerPayload(plan.sourceIdentity, normalized),
      );
      const normalizedObject = objectEnvelope(
        "NORMALIZED_RESULT",
        normalized,
      );
      normalizedObject.reference.derived_from = [
        providerObject.reference.content_id,
      ];
      const revision = (requestIndex?.value.manifest_ids.length ?? 0) + 1;
      const recordedAt = this.now();
      const retryableUntil =
        cacheEligibility === "RETRYABLE_FAILURE"
          ? retryableUntilOverride ??
            new Date(
              this.clock() + this.retryableFailureTtlMs,
            ).toISOString()
          : null;
      const body = {
        contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
        manifest_type: "HISTORICAL_SOURCE_EVIDENCE" as const,
        request_fingerprint: plan.requestFingerprint,
        revision,
        recorded_at: recordedAt,
        retrieved_at: [
          ...new Set(normalized.map((result) => result.retrieved_at)),
        ].sort(),
        source_identity: plan.sourceIdentity,
        context: plan.context,
        status: this.status(plan, normalized),
        objects: {
          provider_payload: providerObject.reference,
          normalized_result: normalizedObject.reference,
        },
        lineage: {
          normalized_result_derived_from: [
            providerObject.reference.content_id,
          ],
          preserves_bar_fields: [
            "source_time",
            "bar_start",
            "bar_end",
            "available_at",
            "retrieved_at",
          ] as [
            "source_time",
            "bar_start",
            "bar_end",
            "available_at",
            "retrieved_at",
          ],
          retrieved_at_is_not_availability: true as const,
        },
        diff: {
          previous_manifest_id: previous?.manifest.manifest_id ?? null,
          provider_payload_changed:
            previous !== null &&
            previous.manifest.objects.provider_payload.content_id !==
              providerObject.reference.content_id,
          normalized_result_changed:
            previous !== null &&
            previous.manifest.objects.normalized_result.content_id !==
              normalizedObject.reference.content_id,
          changed_symbols:
            previous === null
              ? []
              : changedSymbols(previous.results, normalized),
        },
        reused_evidence_from_manifest_id:
          reusedEvidence?.manifest.manifest_id ?? null,
        cache_eligibility: cacheEligibility,
        retryable_until: retryableUntil,
      };
      const manifest = manifestWithId(body);
      const manifestBytes = serialized(manifest);
      const mutableFiles =
        cacheEligibility === "VALID_EVIDENCE"
          ? [
              {
                path: this.requestIndexPath(plan.requestFingerprint),
                bytes: serialized(
                  indexWithChecksum({
                    contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
                    index_type: "REQUEST_REVISIONS",
                    request_fingerprint: plan.requestFingerprint,
                    updated_at: recordedAt,
                    manifest_ids: [
                      ...(requestIndex?.value.manifest_ids ?? []),
                      manifest.manifest_id,
                    ],
                  }),
                ),
                description: "Mutable evidence request index",
              },
            ]
          : [
              {
                path: this.failureIndexPath(plan.requestFingerprint),
                bytes: serialized(
                  indexWithChecksum({
                    contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
                    index_type: "RETRYABLE_FAILURE",
                    request_fingerprint: plan.requestFingerprint,
                    manifest_id: manifest.manifest_id,
                    expires_at: retryableUntil!,
                    updated_at: recordedAt,
                  }),
                ),
                description: "Mutable retryable-failure index",
              },
            ];
      const bytesWritten = await this.commit(
        [
          {
            path: this.objectPath(providerObject.reference.content_id),
            bytes: providerObject.bytes,
            description: "Sanitized provider evidence object",
          },
          {
            path: this.objectPath(normalizedObject.reference.content_id),
            bytes: normalizedObject.bytes,
            description: "Normalized evidence object",
          },
          {
            path: this.manifestPath(manifest.manifest_id),
            bytes: manifestBytes,
            description: "Immutable evidence manifest",
          },
        ],
        mutableFiles,
      );
      if (cacheEligibility === "VALID_EVIDENCE") {
        await rm(this.failureIndexPath(plan.requestFingerprint), {
          force: true,
        });
      }
      const verifiedManifest = await this.readManifest(
        manifest.manifest_id,
      );
      if (
        verifiedManifest.manifest_type !==
        "HISTORICAL_SOURCE_EVIDENCE"
      ) {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
          "New evidence manifest did not read back as source evidence.",
        );
      }
      const loaded = await this.loadEvidence(verifiedManifest);
      return {
        ...loaded,
        bytesWritten,
      };
    });
  }

  private async materializeContext(
    plan: CachePlan,
    stored: StoredEvidence,
  ): Promise<StoredEvidence> {
    if (contextMatches(stored.manifest.context, plan.context)) {
      return stored;
    }
    return this.writeEvidence(
      plan,
      stored.results,
      {
        manifest: stored.manifest,
        results: stored.results,
      },
      stored.manifest.cache_eligibility,
      stored.manifest.retryable_until,
    );
  }

  private async latestEvidence(
    plan: CachePlan,
  ): Promise<StoredEvidence | null> {
    const index = await this.readRequestIndex(plan.requestFingerprint);
    const manifestId = index?.value.manifest_ids.at(-1);
    if (!manifestId) return null;
    const manifest = await this.readManifest(manifestId);
    if (
      manifest.manifest_type !== "HISTORICAL_SOURCE_EVIDENCE" ||
      manifest.request_fingerprint !== plan.requestFingerprint ||
      manifest.cache_eligibility !== "VALID_EVIDENCE"
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_INDEX_CORRUPT",
        "Evidence request index points to a mismatched manifest.",
      );
    }
    return this.loadEvidence(manifest);
  }

  private async cachedFailure(
    plan: CachePlan,
  ): Promise<StoredEvidence | null> {
    const index = await this.readFailureIndex(plan.requestFingerprint);
    if (!index) return null;
    if (Date.parse(index.value.expires_at) <= this.clock()) {
      await rm(this.failureIndexPath(plan.requestFingerprint), {
        force: true,
      });
      return null;
    }
    const manifest = await this.readManifest(index.value.manifest_id);
    if (
      manifest.manifest_type === "EVIDENCE_MANIFEST_SET" ||
      manifest.request_fingerprint !== plan.requestFingerprint
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_INDEX_CORRUPT",
        "Retryable-failure index points to a mismatched manifest.",
      );
    }
    this.metrics.failure_cache_hits += 1;
    if (manifest.manifest_type === "HISTORICAL_SOURCE_EVIDENCE") {
      if (
        manifest.cache_eligibility !== "RETRYABLE_FAILURE" ||
        manifest.retryable_until !== index.value.expires_at
      ) {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_INDEX_CORRUPT",
          "Retryable-failure index points to evidence without matching retry metadata.",
        );
      }
      return this.loadEvidence(manifest);
    }
    if (manifest.manifest_type !== "HISTORICAL_SOURCE_FAILURE") {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_INDEX_CORRUPT",
        "Retryable-failure index points to an unsupported manifest.",
      );
    }
    throw new EvidenceCacheError(
      "EVIDENCE_CACHE_RETRYABLE_FAILURE",
      manifest.error.message,
      {
        retryable: true,
        cached: true,
        failureManifestId: manifest.manifest_id,
      },
    );
  }

  private async writeFailure(
    plan: CachePlan,
    error: unknown,
  ): Promise<HistoricalSourceFailureManifest> {
    const retryable = isRetryableError(error);
    const recordedAt = this.now();
    const expiresAt = retryable
      ? new Date(this.clock() + this.retryableFailureTtlMs).toISOString()
      : null;
    const body = {
      contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
      manifest_type: "HISTORICAL_SOURCE_FAILURE" as const,
      request_fingerprint: plan.requestFingerprint,
      recorded_at: recordedAt,
      expires_at: expiresAt,
      retryable,
      source_identity: plan.sourceIdentity,
      context: plan.context,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: errorMessage(error),
        code: errorCode(error),
      },
    };
    assertNoSensitiveData(body);
    const manifest = manifestWithId(body);
    const immutableFiles = [
      {
        path: this.manifestPath(manifest.manifest_id),
        bytes: serialized(manifest),
        description: "Immutable provider-failure manifest",
      },
    ];
    const mutableFiles =
      expiresAt === null
        ? []
        : [
            {
              path: this.failureIndexPath(plan.requestFingerprint),
              bytes: serialized(
                indexWithChecksum({
                  contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
                  index_type: "RETRYABLE_FAILURE",
                  request_fingerprint: plan.requestFingerprint,
                  manifest_id: manifest.manifest_id,
                  expires_at: expiresAt,
                  updated_at: recordedAt,
                }),
              ),
              description: "Mutable retryable-failure index",
            },
          ];
    await this.commit(immutableFiles, mutableFiles);
    return manifest;
  }

  private async providerPermit<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.activeProviders >= this.maxConcurrency) {
      await new Promise<void>((resolvePermit) => {
        this.providerWaiters.push(resolvePermit);
      });
    }
    this.activeProviders += 1;
    try {
      return await operation();
    } finally {
      this.activeProviders -= 1;
      this.providerWaiters.shift()?.();
    }
  }

  private async fetchAndStore(
    plan: CachePlan,
    providerCall: () => Promise<HistoricalCandlesResult[]>,
  ): Promise<StoredEvidence> {
    this.metrics.provider_calls += 1;
    try {
      const results = await this.providerPermit(providerCall);
      return await this.writeEvidence(
        plan,
        results,
        null,
        hasRetryableResultFailure(results)
          ? "RETRYABLE_FAILURE"
          : "VALID_EVIDENCE",
      );
    } catch (error) {
      if (error instanceof EvidenceCacheError) throw error;
      const failure = await this.writeFailure(plan, error);
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_PROVIDER_ERROR",
        failure.error.message,
        {
          retryable: failure.retryable,
          failureManifestId: failure.manifest_id,
          cause: error,
        },
      );
    }
  }

  private async deduplicatedFetch(
    plan: CachePlan,
    providerCall: () => Promise<HistoricalCandlesResult[]>,
    refresh: boolean,
  ): Promise<{ stored: StoredEvidence; joined: boolean }> {
    const key = `${refresh ? "refresh" : "miss"}:${plan.requestFingerprint}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return { stored: await existing, joined: true };
    }
    const promise = (async () => {
      if (!refresh) {
        const afterWait = await this.latestEvidence(plan);
        if (afterWait) return afterWait;
      }
      return this.fetchAndStore(plan, providerCall);
    })();
    this.inFlight.set(key, promise);
    try {
      return { stored: await promise, joined: false };
    } finally {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    }
  }

  private async expandedManifests(
    ids: string[],
  ): Promise<{
    manifests: Array<
      HistoricalSourceEvidenceManifest | HistoricalSourceFailureManifest
    >;
    setByManifest: Map<string, string>;
  }> {
    const manifests: Array<
      HistoricalSourceEvidenceManifest | HistoricalSourceFailureManifest
    > = [];
    const setByManifest = new Map<string, string>();
    for (const id of ids) {
      const manifest = await this.readManifest(id);
      if (manifest.manifest_type === "EVIDENCE_MANIFEST_SET") {
        for (const entry of manifest.manifests) {
          const child = await this.readManifest(entry.manifest_id);
          if (child.manifest_type === "EVIDENCE_MANIFEST_SET") {
            throw new EvidenceCacheError(
              "EVIDENCE_CACHE_POLICY_MISMATCH",
              "Nested evidence manifest sets are not supported.",
            );
          }
          if (child.context.evidence_role !== entry.evidence_role) {
            throw new EvidenceCacheError(
              "EVIDENCE_CACHE_POLICY_MISMATCH",
              `Manifest set ${id} has a role mismatch for ${entry.manifest_id}.`,
            );
          }
          if (child.manifest_type === "HISTORICAL_SOURCE_EVIDENCE") {
            await this.loadEvidence(child, manifest.manifest_id);
          }
          manifests.push(child);
          setByManifest.set(child.manifest_id, id);
        }
      } else {
        manifests.push(manifest);
      }
    }
    return { manifests, setByManifest };
  }

  private async exactEvidence(plan: CachePlan): Promise<StoredEvidence> {
    const expanded = await this.expandedManifests(
      plan.cache.manifestIds,
    );
    const matching = expanded.manifests.filter(
      (manifest) =>
        manifest.request_fingerprint === plan.requestFingerprint &&
        contextMatches(manifest.context, plan.context),
    );
    if (matching.length === 0) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_POLICY_MISMATCH",
        "No supplied immutable manifest matches the exact source request, profile, policy, revision, and evidence role.",
      );
    }
    if (matching.length > 1) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_MANIFEST_AMBIGUOUS",
        "Multiple supplied immutable manifests match the exact source request.",
      );
    }
    const manifest = matching[0];
    if (
      canonicalJson(manifest.source_identity) !==
      canonicalJson(plan.sourceIdentity)
    ) {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_POLICY_MISMATCH",
        "The immutable manifest source identity does not exactly match the requested policy.",
      );
    }
    if (manifest.manifest_type === "HISTORICAL_SOURCE_FAILURE") {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_RECORDED_FAILURE",
        manifest.error.message,
        {
          retryable: manifest.retryable,
          cached: true,
          failureManifestId: manifest.manifest_id,
        },
      );
    }
    return this.loadEvidence(
      manifest,
      expanded.setByManifest.get(manifest.manifest_id) ?? null,
    );
  }

  async execute(
    request: HistoricalCandlesBatchInput,
    providerCall: () => Promise<HistoricalCandlesResult[]>,
  ): Promise<HistoricalCandlesResult[]> {
    const plan = this.plan(request);
    if (plan.cache.mode === "BYPASS") return providerCall();
    if (plan.cache.mode === "CACHE_ONLY") {
      const stored = await this.exactEvidence(plan);
      this.metrics.cache_only_hits += 1;
      this.metrics.provider_calls_avoided += 1;
      return attachMetadata(
        stored,
        "CACHE_ONLY_HIT",
        plan.cache.evidenceRole,
        1,
      );
    }
    if (plan.cache.mode === "READ_WRITE") {
      const hit = await this.latestEvidence(plan);
      if (hit) {
        const contextual = await this.materializeContext(plan, hit);
        this.metrics.cache_hits += 1;
        this.metrics.provider_calls_avoided += 1;
        return attachMetadata(
          contextual,
          "HIT",
          plan.cache.evidenceRole,
          1,
        );
      }
      const retryableFailure = await this.cachedFailure(plan);
      if (retryableFailure) {
        const contextual = await this.materializeContext(
          plan,
          retryableFailure,
        );
        this.metrics.retryable_failure_hits += 1;
        this.metrics.provider_calls_avoided += 1;
        return attachMetadata(
          contextual,
          "RETRYABLE_FAILURE_HIT",
          plan.cache.evidenceRole,
          1,
        );
      }
      const { stored, joined } = await this.deduplicatedFetch(
        plan,
        providerCall,
        false,
      );
      const contextual = await this.materializeContext(plan, stored);
      if (stored.manifest.cache_eligibility === "RETRYABLE_FAILURE") {
        if (joined) {
          this.metrics.retryable_failure_hits += 1;
          this.metrics.provider_calls_avoided += 1;
          return attachMetadata(
            contextual,
            "RETRYABLE_FAILURE_HIT",
            plan.cache.evidenceRole,
            1,
          );
        }
        this.metrics.retryable_failures += 1;
        return attachMetadata(
          contextual,
          "RETRYABLE_FAILURE",
          plan.cache.evidenceRole,
          0,
        );
      }
      if (joined || stored.bytesWritten === 0) {
        this.metrics.cache_hits += 1;
        this.metrics.provider_calls_avoided += 1;
        return attachMetadata(
          contextual,
          "HIT",
          plan.cache.evidenceRole,
          1,
        );
      }
      this.metrics.cache_misses += 1;
      return attachMetadata(
        contextual,
        "MISS",
        plan.cache.evidenceRole,
        0,
      );
    }

    const { stored, joined } = await this.deduplicatedFetch(
      plan,
      providerCall,
      true,
    );
    const contextual = await this.materializeContext(plan, stored);
    if (stored.manifest.cache_eligibility === "RETRYABLE_FAILURE") {
      if (joined) {
        this.metrics.retryable_failure_hits += 1;
        this.metrics.provider_calls_avoided += 1;
        return attachMetadata(
          contextual,
          "RETRYABLE_FAILURE_HIT",
          plan.cache.evidenceRole,
          1,
        );
      }
      this.metrics.retryable_failures += 1;
      return attachMetadata(
        contextual,
        "RETRYABLE_FAILURE",
        plan.cache.evidenceRole,
        0,
      );
    }
    if (joined) {
      this.metrics.cache_hits += 1;
      this.metrics.provider_calls_avoided += 1;
      return attachMetadata(
        contextual,
        "HIT",
        plan.cache.evidenceRole,
        1,
      );
    }
    this.metrics.refreshes += 1;
    return attachMetadata(
      contextual,
      "REFRESH",
      plan.cache.evidenceRole,
      0,
    );
  }

  async createManifestSet(input: {
    label: string;
    entry_as_of: string;
    manifests: Array<{
      evidence_role: EvidenceRole;
      manifest_id: string;
    }>;
  }): Promise<EvidenceManifestSet> {
    const label = input.label.trim();
    if (!label || label.length > 200) {
      throw new Error("Manifest-set label must be 1-200 characters.");
    }
    assertNoSensitiveData(label, "manifest_set.label");
    if (
      !Array.isArray(input.manifests) ||
      input.manifests.length < 1 ||
      input.manifests.length > 500
    ) {
      throw new Error(
        "Manifest sets must contain between 1 and 500 manifests.",
      );
    }
    const entries = [];
    for (const entry of input.manifests) {
      const manifest = await this.readManifest(entry.manifest_id);
      if (manifest.manifest_type !== "HISTORICAL_SOURCE_EVIDENCE") {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_POLICY_MISMATCH",
          "Manifest sets may contain only valid historical source evidence.",
        );
      }
      if (manifest.context.evidence_role !== entry.evidence_role) {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_POLICY_MISMATCH",
          `Evidence role ${entry.evidence_role} does not match ${entry.manifest_id}.`,
        );
      }
      await this.loadEvidence(manifest);
      entries.push({
        evidence_role: entry.evidence_role,
        manifest_id: entry.manifest_id,
      });
    }
    const body = {
      contract_version: EVIDENCE_CACHE_CONTRACT_VERSION,
      manifest_type: "EVIDENCE_MANIFEST_SET" as const,
      label,
      entry_as_of: normalizeRfc3339(
        input.entry_as_of,
        "entry_as_of",
      ),
      created_at: this.now(),
      manifests: entries,
    };
    const manifest = manifestWithId(body);
    await this.commit(
      [
        {
          path: this.manifestPath(manifest.manifest_id),
          bytes: serialized(manifest),
          description: "Immutable evidence manifest set",
        },
      ],
      [],
    );
    const verified = await this.readManifest(manifest.manifest_id);
    if (verified.manifest_type !== "EVIDENCE_MANIFEST_SET") {
      throw new EvidenceCacheError(
        "EVIDENCE_CACHE_CHECKSUM_MISMATCH",
        "Evidence manifest set failed read-back verification.",
      );
    }
    return verified;
  }

  async listValidManifests(
    request?: HistoricalCandlesBatchInput,
  ): Promise<string[]> {
    await this.initialize();
    if (request) {
      const plan = this.plan(request);
      return (
        (await this.readRequestIndex(plan.requestFingerprint))?.value
          .manifest_ids ?? []
      );
    }
    const directory = join(this.directory, "indexes", "requests");
    const entries = await readdir(directory, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const loaded = await this.readJson<RequestIndex>(
        join(directory, entry.name),
        "EVIDENCE_CACHE_INDEX_MISSING",
        "Evidence cache request index",
      );
      ids.push(...loaded.value.manifest_ids);
    }
    return [...new Set(ids)];
  }

  async listFiles(path = this.directory): Promise<string[]> {
    const existing = await this.pathStat(path);
    if (!existing) return [];
    if (existing.isFile()) return [path];
    const entries = await readdir(path, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      files.push(...(await this.listFiles(join(path, entry.name))));
    }
    return files;
  }

  getMetrics(): EvidenceCacheMetrics {
    return { ...this.metrics };
  }
}

function singleToBatch(
  request: HistoricalCandlesInput,
): HistoricalCandlesBatchInput {
  return {
    instruments: [
      {
        symbol: request.symbol,
        streamer_symbol: request.streamer_symbol,
        instrument_type: request.instrument_type,
        lifecycle: request.lifecycle,
      },
    ],
    interval: request.interval,
    start_time: request.start_time,
    end_time: request.end_time,
    session: request.session,
    resolution_profile: request.resolution_profile,
    deadline_ms: request.deadline_ms,
    max_output_candles: request.max_output_candles,
    max_received_events: request.max_received_events,
    max_buffer_bytes: request.max_buffer_bytes,
    timeout_ms: request.timeout_ms,
    max_candles: request.max_candles,
    evidence_cache: request.evidence_cache,
  };
}

function withoutBatchCache(
  request: HistoricalCandlesBatchInput,
): HistoricalCandlesBatchInput {
  const { evidence_cache: _evidenceCache, ...providerRequest } = request;
  return providerRequest;
}

function withoutSingleCache(
  request: HistoricalCandlesInput,
): HistoricalCandlesInput {
  const { evidence_cache: _evidenceCache, ...providerRequest } = request;
  return providerRequest;
}

export class CachedHistoricalCandlesService {
  constructor(
    private readonly provider: HistoricalCandlesProvider,
    private readonly cache: FileEvidenceCache | null,
  ) {}

  async getHistoricalCandles(
    request: HistoricalCandlesInput,
  ): Promise<HistoricalCandlesResult> {
    const mode =
      request.evidence_cache?.mode ??
      this.cache?.defaultMode ??
      "BYPASS";
    if (mode === "BYPASS") {
      return this.provider.getHistoricalCandles(
        withoutSingleCache(request),
      );
    }
    const [result] = await this.getHistoricalCandlesBatch(
      singleToBatch(request),
    );
    return result;
  }

  async getHistoricalCandlesBatch(
    request: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]> {
    const mode =
      request.evidence_cache?.mode ??
      this.cache?.defaultMode ??
      "BYPASS";
    if (mode !== "BYPASS") {
      this.provider.assertEvidenceCacheAllowed?.(request);
    }
    if (!this.cache) {
      if (mode !== "BYPASS") {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_NOT_CONFIGURED",
          "Evidence cache was requested but no private backend is configured.",
        );
      }
      return this.providerBatch(withoutBatchCache(request));
    }
    return this.cache.execute(request, () =>
      this.providerBatch(withoutBatchCache(request)),
    );
  }

  private async providerBatch(
    request: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]> {
    if (this.provider.getHistoricalCandlesBatch) {
      return this.provider.getHistoricalCandlesBatch(request);
    }
    if (request.instruments.length !== 1) {
      throw new Error(
        "Historical candle provider does not support batched retrieval.",
      );
    }
    const instrument = request.instruments[0];
    return [
      await this.provider.getHistoricalCandles(
        withoutSingleCache({
          symbol: instrument.symbol,
          streamer_symbol: instrument.streamer_symbol,
          instrument_type: instrument.instrument_type,
          lifecycle: instrument.lifecycle,
          interval: request.interval,
          start_time: request.start_time,
          end_time: request.end_time,
          session: request.session,
          resolution_profile: request.resolution_profile,
          deadline_ms: request.deadline_ms,
          max_output_candles: request.max_output_candles,
          max_received_events: request.max_received_events,
          max_buffer_bytes: request.max_buffer_bytes,
          timeout_ms: request.timeout_ms,
          max_candles: request.max_candles,
        }),
      ),
    ];
  }
}

function envPositiveInteger(
  name: string,
  fallback: number,
): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function evidenceCacheFromEnv(): FileEvidenceCache | null {
  const directory = process.env.TASTYTRADE_EVIDENCE_CACHE_DIR?.trim();
  if (!directory) return null;
  const defaultModeValue =
    process.env.TASTYTRADE_EVIDENCE_CACHE_DEFAULT_MODE?.trim() ||
    "BYPASS";
  if (
    defaultModeValue !== "BYPASS" &&
    defaultModeValue !== "READ_WRITE" &&
    defaultModeValue !== "REFRESH"
  ) {
    throw new Error(
      "TASTYTRADE_EVIDENCE_CACHE_DEFAULT_MODE must be BYPASS, READ_WRITE, or REFRESH.",
    );
  }
  return new FileEvidenceCache({
    directory,
    maxBytes: envPositiveInteger(
      "TASTYTRADE_EVIDENCE_CACHE_MAX_BYTES",
      DEFAULT_MAX_BYTES,
    ),
    maxConcurrency: envPositiveInteger(
      "TASTYTRADE_EVIDENCE_CACHE_MAX_CONCURRENCY",
      DEFAULT_MAX_CONCURRENCY,
    ),
    retryableFailureTtlMs: envPositiveInteger(
      "TASTYTRADE_EVIDENCE_CACHE_RETRYABLE_FAILURE_TTL_MS",
      DEFAULT_RETRYABLE_FAILURE_TTL_MS,
    ),
    defaultMode: defaultModeValue,
    datasetId: process.env.TASTYTRADE_EVIDENCE_CACHE_DATASET_ID,
    licenseScopeId:
      process.env.TASTYTRADE_EVIDENCE_CACHE_LICENSE_SCOPE_ID,
    normalizationVersion:
      process.env.TASTYTRADE_EVIDENCE_CACHE_NORMALIZATION_VERSION,
    modelVersion:
      process.env.TASTYTRADE_EVIDENCE_CACHE_MODEL_VERSION,
    sourceRevision:
      process.env.TASTYTRADE_EVIDENCE_CACHE_SOURCE_REVISION,
  });
}
