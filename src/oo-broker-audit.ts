import {
  BROKER_HISTORY_PROPERTIES, FEE_FIELDS, brokerTime, decimalString, historyWindow, occSymbol, privateReference,
  type BrokerHistoryInput, type BrokerHistoryService, type BrokerOrder, type BrokerTime, type BrokerTransaction,
} from "./broker-history.js";
import { ExactDecimal } from "./decimal.js";

export type OOEvent = {
  kind: "STOP_TRIGGERED" | "LIMIT_ATTEMPT" | "RETRY_LIMIT_EXHAUSTED" | "FILL_REPORTED";
  timestamp: string;
  order_id?: string;
  symbols?: string[];
  price?: string;
  campaign_id?: string;
};
export type OOBrokerAuditInput = BrokerHistoryInput & {
  strategy_name?: string;
  activity_log?: string | { events: OOEvent[] };
};
const EVENT_KINDS = ["STOP_TRIGGERED", "LIMIT_ATTEMPT", "RETRY_LIMIT_EXHAUSTED", "FILL_REPORTED"];
export const OO_BROKER_AUDIT_SCHEMA = {
  type: "object", properties: {
    request: {
      type: "object", properties: {
        ...BROKER_HISTORY_PROPERTIES,
        strategy_name: { type: "string", minLength: 1, maxLength: 200 },
        activity_log: {
          oneOf: [
            { type: "string", maxLength: 100000 },
            { type: "object", properties: {
              events: { type: "array", maxItems: 2000, items: {
                type: "object", properties: {
                  kind: { enum: EVENT_KINDS },
                  timestamp: { type: "string", maxLength: 50 },
                  order_id: { type: "string", pattern: "^\\d{1,30}$" },
                  symbols: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true,
                    items: { type: "string", pattern: "^SPXW? {0,5}\\d{6}[CP]\\d{8}$" } },
                  price: { type: "string", pattern: "^\\d{1,10}(?:\\.\\d{1,8})?$" },
                  campaign_id: { type: "string", minLength: 1, maxLength: 100 },
                }, required: ["kind", "timestamp"], additionalProperties: false,
              } },
            }, required: ["events"], additionalProperties: false },
          ],
        },
      }, required: ["account", "start", "end"], additionalProperties: false,
    },
  }, required: ["request"], additionalProperties: false,
} as const;

type Event = Omit<OOEvent, "timestamp" | "campaign_id"> & {
  time: BrokerTime; campaign_reference: string | null; correlation: string; matched_order_ids: string[];
  broker_limit_consistency: "MATCH" | "CONFLICT" | "NOT_COMPARABLE";
};
function normalizeEvent(event: OOEvent): Event {
  if (!event || typeof event !== "object" || Array.isArray(event) ||
      Object.keys(event).some(k => !["kind", "timestamp", "order_id", "symbols", "price", "campaign_id"].includes(k)) ||
      !EVENT_KINDS.includes(event.kind) || typeof event.timestamp !== "string" ||
      (event.order_id !== undefined && (typeof event.order_id !== "string" || !/^\d{1,30}$/.test(event.order_id))) ||
      (event.symbols !== undefined && (!Array.isArray(event.symbols) || !event.symbols.length || event.symbols.length > 8 ||
        new Set(event.symbols).size !== event.symbols.length || event.symbols.some(s => !occSymbol(s)))) ||
      (event.price !== undefined && (typeof event.price !== "string" || !/^\d{1,10}(?:\.\d{1,8})?$/.test(event.price))) ||
      (event.campaign_id !== undefined && (typeof event.campaign_id !== "string" || !event.campaign_id.length || event.campaign_id.length > 100))) {
    throw new Error("INVALID_OO_EVENT");
  }
  return {
    kind: event.kind, time: brokerTime(event.timestamp, "OO")!,
    order_id: event.order_id, symbols: event.symbols, price: decimalString(event.price) ?? undefined,
    campaign_reference: event.campaign_id ? privateReference(event.campaign_id) : null,
    correlation: "UNVERIFIED", matched_order_ids: [],
    broker_limit_consistency: "NOT_COMPARABLE",
  };
}
function parseEvents(log: OOBrokerAuditInput["activity_log"]): { events: Event[]; gaps: string[] } {
  if (log === undefined) return { events: [], gaps: ["OO_LOG_NOT_SUPPLIED"] };
  if (typeof log !== "string") {
    if (!log || Object.keys(log).some(k => k !== "events") || !Array.isArray(log.events) || log.events.length > 2000) throw new Error("INVALID_OO_LOG");
    return { events: log.events.map(normalizeEvent), gaps: [] };
  }
  if (log.length > 100000) throw new Error("OO_LOG_TOO_LARGE");
  if (/^\s*[{[]/.test(log)) {
    try { return parseEvents(JSON.parse(log)); } catch { throw new Error("INVALID_OO_JSON"); }
  }
  const events: Event[] = [], gaps: string[] = [];
  // Only explicitly labelled events with offset-bearing times are interpreted.
  // Arbitrary vendor prose, relative times and unlabelled numbers are not guessed.
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const time = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})/);
    const kind = EVENT_KINDS.find(k => new RegExp(`\\b${k}\\b`).test(line));
    if (!time || !kind) { if (!gaps.includes("OO_TEXT_LINES_UNPARSED")) gaps.push("OO_TEXT_LINES_UNPARSED"); continue; }
    const id = line.match(/\border_id=(\d{1,30})\b/);
    const price = line.match(/\bprice=(\d{1,10}(?:\.\d{1,8})?)\b/);
    const symbols = line.match(/SPXW? {0,5}\d{6}[CP]\d{8}/g);
    events.push(normalizeEvent({
      kind: kind as OOEvent["kind"], timestamp: time[0],
      ...(id ? { order_id: id[1] } : {}), ...(price ? { price: price[1] } : {}),
      ...(symbols ? { symbols: [...new Set(symbols)] } : {}),
    }));
  }
  return { events, gaps };
}
function identities(symbols: string[]): string {
  return symbols.map(s => s.replace(/ /g, "")).sort().join("|");
}
function sameLegs(event: Event, order: BrokerOrder): boolean {
  return !!event.symbols && identities(event.symbols) === identities(order.legs.map(l => l.symbol));
}
function milliseconds(start: BrokerTime | null | undefined, end: BrokerTime | null | undefined) {
  if (!start || !end) return null;
  return Date.parse(end.utc) - Date.parse(start.utc);
}
const decimal = (value: string) => ExactDecimal.parse(value);
const zero = () => ExactDecimal.zero();
function signed(value: string | null, effect: string | null): ExactDecimal | null {
  if (value === null || !["Credit", "Debit", "None"].includes(effect ?? "")) return null;
  if (decimal(value).compare(zero()) < 0 || (effect === "None" && !decimal(value).isZero())) return null;
  return effect === "Debit" ? decimal(value).negate() : decimal(value);
}
function reconcileExecution(t: BrokerTransaction) {
  const gaps = new Set<string>();
  const supported = !!t.symbol && !!t.quantity && !!t.action && t.type === "Trade" && t.currency === "USD" && !!t.time;
  if (!supported) gaps.add("UNSUPPORTED_OR_INCOMPLETE_TRANSACTION");
  if (t.reverses_id) gaps.add("REVERSAL_REQUIRES_RECONCILIATION");
  if (t.quantity === null || decimal(t.quantity).compare(zero()) <= 0) gaps.add("INVALID_EXECUTION_QUANTITY");
  if (t.price === null) gaps.add("EXECUTION_PRICE_MISSING");
  else if (decimal(t.price).compare(zero()) < 0) gaps.add("INVALID_EXECUTION_PRICE");
  if (!t.action || !["Buy to Open", "Sell to Open", "Buy to Close", "Sell to Close"].includes(t.action)) gaps.add("OPEN_CLOSE_CLASSIFICATION_MISSING");
  const amount = signed(t.value, t.value_effect);
  if (t.value !== null && !amount) gaps.add("INVALID_CASH_FLOW_EFFECT");
  const calculated = supported && t.price !== null
    ? decimal(t.price).multiply(decimal(t.quantity!)).multiplyInteger(100)
      .multiplyInteger(t.action!.startsWith("Sell") ? 1 : -1) : null;
  if (!amount && !calculated) gaps.add("GROSS_CASH_FLOW_MISSING");
  if (amount && calculated && amount.compare(calculated) !== 0) gaps.add("PER_LEG_VALUE_MISMATCH");
  return { supported, effective: amount ?? calculated, gaps: [...gaps] };
}
function executionTimeKey(time: BrokerTime) {
  const fraction = time.original.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return `${Math.floor(Date.parse(time.utc) / 1000)}:${fraction.padEnd(9, "0")}`;
}
function reconcileOrderFills(order: BrokerOrder, transactions: BrokerTransaction[]) {
  return order.legs.map(leg => {
    const gaps = new Set<string>();
    const tx = transactions.filter(t => t.order_id === order.id &&
      t.symbol?.replace(/ /g, "") === leg.symbol.replace(/ /g, "") && t.action === leg.action);
    if (!leg.fills.length) return { symbol: leg.symbol, gaps: [] };
    const validFill = (f: { quantity: string | null; price: string | null; time: BrokerTime | null }) =>
      f.quantity !== null && decimal(f.quantity).compare(zero()) > 0 &&
      f.price !== null && decimal(f.price).compare(zero()) >= 0 && f.time !== null;
    if (leg.fills.some(f => !validFill(f))) gaps.add("ORDER_FILL_EVIDENCE_INCOMPLETE");
    if (tx.some(t => reconcileExecution(t).gaps.length) || !tx.length) gaps.add("ORDER_FILL_TRANSACTION_EVIDENCE_INCOMPLETE");
    // Fill IDs are not transaction execution IDs. Only like-named execution
    // namespaces can prove identity; otherwise compare exact economic buckets.
    for (const field of ["id", "exec_id", "ext_exec_id"] as const) {
      const ids = leg.fills.map(f => f[field]).filter((id): id is string => !!id);
      if (new Set(ids).size !== ids.length) gaps.add("ORDER_FILL_IDENTITY_AMBIGUOUS");
    }
    for (const field of ["exec_id", "ext_exec_id"] as const) {
      const ids = tx.map(t => t[field]).filter((id): id is string => !!id);
      if (new Set(ids).size !== ids.length) gaps.add("ORDER_FILL_IDENTITY_AMBIGUOUS");
      for (const f of leg.fills) {
        if (!f[field] || !tx.some(t => t[field])) continue;
        const matched = tx.filter(t => t[field] === f[field]);
        if (matched.length !== 1) { gaps.add("ORDER_FILL_IDENTITY_UNRECONCILED"); continue; }
        const t = matched[0];
        if (!validFill(f) || !validFill(t)) continue;
        if (decimal(f.quantity!).compare(decimal(t.quantity!)) !== 0) gaps.add("ORDER_FILL_QUANTITY_CONFLICT");
        if (decimal(f.price!).compare(decimal(t.price!)) !== 0) gaps.add("ORDER_FILL_PRICE_CONFLICT");
        if (executionTimeKey(f.time!) !== executionTimeKey(t.time!)) gaps.add("ORDER_FILL_TIME_CONFLICT");
      }
    }
    if (leg.fills.every(validFill) && tx.every(validFill)) {
      const total = (rows: typeof leg.fills | typeof tx) =>
        rows.reduce((sum, row) => sum.add(decimal(row.quantity!)), zero());
      if (total(leg.fills).compare(total(tx)) !== 0) gaps.add("ORDER_FILL_QUANTITY_CONFLICT");
      const buckets = (rows: typeof leg.fills | typeof tx) => {
        const result = new Map<string, ExactDecimal>();
        for (const row of rows) {
          const key = `${decimal(row.price!).toString()}@${executionTimeKey(row.time!)}`;
          result.set(key, (result.get(key) ?? zero()).add(decimal(row.quantity!)));
        }
        return result;
      };
      const orderBuckets = buckets(leg.fills), transactionBuckets = buckets(tx);
      if (orderBuckets.size !== transactionBuckets.size || [...orderBuckets].some(([key, quantity]) =>
        !transactionBuckets.has(key) || quantity.compare(transactionBuckets.get(key)!) !== 0)) {
        gaps.add("ORDER_FILL_PRICE_TIME_DISTRIBUTION_CONFLICT");
      }
    }
    return { symbol: leg.symbol, gaps: [...gaps] };
  });
}
function reconcileClose(order: BrokerOrder, transactions: BrokerTransaction[], sourceGaps: string[]) {
  const executions = transactions.filter(t => t.order_id === order.id);
  const reconciled = executions.map(reconcileExecution);
  const gaps = new Set([...sourceGaps, ...reconciled.flatMap(r => r.gaps)]);
  if (!order.legs.length || order.legs.some(l => !l.action.endsWith("Close")) ||
      new Set(order.legs.map(l => l.symbol.replace(/ /g, ""))).size !== order.legs.length ||
      executions.some(t => !order.legs.some(l => l.symbol.replace(/ /g, "") === t.symbol?.replace(/ /g, "") && l.action === t.action))) {
    gaps.add("ORDER_EXECUTION_LEG_CONFLICT");
  }
  if (!order.legs.length || order.legs.some(l => l.quantity === null || decimal(l.quantity).compare(zero()) <= 0 ||
      !executions.some(t => t.symbol?.replace(/ /g, "") === l.symbol.replace(/ /g, "") && t.action === l.action) ||
      executions.filter(t => t.symbol?.replace(/ /g, "") === l.symbol.replace(/ /g, "") && t.action === l.action)
        .reduce((sum, t) => sum.add(decimal(t.quantity ?? "0")), zero()).compare(decimal(l.quantity)) !== 0)) {
    gaps.add("INCOMPLETE_CLOSE_EXECUTION_QUANTITY");
  }
  return {
    complete: order.status === "Filled" && !gaps.size,
    gross: reconciled.reduce((sum, r) => sum.add(r.effective ?? zero()), zero()),
    gaps: [...gaps],
  };
}
function cashFlow(transactions: BrokerTransaction[], sourceGaps: string[] = []) {
  let gross = zero(), fees = zero(), reportedNet = zero();
  const inventory = new Map<string, ExactDecimal>();
  const openInventory = new Map<string, ExactDecimal>();
  const gaps = new Set<string>(sourceGaps);
  let opened = false, closed = false;
  const feeComponents: Record<string, string> = {};
  for (const t of [...transactions].sort((a, b) =>
    (a.time ? executionTimeKey(a.time) : "").localeCompare(b.time ? executionTimeKey(b.time) : ""))) {
    const execution = reconcileExecution(t);
    execution.gaps.forEach(g => gaps.add(g));
    if (!execution.supported) continue;
    const effective = execution.effective;
    if (effective) gross = gross.add(effective);
    const net = signed(t.net_value, t.net_value_effect);
    if (net) reportedNet = reportedNet.add(net); else gaps.add("NET_VALUE_MISSING");
    let transactionFees = zero();
    // Do not assume an absent fee field is zero.
    for (const key of FEE_FIELDS) {
      const fee = t.fees[key];
      if (!fee) { gaps.add("FEE_COMPONENTS_MISSING"); continue; }
      const value = decimal(fee.amount).isZero() ? zero() : signed(fee.amount, fee.effect);
      if (!value) { gaps.add("FEE_EFFECT_MISSING"); continue; }
      transactionFees = transactionFees.add(value);
      feeComponents[key] = decimal(feeComponents[key] ?? "0").add(value).toString();
    }
    fees = fees.add(transactionFees);
    if (t.fees_estimated) gaps.add("ESTIMATED_FEES");
    if (net && effective && t.fees && FEE_FIELDS.every(k => t.fees[k]) && net.compare(effective.add(transactionFees)) !== 0) gaps.add("NET_FEE_RECONCILIATION_MISMATCH");
    const symbol = t.symbol!.replace(/ /g, "");
    const quantity = decimal(t.quantity!);
    const positionChange = quantity.multiplyInteger(t.action!.startsWith("Buy") ? 1 : -1);
    inventory.set(symbol, (inventory.get(symbol) ?? zero()).add(positionChange));
    if (t.action!.endsWith("Open")) {
      opened = true;
      openInventory.set(symbol, (openInventory.get(symbol) ?? zero()).add(positionChange));
    } else if (t.action!.endsWith("Close")) {
      closed = true;
      const previous = openInventory.get(symbol) ?? zero();
      if (previous.isZero() || previous.compare(zero()) === positionChange.compare(zero()) || previous.abs().compare(quantity) < 0) gaps.add("UNMATCHED_CLOSE_OR_PREWINDOW_ENTRY");
      openInventory.set(symbol, previous.add(positionChange));
    } else gaps.add("OPEN_CLOSE_CLASSIFICATION_MISSING");
  }
  const balanced = transactions.length > 0 && opened && closed && [...inventory.values()].every(v => v.isZero()) && [...openInventory.values()].every(v => v.isZero());
  if (!balanced) gaps.add("PARTIAL_OR_OPEN_INVENTORY");
  const grossGaps = [...gaps].filter(g => !["FEE_COMPONENTS_MISSING", "FEE_EFFECT_MISSING", "NET_VALUE_MISSING", "ESTIMATED_FEES", "NET_FEE_RECONCILIATION_MISMATCH"].includes(g));
  return {
    transaction_ids: transactions.map(t => t.id),
    gross_cash_flow: gross.toString(), observed_fee_cash_flow: fees.toString(),
    fee_components: feeComponents, calculated_net_cash_flow: gross.add(fees).toString(),
    reported_net_cash_flow: reportedNet.toString(),
    balanced_inventory: balanced,
    realized_gross: balanced && !grossGaps.length ? gross.toString() : null,
    realized_net: balanced && !gaps.size ? gross.add(fees).toString() : null,
    completeness: gaps.size ? "INCOMPLETE" : "WINDOW_ROUND_TRIP_ONLY",
    gaps: [...gaps],
    inventory: Object.fromEntries([...inventory].map(([k, v]) => [k, v.toString()])),
  };
}

export async function buildOOBrokerAudit(service: BrokerHistoryService, input: OOBrokerAuditInput) {
  if (!input || typeof input !== "object" || Object.keys(input).some(k => !["account", "start", "end", "page_size", "max_pages", "strategy_name", "activity_log"].includes(k)) ||
      (input.strategy_name !== undefined && (typeof input.strategy_name !== "string" || input.strategy_name.length < 1 || input.strategy_name.length > 200))) throw new Error("INVALID_AUDIT_INPUT");
  const window = historyWindow(input);
  const parsed = parseEvents(input.activity_log);
  const historyInput: BrokerHistoryInput = {
    account: input.account, start: input.start, end: input.end,
    ...(input.page_size !== undefined ? { page_size: input.page_size } : {}),
    ...(input.max_pages !== undefined ? { max_pages: input.max_pages } : {}),
  };
  const orders = await service.getOrders(historyInput);
  const transactions = await service.getTransactions(historyInput);
  const gaps = [...parsed.gaps, ...orders.coverage.gaps, ...transactions.coverage.gaps];
  const accountConsistent = orders.account_reference !== null && orders.account_reference === transactions.account_reference;
  if (!accountConsistent) gaps.push("ACCOUNT_SCOPE_NOT_RECONCILED");
  const events = parsed.events.filter(e => {
    if (e.time.utc < window.start_utc || e.time.utc >= window.end_utc) { gaps.push("OO_EVENT_OUTSIDE_WINDOW"); return false; }
    return true;
  });
  const orderMap = new Map(orders.items.map(o => [o.id, o]));
  for (const e of events) {
    if (e.order_id) {
      const o = orderMap.get(e.order_id);
      if (!o) e.correlation = "ORDER_ID_NOT_FOUND";
      else if (e.symbols && !sameLegs(e, o)) e.correlation = "ORDER_ID_LEG_CONFLICT";
      else {
        e.correlation = "EXPLICIT_ORDER_ID"; e.matched_order_ids = [o.id];
        if (e.kind === "LIMIT_ATTEMPT" && e.price && o.price) {
          e.broker_limit_consistency = decimal(e.price).compare(decimal(o.price)) === 0 ? "MATCH" : "CONFLICT";
          if (e.broker_limit_consistency === "CONFLICT") gaps.push("OO_BROKER_LIMIT_PRICE_CONFLICT");
        }
      }
    } else if (e.symbols) {
      e.matched_order_ids = orders.items.filter(o => sameLegs(e, o)).map(o => o.id);
      e.correlation = e.matched_order_ids.length ? "LEG_IDENTITY_ONLY_NOT_RETRY_OR_CAMPAIGN_PROOF" : "LEG_IDENTITY_NOT_FOUND";
    }
    if (!e.matched_order_ids.length) gaps.push("OO_BROKER_CORRELATION_GAP");
  }
  const inconsistentOrders = new Set<string>();
  for (const t of transactions.items) {
    gaps.push(...reconcileExecution(t).gaps);
    const o = t.order_id ? orderMap.get(t.order_id) : undefined;
    if (!o) {
      gaps.push("TRANSACTION_ORDER_HISTORY_GAP");
    } else if (!o.legs.some(l => l.symbol.replace(/ /g, "") === t.symbol?.replace(/ /g, "") && l.action === t.action)) {
      inconsistentOrders.add(o.id);
      gaps.push("ORDER_EXECUTION_LEG_CONFLICT");
    }
  }
  const providerComplete = orders.coverage.pagination_complete && transactions.coverage.pagination_complete;
  const orderFillEvidence = new Map(orders.items.map(o => [o.id, reconcileOrderFills(o, transactions.items)]));
  const sourceGaps = (tx: BrokerTransaction[]) => tx.flatMap(t => t.order_id
    ? (orderFillEvidence.get(t.order_id) ?? []).filter(l => l.symbol.replace(/ /g, "") === t.symbol?.replace(/ /g, "")).flatMap(l => l.gaps) : []);
  for (const evidence of orderFillEvidence.values()) gaps.push(...evidence.flatMap(l => l.gaps));
  const closes = new Map(orders.items.filter(o => o.legs.some(l => l.action.endsWith("Close")))
    .map(o => [o.id, reconcileClose(o, transactions.items, orderFillEvidence.get(o.id)!.flatMap(l => l.gaps))]));
  for (const o of orders.items.filter(o => o.status === "Filled" || transactions.items.some(t => t.order_id === o.id))) {
    gaps.push(...(closes.get(o.id)?.gaps ?? []));
  }
  const attempts = orders.items.filter(o => o.legs.some(l => l.action.endsWith("Close"))).map(o => {
    const executions = accountConsistent ? transactions.items.filter(t => t.order_id === o.id) : [];
    const executionGaps = [...new Set([
      ...orderFillEvidence.get(o.id)!.flatMap(l => l.gaps), ...executions.flatMap(t => reconcileExecution(t).gaps),
      ...(inconsistentOrders.has(o.id) ? ["ORDER_EXECUTION_LEG_CONFLICT"] : []),
    ])];
    const timingReconciled = accountConsistent && providerComplete && !executionGaps.length && executions.length > 0;
    const times = timingReconciled ? executions.map(t => t.time).filter((t): t is BrokerTime => t !== null)
      .sort((a, b) => executionTimeKey(a).localeCompare(executionTimeKey(b))) : [];
    const fillObserved = o.legs.some(l => l.fills.length) || executions.length > 0;
    const firstRoute = o.timestamps["rule-routed-at"] ?? o.timestamps["live-at"] ?? o.timestamps["in-flight-at"];
    const received = o.timestamps["received-at"];
    const terminal = o.timestamps["terminal-at"] ?? o.timestamps["cancelled-at"];
    const fillEvents = events.filter(e => e.kind === "FILL_REPORTED" && e.correlation === "EXPLICIT_ORDER_ID" && e.order_id === o.id);
    return {
      order_id: o.id, status: o.status, limit: o.price, price_effect: o.price_effect,
      order_type: o.order_type, time_in_force: o.tif,
      source: o.source, legs: o.legs, timestamps: o.timestamps,
      execution_evidence: {
        timing_basis: timingReconciled ? "RECONCILED_TRANSACTIONS" : "UNCONFIRMED",
        order_fill_scope: o.legs.some(l => l.fills.length) ? "SUPPLIED_LEGS_ONLY" : "NOT_SUPPLIED",
        reconciliation_gaps: executionGaps,
      },
      rejection_reason: o.rejection_reason,
      relationship_evidence: {
        replaces: o.replaces_order_id, replaced_by: o.replacing_order_id,
        complex_order_id: o.complex_order_id,
        retry: "UNVERIFIED_UNLESS_EXPLICIT_OO_ORDER_IDS",
      },
      broker_first_route: firstRoute ?? null, broker_last_fill: times.at(-1) ?? null,
      broker_first_fill: times[0] ?? null,
      received_to_route_ms: milliseconds(received, firstRoute),
      received_to_cancel_ms: milliseconds(received, o.timestamps["cancelled-at"]),
      broker_working_interval: {
        start: firstRoute ?? received ?? null, end: terminal ?? times.at(-1) ?? null,
        fill_observed: fillObserved,
        no_fill_proof: "ABSENCE_IN_RETURNED_HISTORY_NOT_CONTINUOUS_EXECUTION_TELEMETRY",
      },
      replacement_latency_ms: o.replacing_order_id
        ? milliseconds(o.timestamps["cancelled-at"], orderMap.get(o.replacing_order_id)?.timestamps["received-at"]) : null,
      oo_fill_reports: fillEvents.map(e => ({
        time: e.time, broker_time: times.at(-1) ?? null,
        oo_minus_broker_ms: milliseconds(times.at(-1), e.time),
        basis: "OBSERVED_CLOCK_DISCREPANCY_NOT_MEASURED_CLOCK_OFFSET",
      })),
      execution_transaction_ids: executions.map(t => t.id),
    };
  });
  const episodes = events.filter(e => e.kind === "STOP_TRIGGERED").map(stop => {
    // Leg identity narrows candidates, but never proves one retry chain.
    const candidates = attempts.filter(a => stop.matched_order_ids.includes(a.order_id) &&
      (a.timestamps["received-at"]?.utc ?? "") >= stop.time.utc);
    const ordered = [...candidates].sort((a, b) => (a.timestamps["received-at"]?.utc ?? "").localeCompare(b.timestamps["received-at"]?.utc ?? ""));
    const explicitCampaign = stop.campaign_reference ? events.filter(e => e.campaign_reference === stop.campaign_reference && e.correlation === "EXPLICIT_ORDER_ID").map(e => e.order_id!) : [];
    const confirmed = ordered.filter(a => explicitCampaign.includes(a.order_id) || stop.correlation === "EXPLICIT_ORDER_ID");
    const fills = confirmed.filter(a => a.broker_last_fill);
    const first = confirmed.find(a => a.broker_first_route);
    const last = fills.sort((a, b) => executionTimeKey(a.broker_last_fill!).localeCompare(executionTimeKey(b.broker_last_fill!))).at(-1);
    const close = last ? closes.get(last.order_id) : undefined;
    const fillQuantity = last?.legs[0]?.quantity;
    const balancedFill = fillQuantity && last?.legs.every(l => l.quantity !== null && decimal(l.quantity).compare(decimal(fillQuantity)) === 0);
    const uncertainFill = confirmed.some(a => a.execution_evidence.reconciliation_gaps.length ||
      (a.status === "Filled" && a.execution_evidence.timing_basis === "UNCONFIRMED"));
    const completeClose = !uncertainFill && accountConsistent && providerComplete && close?.complete && last && !inconsistentOrders.has(last.order_id);
    const finalDebit = completeClose && balancedFill
      ? close.gross.negate().divide(decimal(fillQuantity!).multiplyInteger(100)).toString() : null;
    return {
      stop: stop.time, threshold: stop.price ?? null, campaign_reference: stop.campaign_reference,
      candidate_order_ids: ordered.map(a => a.order_id), confirmed_order_ids: confirmed.map(a => a.order_id),
      correlation: confirmed.length ? "EXPLICIT_ORDER_OR_CAMPAIGN_REFERENCES" : "CANDIDATES_ONLY",
      stop_to_first_route_ms: milliseconds(stop.time, first?.broker_first_route),
      stop_to_final_fill_ms: completeClose ? milliseconds(stop.time, last?.broker_last_fill) : null,
      latency_clock_basis: "OO_STOP_TO_BROKER_TIME_UNCALIBRATED",
      first_limit: confirmed[0]?.limit ?? null, final_package_debit: finalDebit,
      limit_drift: confirmed[0]?.limit && confirmed.at(-1)?.limit
        ? decimal(confirmed.at(-1)!.limit!).subtract(decimal(confirmed[0].limit)).toString() : null,
      stop_to_fill_difference_per_contract_usd: finalDebit && stop.price
        ? decimal(finalDebit).subtract(decimal(stop.price)).multiplyInteger(100).toString() : null,
      avoidable_slippage: "UNVERIFIED_WITHOUT_CONTEMPORANEOUS_QUOTES",
    };
  });
  const sideGroups = new Map<string, BrokerTransaction[]>();
  for (const t of transactions.items) {
    const match = t.symbol?.match(/(\d{6})([CP])\d{8}$/);
    if (!match) continue;
    const key = `${match[1]}:${match[2] === "C" ? "CALL" : "PUT"}`;
    sideGroups.set(key, [...(sideGroups.get(key) ?? []), t]);
  }
  const reconciliationComplete = providerComplete && accountConsistent && !inconsistentOrders.size &&
    !gaps.includes("TRANSACTION_ORDER_HISTORY_GAP");
  const sideCashFlows = [...sideGroups].map(([side, tx]) => {
    const flow = cashFlow(tx, sourceGaps(tx));
    return {
      side, ...flow,
      completeness: reconciliationComplete ? flow.completeness : "INCOMPLETE_PROVIDER_OR_ORDER_COVERAGE",
      realized_gross: reconciliationComplete ? flow.realized_gross : null,
      realized_net: reconciliationComplete ? flow.realized_net : null,
      scope: "EXPIRATION_SIDE_WINDOW_NOT_STRATEGY_ATTRIBUTION",
    };
  });
  const campaignRefs = [...new Set(events.map(e => e.campaign_reference).filter((v): v is string => v !== null))];
  const campaigns = campaignRefs.map(reference => {
    const relatedEvents = events.filter(e => e.campaign_reference === reference);
    const ids = [...new Set(relatedEvents.filter(e => e.correlation === "EXPLICIT_ORDER_ID").map(e => e.order_id!))];
    const tx = transactions.items.filter(t => t.order_id && ids.includes(t.order_id));
    const flow = cashFlow(tx, [
      ...sourceGaps(tx), ...ids.flatMap(id => (orderFillEvidence.get(id) ?? []).flatMap(l => l.gaps)),
    ]);
    const conflicting = ids.some(id => events.some(e => e.order_id === id && e.campaign_reference && e.campaign_reference !== reference));
    return {
      campaign_reference: reference, order_ids: ids, ...flow,
      completeness: reconciliationComplete && !conflicting ? flow.completeness : "INCOMPLETE_OR_CONFLICTING",
      realized_gross: reconciliationComplete && !conflicting && relatedEvents.every(e => e.correlation === "EXPLICIT_ORDER_ID" || e.kind === "STOP_TRIGGERED") ? flow.realized_gross : null,
      realized_net: reconciliationComplete && !conflicting && relatedEvents.every(e => e.correlation === "EXPLICIT_ORDER_ID" || e.kind === "STOP_TRIGGERED") ? flow.realized_net : null,
      campaign_completeness: "CALLER_REFERENCED_WINDOW_ONLY_NOT_PROOF_OF_FULL_STRATEGY_HISTORY",
      attribution: conflicting ? "CONFLICTING_CAMPAIGN_REFERENCE" : "EXPLICIT_OO_ORDER_REFERENCES",
    };
  });
  const tags = new Set<string>();
  if (events.some(e => e.kind === "STOP_TRIGGERED")) tags.add("STOP_TRIGGERED");
  if (events.some(e => e.kind === "RETRY_LIMIT_EXHAUSTED")) tags.add("RETRY_LIMIT_EXHAUSTED");
  if (attempts.some(a => ["Live", "Working", "Received", "Routed", "In Flight", "Partially Filled"].includes(a.status))) tags.add("EXIT_WORKING");
  if (attempts.some(a => ["Cancelled", "Canceled"].includes(a.status))) tags.add("BROKER_CANCELLED");
  if (attempts.some(a => a.status === "Rejected")) tags.add("BROKER_REJECTED");
  const closureConfirmed = accountConsistent && providerComplete &&
    attempts.some(a => !inconsistentOrders.has(a.order_id) && closes.get(a.order_id)?.complete);
  if (closureConfirmed) tags.add("CLOSED_CONFIRMED");
  if (!closureConfirmed || !providerComplete || gaps.length || attempts.some(a => ["UNKNOWN", "Working", "Live", "Partially Filled"].includes(a.status))) tags.add("UNRESOLVED");
  const confirmedLimits = events.filter(e => e.kind === "LIMIT_ATTEMPT" && e.correlation === "EXPLICIT_ORDER_ID" && e.broker_limit_consistency !== "CONFLICT");
  const evidenceMatrix = [
    { hypothesis: "OO_LIMIT_PRICING_RETRY", confidence: confirmedLimits.length ? "CONFIRMED" : events.some(e => e.kind === "LIMIT_ATTEMPT") ? "POSSIBLE" : "UNVERIFIED",
      evidence: confirmedLimits.map(e => e.order_id), conclusion: "ATTEMPT_REFERENCES_ONLY_NOT_MALFUNCTION_OR_CAUSALITY" },
    { hypothesis: "BROKER_REJECTION", confidence: tags.has("BROKER_REJECTED") ? "CONFIRMED" : "UNVERIFIED",
      evidence: attempts.filter(a => a.status === "Rejected").map(a => a.order_id), conclusion: "CANCELLED_IS_NOT_REJECTED_ABSENCE_IS_NOT_PROOF" },
    { hypothesis: "MARKETABILITY_LIQUIDITY", confidence: "UNVERIFIED", evidence: [], conclusion: "QUOTE_EVIDENCE_UNAVAILABLE" },
    { hypothesis: "OO_OR_BROKER_OUTAGE", confidence: "UNVERIFIED", evidence: [], conclusion: "NO_ROOT_CAUSE_ASSERTED" },
  ];
  const dailyCoverage = [];
  // Date slices use ET calendar days, including 23/25-hour DST days.
  const etDate = (instant: string) => new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(instant));
  const firstDate = etDate(window.start_utc);
  const lastDate = etDate(new Date(Date.parse(window.end_utc) - 1).toISOString());
  for (let date = firstDate; date <= lastDate; date = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    const orderIds = orders.items.filter(o => Object.values(o.timestamps).some(t => etDate(t.utc) === date)).map(o => o.id);
    const transactionIds = transactions.items.filter(t => t.time && etDate(t.time.utc) === date).map(t => t.id);
    dailyCoverage.push({
      date_et: date, order_ids: orderIds, transaction_ids: transactionIds,
      status: !providerComplete ? "COVERAGE_INCOMPLETE" : orderIds.length || transactionIds.length ? "EVIDENCE_PRESENT" : "NO_ELIGIBLE_EVIDENCE",
      gap: orderIds.length || transactionIds.length ? null : "DATA_COVERAGE_GAP_NO_IDS_OR_ROOT_CAUSE_INFERRED",
    });
  }
  if (dailyCoverage.some(d => d.gap)) tags.add("UNRESOLVED");
  return {
    contract_version: "1.0.0", research_only: true, account: orders.account, account_reference: orders.account_reference,
    strategy_reference: input.strategy_name ? privateReference(input.strategy_name) : null,
    window, coverage: { orders: orders.coverage, transactions: transactions.coverage, gaps: [...new Set(gaps)],
      account_scopes: { orders: orders.account_reference, transactions: transactions.account_reference, consistent: accountConsistent },
      days: dailyCoverage,
      lifecycle: "FINAL_RECORDS_WITH_AVAILABLE_TIMESTAMPS_NOT_COMPLETE_STATE_TRANSITION_STREAM" },
    tags: [...tags], oo_events: events, attempts, episodes,
    transactions: transactions.items, side_cash_flows: sideCashFlows, campaigns,
    quote_evidence: { status: "QUOTE_EVIDENCE_UNAVAILABLE", marketability: "UNVERIFIED", liquidity: "UNVERIFIED",
      reason: "NO_SUPPORTED_CONTEMPORANEOUS_BOTH_LEGS_OR_EXECUTABLE_PACKAGE_QUOTE_SOURCE" },
    evidence_matrix: evidenceMatrix,
    summary_zh_tw: [
      `Traditional IRA 歷史稽核：${attempts.length} 筆平倉委託。`,
      `券商取消 ${attempts.filter(a => ["Cancelled", "Canceled"].includes(a.status)).length} 筆；拒單 ${attempts.filter(a => a.status === "Rejected").length} 筆。取消不等於拒單。`,
      `資料涵蓋：委託 ${orders.coverage.status}；交易 ${transactions.coverage.status}。空白或無權存取代表證據缺口，不推測不存在的委託或原因。`,
      ...dailyCoverage.filter(d => d.gap).map(d => `${d.date_et} ET 無可用個別委託／交易證據；涵蓋缺口，未編造委託 ID 或失敗原因。`),
      ...sideCashFlows.map(s => `${s.side} 觀察到的視窗現金流 ${s.gross_cash_flow} USD（不代表已核對金額）；已實現毛損益 ${s.realized_gross ?? "未確認"}；淨損益 ${s.realized_net ?? "費用或資料不完整"}。`),
      ...episodes.map(e => `停損門檻 ${e.threshold ?? "未提供"}；首筆關聯限價 ${e.first_limit ?? "未確認"}；最終組合成交成本 ${e.final_package_debit ?? "未確認"}。停損至成交成本差 ${e.stop_to_fill_difference_per_contract_usd ?? "未確認"} USD／口；不等於全部可避免滑價。`),
      ...attempts.flatMap(a => a.oo_fill_reports.map(f => `委託 ${a.order_id}：OO ${f.time.original}；券商 ${f.broker_time?.original ?? "缺少成交時間"}；OO 減券商時間 ${f.oo_minus_broker_ms ?? "未確認"} ms（非已校準時鐘偏移）。`)),
      "OO 與券商時間來源各自保留；跨時鐘延遲未校準。缺乏同期雙腿／組合報價，市價可成交性、流動性及根因均未確認。",
    ].join("\n"),
  };
}
