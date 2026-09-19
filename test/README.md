# Tests

The first milestone is a compile-safe, read-only MCP surface around tastytrade's official Backtester API.

Before adding production credentials to any local integration test:

1. keep OAuth credentials in environment variables only;
2. verify the credential target is `api.tastyworks.com`;
3. verify the Backtester target is `backtester.vast.tastyworks.com`;
4. never print access tokens, refresh tokens, client secrets, or Authorization headers.

Planned automated tests:

- OAuth token caching and no-redirect behavior
- fixed-host credential guard
- Backtester route mapping
- MCP tool list and input validation
- upstream error normalization
- response-size limits
- historical candle normalization once DXLink support is added
