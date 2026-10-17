import { describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildHistoricalCoverageAudit,
  verifyPinnedSource,
} from "../scripts/audit-historical-coverage.mjs";
import { stableEvidenceContentId } from "../dist/evidence-cache.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/audit-historical-coverage.mjs", import.meta.url));
const SNAPSHOT = "docs/historical-coverage-audit-issue-98.json";
const BUNDLE = new URL("../scripts/historical-coverage-audit-v1/", import.meta.url);
const exec = promisify(execFile);
const cli = (...args) => exec(process.execPath, [SCRIPT, ...args], { cwd: ROOT, maxBuffer: 1048576 });

describe("issue 98 pinned offline historical inventory", () => {
  test("matches the immutable report and canonical #41 content identity", async () => {
    const report = await buildHistoricalCoverageAudit();
    expect(`${JSON.stringify(report, null, 2)}\n`).toBe(await readFile(new URL(`../${SNAPSHOT}`, import.meta.url), "utf8"));
    const { report_id, ...body } = report;
    expect(report_id).toBe(stableEvidenceContentId(body));
    expect(await buildHistoricalCoverageAudit()).toEqual(report);
    await expect(cli("--check", "--output", SNAPSHOT)).resolves.toMatchObject({ stdout: "", stderr: "" });
  });

  test("retains original source and generator identities with explicit Git provenance", async () => {
    const report = await buildHistoricalCoverageAudit();
    const provenance = JSON.parse(await readFile(new URL("provenance.json", BUNDLE), "utf8"));
    expect(provenance.origin_repository).toBe("hplin/tastytrade-research-mcp");
    expect(provenance.origin_revision).toBe("3ca41fa6f5b05f471640cb172e723c893935eafc");
    expect(provenance.files.map(({ path, byte_sha256 }) => ({ path, byte_sha256 }))).toEqual([
      { path: "scripts/audit-historical-coverage.mjs", byte_sha256: report.generator_byte_sha256 },
      ...report.inputs,
    ]);
    for (const item of provenance.files) {
      const bytes = await readFile(new URL(item.path, BUNDLE));
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(item.byte_sha256);
      expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe(item.git_blob_id);
      if (item.path.startsWith("docs/")) expect(() => verifyPinnedSource(item.path, bytes)).not.toThrow();
    }
  });

  test("reproduces the original audit despite live-document drift and rejects unsafe bundled inputs", async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "historical-coverage-audit-")));
    const bundled = join(fixture, "scripts", "historical-coverage-audit-v1");
    const fixtureScript = join(fixture, "scripts", "audit-historical-coverage.mjs");
    const run = (...args) => exec(process.execPath, [fixtureScript, ...args], { cwd: tmpdir(), maxBuffer: 1048576 });
    try {
      await mkdir(join(fixture, "scripts"));
      await mkdir(join(fixture, "docs"));
      await cp(BUNDLE, bundled, { recursive: true });
      await copyFile(SCRIPT, fixtureScript);
      await symlink(join(ROOT, "dist"), join(fixture, "dist"), "dir");
      await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
      const originalReport = await readFile(join(ROOT, SNAPSHOT), "utf8");
      await writeFile(join(fixture, SNAPSHOT), originalReport);
      for (const path of ["docs/historical-candles.md", "docs/evidence-cache.md"]) {
        const changed = `${await readFile(join(ROOT, path), "utf8")}\nChanged current documentation.\n`;
        await writeFile(join(fixture, path), changed);
        expect(() => verifyPinnedSource(path, Buffer.from(changed))).toThrow("changed audit source");
      }
      await expect(run("--check", "--output", SNAPSHOT)).resolves.toMatchObject({ stdout: "", stderr: "" });
      const full = JSON.parse(originalReport);
      const shards = [];
      for (const month of full.scope.months) {
        const { stdout } = await run("--month", month);
        const shard = JSON.parse(stdout);
        expect(shard.audit_id).toBe(full.audit_id);
        expect(shard.generator_byte_sha256).toBe(full.generator_byte_sha256);
        expect(shard.inputs).toEqual(full.inputs);
        shards.push(shard);
      }
      expect(shards.flatMap((shard) => shard.family_matrix)).toEqual(full.family_matrix);
      expect(shards.flatMap((shard) => shard.observations)).toEqual(full.observations);
      await expect(run("--month", "2026-03")).resolves.toMatchObject({
        stdout: `${JSON.stringify(shards[0], null, 2)}\n`,
      });
      await run("--month", "2026-03", "--output", "march.json");
      expect(await readFile(join(fixture, "march.json"), "utf8")).toBe(`${JSON.stringify(shards[0], null, 2)}\n`);
      await expect(run("--month", "2026-03", "--output", "march.json")).rejects.toMatchObject({ code: 1 });
      for (const path of ["docs/historical-candles.md", "docs/evidence-cache.md", "scripts/audit-historical-coverage.mjs"]) {
        const target = join(bundled, path);
        const original = await readFile(target);
        try {
          await writeFile(target, Buffer.concat([original, Buffer.from("\nchanged\n")]));
          await expect(run("--check", "--output", SNAPSHOT)).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining(path.startsWith("docs/") ? "changed audit source" : "Changed historical audit generator"),
          });
        } finally {
          await writeFile(target, original);
        }
      }
      const target = join(bundled, "docs/historical-candles.md");
      const original = await readFile(target);
      try {
        await writeFile(target, Buffer.alloc(131073));
        await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Unsafe audit source") });
        await unlink(target);
        await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ENOENT") });
        await symlink(join(fixture, "docs/historical-candles.md"), target, "file");
        await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Unsafe audit source") });
        await unlink(target);
      } finally {
        await writeFile(target, original);
      }
      expect(await readFile(join(fixture, SNAPSHOT), "utf8")).toBe(originalReport);
      await expect(run("--check", "--output", SNAPSHOT)).resolves.toMatchObject({ stdout: "", stderr: "" });
    } finally {
      await rm(fixture, { recursive: true });
    }
  }, 30000);

  test("keeps all six months and every family/checkpoint blocked, never 0/0 success", async () => {
    const report = await buildHistoricalCoverageAudit();
    expect(report.monthly_inventory.map((m) => m.trading_month)).toEqual([
      "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
    ]);
    expect(report.family_matrix).toHaveLength(48);
    expect(report.family_matrix.reduce((n, r) => n + r.checkpoints.length, 0)).toBe(258);
    for (const row of report.family_matrix) {
      expect(row.status).toBe("BLOCKED");
      for (const key of ["expected_frozen_packages", "expected_exact_leg_observations", "quote_backed",
        "reference_only", "modeled", "not_assessable", "entry_count", "early_exit_count",
        "plus_3_exit_count", "plus_5_exit_count", "synchronized_checkpoint_count", "excluded_count"]) {
        expect(row[key]).toBeNull();
      }
      expect(row.checkpoints).toContain("INITIAL");
      expect(row.checkpoints).toContain("EARLY_EXIT");
    }
    expect(report.family_matrix.find((r) => r.family === "BWB").required_exact_leg_count).toBe(3);
    expect(report.family_matrix.find((r) => r.family === "SIC").checkpoints).toContain("SIC_STAGE_ADJUST");
    expect(report.source_decision).toBe("DO_NOT_ENABLE");
    expect(report.rights.legal_storage_scope).toBeNull();
    expect(report.complete_issue_acceptance).toBe(false);
  });

  test("enumerates real artifact rows without inventing omitted contracts or family membership", async () => {
    const report = await buildHistoricalCoverageAudit();
    expect(report.observations).toHaveLength(56);
    expect(report.enumerated_artifact_rows_only).toMatchObject({
      denominator: 56, quote_backed: 0, reference_only: 16, modeled: 0, not_assessable: 40,
    });
    expect(report.capability_cohorts[0]).toMatchObject({
      checkpoint_at: "2026-03-02T15:30:00.000Z",
      provider_status: "NOT_AVAILABLE",
      reported_reconstructed_symbol_count: 0,
      frozen_expected_denominator: null,
    });
    expect(report.capability_cohorts[1]).toMatchObject({
      reported_reconstructed_symbol_count: 12, enumerated_symbol_count: 8,
      unenumerated_returned_symbols: 4, frozen_expected_denominator: null,
    });
    expect(report.observations.filter((r) => r.checkpoint === "ENTRY")).toHaveLength(16);
    expect(report.observations.filter((r) => r.missing_observation === true)).toHaveLength(32);
    for (const row of report.observations) {
      expect(row.family).toBeNull();
      expect(row.front_dte).toBeNull();
      expect(row.back_dte).toBeNull();
      expect(row.coverage_denominator).toBeNull();
      expect(row.native_bid).toBeNull();
      expect(row.native_ask).toBeNull();
      expect(row.native_quote_greeks).toBeNull();
      expect(row.native_quote_iv).toBeNull();
      expect(row.crossed).toBeNull();
      expect(row.usable_for_execution).toBe(false);
      expect(row.synchronized_exact_package).toBeNull();
    }
    const entry = report.observations.find((r) => r.checkpoint === "ENTRY");
    expect(entry).toMatchObject({
      exact_occ_symbol: "SPXW  260921C07725000",
      root: "SPXW", option_type: "CALL", strike: "7725", calendar_dte: 28,
      checkpoint_at: "2026-08-24T14:30:00.000Z",
      bar_start: "2026-08-24T14:05:00.000Z",
      available_at: "2026-08-24T14:10:00.000Z",
      age_minutes: 20, stale: false, source_time: null,
      candle_close: "72.24", evidence_class: "REFERENCE_ONLY",
    });
    expect(report.observations.some((r) => r.session_date.startsWith("2026-09"))).toBe(true);
    expect(report.observations.every((r) => r.trading_month === "2026-08")).toBe(true);
    expect(report.observations.filter((r) => r.available_at).every(
      (r) => Date.parse(r.available_at) <= Date.parse(r.checkpoint_at),
    )).toBe(true);
    expect(report.separate_prior_art[0].requested_contract_observations).toBe(714);
    expect(report.separate_prior_art[1].included_in_matrix_numerators).toBe(false);
  });

  test("supports deterministic bounded month shards sharing one audit identity", async () => {
    const full = await buildHistoricalCoverageAudit();
    const shards = await Promise.all(full.scope.months.map(buildHistoricalCoverageAudit));
    expect(shards.every((r) => r.audit_id === full.audit_id)).toBe(true);
    expect(shards.flatMap((r) => r.family_matrix)).toEqual(full.family_matrix);
    expect(shards.flatMap((r) => r.observations)).toEqual(full.observations);
    expect(shards[0].enumerated_artifact_rows_only.denominator).toBe(0);
    expect(shards[0].monthly_inventory[0].coverage_fraction).toBeNull();
    expect(shards[0].status).toBe("BLOCKED");
    expect(shards[0].six_month_coverage_pass).toBe(false);
    await expect(buildHistoricalCoverageAudit("2026-10")).rejects.toThrow("Month must");
  });

  test("rejects unknown or modified sources, malformed arguments and immutable output replacement", async () => {
    const path = "docs/historical-quote-capability-2026-09-26.json";
    const original = await readFile(new URL(`../${path}`, import.meta.url));
    expect(() => verifyPinnedSource(path, original)).not.toThrow();
    expect(() => verifyPinnedSource(path, Buffer.from("{}"))).toThrow("changed audit source");
    expect(() => verifyPinnedSource(path, Buffer.from("{"))).toThrow("changed audit source");
    expect(() => verifyPinnedSource("../.env", original)).toThrow("Unrecognized");
    for (const args of [["--input", ".env"], ["--month"], ["--month", "2026-09"],
      ["--check"], ["--check", "--check"], ["--output", "--check"]]) {
      await expect(cli(...args)).rejects.toMatchObject({ code: 1 });
    }
    const scratch = new URL(`./.coverage-audit-${process.pid}/`, import.meta.url);
    await mkdir(scratch);
    const output = fileURLToPath(new URL("report.json", scratch));
    try {
      await cli("--month", "2026-03", "--output", output);
      const originalReport = await readFile(output, "utf8");
      await expect(cli("--month", "2026-03", "--output", output)).rejects.toMatchObject({ code: 1 });
      expect(await readFile(output, "utf8")).toBe(originalReport);
      await writeFile(output, "{}\n");
      await expect(cli("--month", "2026-03", "--check", "--output", output)).rejects.toMatchObject({ code: 1 });
      expect(await readFile(output, "utf8")).toBe("{}\n");
    } finally {
      await rm(scratch, { recursive: true });
    }
  });
});
