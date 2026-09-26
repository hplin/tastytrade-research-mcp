import { ExactDecimal, type DecimalInput } from "./decimal.js";
import { normalizeRfc3339 } from "./time.js";

export const EXECUTION_EVIDENCE_CONTRACT_VERSION = "1.0.0" as const;

export type EvidenceType =
  | "NATIVE_PACKAGE"
  | "SYNTHETIC_NATURAL"
  | "SYNTHETIC_MID_REFERENCE"
  | "HISTORICAL_OPTION_PACKAGE_REFERENCE"
  | "HISTORICAL_PATH"
  | "BACKTESTER_SIMULATION"
  | "BROKER_DRY_RUN";

export type EvidencePhase =
  | "LIVE_CHECKPOINT"
  | "POST_SESSION_REGRESSION";

export type FreshnessStatus = "FRESH" | "STALE" | "UNKNOWN";

export type TemporalAlignment = "ALIGNED" | "MISALIGNED" | "UNKNOWN";

export type FillModel =
  | "LIMIT_TOUCH"
  | "CONSERVATIVE_CROSS"
  | "NOT_APPLICABLE";

export type FillConfidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "NOT_APPLICABLE";

export type ExecutionReferences = {
  checkpoint_id?: string;
  paper_order_id?: string;
  position_id?: string;
};

export type ExecutionEvidence = {
  contract_version: typeof EXECUTION_EVIDENCE_CONTRACT_VERSION;
  evidence_type: EvidenceType;
  evidence_phase: EvidencePhase;
  source: string;
  as_of: string | null;
  oldest_leg_as_of: string | null;
  freshness_status: FreshnessStatus;
  temporal_alignment: TemporalAlignment;
  native_available: boolean;
  working_limit: string | null;
  acceptable_bound: string | null;
  fill_model: FillModel;
  fill_confidence: FillConfidence;
  references: ExecutionReferences;
  warnings: string[];
};

export type ExecutionEvidenceInput = Omit<
  ExecutionEvidence,
  | "contract_version"
  | "as_of"
  | "oldest_leg_as_of"
  | "working_limit"
  | "acceptable_bound"
  | "warnings"
> & {
  as_of?: string | null;
  oldest_leg_as_of?: string | null;
  working_limit?: DecimalInput | null;
  acceptable_bound?: DecimalInput | null;
  warnings?: string[];
};

const HISTORICAL_EVIDENCE_TYPES = new Set<EvidenceType>([
  "HISTORICAL_OPTION_PACKAGE_REFERENCE",
  "HISTORICAL_PATH",
  "BACKTESTER_SIMULATION",
]);

function normalizeTimestamp(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeRfc3339(value, field);
}

function normalizeReference(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error(`${field} must be 1-200 characters.`);
  }
  return normalized;
}

function normalizeDecimal(
  value: DecimalInput | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  return ExactDecimal.parse(value, field).toString();
}

export function createExecutionEvidence(
  input: ExecutionEvidenceInput,
): ExecutionEvidence {
  const source = input.source.trim();
  if (!source) throw new Error("source must be non-empty.");

  if (
    HISTORICAL_EVIDENCE_TYPES.has(input.evidence_type) &&
    input.evidence_phase !== "POST_SESSION_REGRESSION"
  ) {
    throw new Error(
      `${input.evidence_type} evidence must be POST_SESSION_REGRESSION evidence.`,
    );
  }

  if (
    (input.evidence_type === "BROKER_DRY_RUN" ||
      input.evidence_type === "SYNTHETIC_MID_REFERENCE" ||
      input.evidence_type === "HISTORICAL_OPTION_PACKAGE_REFERENCE") &&
    (input.fill_model !== "NOT_APPLICABLE" ||
      input.fill_confidence !== "NOT_APPLICABLE")
  ) {
    throw new Error(
      `${input.evidence_type} must not claim a fill model or fill confidence.`,
    );
  }

  const warnings = [...(input.warnings ?? [])];
  if (input.evidence_type === "BROKER_DRY_RUN") {
    warnings.push("BROKER_DRY_RUN_VALIDATES_STRUCTURE_NOT_FILLABILITY");
  }
  if (input.evidence_type === "SYNTHETIC_MID_REFERENCE") {
    warnings.push("SYNTHETIC_MIDPOINT_IS_VALUATION_ONLY");
  }

  return {
    contract_version: EXECUTION_EVIDENCE_CONTRACT_VERSION,
    evidence_type: input.evidence_type,
    evidence_phase: input.evidence_phase,
    source,
    as_of: normalizeTimestamp(input.as_of, "as_of"),
    oldest_leg_as_of: normalizeTimestamp(
      input.oldest_leg_as_of,
      "oldest_leg_as_of",
    ),
    freshness_status: input.freshness_status,
    temporal_alignment: input.temporal_alignment,
    native_available: input.native_available,
    working_limit: normalizeDecimal(input.working_limit, "working_limit"),
    acceptable_bound: normalizeDecimal(
      input.acceptable_bound,
      "acceptable_bound",
    ),
    fill_model: input.fill_model,
    fill_confidence: input.fill_confidence,
    references: {
      checkpoint_id: normalizeReference(
        input.references.checkpoint_id,
        "checkpoint_id",
      ),
      paper_order_id: normalizeReference(
        input.references.paper_order_id,
        "paper_order_id",
      ),
      position_id: normalizeReference(
        input.references.position_id,
        "position_id",
      ),
    },
    warnings: [...new Set(warnings)],
  };
}
