import { mkdir, readFile, writeFile } from "node:fs/promises";
import { normalizeDdIvMeasurements } from "../dist/dd-iv-measurement.js";

const inputUrl = new URL(
  "../test/fixtures/dd-iv-measurement-input-v1.json",
  import.meta.url,
);
const outputUrl = new URL(
  "../docs/examples/dd-iv-measurement-handoff-v1.json",
  import.meta.url,
);
const fixture = JSON.parse(await readFile(inputUrl, "utf8"));
const output = `${JSON.stringify(
  {
    dataset_version: "dd-iv-handoff/1.0.0",
    generated_from: "test/fixtures/dd-iv-measurement-input-v1.json",
    method_document: "docs/dd-iv-measurements.md",
    intended_consumers: [
      "spx-spread-grading",
      "spx-spread-regression",
    ],
    policy_fields_included: false,
    handoff: normalizeDdIvMeasurements(fixture.input),
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputUrl, "utf8");
  if (existing !== output) {
    throw new Error(
      "DD IV handoff example is stale; run npm run handoff:dd-iv.",
    );
  }
} else {
  await mkdir(new URL(".", outputUrl), { recursive: true });
  await writeFile(outputUrl, output);
}
