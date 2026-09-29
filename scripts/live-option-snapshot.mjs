import { TastytradeLiveOptionSnapshotClient } from "../dist/live-option-snapshot.js";

const requiredEnvironment = [
  "TASTYTRADE_CLIENT_ID",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
  "TASTYTRADE_LIVE_OPTION_EXPIRATIONS",
  "TASTYTRADE_LIVE_OPTION_AROUND_PRICE",
];
const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingEnvironment.length > 0) {
  console.error(
    JSON.stringify(
      {
        status: "NOT_RUN",
        reason: "MISSING_LIVE_OPTION_SNAPSHOT_CONFIGURATION",
        missing_environment: missingEnvironment,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} else {
  const expirations = process.env.TASTYTRADE_LIVE_OPTION_EXPIRATIONS.split(
    ",",
  )
    .map((value) => value.trim())
    .filter(Boolean);
  const strikeCount = Number(
    process.env.TASTYTRADE_LIVE_OPTION_STRIKE_COUNT ?? "5",
  );
  const client = new TastytradeLiveOptionSnapshotClient();
  const result = await client.getLiveOptionSnapshot({
    underlying:
      process.env.TASTYTRADE_LIVE_OPTION_UNDERLYING?.trim().toUpperCase() ??
      "SPX",
    expirations,
    around_price: process.env.TASTYTRADE_LIVE_OPTION_AROUND_PRICE,
    strike_count: strikeCount,
    include_quotes: true,
    include_greeks: true,
    include_summary: true,
    phase: "LIVE_SUPPORT",
    deadline_ms: Number(
      process.env.TASTYTRADE_LIVE_OPTION_DEADLINE_MS ?? "5000",
    ),
    max_temporal_skew_ms: Number(
      process.env.TASTYTRADE_LIVE_OPTION_MAX_TEMPORAL_SKEW_MS ?? "5000",
    ),
  });
  const gammaAndOpenInterestContracts = result.contracts.filter(
    (contract) =>
      contract.greeks?.gamma !== null &&
      contract.greeks &&
      contract.summary?.open_interest !== null &&
      contract.summary,
  ).length;
  const outcome =
    result.snapshot_complete && gammaAndOpenInterestContracts > 0
      ? "PASS"
      : "FAIL";
  console.log(
    JSON.stringify(
      {
        gate: "LIVE_SPX_GAMMA_OPEN_INTEREST_SNAPSHOT",
        outcome,
        verified: {
          direct_provider: result.provider,
          open_interest_source: result.source.open_interest,
          selected_contracts: result.contracts.length,
          gamma_and_open_interest_contracts:
            gammaAndOpenInterestContracts,
          snapshot_complete: result.snapshot_complete,
          temporal_alignment: result.temporal_alignment,
          gamma_proxy_status:
            result.gamma_concentration_proxy.status,
          dealer_gex_status:
            result.gamma_concentration_proxy.dealer_gex_status,
          evidence_role: result.evidence_role,
        },
        result,
      },
      null,
      2,
    ),
  );
  if (outcome !== "PASS") process.exitCode = 1;
}
