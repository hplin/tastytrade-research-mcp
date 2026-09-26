# tastytrade-research-mcp

Research-only Model Context Protocol (MCP) server for tastytrade historical
options research, package-price evidence, and strategy regression testing.

The project is intentionally separate from the official
[tastytrade/tastytrade-mcp](https://github.com/tastytrade/tastytrade-mcp):

- **official tastytrade MCP**: live quotes, option chains, market metrics,
  account workflows, and broker dry-run validation
- **this project**: historical candles, Backtester access, package-pricing
  research, and post-session fill verification
- **never exposed here**: brokerage order placement, replacement, or
  cancellation

## MCP tools

### Provider-native Backtester tools

| Tool | Upstream endpoint | Purpose |
| --- | --- | --- |
| `tastytrade_get_backtest_available_dates` | `GET /available-dates` | Discover symbols and historical coverage |
| `tastytrade_list_backtests` | `GET /backtests` | List submitted research jobs |
| `tastytrade_create_backtest` | `POST /backtests` | Submit a provider-native historical strategy |
| `tastytrade_get_backtest` | `GET /backtests/{id}` | Poll status and retrieve results |
| `tastytrade_get_backtest_logs` | `GET /backtests/{id}/logs` | Retrieve trials and execution logs |
| `tastytrade_cancel_backtest` | `POST /backtests/{id}/cancel` | Cancel only a Backtester job |
| `tastytrade_simulate_trade` | `POST /simulate-trade` | Simulate one exact historical trade |

### Research and regression tools

| Tool | Purpose |
| --- | --- |
| `tastytrade_price_option_package` | Price verticals, iron condors, and double diagonals with explicit native/synthetic provenance |
| `tastytrade_discover_historical_spx_candidates` | Reconstruct timestamp-safe historical SPXW candidates from completed DXLink evidence, with exact-timestamp Backtester fallback |
| `tastytrade_get_historical_spx_candidate_universe` | Return a bounded multi-strike, multi-expiration SPXW universe for downstream deterministic spread construction |
| `tastytrade_prepare_spx_spread` | Deterministically normalize SPX legs without calling an upstream service |
| `tastytrade_simulate_spx_spread` | Run exact-leg SPX historical simulation and normalize its result |
| `tastytrade_create_spx_spread_backtest` | Submit supported SPX structures through relative Backtester selectors |
| `tastytrade_verify_historical_fill` | Check a frozen paper limit against a forward Backtester path |
| `tastytrade_get_historical_candles` | Retrieve normalized DXLink OHLCV candles without resampling |

Use MCP `tools/list` for the complete JSON input schemas.

## Execution evidence contract

Every normalized research result uses execution-evidence contract `1.0.0`.
The contract distinguishes:

- `NATIVE_PACKAGE`
- `SYNTHETIC_NATURAL`
- `SYNTHETIC_MID_REFERENCE`
- `HISTORICAL_PATH`
- `BACKTESTER_SIMULATION`
- `BROKER_DRY_RUN`

The machine-readable schema is
[`docs/execution-evidence.schema.json`](docs/execution-evidence.schema.json).
Migration guidance for existing paper-simulation logs is in
[`docs/execution-evidence-migration.md`](docs/execution-evidence-migration.md).

`BROKER_DRY_RUN` validates a caller-supplied order; it never implies
fillability. Synthetic midpoint evidence is valuation-only.

## Package pricing

Package arithmetic uses an in-repository exact decimal implementation rather
than binary floating-point arithmetic.

- `NATIVE_PACKAGE` is selected only when the caller supplies a valid,
  non-crossed upstream package market.
- `SYNTHETIC_NATURAL` buys each leg at its ask and sells each leg at its bid.
- `SYNTHETIC_MID_REFERENCE` uses leg midpoints and always reports
  `guaranteed_executable: false`.
- Native package bid/ask fields are never populated with synthetic arithmetic.
- Every leg retains its exact symbol, action, quantity, expiration, timestamp,
  and provider source.
- `as_of`, freshness, and temporal alignment are computed from the
  decision-critical observations.
- Missing, crossed, stale, future-dated, and materially misaligned quotes are
  returned as explicit warnings. Unusable evidence is never success-shaped.

Supported families are `DEBIT_VERTICAL`, `CREDIT_VERTICAL`, `IRON_CONDOR`, and
multi-expiration `DOUBLE_DIAGONAL`.

## SPX spread adapter

The high-level adapter preserves each exact provider/OCC option symbol in
`/simulate-trade` requests and returns stable `1.0.0` result envelopes. Each
result repeats the immutable normalized legs and carries a deterministic
SHA-256 `request_id`, so persisted evidence remains attributable even though
the provider response itself contains only prices and timestamps.

Aggregate `/backtests` requests use relative selectors (`delta`,
`percentageOTM`, `currentPriceOffset`, or `premium`) and therefore cannot
preserve an exact historical strike or expiration. The adapter exposes that
limitation in its capability flags.

Double diagonals remain exact-simulation only because the aggregate
Backtester cannot faithfully preserve their multi-expiration identity. 0DTE
legs are rejected unless the caller explicitly sets `allow_0dte: true`.

This MCP supplies evidence only. It does not assign grades or make production
entry decisions.

## Historical SPX candidate discovery

`tastytrade_discover_historical_spx_candidates` is the
`REGRESSION_RESEARCH` bridge between timestamp-safe selector evidence and
exact contract identity.

The official option-chain and REST quote endpoints do not document an
historical `as_of` parameter. Backtester logs currently expose exact selected
strike, expiration, side, and a provider-internal symbol, but those log fields
are undocumented. The documented Backtester `EntryConditions` also has no
time-of-day field, and a live request containing undocumented
`entryTime: "14:30:00Z"` was silently ignored: the SPX trial still opened at
`19:45:00Z`.

For `DELTA` and `PERCENTAGE_OTM`, the adapter reconstructs a bounded SPXW
universe from generated OCC/streamer symbols and completed 5-minute DXLink
candles. It enforces `bar start + interval <= as_of`, a 60-minute option
observation limit, timestamp-aligned call/put parity for the forward, and
contract-candle IV for Black-76-style delta. Selection is deterministic by
selector error, observation age, DTE distance, and strike.

Generated contract identity becomes eligible only when DXLink returns
historical evidence for that exact symbol. The result preserves checkpoint
selection time, observation age, price, contract IV, reconstructed delta,
volume/OI when present, OCC identity, and field-level provenance.

Exact-timestamp Backtester selection remains the fallback for unsupported
selectors or insufficient reconstruction evidence. It never sends or trusts
`entryTime`, and it accepts only a trial and opening order exactly at
`as_of`. Stale and future trials remain fail-closed.

The capability returns `HISTORICAL_SELECTOR_CANDIDATE_SET`, never a
full-chain snapshot. Historical bid/ask, ATM IV surface, skew, and term
structure remain unavailable. Exact symbols are `/simulate-trade` compatible,
but the capability separately reports whether an exact simulation snapshot
exists at the arbitrary checkpoint.

The live 2026-08-25 07:30 PT smoke test returns four timestamp-safe CALL/PUT
Delta-20 and 1%-OTM candidates without creating Backtester jobs.

The full provider findings, contract, anti-lookahead rules, and limitations
are documented in
[`docs/historical-spx-candidates.md`](docs/historical-spx-candidates.md).

## Historical SPX candidate universe

`tastytrade_get_historical_spx_candidate_universe` expands checkpoint-safe
evidence from selector winners into a caller-bounded strike grid. By default
it covers the nearest min/mid/max DTE SPXW expirations, both option sides, and
a 25-point strike step.

Generated OCC identity is returned only after DXLink supplies a completed
historical candle for that exact symbol. Contracts without timestamp-safe
evidence are omitted and counted as coverage gaps. The endpoint preserves
price, reconstructed delta, contract IV, OI, volume, observation age, and
field-level provenance when available; it never selects the final spread.

The default freshness maximum is 60 minutes. A caller may explicitly extend
it to 24 hours; older pre-checkpoint observations are then retained only as
`STALE`/`LOW` evidence. Coverage gaps, provider batch errors, and per-field
availability counts remain machine-readable, and aggregate field capability
flags are true only when every returned contract supports the field.

See
[`docs/historical-spx-universe.md`](docs/historical-spx-universe.md)
for the input contract, reconstruction rules, and live checkpoint findings.

## Historical fill verification

`tastytrade_verify_historical_fill`:

- evaluates only `[submitted_at, valid_until]`;
- supports both `ENTRY` and `EXIT`;
- preserves `paper_order_id`, `checkpoint_id`, and `position_id` references;
- returns `TOUCHED`, `NOT_TOUCHED`, or `NOT_VERIFIABLE`;
- distinguishes `LIMIT_TOUCH` from `CONSERVATIVE_CROSS`;
- reports an exact observed touch timestamp when defensible, otherwise a
  bounded interval for a sparse path;
- records disagreement with a live paper assumption without mutating the
  original paper event.

All verification is marked `POST_SESSION_REGRESSION` and includes
`HISTORICAL_EVIDENCE_ONLY_DO_NOT_REWRITE_LIVE_EVENT`.

## DXLink historical candles

`tastytrade_get_historical_candles` obtains an API quote token from
`GET /api-quote-tokens`, connects only to a `wss://` host under
`dxfeed.com`, completes the DXLink handshake, and waits for the indexed-event
snapshot boundary.

The normalized output includes:

- requested and actual UTC ranges;
- source timestamp per bar;
- explicit instrument type and interval;
- `ALL`, US `REGULAR`, or caller-defined `CUSTOM` session filtering with an
  IANA timezone;
- OHLC, volume, VWAP, bid/ask volume, implied volatility, and open interest
  when supplied;
- missing-bar, empty-result, and snapshot-truncation warnings;
- `resampled: false`.

`REGULAR` requests use provider-native `a=s,tho=true` candle attributes, so
bars are aligned to and built only from the instrument's regular trading
session. `CUSTOM` windows filter complete provider bars by their source
timestamp; they are never reaggregated and include an explicit warning about
that limitation.

The server sends `fromTime` as epoch **milliseconds**, matching the current
production DXLink service. The published AsyncAPI description currently says
seconds, but seconds cause the service to replay the full available history.
Production currently ignores `toTime`, so the client estimates and limits the
entire snapshot from `start_time` through the present before opening a socket,
then enforces the same limit while receiving data. Old fine-grained ranges
must use a coarser interval rather than silently consuming an unbounded
snapshot.

### Rate limits and retries

- API quote tokens are cached for 23 hours, below their documented 24-hour
  lifetime.
- The quote-token REST request retries network errors, `429`, and `5xx` up to
  three attempts with capped exponential backoff and jitter.
- A candle snapshot has a configurable timeout (maximum 60 seconds).
- WebSocket snapshot failures are returned explicitly and are not silently
  retried or merged.
- Requests are bounded by `max_candles` (default 10,000; maximum 20,000).
- DXLink permits at most 5 concurrent sessions and 100 Candle subscriptions
  per session. Callers should batch work rather than fan out unbounded calls.

## Security model

OAuth client credentials and refresh tokens are sent only to
`api.tastyworks.com`. The short-lived OAuth token is sent to the fixed
Backtester host and to the tastytrade quote-token endpoint. The resulting
quote token is sent only over `wss://` to a host under `dxfeed.com`.

Do not commit credentials. If using Node's `--env-file`, unset inherited
`TASTYTRADE_*` variables first because inherited values override the file.
All API timestamps must be RFC3339 values containing `Z` or an explicit UTC
offset; timezone-less timestamps are rejected.

The remote HTTP entrypoint supports two authentication modes:

- `api-key` for local development and emergency rollback, using a constant-time
  comparison against `MCP_API_KEY`;
- `oauth` for production, validating Entra JWT signature, issuer, audience,
  expiration, and `mcp.read` scope through cached JWKS.

OAuth mode publishes RFC 9728 protected-resource metadata at both supported
well-known paths and includes that URL and the required scope in every 401
challenge. MCP is accepted only at `POST /mcp`, request bodies are limited to
1 MiB, and `GET /healthz` remains unauthenticated with health metadata only.

## Requirements and setup

- Node.js 22+
- tastytrade OAuth API grant:
  - `TASTYTRADE_CLIENT_ID`
  - `TASTYTRADE_CLIENT_SECRET`
  - `TASTYTRADE_REFRESH_TOKEN`
- A fully onboarded tastytrade customer for DXLink quote tokens

```bash
npm ci
npm run build

export TASTYTRADE_CLIENT_ID="..."
export TASTYTRADE_CLIENT_SECRET="..."
export TASTYTRADE_REFRESH_TOKEN="..."

npm start
```

For remote Streamable HTTP:

```bash
export MCP_API_KEY="$(openssl rand -hex 32)"
export MCP_HTTP_HOST=127.0.0.1
export MCP_HTTP_PORT=8000

npm run start:http
```

Connect to `http://127.0.0.1:8000/mcp` with
`Authorization: Bearer <MCP_API_KEY>`. Azure Container Apps deployment and
Key Vault guidance are documented in
[`docs/azure-deployment.md`](docs/azure-deployment.md).

Production OAuth configuration additionally requires `MCP_PUBLIC_URL`,
`OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `OAUTH_AUDIENCE`,
`OAUTH_REQUIRED_SCOPE`, and `OAUTH_TOKEN_SCOPE`. ChatGPT discovers the Entra
authorization server from
`/.well-known/oauth-protected-resource`, then sends its access token in the
standard `Authorization` header.

For an MCP client:

```json
{
  "mcpServers": {
    "tastytrade-research": {
      "command": "node",
      "args": ["/absolute/path/to/tastytrade-research-mcp/dist/index.js"],
      "env": {
        "TASTYTRADE_CLIENT_ID": "...",
        "TASTYTRADE_CLIENT_SECRET": "...",
        "TASTYTRADE_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

## Development

```bash
npm ci
npm run typecheck
npm test
```

The regression suite covers clean and degraded package markets, all supported
spread families, regular and custom candle sessions, both fill models,
ambiguous paths, Backtester normalization, and MCP tool dispatch.

## Upstream documentation

- Backtesting guide: https://developer.tastytrade.com/docs/guides/backtesting/
- Backtesting API: https://developer.tastytrade.com/reference/backtesting/
- Streaming guide: https://developer.tastytrade.com/docs/guides/stream-market-data/
- Streaming concepts: https://developer.tastytrade.com/docs/concepts/streaming/
- Rate limits: https://developer.tastytrade.com/docs/guides/rate-limits-and-backoff/

## Disclaimer

This is an independent research project and is not an official tastytrade
product. Historical simulations can differ materially from live execution
because of fills, liquidity, spreads, slippage, data availability, and model
assumptions.

MIT License.
