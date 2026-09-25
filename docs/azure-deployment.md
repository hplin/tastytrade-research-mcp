# Azure Container Apps deployment

The remote deployment runs the MCP server as a stateless Streamable HTTP
service:

- `GET /healthz` is public and contains no credential or account data.
- `POST /mcp` requires `Authorization: Bearer <MCP_API_KEY>`.
- Other MCP methods and paths are rejected.
- The existing stdio entrypoint remains available for local clients.

The production container runs as the unprivileged Node user and keeps
tastytrade OAuth credentials and the MCP API key in Azure Key Vault-backed
Container App secrets.

## Current production deployment

- Resource group: `rg-trading-mcp`
- Container Apps environment: `cae-trading`
- Container App: `tastytrade-research-mcp`
- MCP URL:
  `https://tastytrade-research-mcp.victoriousfield-047d2c99.westus2.azurecontainerapps.io/mcp`
- Health URL:
  `https://tastytrade-research-mcp.victoriousfield-047d2c99.westus2.azurecontainerapps.io/healthz`
- ACR image:
  `hplintradingmcp.azurecr.io/tastytrade-research-mcp:azure-20260925041145`
- Image digest:
  `sha256:4d635316b9132439ff51a5b1aebf8fac35afb0726fa39a3153a7dc00e2bfcd69`
- Managed identity: `mi-tastytrade-research-mcp`

The production API key is stored in Key Vault as
`tastytrade-research-mcp-api-key`; it is not documented in source control.

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
- `tastytrade-research-mcp-api-key`

Container App secret aliases are limited to 20 characters, so the app maps
those vault entries to `tt-client-id`, `tt-client-secret`,
`tt-refresh-token`, and `mcp-api-key`.

## Build and run locally

```bash
docker build -t tastytrade-research-mcp:local .
docker run --rm -p 8000:8000 \
  -e TASTYTRADE_CLIENT_ID \
  -e TASTYTRADE_CLIENT_SECRET \
  -e TASTYTRADE_REFRESH_TOKEN \
  -e MCP_API_KEY \
  tastytrade-research-mcp:local
```

Check health without credentials:

```bash
curl --fail http://127.0.0.1:8000/healthz
```

Configure a Streamable HTTP MCP client with:

- URL: `https://<container-app-fqdn>/mcp`
- header: `Authorization: Bearer <MCP_API_KEY>`

Never put the API key or tastytrade credentials in source control, container
images, deployment logs, or client configuration committed to a repository.

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
references. Use `az containerapp secret set` with
`keyvaultref:<secret-url>,identityref:<identity-resource-id>` and map the
environment variables with `secretref:<alias>`.

After deployment, verify:

1. `/healthz` returns HTTP 200.
2. `/mcp` without a bearer token returns HTTP 401.
3. An authenticated MCP client connects, lists all 13 tools, and can call a
   local-only tool such as `tastytrade_price_option_package`.
4. A live provider smoke test can call
   `tastytrade_get_backtest_available_dates`.
