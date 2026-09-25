import { ExactDecimal, type DecimalInput } from "./decimal.js";
import {
  createExecutionEvidence,
  type ExecutionEvidence,
  type ExecutionReferences,
  type FillModel,
} from "./execution-evidence.js";
import type { PriceEffect } from "./package-pricing.js";
import {
  prepareSpreadResearch,
  runSpreadSimulation,
  type SpreadBacktester,
  type SpreadResearchInput,
} from "./spread-adapter.js";
import { normalizeRfc3339 } from "./time.js";

export type HistoricalPathPoint = {
  as_of: string;
  price: DecimalInput;
  price_effect: Exclude<PriceEffect, "EVEN">;
  source?: string;
};

export type HistoricalFillStatus =
  | "TOUCHED"
  | "NOT_TOUCHED"
  | "NOT_VERIFIABLE";

export type VerificationSide = "ENTRY" | "EXIT";

export type LivePaperAssumption = "FILLED" | "NOT_FILLED" | "PENDING";

export type HistoricalFillInput = {
  submitted_at: string;
  valid_until: string;
  working_limit: DecimalInput;
  acceptable_bound?: DecimalInput | null;
  price_effect: Exclude<PriceEffect, "EVEN">;
  verification_side: VerificationSide;
  fill_model: Exclude<FillModel, "NOT_APPLICABLE">;
  path: HistoricalPathPoint[];
  evidence_source: string;
  references: ExecutionReferences;
  max_observation_gap_ms?: number;
  live_assumption?: LivePaperAssumption;
};

export type HistoricalFillResult = {
  contract_version: "1.0.0";
  status: HistoricalFillStatus;
  verification_side: VerificationSide;
  first_touch_at: string | null;
  first_touch_window: {
    start: string;
    end: string;
  } | null;
  evidence_source: string;
  path_resolution:
    | "OBSERVED_POINT"
    | "BOUNDED_INTERVAL"
    | "COMPLETE_NO_TOUCH"
    | "INSUFFICIENT";
  quote_path_quality: "COMPLETE" | "SPARSE" | "PARTIAL" | "INVALID";
  fill_model: Exclude<FillModel, "NOT_APPLICABLE">;
  threshold: string;
  working_limit: string;
  acceptable_bound: string | null;
  live_assumption: LivePaperAssumption | null;
  comparison_to_live_assumption:
    | "AGREES"
    | "DISAGREES"
    | "NOT_COMPARABLE";
  mutates_live_event: false;
  warnings: string[];
  evidence: ExecutionEvidence;
};

export type HistoricalFillBacktesterInput = Omit<
  SpreadResearchInput,
  "entry_at" | "exit_at" | "intended_price"
> & {
  submitted_at: string;
  valid_until: string;
  working_limit: DecimalInput;
  acceptable_bound?: DecimalInput | null;
  verification_side: VerificationSide;
  fill_model: Exclude<FillModel, "NOT_APPLICABLE">;
  max_observation_gap_ms?: number;
  live_assumption?: LivePaperAssumption;
};

type NormalizedPathPoint = {
  asOf: string;
  timestamp: number;
  signedPrice: ExactDecimal;
};

const DEFAULT_MAX_OBSERVATION_GAP_MS = 15 * 60_000;

function normalizeTimestamp(value: string, field: string): string {
  return normalizeRfc3339(value, field);
}

function signedPrice(
  value: DecimalInput,
  effect: Exclude<PriceEffect, "EVEN">,
  field: string,
): ExactDecimal {
  const decimal = ExactDecimal.parse(value, field);
  if (decimal.compare(ExactDecimal.zero()) < 0) {
    throw new Error(`${field} must be non-negative.`);
  }
  return effect === "DEBIT" ? decimal : decimal.negate();
}

function compareAssumption(
  status: HistoricalFillStatus,
  assumption: LivePaperAssumption | undefined,
): HistoricalFillResult["comparison_to_live_assumption"] {
  if (!assumption || assumption === "PENDING" || status === "NOT_VERIFIABLE") {
    return "NOT_COMPARABLE";
  }
  return (
    (status === "TOUCHED" && assumption === "FILLED") ||
    (status === "NOT_TOUCHED" && assumption === "NOT_FILLED")
  )
    ? "AGREES"
    : "DISAGREES";
}

function pathQuality(
  points: NormalizedPathPoint[],
  submittedAt: number,
  validUntil: number,
  maxGapMs: number,
): {
  quality: HistoricalFillResult["quote_path_quality"];
  largestGap: number;
  coversStart: boolean;
  coversEnd: boolean;
} {
  if (points.length === 0) {
    return {
      quality: "INVALID",
      largestGap: 0,
      coversStart: false,
      coversEnd: false,
    };
  }

  let largestGap = 0;
  for (let index = 1; index < points.length; index += 1) {
    largestGap = Math.max(
      largestGap,
      points[index].timestamp - points[index - 1].timestamp,
    );
  }
  const coversStart = points[0].timestamp <= submittedAt + maxGapMs;
  const coversEnd =
    points.at(-1)!.timestamp >= validUntil - maxGapMs;
  const quality =
    points.length < 2 || !coversStart || !coversEnd
      ? "PARTIAL"
      : largestGap > maxGapMs
        ? "SPARSE"
        : "COMPLETE";
  return { quality, largestGap, coversStart, coversEnd };
}

export function verifyHistoricalFill(
  input: HistoricalFillInput,
): HistoricalFillResult {
  if (!input.references.paper_order_id && !input.references.checkpoint_id) {
    throw new Error(
      "Historical verification requires paper_order_id or checkpoint_id.",
    );
  }
  const evidenceSource = input.evidence_source.trim();
  if (!evidenceSource) throw new Error("evidence_source must be non-empty.");

  const submittedAtText = normalizeTimestamp(
    input.submitted_at,
    "submitted_at",
  );
  const validUntilText = normalizeTimestamp(
    input.valid_until,
    "valid_until",
  );
  const submittedAt = Date.parse(submittedAtText);
  const validUntil = Date.parse(validUntilText);
  if (validUntil <= submittedAt) {
    throw new Error("valid_until must be later than submitted_at.");
  }
  const maxGapMs =
    input.max_observation_gap_ms ?? DEFAULT_MAX_OBSERVATION_GAP_MS;
  if (!Number.isSafeInteger(maxGapMs) || maxGapMs <= 0) {
    throw new Error("max_observation_gap_ms must be a positive integer.");
  }

  const workingLimit = signedPrice(
    input.working_limit,
    input.price_effect,
    "working_limit",
  );
  const acceptableBound =
    input.acceptable_bound === null || input.acceptable_bound === undefined
      ? null
      : signedPrice(
          input.acceptable_bound,
          input.price_effect,
          "acceptable_bound",
        );
  if (input.fill_model === "CONSERVATIVE_CROSS" && !acceptableBound) {
    throw new Error(
      "CONSERVATIVE_CROSS requires an acceptable_bound.",
    );
  }
  if (acceptableBound && acceptableBound.compare(workingLimit) > 0) {
    throw new Error(
      "acceptable_bound must be at least as conservative as working_limit.",
    );
  }
  const threshold =
    input.fill_model === "CONSERVATIVE_CROSS"
      ? acceptableBound!
      : workingLimit;

  const warnings = [
    "HISTORICAL_EVIDENCE_ONLY_DO_NOT_REWRITE_LIVE_EVENT",
  ];
  const normalizedByTime = new Map<number, NormalizedPathPoint>();
  let ignoredBefore = 0;
  let ignoredAfter = 0;
  let invalidPoints = 0;
  for (const [index, point] of input.path.entries()) {
    try {
      const asOf = normalizeTimestamp(point.as_of, `path[${index}].as_of`);
      const timestamp = Date.parse(asOf);
      if (timestamp < submittedAt) {
        ignoredBefore += 1;
        continue;
      }
      if (timestamp > validUntil) {
        ignoredAfter += 1;
        continue;
      }
      normalizedByTime.set(timestamp, {
        asOf,
        timestamp,
        signedPrice: signedPrice(
          point.price,
          point.price_effect,
          `path[${index}].price`,
        ),
      });
    } catch {
      invalidPoints += 1;
    }
  }
  if (ignoredBefore > 0) {
    warnings.push(`PRE_SUBMISSION_OBSERVATIONS_IGNORED:${ignoredBefore}`);
  }
  if (ignoredAfter > 0) {
    warnings.push(`POST_EXPIRY_OBSERVATIONS_IGNORED:${ignoredAfter}`);
  }
  if (invalidPoints > 0) {
    warnings.push(`INVALID_PATH_OBSERVATIONS_IGNORED:${invalidPoints}`);
  }

  const points = [...normalizedByTime.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const quality = pathQuality(points, submittedAt, validUntil, maxGapMs);
  if (!quality.coversStart) warnings.push("PATH_DOES_NOT_COVER_SUBMISSION");
  if (!quality.coversEnd) warnings.push("PATH_DOES_NOT_COVER_VALID_UNTIL");
  if (quality.largestGap > maxGapMs) {
    warnings.push(`SPARSE_PATH_MAX_GAP:${quality.largestGap}ms`);
  }

  const touchIndex = points.findIndex(
    (point) => point.signedPrice.compare(threshold) <= 0,
  );
  let status: HistoricalFillStatus;
  let firstTouchAt: string | null = null;
  let firstTouchWindow: HistoricalFillResult["first_touch_window"] = null;
  let resolution: HistoricalFillResult["path_resolution"];
  let fillConfidence: ExecutionEvidence["fill_confidence"];

  if (touchIndex >= 0) {
    status = "TOUCHED";
    const point = points[touchIndex];
    const previous = touchIndex > 0 ? points[touchIndex - 1] : null;
    if (!previous && point.timestamp > submittedAt) {
      firstTouchWindow = {
        start: submittedAtText,
        end: point.asOf,
      };
      resolution = "BOUNDED_INTERVAL";
      fillConfidence = "LOW";
      warnings.push("FIRST_TOUCH_LACKS_PRECEDING_NON_TOUCH_OBSERVATION");
    } else if (
      previous &&
      point.timestamp - previous.timestamp > maxGapMs &&
      previous.signedPrice.compare(threshold) > 0
    ) {
      firstTouchWindow = {
        start: previous.asOf,
        end: point.asOf,
      };
      resolution = "BOUNDED_INTERVAL";
      fillConfidence = "LOW";
      warnings.push("FIRST_TOUCH_ONLY_BOUNDED_BY_SPARSE_OBSERVATIONS");
    } else {
      firstTouchAt = point.asOf;
      resolution = "OBSERVED_POINT";
      fillConfidence = quality.quality === "COMPLETE" ? "HIGH" : "MEDIUM";
    }
  } else if (quality.quality === "COMPLETE") {
    status = "NOT_TOUCHED";
    resolution = "COMPLETE_NO_TOUCH";
    fillConfidence = "HIGH";
  } else {
    status = "NOT_VERIFIABLE";
    resolution = "INSUFFICIENT";
    fillConfidence = "LOW";
  }

  const comparison = compareAssumption(status, input.live_assumption);
  if (comparison === "DISAGREES") {
    warnings.push("HISTORICAL_RESULT_DISAGREES_WITH_LIVE_ASSUMPTION");
  }

  const evidence = createExecutionEvidence({
    evidence_type: "HISTORICAL_PATH",
    evidence_phase: "POST_SESSION_REGRESSION",
    source: evidenceSource,
    as_of: points.at(-1)?.asOf ?? null,
    oldest_leg_as_of: null,
    freshness_status: "UNKNOWN",
    temporal_alignment:
      quality.quality === "COMPLETE"
        ? "ALIGNED"
        : quality.quality === "SPARSE"
          ? "MISALIGNED"
          : "UNKNOWN",
    native_available: false,
    working_limit: ExactDecimal.parse(
      input.working_limit,
      "working_limit",
    ).toString(),
    acceptable_bound:
      input.acceptable_bound === null ||
      input.acceptable_bound === undefined
        ? null
        : ExactDecimal.parse(
            input.acceptable_bound,
            "acceptable_bound",
          ).toString(),
    fill_model: input.fill_model,
    fill_confidence: fillConfidence,
    references: input.references,
    warnings,
  });

  return {
    contract_version: "1.0.0",
    status,
    verification_side: input.verification_side,
    first_touch_at: firstTouchAt,
    first_touch_window: firstTouchWindow,
    evidence_source: evidenceSource,
    path_resolution: resolution,
    quote_path_quality: quality.quality,
    fill_model: input.fill_model,
    threshold: threshold.abs().toString(),
    working_limit: workingLimit.abs().toString(),
    acceptable_bound: acceptableBound?.abs().toString() ?? null,
    live_assumption: input.live_assumption ?? null,
    comparison_to_live_assumption: comparison,
    mutates_live_event: false,
    warnings: evidence.warnings,
    evidence,
  };
}

export async function verifyHistoricalFillWithBacktester(
  backtester: SpreadBacktester,
  input: HistoricalFillBacktesterInput,
): Promise<HistoricalFillResult> {
  const planInput: SpreadResearchInput = {
    family: input.family,
    underlying: input.underlying,
    legs: input.legs,
    entry_at: input.submitted_at,
    exit_at: input.valid_until,
    intended_price: input.working_limit,
    price_effect: input.price_effect,
    allow_0dte: input.allow_0dte,
    references: input.references,
  };
  const plan = prepareSpreadResearch(planInput);
  const simulation = await runSpreadSimulation(backtester, planInput);

  return verifyHistoricalFill({
    submitted_at: plan.entry_at,
    valid_until: plan.exit_at,
    working_limit: input.working_limit,
    acceptable_bound: input.acceptable_bound,
    price_effect: input.price_effect,
    verification_side: input.verification_side,
    fill_model: input.fill_model,
    path: simulation.snapshots.map((snapshot) => ({
      as_of: snapshot.as_of,
      price: snapshot.price,
      price_effect: snapshot.price_effect,
      source: "tastytrade-backtester:/simulate-trade",
    })),
    evidence_source: "tastytrade-backtester:/simulate-trade",
    references: input.references ?? {},
    max_observation_gap_ms: input.max_observation_gap_ms,
    live_assumption: input.live_assumption,
  });
}
