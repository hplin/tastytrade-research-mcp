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
  `tastytrade-research-mcp--main-e5e0423`
- ACR image:
  `hplintradingmcp.azurecr.io/tastytrade-research-mcp:main-e5e0423`
- Image digest:
  `sha256:a7cf655c8d76f7df5318d5cf1279e622c4277b7e3cc3a5814b6d56273cee8d82`
- Source commit:
  `e5e0423d850fdf3fd5f99a2a59ea819bd9c02ec9`
- Managed identity: `mi-tastytrade-research-mcp`

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

For emergency rollback, reactivate revision
`tastytrade-research-mcp--main-faa26ef` and move 100% traffic to it. That
revision contains the expanded historical delta reconstruction, but predates
checkpoint-time exact-leg package valuation and historical package paths. It
retains the same Entra OAuth and Key Vault-backed tastytrade configuration.

After deployment, verify:

1. `/healthz` returns HTTP 200.
2. The protected-resource metadata names Entra and the `mcp.read` scope.
3. `/mcp` without a bearer token returns HTTP 401 with `resource_metadata`.
4. A real Entra token connects, lists all 17 tools, and can call a local-only
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
7. A live exact-leg package smoke test can reconstruct checkpoint evidence,
   return a gap-preserving short path at the finest retrievable resolution,
   and feed that path directly to `tastytrade_verify_historical_fill`.

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
- an Entra delegated `mcp.read` token listing all 17 MCP tools;
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
