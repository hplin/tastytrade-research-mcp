# tastytrade-research-mcp

Research-only Model Context Protocol (MCP) server for tastytrade historical options research and strategy regression testing.

The project is intentionally separate from the official [tastytrade/tastytrade-mcp](https://github.com/tastytrade/tastytrade-mcp):

- **official tastytrade MCP**: live quotes, option chains, market metrics, account and trading workflows
- **this project**: historical research, Backtester API access, and regression-test support
- **no order placement, replacement, cancellation, or brokerage-account mutation**

## Goals

Primary use cases:

- XSP/SPX directional-strategy regression tests
- SPY cash-secured-put regression tests
- historical option trade simulation
- historical backtest coverage discovery
- reproducible research inputs for higher-level grading engines

## Initial MCP tools

| Tool | Upstream tastytrade endpoint | Purpose |
| --- | --- | --- |
| `tastytrade_get_backtest_available_dates` | `GET /available-dates` | Discover symbols and historical coverage |
| `tastytrade_list_backtests` | `GET /backtests` | List submitted backtest IDs |
| `tastytrade_create_backtest` | `POST /backtests` | Submit a historical strategy backtest |
| `tastytrade_get_backtest` | `GET /backtests/{id}` | Poll status and retrieve results |
| `tastytrade_get_backtest_logs` | `GET /backtests/{id}/logs` | Inspect trial execution logs |
| `tastytrade_simulate_trade` | `POST /simulate-trade` | Simulate one historical trade path |

Backtester base URL: `https://backtester.vast.tastyworks.com`.

## Planned historical-market-data support

A second phase will add a normalized MCP tool for DXLink historical candles:

```text
tastytrade_get_historical_candles
```

That tool is intended to provide OHLCV inputs for deterministic calculations such as VWAP, moving averages, ATR, and price-structure regression. It is deliberately not exposed until the DXLink request/response behavior is implemented and tested.

## Security model

This server is **research-only**.

It never exposes order-entry tools and does not need an account number to run Backtester requests. OAuth client credentials and refresh tokens are sent only to the fixed tastytrade OAuth host. The resulting short-lived access token is sent to the fixed tastytrade Backtester host.

Do not commit credentials.

## Requirements

- Node.js 22+
- tastytrade OAuth API grant:
  - `TASTYTRADE_CLIENT_ID`
  - `TASTYTRADE_CLIENT_SECRET`
  - `TASTYTRADE_REFRESH_TOKEN`

## Setup

```bash
npm install
npm run build

export TASTYTRADE_CLIENT_ID="..."
export TASTYTRADE_CLIENT_SECRET="..."
export TASTYTRADE_REFRESH_TOKEN="..."

npm start
```

For an MCP client, launch:

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

## Regression architecture

```text
Historical market state
        |
        +--> XSP/SPX grading engine
        |         |
        |         +--> candidate gate
        |
        +--> SPY CSP grading engine
                  |
                  +--> candidate gate
                            |
                            v
                 tastytrade Backtester
                    /         \
             aggregate      simulate
              backtest       trade
```

This MCP supplies historical evidence and simulation results. It does not assign strategy grades or decide whether a trade should be entered.

## Development

```bash
npm run typecheck
npm run build
```

## Upstream documentation

- Backtesting guide: https://developer.tastytrade.com/docs/guides/backtesting/
- Backtesting API: https://developer.tastytrade.com/open-api-spec/backtesting/
- Streaming / DXLink: https://developer.tastytrade.com/docs/concepts/streaming/

## Disclaimer

This is an independent research project and is not an official tastytrade product. Historical simulations can differ materially from live execution because of fills, liquidity, spreads, slippage, data availability, and model assumptions.

MIT License.
