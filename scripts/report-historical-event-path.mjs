import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stableEvidenceContentId } from "../dist/evidence-cache.js";
import { HISTORICAL_EVENT_PATH_VERSION } from "../dist/historical-event-path.js";

const root = new URL("../", import.meta.url);
const destination = new URL("docs/historical-event-path-audit-issue-101.json", root);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check") || args.length > 1) throw new Error("Usage: node scripts/report-historical-event-path.mjs [--check]");
const inputs = [];
const artifacts = new Map();
for (const path of [
  "docs/historical-quote-capability-2026-09-26.json",
  "docs/historical-replay-smoke-2026-09-26.json",
  "docs/historical-coverage-audit-issue-98.json",
]) {
  const bytes = await readFile(new URL(path, root));
  if (bytes.length > 524288) throw new Error(`Offline input exceeds the 512 KiB bound: ${path}`);
  artifacts.set(path, JSON.parse(bytes));
  inputs.push({ path, byte_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
}
const smoke = artifacts.get("docs/historical-replay-smoke-2026-09-26.json");
const coverage = artifacts.get("docs/historical-coverage-audit-issue-98.json");
if (smoke.status !== "NOT_ASSESSABLE" || smoke.replay_report_built !== false ||
    coverage.source_decision !== "DO_NOT_ENABLE" || coverage.complete_issue_acceptance !== false) {
  throw new Error("Tracked artifact preconditions changed; reassess the event-path audit instead of assuming missing evidence.");
}
const body = {
  contract_version: HISTORICAL_EVENT_PATH_VERSION,
  generator_version: "issue-101-offline-event-path/1",
  status: "NOT_ASSESSABLE",
  acceptance_alternative: "ISSUE_101_AC1_DOCUMENTED_GAPS",
  network_requests: 0,
  credentials_accessed: false,
  source_decision: coverage.source_decision,
  provider_enablement_changed: false,
  licensed_vertical_slice_replayed: false,
  measured_market_results: false,
  fixtures_used_as_market_observations: false,
  inputs,
  retained_evidence: {
    smoke_status: smoke.status,
    replay_report_built: smoke.replay_report_built,
    smoke_replay_blockers: smoke.replay_blockers,
    coverage_status: coverage.status,
    coverage_blockers: coverage.blockers,
    source_and_license_claims_verified: false,
    cache_contents_verified: false,
  },
  gaps: [
    "AUTHORIZED_RETAINED_EXACT_LEG_BID_ASK_SIZE_SEQUENCE_UNAVAILABLE",
    "AUTHORITATIVE_EVENT_PATH_CALENDAR_AND_VARIABLE_CHECKPOINTS_NOT_RETAINED",
    "FROZEN_ENTRY_PARTIAL_CLOSE_ROLL_AND_SETTLEMENT_LEDGER_NOT_RETAINED",
    "TIMESTAMP_SAFE_FRONT_BACK_IV_AND_GREEKS_SEQUENCE_UNAVAILABLE",
    "REFERENCED_IMMUTABLE_CACHE_OBJECTS_AND_MANIFESTS_NOT_RECOVERED",
    "ENTITLEMENT_STORAGE_REPLAY_RIGHTS_AND_COST_UNCONFIRMED",
  ],
  coverage: {
    expected_checkpoints: null, expected_active_leg_observations: null,
    measured_pnl_checkpoints: null, quote_backed_checkpoints: null,
    denominator_status: "NO_FROZEN_REAL_EVENT_PATH_INVENTORY_OR_CALENDAR",
  },
  metrics: { net_pnl_dollars: null, mae_dollars: null, mfe_dollars: null, holding_duration_ms: null },
  conclusion: "The tracked sanitized artifacts do not establish one licensed exact-leg vertical slice from entry through a variable early exit. No invented calendar, inventory, fill, zero-denominator result, market P/L or coverage claim substitutes for missing retained evidence. Deterministic fixtures verify only the additive local contract.",
  boundaries: [
    "ISSUE_98_SIX_MONTH_ACCEPTANCE_REMAINS_INCOMPLETE",
    "ISSUE_42_DO_NOT_ENABLE_UNCHANGED",
    "NO_PROVIDER_CALL_PURCHASE_CREDENTIAL_ACCESS_CACHE_RECOVERY_OR_POLICY_MUTATION",
  ],
};
const output = `${JSON.stringify({ audit_id: stableEvidenceContentId(body), ...body }, null, 2)}\n`;
if (args.includes("--check")) {
  if (await readFile(destination, "utf8") !== output) throw new Error("Historical event-path offline report is stale.");
} else {
  await writeFile(destination, output);
}
console.log(`Historical event-path offline audit: ${body.status}; ${body.gaps.length} documented gaps; 0 network requests.`);
