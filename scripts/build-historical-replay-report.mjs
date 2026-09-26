import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildHistoricalReplayReport } from "../dist/historical-replay.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/build-historical-replay-report.mjs --input <request.json> [--output <report.json>]",
    "",
    "The input is the request body accepted by",
    "tastytrade_build_historical_replay_report (without the outer request key).",
  ].join("\n");
}

function parseArguments(argv) {
  let input = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true, input: null, output: null };
    }
    if (argument === "--input" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path.`);
      }
      if (argument === "--input") input = value;
      else output = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!input) throw new Error("--input is required.");
  return { help: false, input, output };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const inputPath = resolve(options.input);
    const request = JSON.parse(await readFile(inputPath, "utf8"));
    const report = buildHistoricalReplayReport(request);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      await writeFile(resolve(options.output), serialized, {
        encoding: "utf8",
        flag: "wx",
      });
    } else {
      process.stdout.write(serialized);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
