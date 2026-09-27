# Azure Container Apps deployment

The remote deployment runs the MCP server as an OAuth-protected stateless
Streamable HTTP service:

- `GET /healthz` is public and contains no credential or account data.
- `POST /mcp` requires a valid Entra OAuth access token.
- `GET /.well-known/oauth-protected-resource` publishes RFC 9728 discovery.
- Other MCP methods and paths are rejected.
- The existing stdio entrypoint remains available for local clients.

The production container runs as the unprivileged Node user and keeps
tastytrade OAuth credentials in Azure Key Vault-backed Container App secrets.

## Current production deployment

- Resource group: `rg-trading-mcp`
- Container Apps environment: `cae-trading`
- Container App: `tastytrade-research-mcp`
- MCP URL:
  `https://tastytrade-research-mcp.victoriousfield-047d2c99.westus2.azurecontainerapps.io/mcp`
- Health URL:
  `https://tastytrade-research-mcp.victoriousfield-047d2c99.westus2.azurecontainerapps.io/healthz`
- Production revision:
  `tastytrade-research-mcp--main-851f08c`
- ACR image:
  `hplintradingmcp.azurecr.io/tastytrade-research-mcp:main-851f08c`
- Image digest:
  `sha256:632fcfc61c1c0dfade6654151c650e4fc56dacde498b6f9d815c515c1595149d`
- Source commit:
  `851f08ca1a8b7ce77b534edb0bf6237d35a6c6e4`
- Managed identity: `mi-tastytrade-research-mcp`
- Rollback revision:
  `tastytrade-research-mcp--main-0992cc7`

Production OAuth uses Entra resource application
`f6c77904-5bf9-46cf-96f9-be5f2e841054` and delegated scope
`api://f6c77904-5bf9-46cf-96f9-be5f2e841054/mcp.read`.
The dedicated static ChatGPT client ID is
`f743de22-deaf-4e3f-91c1-8e615884cc42`; its secret is held outside source
control.
`tastytrade-research-mcp-api-key` remains in Key Vault only for rollback and
is not mapped into the production container.

## Required Azure resources

Set these variables for the target subscription:

```bash
RESOURCE_GROUP=rg-trading-mcp
LOCATION=westus2
ENVIRONMENT=cae-trading
REGISTRY=hplintradingmcp
KEY_VAULT=kv-trading-mcp-hplin
IDENTITY=mi-tastytrade-research-mcp
APP=tastytrade-research-mcp
```

The managed identity needs:

- `AcrPull` on the registry;
- `Key Vault Secrets User` on the vault.

The vault stores:

- `tastytrade-research-client-id`
- `tastytrade-research-client-secret`
- `tastytrade-research-refresh-token`

Container App secret aliases are limited to 20 characters, so the app maps
those vault entries to `tt-client-id`, `tt-client-secret`, and
`tt-refresh-token`.

## Build and run locally

```bash
docker build -t tastytrade-research-mcp:local .
docker run --rm -p 8000:8000 \
  -e TASTYTRADE_CLIENT_ID \
  -e TASTYTRADE_CLIENT_SECRET \
  -e TASTYTRADE_REFRESH_TOKEN \
  -e MCP_AUTH_MODE=api-key \
  -e MCP_API_KEY \
  tastytrade-research-mcp:local
```

Check health without credentials:

```bash
curl --fail http://127.0.0.1:8000/healthz
```

Configure ChatGPT with:

- URL: `https://<container-app-fqdn>/mcp`
- authentication: OAuth with static Entra client credentials;
- authorization URL:
  `https://login.microsoftonline.com/ed9ea9dd-8968-441c-91f6-f359f8d3ef3b/oauth2/v2.0/authorize`;
- token URL:
  `https://login.microsoftonline.com/ed9ea9dd-8968-441c-91f6-f359f8d3ef3b/oauth2/v2.0/token`;
- client ID: `f743de22-deaf-4e3f-91c1-8e615884cc42`;
- scope:
  `api://f6c77904-5bf9-46cf-96f9-be5f2e841054/mcp.read`.

The ChatGPT OAuth client secret must remain in Key Vault or a local
permission-restricted handoff file. Never put it or tastytrade credentials in
source control, container images, or deployment logs.

The client initially registers
`https://chatgpt.com/connector_platform_oauth_redirect`. If ChatGPT displays a
connector-specific callback instead, append that exact HTTPS URI to the
client's web redirect URIs before completing installation; Entra does not
accept redirect URI wildcards.

## Persistent evidence-cache volume

The immutable historical evidence cache is implemented in the application but remains disabled unless a private persistent filesystem is mounted and `TASTYTRADE_EVIDENCE_CACHE_DIR` is set. Production must not point this setting at replica-local `/tmp` storage.

For the current Azure Container Apps deployment, use a classic private Azure Files share attached to `cae-trading`, mount it read/write into the app (for example `/var/lib/tastytrade-evidence-cache`), and set:

```text
TASTYTRADE_EVIDENCE_CACHE_DIR=/var/lib/tastytrade-evidence-cache
TASTYTRADE_EVIDENCE_CACHE_DEFAULT_MODE=BYPASS
TASTYTRADE_EVIDENCE_CACHE_FILESYSTEM_MODE=AZURE_FILES_SMB
TASTYTRADE_EVIDENCE_CACHE_MAX_BYTES=1073741824
TASTYTRADE_EVIDENCE_CACHE_MAX_CONCURRENCY=4
TASTYTRADE_EVIDENCE_CACHE_DATASET_ID=tastytrade-dxlink-candles
TASTYTRADE_EVIDENCE_CACHE_LICENSE_SCOPE_ID=private-research
```

Keep the default mode `BYPASS`; individual regression requests opt into `READ_WRITE` or `CACHE_ONLY`. Do not enable automatic caching for live requests. Azure Files SMB does not expose POSIX `chmod` or hard links, so the explicit filesystem mode uses same-share atomic rename publication and mount-level access control while retaining checksum and read-back verification. Keep this deployment at one replica.

Azure requires an environment-level storage definition plus a revision-level `AzureFile` volume and container `volumeMount`. Follow the Microsoft Container Apps Azure Files procedure and keep the storage-account key out of source control. After the new revision is healthy, acceptance requires one `READ_WRITE` historical request to return a non-null `manifest_id`, followed by an exact `CACHE_ONLY` replay of that manifest with no provider call.

## Build and deploy

Build the image in ACR:

```bash
TAG="azure-$(date -u +%Y%m%d%H%M%S)"
az acr build \
  --registry "$REGISTRY" \
  --image "tastytrade-research-mcp:$TAG" \
  .
```

Create or update the Container App with external HTTPS ingress on port 8000,
one replica, the managed identity for ACR pulls, and Key Vault-backed secret
references. Set these non-secret environment variables:

```text
MCP_AUTH_MODE=oauth
MCP_PUBLIC_URL=https://<container-app-fqdn>/mcp
OAUTH_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OAUTH_JWKS_URL=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
OAUTH_AUDIENCE=<resource-app-id>
OAUTH_REQUIRED_SCOPE=api://<resource-app-id>/mcp.read
OAUTH_TOKEN_SCOPE=mcp.read
OAUTH_RESOURCE_NAME=Tastytrade Research MCP
```

For emergency rollback, move 100% traffic to the still-active revision
`tastytrade-research-mcp--main-0992cc7`. That revision contains the persistent
Azure Files cache, exact fixed-horizon package workflow, research-only model
valuation fallback, and resumable date-range candidate discovery, but
predates the 100-symbol candidate batches and stage-level timeout
diagnostics. It retains the same Entra OAuth and Key Vault-backed tastytrade
configuration.

After deployment, verify:

1. `/healthz` returns HTTP 200.
2. The protected-resource metadata names Entra and the `mcp.read` scope.
3. `/mcp` without a bearer token returns HTTP 401 with `resource_metadata`.
4. A real Entra token connects, lists all 22 tools, and can call a local-only
   tool such as `tastytrade_price_option_package`.
5. A live provider smoke test can call
   `tastytrade_get_historical_spx_candidate_universe` and verify bounded
   contract coverage, exact OCC identities, explicit gaps, and no evidence
   after `as_of`.
6. A live provider smoke test can call
   `tastytrade_discover_historical_spx_candidates` for
   `2026-08-25T14:30:00Z` and returns four `RECONSTRUCTED_CANDIDATE_FOUND`
   CALL/PUT Delta-20 and 1%-OTM contracts. Every provenance timestamp must be
   `<= as_of`.
7. A range smoke test can call
   `tastytrade_discover_historical_spx_candidates_range` with an explicit
   trading calendar, bounded concurrency, and a checkpoint deadline; verify
   ordered per-checkpoint results, continuation behavior, and aggregate cache
   diagnostics.
8. A live exact-leg package smoke test can reconstruct checkpoint evidence,
   return a gap-preserving short path at the finest retrievable resolution,
   and feed that path directly to `tastytrade_verify_historical_fill`.
9. A frozen-inventory smoke test can call
   `tastytrade_get_historical_option_package_horizons` with an authoritative
   trading calendar and verify exact ENTRY/+3/+5 symbols plus aggregate
   coverage diagnostics.

## Current pre-selector-timeout deployment verification

Revision `tastytrade-research-mcp--main-851f08c` was verified on 2026-09-27
with:

- ACR build run `ccu` producing digest
  `sha256:632fcfc61c1c0dfade6654151c650e4fc56dacde498b6f9d815c515c1595149d`;
- source commit `851f08ca1a8b7ce77b534edb0bf6237d35a6c6e4`;
- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic, with `main-0992cc7`, `main-6c5521e`, and
  `main-85b194f` healthy and active at 0%; `main-0992cc7` is the immediate
  rollback revision;
- unchanged managed identity, ACR pull configuration, Key Vault secret refs,
  ingress, resource limits, one-replica scale, and Azure Files cache mount;
- HTTP 200 from `/healthz`, valid RFC 9728 protected-resource metadata, and
  HTTP 401 with the required resource metadata and `mcp.read` scope from
  unauthenticated `/mcp`;
- an Entra delegated `mcp.read` token listing all 22 MCP tools and an
  authenticated local package-pricing call returning a `1` synthetic natural
  credit;
- a production `BYPASS` request for the exact #70 2026-08-24 grid completing
  in 6,739 ms, starting all 12 selectors, returning eight candidates, and
  reporting no timeout;
- the same warmed `READ_WRITE` request completing in 1,925 ms with six
  immutable manifests and no provider bootstrap, followed by exact
  `CACHE_ONLY` replay in 956 ms with all 12 selectors, eight candidates, and
  zero provider access; and
- stage diagnostics reporting the fixed cache, provider, universe,
  reconstruction, and selector stages with `timeout_stage: null` for the
  successful provider and cache probes.

A fresh `READ_WRITE` namespace on the accumulated Azure Files share exposed a
separate storage bottleneck: the 15-second checkpoint ended in
`CACHE_LOOKUP` after only two cache operations, while provider bootstrap used
1,494 ms. Repeated requests safely populated the immutable manifests, but
cold Azure Files quota/write latency remains tracked in #72. The optimized
uncached provider path itself completed within the #70 deadline.

## Previous range-discovery deployment verification

Revision `tastytrade-research-mcp--main-0992cc7` was verified on 2026-09-27
with:

- ACR build run `cct` producing digest
  `sha256:874e60cc2ee0cc68740224727d5380ae8bd46d705242eeac350c7a2cc24e59dd`;
- source commit `0992cc762fd4fe31a6dbf0cf0bb084b92a688cff`;
- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic, with `main-6c5521e` and `main-85b194f` healthy and
  active at 0%; `main-6c5521e` is the immediate rollback revision;
- unchanged managed identity, ACR pull configuration, Key Vault secret refs,
  ingress, resource limits, one-replica scale, and Azure Files cache mount;
- HTTP 200 from `/healthz` and RFC 9728 protected-resource metadata;
- HTTP 401 plus the correct resource metadata and scope from unauthenticated
  `/mcp`;
- an Entra delegated `mcp.read` token listing all 22 MCP tools and exposing
  the range continuation schema;
- an authenticated local package-pricing call returning a `1` synthetic
  natural credit;
- an authenticated 2026-08-25 07:30 PT range call resolving the exact
  checkpoint, completing without a continuation, preserving the
  single-checkpoint `NOT_AVAILABLE` result, and returning four immutable
  candle manifests; and
- a second production call reusing all four manifests as cache hits and
  reporting four provider calls avoided.

## Current model-valuation deployment verification

Revision `tastytrade-research-mcp--main-6c5521e` was verified on 2026-09-27
with:

- ACR build run `ccs` producing digest
  `sha256:a467850284d16a6d2e2233c85a76756180173c8195cc30ada89ecc7acfeb9511`;
- source commit `6c5521effeb7daded18dcbd51d990df6c4260426`;
- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic, with `main-85b194f` active at 0% as the immediate
  rollback revision and the older `main-8a93c25` revision deactivated;
- unchanged managed identity, ACR pull configuration, Key Vault secret refs,
  ingress, resource limits, one-replica scale, and Azure Files cache mount;
- HTTP 200 from `/healthz` and RFC 9728 protected-resource metadata;
- HTTP 401 plus the correct resource metadata and scope from unauthenticated
  `/mcp`;
- an Entra delegated `mcp.read` token listing all 21 MCP tools and exposing
  the opt-in `valuation_fallback` schema;
- an authenticated local package-pricing call returning a `1` synthetic
  natural credit;
- the frozen 2026-08-25 IC/DD inventory retaining two exact packages while
  increasing usable valuation coverage from two of six to four of six:
  two `EXACT_PACKAGE_REFERENCE`, one `MIXED_OBSERVED_MODELED`, and one
  `MODEL_SURFACE`;
- the modeled IC +3 value of `-13.988598` and mixed DD ENTRY value of
  `68.344389`, both normalizing as complete `MODEL_REFERENCE` inputs; and
- all six horizon manifests replaying through `CACHE_ONLY` with identical
  strict and modeled results and six provider calls avoided.

## Current exact-package horizon deployment verification

Revision `tastytrade-research-mcp--main-85b194f` was verified on 2026-09-27
with:

- ACR build run `ccr` producing digest
  `sha256:7f2d2e16530c8b72f9e046623c64e92300644f28a17de117308572128e085508`;
- source commit `85b194f82e0ed65549359a1fcd9f671e07de8fa5`;
- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic, with `main-8a93c25` active at 0% as the immediate
  rollback revision and the older `main-fc7e5d9` revision deactivated;
- unchanged managed identity, ACR pull configuration, Key Vault secret refs,
  ingress, resource limits, one-replica scale, and Azure Files cache mount;
- HTTP 200 from `/healthz` and RFC 9728 protected-resource metadata;
- HTTP 401 plus the correct resource metadata and scope from unauthenticated
  `/mcp`;
- an Entra delegated `mcp.read` token listing all 21 MCP tools;
- an authenticated local package-pricing call returning a `1` synthetic
  natural credit;
- the four expected 2026-08-25 Path B candidates, all selected at the exact
  checkpoint with no future provenance;
- the 21-35 DTE, 7300-8050, 25-point candidate universe retaining 110 of 186
  requested contracts, 103 reconstructed deltas, all four Double Diagonal
  target inputs, zero provider errors, and zero future evidence; and
- an exact frozen 2026-08-25 Iron Condor horizon request returning a `14.3`
  ENTRY credit, explicit contract-absence diagnostics at +3, and a `9.11` +5
  credit. Its three `READ_WRITE` manifests replayed through `CACHE_ONLY` with
  identical exact symbols, reference values, failures, and coverage.

## Current persistent-cache deployment verification

Revision `tastytrade-research-mcp--main-8a93c25` was verified on 2026-09-27
with:

- ACR build run `ccq` producing digest
  `sha256:adebce601fea60ce2d2cab49866388cbe616a5f038e2d20267b86b9e7e33054c`;
- source commit `8a93c255116a886658ffb1ef4c48b012a2f07c77`;
- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic, with `main-fc7e5d9` active at 0% as the rollback
  revision and obsolete cache-test revisions deactivated;
- HTTP 200 from `/healthz` and RFC 9728 protected-resource metadata;
- HTTP 401 plus the correct resource metadata from unauthenticated `/mcp`;
- an Entra delegated `mcp.read` token listing all 20 MCP tools;
- an authenticated local package-pricing call returning a `1` synthetic
  natural credit;
- the Azure Files cache mounted at
  `/var/lib/tastytrade-evidence-cache` in explicit `AZURE_FILES_SMB` mode;
- a `READ_WRITE` request reusing a persistent manifest across revisions,
  followed by an exact `CACHE_ONLY_HIT` with the same normalized content,
  identical candles, and `provider_calls_avoided: 1`;
- default 5-minute Path B returning four
  `RECONSTRUCTED_CANDIDATE_FOUND` contracts with zero future provenance:
  `SPXW  260922C07900000`, `SPXW  260922C07740000`,
  `SPXW  260922P07425000`, and `SPXW  260922P07590000`; and
- the seven-date hourly gate retaining strict-session results at one partial
  date and five verified contracts, while the separate provider-clock cohort
  improved from zero coverage to seven partial dates and 125 verified
  contracts, with zero provider errors and zero future provenance.

The provider-clock cohort remains partial rather than complete because the
available hourly option grid does not provide timestamp-safe price/delta
coverage for every requested contract. This deployment does not relabel those
bars, enable a paid historical provider, or weaken timestamp checks.

## Current historical-package deployment verification

Revision `tastytrade-research-mcp--main-e5e0423` was verified on 2026-09-26
with:

- ACR build run `cck` producing digest
  `sha256:a7cf655c8d76f7df5318d5cf1279e622c4277b7e3cc3a5814b6d56273cee8d82`;
- source commit `e5e0423d850fdf3fd5f99a2a59ea819bd9c02ec9`;
- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic and the superseded `main-faa26ef` revision
  deactivated;
- HTTP 200 from `/healthz`;
- HTTP 200 from RFC 9728 protected-resource metadata;
- HTTP 401 plus the correct resource metadata from unauthenticated `/mcp`;
- an Entra delegated `mcp.read` token listing all 17 MCP tools at the time of
  that deployment (the current source tree exposes 20; this historical
  revision has not been redeployed);
- the strict 30-minute age / 10-minute skew checkpoint request returning
  `NOT_AVAILABLE`, `STALE`, and `MISALIGNED`;
- the explicit 60-minute age / 30-minute skew request returning a `21.06`
  debit `HISTORICAL_OPTION_PACKAGE_REFERENCE` with
  `execution_quality: VALUATION_ONLY`;
- a requested 1-minute 07:30-07:50 PT path explicitly selecting 5-minute
  resolution, returning four gaps and zero fabricated points; and
- direct fill verification returning legacy `NOT_VERIFIABLE` plus
  `assessment_status: NOT_ASSESSABLE`.

## Current expanded-delta deployment verification

Revision `tastytrade-research-mcp--main-faa26ef` was verified on 2026-09-26
with:

- ACR build run `ccj` producing digest
  `sha256:80416c62cd0a8b49ccd1a4aeb31267ac4eac8360c9240d5f791ca01beb18725f`;
- source commit `faa26ef50aedeb61e8724c5fca685fd221d6b8b2`;
- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic and the superseded revision deactivated;
- HTTP 200 from `/healthz`;
- HTTP 200 from RFC 9728 protected-resource metadata;
- HTTP 401 plus the correct resource metadata and scope from unauthenticated
  `/mcp`;
- an Entra delegated `mcp.read` token listing all 15 MCP tools; and
- an authenticated 21-35 DTE, 7300-8050, 25-point candidate-universe request
  returning 110 of 186 requested contracts, delta on 103 contracts, no
  provider errors, all four Double Diagonal target inputs, and zero
  provenance timestamps after the checkpoint.

The live delta coverage was 39/39 at 21 DTE, 34/36 at 28 DTE, and 30/35 at
35 DTE. 34 contracts used aligned parity and 69 used the explicit
spot-forward zero-carry approximation; the seven contracts without historical
IV remained null.

## Initial candidate-universe deployment verification

Revision `tastytrade-research-mcp--main-8c9db34` was verified on 2026-09-26
with:

- ACR build run `cch` producing digest
  `sha256:db9242e0a68035dcc8c5c649e1279fc6ba5b772a6a223e7bab4cc3e9dd2c1f03`;
- source commit `8c9db34d3bd69d3e777a36a3b3508aeea3bf7b04`;
- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic and the superseded revision deactivated;
- HTTP 200 from `/healthz`;
- HTTP 200 from RFC 9728 protected-resource metadata;
- HTTP 401 plus the correct resource metadata and scope from unauthenticated
  `/mcp`;
- an Entra delegated `mcp.read` token listing all 15 MCP tools;
- an authenticated package-pricing call returning the expected natural
  credit; and
- an authenticated 28-DTE, 7350-7950, 50-point candidate-universe request
  returning 18 of 26 requested contracts with no provider errors, all four
  acceptance Iron Condor legs, and zero provenance timestamps after the
  checkpoint.

## Path B deployment verification

Revision `tastytrade-research-mcp--issue20-pathb-4462026` was verified on
2026-09-26 with:

- one healthy replica in `RunningAtMaxScale`;
- 100% production traffic and the superseded revision deactivated;
- HTTP 200 from `/healthz`;
- HTTP 200 from RFC 9728 protected-resource metadata;
- HTTP 401 plus the correct resource metadata and scope from unauthenticated
  `/mcp`;
- an Entra delegated `mcp.read` token listing all 14 MCP tools;
- an authenticated package-pricing call returning the expected natural
  credit; and
- an authenticated live historical-candidate call returning:

  ```text
  SPXW  260922C07900000
  SPXW  260922C07740000
  SPXW  260922P07425000
  SPXW  260922P07590000
  ```

The production response was `COMPLETE`, all four attempts were
`RECONSTRUCTED_CANDIDATE_FOUND`, every contract had
`selected_at == as_of`, and no provenance timestamp exceeded the checkpoint.
