import { describe, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { TastytradeBrokerHistoryClient, brokerTime, historyWindow, FEE_FIELDS } from "../dist/broker-history.js";
import { buildOOBrokerAudit } from "../dist/oo-broker-audit.js";
import { createResearchServer } from "../dist/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/oo-broker-2026-10-13-synthetic.json", import.meta.url)));
const input = { account: { type: "Traditional IRA" }, start: "2026-10-12", end: "2026-10-14" };
const account = { "account-number": "PRIVATE12345678", "account-type-name": "Traditional IRA", "is-closed": false };
const leg = (symbol, action, quantity = "1") => ({ symbol, action, quantity, fills: [] });
function order(id, status = "Cancelled", price = "3.85", seconds = "01") {
  return {
    id, "account-number": account["account-number"], status, price, "price-effect": "Debit",
    source: "OptionOmega", "order-type": "Limit", "time-in-force": "Day",
    "received-at": `2026-10-13T14:06:${seconds}-04:00`,
    "live-at": `2026-10-13T14:06:${seconds}-04:00`,
    "cancelled-at": status === "Cancelled" ? `2026-10-13T14:06:${String(Number(seconds) + 1).padStart(2, "0")}-04:00` : undefined,
    legs: [leg(fixture.symbols[0], "Buy to Close"), leg(fixture.symbols[1], "Sell to Close")],
  };
}
function transaction(id, orderId, symbol, action, price, time, quantity = "1") {
  const sell = action.startsWith("Sell");
  // Fixture values are literal decimal strings rather than JS float arithmetic.
  const values = { "2.22": "222", "0.12": "12", "8.37": "837", "0.22": "22", "1.00": "100" };
  return {
    id, "order-id": orderId, "exec-id": `fill-${id}`, symbol, action, price, quantity,
    "executed-at": time, "transaction-type": "Trade", currency: "USD",
    value: values[price], "value-effect": sell ? "Credit" : "Debit",
    "net-value": values[price], "net-value-effect": sell ? "Credit" : "Debit",
    ...Object.fromEntries(FEE_FIELDS.flatMap(k => [[k, "0"], [`${k}-effect`, "Debit"]])),
  };
}
function envelope(rows, offset = 0, total = rows.length, pages = 1) {
  return { data: { items: rows }, pagination: {
    "page-offset": offset, "total-items": total, "total-pages": pages, "current-item-count": rows.length,
  } };
}
function clientWith(orders = [], transactions = [], override) {
  const get = jest.fn(async (path, config) => {
    if (override) { const response = await override(path, config); if (response !== undefined) return response; }
    if (path === "/customers/me/accounts") return { data: { data: { items: [{ account }] } } };
    return { data: envelope(path.endsWith("/orders") ? orders : transactions) };
  });
  const oauth = { getAccessToken: jest.fn(async () => "SECRET_ACCESS_TOKEN") };
  return { client: new TastytradeBrokerHistoryClient(oauth, { get }), get, oauth };
}
function replay() {
  const opening = {
    ...order("900000000", "Filled", "2.10"), "price-effect": "Credit",
    "received-at": "2026-10-13T14:00:00-04:00", "live-at": "2026-10-13T14:00:00-04:00",
    legs: [leg(fixture.symbols[0], "Sell to Open"), leg(fixture.symbols[1], "Buy to Open")],
  };
  const attempts = fixture.cancelled_limits.map((price, i) => order(String(910000000 + i), "Cancelled", price, String(1 + i * 4).padStart(2, "0")));
  const closing = order(fixture.final_order_id, "Filled", fixture.final_limit, "52");
  closing["terminal-at"] = fixture.broker_fill_time;
  const transactions = [
    transaction("1", opening.id, fixture.symbols[0], "Sell to Open", "2.22", "2026-10-13T14:00:01-04:00"),
    transaction("2", opening.id, fixture.symbols[1], "Buy to Open", "0.12", "2026-10-13T14:00:01-04:00"),
    transaction("3", closing.id, fixture.symbols[0], "Buy to Close", "8.37", fixture.broker_fill_time),
    transaction("4", closing.id, fixture.symbols[1], "Sell to Close", "0.22", fixture.broker_fill_time),
  ];
  const events = [
    { kind: "STOP_TRIGGERED", timestamp: fixture.stop_time, symbols: fixture.symbols, price: fixture.stop_threshold, campaign_id: "synthetic-call-side" },
    { kind: "LIMIT_ATTEMPT", timestamp: "2026-10-13T14:00:00-04:00", order_id: opening.id, symbols: fixture.symbols, campaign_id: "synthetic-call-side" },
    ...attempts.map(a => ({ kind: "LIMIT_ATTEMPT", timestamp: a["received-at"], order_id: a.id, symbols: fixture.symbols, price: a.price, campaign_id: "synthetic-call-side" })),
    { kind: "RETRY_LIMIT_EXHAUSTED", timestamp: fixture.retry_exhausted_time, symbols: fixture.symbols },
    { kind: "FILL_REPORTED", timestamp: fixture.oo_fill_time, order_id: closing.id, symbols: fixture.symbols, campaign_id: "synthetic-call-side" },
  ];
  return { orders: [opening, ...attempts, closing], transactions, events };
}

describe("historical read-only broker client", () => {
  test("uses historical endpoint, selects IRA dynamically, all statuses and precise window", async () => {
    const { client, get } = clientWith([order("123")]);
    const result = await client.getOrders(input);
    expect(result.coverage.status).toBe("COMPLETE");
    expect(result.account).toBe("Traditional IRA [****5678]");
    const [path, config] = get.mock.calls[1];
    expect(path).toBe("/accounts/PRIVATE12345678/orders");
    expect(path).not.toContain("live");
    expect(config.params).toMatchObject({ "start-at": "2026-10-12T04:00:00.000Z", "end-at": "2026-10-14T04:00:00.000Z", "page-offset": 0 });
    expect(config.params.status).toBeUndefined();
  });
  test("paginates and suppresses exact duplicates without hiding completeness", async () => {
    const a = order("123"), b = order("124", "Rejected");
    const { client, get } = clientWith([], [], (path, config) => {
      if (!path.endsWith("/orders")) return;
      return { data: config.params["page-offset"] === 0 ? envelope([a], 0, 2, 2) : envelope([a, b], 1, 2, 2) };
    });
    const result = await client.getOrders(input);
    expect(result.items.map(x => x.id)).toEqual(["123", "124"]);
    expect(result.coverage).toMatchObject({ pagination_complete: true, duplicates: 1, pages: 2, total_items: 2 });
    expect(get.mock.calls.filter(([p]) => p.endsWith("/orders"))).toHaveLength(2);
  });
  test.each(["conflict", "repeated", "missing", "changed", "empty", "budget", "total"])("definite %s pagination gap", async mode => {
    const { client } = clientWith([], [], (path, config) => {
      if (!path.endsWith("/orders")) return;
      const page = config.params["page-offset"];
      if (mode === "missing") return { data: { data: { items: [order("1")] } } };
      const rows = page === 0 ? [order("1")] : mode === "empty" ? [] : mode === "changed" ? [order("2")] :
        [order("1", mode === "conflict" ? "Rejected" : "Cancelled")];
      return { data: envelope(rows, page, mode === "changed" && page ? 3 : mode === "total" ? 9 : 2, mode === "total" ? 1 : 2) };
    });
    const result = await client.getOrders({ ...input, ...(mode === "budget" ? { max_pages: 1 } : {}) });
    expect(result.coverage.pagination_complete).toBe(false);
    expect(result.coverage.gaps.length).toBeGreaterThan(0);
  });
  test("empty is not successful incident reconstruction", async () => {
    const { client } = clientWith();
    const result = await client.getOrders(input);
    expect(result.coverage).toMatchObject({ status: "EMPTY", pagination_complete: true, gaps: ["NO_ELIGIBLE_SPXW_EVIDENCE"] });
  });
  test("second-page access denial retains acquired evidence but never claims complete", async () => {
    const { client } = clientWith([], [], (path, config) => {
      if (!path.endsWith("/orders")) return;
      if (config.params["page-offset"] === 1) throw { isAxiosError: true, response: { status: 403, data: "SECRET" } };
      return { data: envelope([order("1")], 0, 2, 2) };
    });
    const result = await client.getOrders(input);
    expect(result.items).toHaveLength(1);
    expect(result.coverage).toMatchObject({ status: "INCOMPLETE", pagination_complete: false, pages: 1 });
    expect(result.coverage.gaps).toContain("HISTORY_ACCESS_DENIED");
  });
  test("all lifecycle statuses are distinct and original timestamps are retained", async () => {
    const statuses = ["Filled", "Cancelled", "Rejected", "Expired", "Working", "Replaced", "Live"];
    const result = await clientWith(statuses.map((status, i) => order(String(i + 1), status))).client.getOrders(input);
    expect(result.items.map(o => o.status)).toEqual(statuses);
    expect(result.items[0].timestamps["received-at"].original).toBe("2026-10-13T14:06:01-04:00");
  });
  test("incomplete and closed account lists cannot silently resolve IRA", async () => {
    for (const response of [
      { data: { items: [{ account }] }, pagination: { "total-pages": 2, "total-items": 2 } },
      { data: { items: [{ account: { ...account, "is-closed": true } }] } },
    ]) {
      const { client } = clientWith([], [], path => path === "/customers/me/accounts" ? { data: response } : undefined);
      expect((await client.getOrders(input)).coverage.status).toBe("INACCESSIBLE");
    }
  });
  test("provider records outside requested window and mixed packages are definite gaps", async () => {
    const outside = { ...order("1"), "received-at": "2026-10-11T14:00:00-04:00" };
    const mixed = order("2"); mixed.legs.push(leg("AAPL", "Buy"));
    const result = await clientWith([outside, mixed]).client.getOrders(input);
    expect(result.items).toHaveLength(0);
    expect(result.coverage.gaps).toEqual(expect.arrayContaining(["PROVIDER_RECORD_OUTSIDE_WINDOW", "INVALID_OR_UNSUPPORTED_RECORD"]));
  });
  test.each([401, 403, 429, 500])("HTTP %i is sanitized including raw Axios body/config", async status => {
    const secret = "token=SECRET PRIVATE12345678 Jane Doe jane@example.com";
    const { client } = clientWith([], [], path => {
      if (!path.endsWith("/orders")) return;
      throw { isAxiosError: true, response: { status, data: secret }, config: { headers: { Authorization: secret } }, message: secret };
    });
    const result = await client.getOrders(input);
    expect(result.coverage.status).toBe("INACCESSIBLE");
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE12345678|Jane|jane@/);
  });
  test("ambiguous IRA fails; explicit account resolves; closed/Roth excluded", async () => {
    const other = { ...account, "account-number": "IRA98765432" };
    const { client, get } = clientWith([], [], path => path === "/customers/me/accounts" ? { data: { data: { items: [{ account }, { account: other }, { account: { ...account, "account-type-name": "Roth IRA" } }] } } } : undefined);
    const ambiguous = await client.getOrders(input);
    expect(ambiguous.coverage.gaps).toContain("AMBIGUOUS_TRADITIONAL_IRA");
    expect(get.mock.calls).toHaveLength(1);
    const selected = await client.getOrders({ ...input, account: { type: "Traditional IRA", account_number: "IRA98765432" } });
    expect(selected.account).toContain("5432");
  });
  test("OAuth failure is sanitized, no history request occurs", async () => {
    const { client, get, oauth } = clientWith();
    oauth.getAccessToken.mockRejectedValue(new Error("secret refresh_token PII"));
    const result = await client.getOrders(input);
    expect(result.coverage.status).toBe("INACCESSIBLE");
    expect(JSON.stringify(result)).not.toContain("refresh_token");
    expect(get).not.toHaveBeenCalled();
  });
  test.each([
    { start: "2026-02-30", end: "2026-03-02" },
    { start: "2026-10-14", end: "2026-10-12" },
    { start: "2026-10-13T14:00:00", end: "2026-10-14" },
    { max_pages: 0 }, { page_size: 251 }, { account: { type: "Roth IRA" } }, { extra: "invalid" },
  ])("invalid input rejected before auth %j", async invalid => {
    const { client, oauth } = clientWith();
    await expect(client.getOrders({ ...input, ...invalid })).rejects.toThrow();
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });
  test.each(["orders", "transactions", "audit"])("%s accepts page_size 200 unchanged and rejects 201/250 before broker calls", async kind => {
    const { client, get, oauth } = clientWith();
    const query = request => kind === "audit" ? buildOOBrokerAudit(client, request) :
      kind === "orders" ? client.getOrders(request) : client.getTransactions(request);
    await query({ ...input, page_size: 200 });
    expect(get.mock.calls.filter(([path]) => path !== "/customers/me/accounts")
      .every(([, config]) => config.params["per-page"] === 200)).toBe(true);
    get.mockClear(); oauth.getAccessToken.mockClear();
    for (const page_size of [201, 250]) await expect(query({ ...input, page_size })).rejects.toThrow("INVALID_HISTORY_INPUT");
    expect(get).not.toHaveBeenCalled();
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });
  test("invalid exact decimals mark unsupported records, never float-coerce", async () => {
    const { client } = clientWith([order("1", "Filled", 8.15)]);
    const result = await client.getOrders(input);
    expect(result.items).toEqual([]);
    expect(result.coverage.gaps).toContain("INVALID_OR_UNSUPPORTED_RECORD");
  });
  test("credentials embedded in technical fill IDs cannot escape the allowlist", async () => {
    const raw = order("1", "Filled");
    raw.legs[0].fills = [{ "fill-id": "SECRET_ACCESS_TOKEN", quantity: "1", "fill-price": "8.37", "filled-at": fixture.broker_fill_time }];
    const result = await clientWith([raw]).client.getOrders(input);
    expect(result.items).toEqual([]);
    expect(result.coverage.gaps).toContain("SENSITIVE_IDENTIFIER_IN_TECHNICAL_FIELDS");
    expect(JSON.stringify(result)).not.toContain("SECRET_ACCESS_TOKEN");
  });
  test("precision, lifecycle, replacement evidence and fills preserved", async () => {
    const raw = { ...order("1"), price: "3.850000000000000001", "replaces-order-id": "99", "replacing-order-id": "2",
      "order-rule": { "routed-at": "2026-10-13T14:06:02-04:00" } };
    raw.legs[0].fills = [{ "fill-id": "fill-1", "fill-price": "8.370000000000000001", quantity: "0.5", "filled-at": fixture.broker_fill_time }];
    const result = await clientWith([raw]).client.getOrders(input);
    expect(result.items[0]).toMatchObject({ price: raw.price, replaces_order_id: "99", replacing_order_id: "2" });
    expect(result.items[0].legs[0].fills[0].price).toBe("8.370000000000000001");
    expect(result.items[0].timestamps["rule-routed-at"].utc).toBe("2026-10-13T18:06:02.000Z");
  });
});

describe("OO broker synthetic replay", () => {
  test.each([
    ["value-price mismatch", { value: "99999" }, "PER_LEG_VALUE_MISMATCH"],
    ["missing price", { price: undefined }, "EXECUTION_PRICE_MISSING"],
    ["unknown value effect", { "value-effect": "INVALID" }, "INVALID_CASH_FLOW_EFFECT"],
    ["missing value effect", { "value-effect": undefined }, "INVALID_CASH_FLOW_EFFECT"],
    ["opposite value effect", { "value-effect": "Credit" }, "PER_LEG_VALUE_MISMATCH"],
    ["nonzero None effect", { "value-effect": "None" }, "INVALID_CASH_FLOW_EFFECT"],
    ["incompatible execution type", { "transaction-type": "Receive Deliver" }, "UNSUPPORTED_OR_INCOMPLETE_TRANSACTION"],
    ["missing execution type", { "transaction-type": undefined }, "UNSUPPORTED_OR_INCOMPLETE_TRANSACTION"],
    ["negative execution price", { price: "-8.37" }, "INVALID_EXECUTION_PRICE"],
    ["nonpositive execution quantity", { quantity: "-1" }, "INVALID_EXECUTION_QUANTITY"],
    ["reversal", { "reverses-id": "other-fill" }, "REVERSAL_REQUIRES_RECONCILIATION"],
    ["wrong closing action", { action: "Sell to Close" }, "ORDER_EXECUTION_LEG_CONFLICT"],
  ])("%s cannot become definitive episode cost, full closure or realized P/L", async (_name, mutation, gap) => {
    const data = replay();
    Object.assign(data.transactions[2], mutation);
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, {
      ...input, start: "2026-10-13", activity_log: { events: data.events },
    });
    expect(report.coverage.gaps).toContain(gap);
    expect(report.tags).toContain("UNRESOLVED");
    expect(report.tags).not.toContain("CLOSED_CONFIRMED");
    expect(report.episodes[0]).toMatchObject({
      final_package_debit: null, stop_to_fill_difference_per_contract_usd: null, stop_to_final_fill_ms: null,
    });
    expect(report.side_cash_flows[0].realized_gross).toBeNull();
    expect(report.campaigns[0].realized_gross).toBeNull();
    expect(report.summary_zh_tw).toContain("最終組合成交成本 未確認");
    expect(report.summary_zh_tw).not.toContain("最終組合成交成本 999.77");
    expect(report.summary_zh_tw).not.toContain("停損至成交成本差 99612");
  });
  test("missing or estimated fees and missing net values do not suppress reconciled gross or closure", async () => {
    const data = replay();
    delete data.transactions[2].commission;
    delete data.transactions[2]["net-value"];
    data.transactions[3]["is-estimated-fee"] = true;
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, {
      ...input, start: "2026-10-13", activity_log: { events: data.events },
    });
    expect(report.episodes[0]).toMatchObject({ final_package_debit: "8.15", stop_to_fill_difference_per_contract_usd: "450" });
    expect(report.tags).toContain("CLOSED_CONFIRMED");
    expect(report.tags).not.toContain("UNRESOLVED");
    expect(report.side_cash_flows[0]).toMatchObject({ realized_gross: "-605", realized_net: null });
    expect(report.side_cash_flows[0].gaps).toEqual(expect.arrayContaining(["FEE_COMPONENTS_MISSING", "NET_VALUE_MISSING", "ESTIMATED_FEES"]));
  });
  test("absent provider values preserve gross established by complete per-leg price/quantity evidence", async () => {
    const data = replay();
    for (const tx of data.transactions) {
      delete tx.value; delete tx["value-effect"];
    }
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, {
      ...input, start: "2026-10-13", activity_log: { events: data.events },
    });
    expect(report.episodes[0]).toMatchObject({ final_package_debit: "8.15", stop_to_fill_difference_per_contract_usd: "450" });
    expect(report.side_cash_flows[0].realized_gross).toBe("-605");
    expect(report.tags).toContain("CLOSED_CONFIRMED");
    expect(report.tags).not.toContain("UNRESOLVED");
  });
  test("Filled with missing closing execution cannot confirm full closure", async () => {
    const data = replay();
    data.transactions.pop();
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, {
      ...input, start: "2026-10-13", activity_log: { events: data.events },
    });
    expect(report.coverage.gaps).toContain("INCOMPLETE_CLOSE_EXECUTION_QUANTITY");
    expect(report.tags).toContain("UNRESOLVED");
    expect(report.tags).not.toContain("CLOSED_CONFIRMED");
    expect(report.episodes[0].final_package_debit).toBeNull();
    expect(report.episodes[0].stop_to_fill_difference_per_contract_usd).toBeNull();
  });
  test("gross execution gaps in another side leave valid closure and package cost available", async () => {
    const data = replay();
    const put = { ...order("920000000", "Filled", "2.10", "58"), legs: [
      leg("SPXW  261013P07700000", "Buy to Close"), leg("SPXW  261013P07660000", "Sell to Close"),
    ] };
    data.orders.push(put);
    data.transactions.push(
      { ...transaction("5", put.id, put.legs[0].symbol, "Buy to Close", "2.22", fixture.broker_fill_time), value: "99999" },
      transaction("6", put.id, put.legs[1].symbol, "Sell to Close", "0.12", fixture.broker_fill_time),
    );
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, {
      ...input, start: "2026-10-13", activity_log: { events: data.events },
    });
    expect(report.coverage.gaps).toContain("PER_LEG_VALUE_MISMATCH");
    expect(report.tags).toEqual(expect.arrayContaining(["CLOSED_CONFIRMED", "UNRESOLVED"]));
    expect(report.episodes[0].final_package_debit).toBe("8.15");
    expect(report.side_cash_flows.find(s => s.side.endsWith("CALL")).realized_gross).toBe("-605");
    expect(report.side_cash_flows.find(s => s.side.endsWith("PUT")).realized_gross).toBeNull();
  });
  test("incomplete transaction pagination cannot establish final package cost or full closure", async () => {
    const data = replay();
    const { client } = clientWith(data.orders, data.transactions, path => path.endsWith("/transactions") ?
      { data: envelope(data.transactions, 0, data.transactions.length + 1, 2) } : undefined);
    const report = await buildOOBrokerAudit(client, {
      ...input, start: "2026-10-13", max_pages: 1, activity_log: { events: data.events },
    });
    expect(report.coverage.transactions.pagination_complete).toBe(false);
    expect(report.episodes[0].final_package_debit).toBeNull();
    expect(report.tags).not.toContain("CLOSED_CONFIRMED");
    expect(report.tags).toContain("UNRESOLVED");
  });
  test("10/13 cancelled attempts, exact gross -605, difference 450, clocks 4000 ms; 10/12 gap", async () => {
    const data = replay();
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, { ...input, strategy_name: fixture.strategy, activity_log: { events: data.events } });
    expect(report.attempts.filter(a => a.status === "Cancelled").map(a => a.limit)).toEqual(fixture.cancelled_limits);
    expect(report.tags).toEqual(expect.arrayContaining(["STOP_TRIGGERED", "RETRY_LIMIT_EXHAUSTED", "BROKER_CANCELLED", "CLOSED_CONFIRMED"]));
    expect(report.tags).not.toContain("BROKER_REJECTED");
    expect(report.episodes[0]).toMatchObject({ final_package_debit: "8.15", first_limit: "3.85", limit_drift: "4.3",
      stop_to_fill_difference_per_contract_usd: "450", stop_to_first_route_ms: 1000, stop_to_final_fill_ms: 53000 });
    const final = report.attempts.find(a => a.order_id === fixture.final_order_id);
    expect(final.oo_fill_reports[0]).toMatchObject({ oo_minus_broker_ms: 4000 });
    expect(final.oo_fill_reports[0].time.original).toBe(fixture.oo_fill_time);
    expect(final.oo_fill_reports[0].broker_time.original).toBe(fixture.broker_fill_time);
    expect(report.side_cash_flows[0].realized_gross).toBe("-605");
    expect(report.campaigns[0].realized_gross).toBe("-605");
    expect(report.coverage.days[0]).toMatchObject({ date_et: "2026-10-12", order_ids: [], status: "NO_ELIGIBLE_EVIDENCE" });
    expect(report.quote_evidence).toMatchObject({ status: "QUOTE_EVIDENCE_UNAVAILABLE", liquidity: "UNVERIFIED", marketability: "UNVERIFIED" });
    expect(report.summary_zh_tw).toContain("不等於全部可避免滑價");
    expect(report.evidence_matrix.find(e => e.hypothesis === "OO_LIMIT_PRICING_RETRY").confidence).toBe("CONFIRMED");
  });
  test("no retry/root cause from temporal proximity; leg conflict prevents matching", async () => {
    const data = replay();
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, { ...input, activity_log: { events: [
      { kind: "STOP_TRIGGERED", timestamp: fixture.stop_time, symbols: fixture.symbols, price: "3.65" },
      { kind: "FILL_REPORTED", timestamp: fixture.oo_fill_time, order_id: fixture.final_order_id, symbols: ["SPXW  261013P07800000"] },
    ] } });
    expect(report.episodes[0].confirmed_order_ids).toEqual([]);
    expect(report.episodes[0].stop_to_final_fill_ms).toBeNull();
    expect(report.oo_events[1].correlation).toBe("ORDER_ID_LEG_CONFLICT");
    expect(report.campaigns).toEqual([]);
  });
  test("partial IC, independent put/call sides, no full closure or invented realized P/L", async () => {
    const call = order("1", "Partially Filled");
    const putSymbols = ["SPXW  261013P07700000", "SPXW  261013P07660000"];
    call.legs.push(leg(putSymbols[0], "Buy to Close"), leg(putSymbols[1], "Sell to Close"));
    const tx = [transaction("1", "1", fixture.symbols[0], "Buy to Close", "1.00", fixture.broker_fill_time, "0.5"),
      transaction("2", "1", putSymbols[0], "Buy to Close", "1.00", fixture.broker_fill_time)];
    const report = await buildOOBrokerAudit(clientWith([call], tx).client, input);
    expect(report.tags).toContain("EXIT_WORKING");
    expect(report.tags).not.toContain("CLOSED_CONFIRMED");
    expect(report.side_cash_flows.map(s => s.side)).toEqual(["261013:CALL", "261013:PUT"]);
    expect(report.side_cash_flows.every(s => s.realized_gross === null)).toBe(true);
  });
  test("complete IC with separate call/put stop episodes and split partial executions", async () => {
    const data = replay();
    const putSymbols = ["SPXW  261013P07700000", "SPXW  261013P07660000"];
    const entry = data.orders[0];
    entry.legs.push(leg(putSymbols[0], "Sell to Open"), leg(putSymbols[1], "Buy to Open"));
    const putClose = { ...order("920000000", "Filled", "2.10", "58"),
      legs: [leg(putSymbols[0], "Buy to Close"), leg(putSymbols[1], "Sell to Close")] };
    data.orders.push(putClose);
    data.transactions.push(
      transaction("5", entry.id, putSymbols[0], "Sell to Open", "2.22", "2026-10-13T14:00:01-04:00"),
      transaction("6", entry.id, putSymbols[1], "Buy to Open", "0.12", "2026-10-13T14:00:01-04:00"),
      transaction("7", putClose.id, putSymbols[0], "Buy to Close", "2.22", "2026-10-13T14:06:59-04:00"),
      transaction("8", putClose.id, putSymbols[1], "Sell to Close", "0.12", "2026-10-13T14:06:59-04:00"),
    );
    data.events[1].symbols = entry.legs.map(l => l.symbol);
    data.events.push(
      { kind: "STOP_TRIGGERED", timestamp: "2026-10-13T14:06:55-04:00", symbols: putSymbols, price: "2.10", campaign_id: "synthetic-call-side" },
      { kind: "FILL_REPORTED", timestamp: "2026-10-13T14:06:59-04:00", order_id: putClose.id, symbols: putSymbols, campaign_id: "synthetic-call-side" },
    );
    const original = data.transactions[2];
    data.transactions[2] = { ...original, quantity: "0.5", value: "418.5", "net-value": "418.5" };
    data.transactions.push({ ...original, id: "9", "exec-id": "split-fill", quantity: "0.5", value: "418.5", "net-value": "418.5" });
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, { ...input, activity_log: { events: data.events } });
    expect(report.episodes).toHaveLength(2);
    expect(report.episodes[0].confirmed_order_ids).not.toContain(putClose.id);
    expect(report.episodes[1].confirmed_order_ids).toEqual([putClose.id]);
    expect(report.side_cash_flows.map(s => s.realized_gross)).toEqual(["-605", "0"]);
    expect(report.campaigns[0].realized_gross).toBe("-605");
    expect(report.tags).toContain("CLOSED_CONFIRMED");
  });
  test("reported limits inconsistent with broker are surfaced, not confirmed pricing evidence", async () => {
    const report = await buildOOBrokerAudit(clientWith([order("1")]).client, { ...input, activity_log: { events: [
      { kind: "LIMIT_ATTEMPT", timestamp: fixture.stop_time, order_id: "1", price: "99.00" },
    ] } });
    expect(report.oo_events[0].broker_limit_consistency).toBe("CONFLICT");
    expect(report.coverage.gaps).toContain("OO_BROKER_LIMIT_PRICE_CONFLICT");
    expect(report.evidence_matrix[0].confidence).toBe("POSSIBLE");
  });
  test("conflicting campaign references and reversed/estimated transactions cannot claim net realization", async () => {
    const data = replay();
    data.events.push({ ...data.events.at(-1), campaign_id: "other-campaign" });
    data.transactions[3]["reverses-id"] = "3";
    data.transactions[0]["is-estimated-fee"] = true;
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, { ...input, activity_log: { events: data.events } });
    expect(report.campaigns.every(c => c.realized_gross === null && c.realized_net === null)).toBe(true);
    expect(report.side_cash_flows[0].realized_net).toBeNull();
    expect(report.side_cash_flows[0].gaps).toContain("REVERSAL_REQUIRES_RECONCILIATION");
  });
  test("changing account scope, even with same masked suffix, blocks composite confirmation", async () => {
    const data = replay();
    let lookups = 0;
    const { client } = clientWith(data.orders, data.transactions, path => {
      if (path !== "/customers/me/accounts") return;
      lookups++;
      return { data: { data: { items: [{ account: { ...account, "account-number": lookups === 1 ? account["account-number"] : "DIFFERENT5678" } }] } } };
    });
    const report = await buildOOBrokerAudit(client, { ...input, activity_log: { events: data.events } });
    expect(report.coverage.gaps).toContain("ACCOUNT_SCOPE_NOT_RECONCILED");
    expect(report.tags).not.toContain("CLOSED_CONFIRMED");
    expect(report.episodes[0].final_package_debit).toBeNull();
    expect(report.side_cash_flows[0].realized_gross).toBeNull();
  });
  test("contradictory broker leg execution cannot confirm a close or realized side", async () => {
    const data = replay();
    data.transactions[3].symbol = "SPXW  261013C07850000";
    const report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, { ...input, activity_log: { events: data.events } });
    expect(report.coverage.gaps).toContain("ORDER_EXECUTION_LEG_CONFLICT");
    expect(report.episodes[0].final_package_debit).toBeNull();
    expect(report.tags).not.toContain("CLOSED_CONFIRMED");
  });
  test("fees reconcile exact cash flows and missing fees block net completeness", async () => {
    const data = replay();
    data.transactions[0].commission = "1.01"; data.transactions[0]["net-value"] = "220.99";
    let report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, input);
    expect(report.side_cash_flows[0]).toMatchObject({ realized_gross: "-605", realized_net: "-606.01", observed_fee_cash_flow: "-1.01" });
    delete data.transactions[1]["clearing-fees"];
    report = await buildOOBrokerAudit(clientWith(data.orders, data.transactions).client, input);
    expect(report.side_cash_flows[0].realized_gross).toBe("-605");
    expect(report.side_cash_flows[0].realized_net).toBeNull();
  });
  test("restricted transactions prevent realized completeness even with Filled orders", async () => {
    const data = replay();
    const { client } = clientWith(data.orders, data.transactions, path => {
      if (path.endsWith("/transactions")) throw { isAxiosError: true, response: { status: 403 } };
    });
    const report = await buildOOBrokerAudit(client, input);
    expect(report.tags).not.toContain("CLOSED_CONFIRMED");
    expect(report.tags).toContain("UNRESOLVED");
    expect(report.coverage.transactions.status).toBe("INACCESSIBLE");
  });
  test("redacts source, reason, username, arbitrary log/strategy and account identifiers", async () => {
    const secret = "SECRET_TOKEN Jane Doe jane@example.com PRIVATE12345678";
    const raw = { ...order("1", "Rejected"), source: secret, "reject-reason": secret, username: secret, "global-request-id": secret };
    const report = await buildOOBrokerAudit(clientWith([raw]).client, { ...input, strategy_name: secret, activity_log: secret });
    expect(report.tags).toContain("BROKER_REJECTED");
    expect(JSON.stringify(report)).not.toMatch(/SECRET_TOKEN|Jane Doe|jane@example.com|PRIVATE12345678/);
    expect(report.attempts[0].rejection_reason).toBe("PROVIDER_REASON_PRESENT_REDACTED");
  });
  test("normalized text/JSON events accepted; unparseable vendor prose not guessed", async () => {
    const text = `${fixture.stop_time} STOP_TRIGGERED price=3.65 ${fixture.symbols.join(" ")}\nReturning to normal trade management SECRET`;
    const report = await buildOOBrokerAudit(clientWith().client, { ...input, activity_log: text });
    expect(report.oo_events).toHaveLength(1);
    expect(report.coverage.gaps).toContain("OO_TEXT_LINES_UNPARSED");
    expect(JSON.stringify(report)).not.toContain("SECRET");
    const json = await buildOOBrokerAudit(clientWith().client, { ...input, activity_log: JSON.stringify({ events: [{ kind: "STOP_TRIGGERED", timestamp: fixture.stop_time }] }) });
    expect(json.oo_events).toHaveLength(1);
  });
  test.each([
    { events: [{ kind: "MADE_UP", timestamp: fixture.stop_time }] },
    { events: [{ kind: "STOP_TRIGGERED", timestamp: "2026-10-13T14:06:00" }] },
    { events: [{ kind: "STOP_TRIGGERED", timestamp: fixture.stop_time, token: "PRIVATE" }] },
    { events: [{ kind: "STOP_TRIGGERED", timestamp: fixture.stop_time, price: "1e99999" }] },
  ])("strict OO invalid fields rejected without reflecting content", async activity_log => {
    await expect(buildOOBrokerAudit(clientWith().client, { ...input, activity_log })).rejects.toThrow();
  });
});

test("UTC/ET DST date windows and explicit clock offsets", () => {
  expect(historyWindow({ ...input, start: "2026-03-08", end: "2026-03-09" })).toMatchObject({ start_utc: "2026-03-08T05:00:00.000Z", end_utc: "2026-03-09T04:00:00.000Z" });
  expect(historyWindow({ ...input, start: "2026-11-01", end: "2026-11-02" })).toMatchObject({ start_utc: "2026-11-01T04:00:00.000Z", end_utc: "2026-11-02T05:00:00.000Z" });
  expect(brokerTime("2026-11-01T01:30:00-04:00").utc).not.toBe(brokerTime("2026-11-01T01:30:00-05:00").utc);
  expect(brokerTime(fixture.broker_fill_time).et).toContain("14:06:53 GMT-4");
  expect(() => brokerTime("2026-02-30T10:00:00Z")).toThrow();
});

test("MCP tools register, route injected history and reject invalid args", async () => {
  const server = createResearchServer({ brokerHistory: clientWith().client, evidenceCache: null });
  const client = new Client({ name: "broker-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toEqual(expect.arrayContaining(["tastytrade_get_historical_orders", "tastytrade_get_historical_transactions", "tastytrade_audit_oo_broker_orders"]));
    for (const name of ["tastytrade_get_historical_orders", "tastytrade_get_historical_transactions", "tastytrade_audit_oo_broker_orders"]) {
      expect(tools.tools.find(t => t.name === name).inputSchema.properties.request.properties.page_size.maximum).toBe(200);
      for (const page_size of [201, 250]) {
        await expect(client.callTool({ name, arguments: { request: { ...input, page_size } } })).rejects.toThrow("Invalid arguments");
      }
    }
    const response = await client.callTool({ name: "tastytrade_get_historical_orders", arguments: { request: input } });
    expect(JSON.parse(response.content[0].text).coverage.status).toBe("EMPTY");
    const transactions = await client.callTool({ name: "tastytrade_get_historical_transactions", arguments: { request: input } });
    expect(JSON.parse(transactions.content[0].text).coverage.status).toBe("EMPTY");
    const audit = await client.callTool({ name: "tastytrade_audit_oo_broker_orders", arguments: { request: input } });
    expect(JSON.parse(audit.content[0].text).summary_zh_tw).toContain("歷史稽核");
    await expect(client.callTool({ name: "tastytrade_audit_oo_broker_orders", arguments: { request: { ...input, account: { type: "Roth IRA" } } } })).rejects.toThrow("Invalid arguments");
  } finally { await client.close(); await server.close(); }
});
