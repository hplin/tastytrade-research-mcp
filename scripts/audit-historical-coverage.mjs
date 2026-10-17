import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GENERATOR = new URL("./historical-coverage-audit-v1/scripts/audit-historical-coverage.mjs", import.meta.url);
const GENERATOR_SHA256 = "5f13c64e7d9bff6e24da93d3127ce23cf5304fe5d47b6ee399773379ed95b983";

async function loadGenerator() {
  const stat = await lstat(GENERATOR);
  if (!stat.isFile() || stat.size > 131072) throw new Error("Unsafe historical audit generator.");
  const bytes = await readFile(GENERATOR);
  if (createHash("sha256").update(bytes).digest("hex") !== GENERATOR_SHA256) {
    throw new Error("Changed historical audit generator.");
  }
  return import(GENERATOR.href);
}

export async function buildHistoricalCoverageAudit(month = null) {
  return (await loadGenerator()).buildHistoricalCoverageAudit(month);
}

const generator = await loadGenerator();
export const verifyPinnedSource = generator.verifyPinnedSource;

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output" && args[index + 1] && !args[index + 1].startsWith("--")) {
      args[index + 1] = resolve(ROOT, args[index + 1]);
      index += 1;
    }
  }
  const child = spawn(process.execPath, [fileURLToPath(GENERATOR), ...args], { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
