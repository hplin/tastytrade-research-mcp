import assert from "node:assert/strict";
import { mockLiveOptionPackage } from "../test/fixtures/live-option-quality.mjs";

const evidence = [];
for (const options of [
  { legCount: 2 }, { legCount: 3 }, { legCount: 4 },
  { legCount: 2, calendar: true }, { legCount: 4, calendar: true },
  { legCount: 4, missingChainLeg: true },
  { legCount: 4, missingEventLeg: true },
]) {
  const { client, request } = mockLiveOptionPackage(options);
  const result = await client.getLiveOptionSnapshot(request);
  const quality = result.exact_package_quality;
  assert.equal(quality.status, options.missingChainLeg || options.missingEventLeg ? "NOT_READY" : "READY");
  assert.equal(quality.order_authorized, false);
  if (options.missingChainLeg) assert.ok(quality.reasons.includes("MISSING_LEG"));
  evidence.push({
    scenario: options, status: quality.status, reasons: quality.reasons,
    content_complete: quality.content_complete, transport_complete: quality.transport_complete,
    fingerprint: quality.fingerprint,
  });
}
console.log(JSON.stringify({
  validation_kind: "SYNTHETIC_FIXTURE_MOCK_INTEGRATION",
  real_provider_validated: false,
  live_probe: { status: "BLOCKED", reason: "NO_OPERATIONAL_AUTHORIZATION_OR_PROVIDER_SESSION_USED" },
  evidence,
}, null, 2));
