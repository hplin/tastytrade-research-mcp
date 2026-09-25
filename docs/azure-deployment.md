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
  `tastytrade-research-mcp--issue17-202609252238`
- ACR image:
  `hplintradingmcp.azurecr.io/tastytrade-research-mcp:issue17-202609252238`
- Image digest:
  `sha256:fb59846fc4291d6a6e459218ef6b08dd4e2d8e1714b3966a817a2d5e53453ad9`
- Source commit:
  `06d7dd5bfc6cc54469f7f4fc9489bb2b20ad20b5`
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
`tastytrade-research-mcp--oauth20260925043410` and move 100% traffic to it.
That revision retains the same Entra OAuth and Key Vault-backed tastytrade
configuration as the current production revision.

After deployment, verify:

1. `/healthz` returns HTTP 200.
2. The protected-resource metadata names Entra and the `mcp.read` scope.
3. `/mcp` without a bearer token returns HTTP 401 with `resource_metadata`.
4. A real Entra token connects, lists all 14 tools, and can call a local-only
   tool such as `tastytrade_price_option_package`.
5. A live provider smoke test can call
   `tastytrade_discover_historical_spx_candidates` and returns timestamp-safe
   `HISTORICAL_SELECTOR_CANDIDATE_SET` evidence.
