import axios, { type AxiosInstance } from "axios";
import { createHash } from "node:crypto";
import { OAUTH_BASE_URL, USER_AGENT, assertTrustedHosts } from "./config.js";
import { TastytradeOAuthClient } from "./oauth-client.js";
import { ExactDecimal } from "./decimal.js";
import { normalizeDate, normalizeRfc3339, resolveCheckpoint } from "./time.js";

type RecordData = Record<string, unknown>;
export type BrokerHistoryInput = {
  account: { type: "Traditional IRA"; account_number?: string };
  start: string;
  end: string;
  page_size?: number;
  max_pages?: number;
};
export type BrokerTime = { original: string; utc: string; et: string; clock: "BROKER" | "OO" };
export type BrokerFill = {
  id: string | null; quantity: string | null; price: string | null;
  time: BrokerTime | null; venue: string | null;
};
export type BrokerLeg = {
  symbol: string; action: string; quantity: string | null;
  remaining_quantity: string | null; fills: BrokerFill[];
};
export type BrokerOrder = {
  id: string; status: string; price: string | null; price_effect: string | null;
  order_type: string | null; tif: string | null; source: string;
  rejection_reason: string | null; timestamps: Record<string, BrokerTime>;
  replaces_order_id: string | null; replacing_order_id: string | null;
  complex_order_id: string | null; legs: BrokerLeg[];
};
export type BrokerTransaction = {
  id: string; order_id: string | null; fill_id: string | null;
  symbol: string | null; action: string | null; type: string | null;
  quantity: string | null; price: string | null; time: BrokerTime | null;
  venue: string | null; currency: string | null;
  value: string | null; value_effect: string | null;
  net_value: string | null; net_value_effect: string | null;
  fees: Record<string, { amount: string; effect: string | null }>;
  fees_estimated: boolean; reverses_id: string | null;
  transaction_date: string | null;
  transaction_sub_type: string | null;
  contract: { expiration: string; side: "CALL" | "PUT"; strike: string } | null;
  settlement: string | null;
  lots: BrokerFill[];
};
export type Coverage = {
  status: "COMPLETE" | "EMPTY" | "INCOMPLETE" | "INACCESSIBLE";
  pagination_complete: boolean; pages: number; total_items: number | null;
  unique_items: number; duplicates: number; gaps: string[];
  scope: "PROVIDER_QUERY_RESULT_NOT_EVENT_STREAM";
};
export type HistoryResult<T> = {
  account: string; account_reference: string | null;
  window: { start: string; end: string; start_utc: string; end_utc: string };
  coverage: Coverage; items: T[];
};
export type BrokerHistoryService = {
  getOrders(input: BrokerHistoryInput): Promise<HistoryResult<BrokerOrder>>;
  getTransactions(input: BrokerHistoryInput): Promise<HistoryResult<BrokerTransaction>>;
};

const TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2}))?$";
export const BROKER_HISTORY_PROPERTIES = {
  account: {
    type: "object", properties: {
      type: { const: "Traditional IRA" },
      account_number: { type: "string", pattern: "^[A-Za-z0-9-]{4,32}$" },
    }, required: ["type"], additionalProperties: false,
  },
  start: { type: "string", pattern: TIMESTAMP_PATTERN },
  end: { type: "string", pattern: TIMESTAMP_PATTERN },
  page_size: { type: "integer", minimum: 1, maximum: 200 },
  max_pages: { type: "integer", minimum: 1, maximum: 1000 },
} as const;
export const BROKER_HISTORY_SCHEMA = {
  type: "object", properties: {
    request: {
      type: "object", properties: BROKER_HISTORY_PROPERTIES,
      required: ["account", "start", "end"], additionalProperties: false,
    },
  }, required: ["request"], additionalProperties: false,
} as const;

function record(value: unknown): RecordData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PROVIDER_RESPONSE");
  return value as RecordData;
}
function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
}
function enumValue(value: unknown, allowed: string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}
export function decimalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[+-]?\d{1,30}(?:\.\d{1,18})?$/.test(value)) {
    throw new Error("INVALID_PROVIDER_DECIMAL");
  }
  ExactDecimal.parse(value);
  return value;
}
export function privateReference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
export function brokerTime(value: unknown, clock: "BROKER" | "OO" = "BROKER"): BrokerTime | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("INVALID_TIMESTAMP");
  const utc = normalizeRfc3339(value, "timestamp");
  normalizeDate(value.slice(0, 10), "timestamp");
  if (!/T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d/.test(value)) throw new Error("INVALID_TIMESTAMP");
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(utc));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { original: value, utc, et: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second} ${p.timeZoneName.replace("−", "-")}`, clock };
}
export function historyWindow(input: BrokerHistoryInput) {
  const bound = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? resolveCheckpoint(undefined, { local_date: value, local_time: "00:00", timezone: "America/New_York" }).instant
    : brokerTime(value)!.utc;
  const start = bound(input.start), end = bound(input.end);
  if (start >= end || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new Error("INVALID_HISTORY_WINDOW");
  return { start: input.start, end: input.end, start_utc: start, end_utc: end };
}
function validateInput(input: BrokerHistoryInput): void {
  if (!input || typeof input !== "object" || Object.keys(input).some(k => !["account", "start", "end", "page_size", "max_pages"].includes(k)) ||
      !input.account || typeof input.account !== "object" || Array.isArray(input.account) || input.account.type !== "Traditional IRA" ||
      Object.keys(input.account).some(k => !["type", "account_number"].includes(k)) ||
      (input.account.account_number !== undefined && (typeof input.account.account_number !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(input.account.account_number))) ||
      typeof input.start !== "string" || typeof input.end !== "string" ||
      !Number.isInteger(input.page_size ?? 100) || (input.page_size ?? 100) < 1 || (input.page_size ?? 100) > 200 ||
      !Number.isInteger(input.max_pages ?? 100) || (input.max_pages ?? 100) < 1 || (input.max_pages ?? 100) > 1000) {
    throw new Error("INVALID_HISTORY_INPUT");
  }
  historyWindow(input);
}
const ACTIONS = ["Buy to Open", "Sell to Open", "Buy to Close", "Sell to Close", "Buy", "Sell"];
const EFFECTS = ["Credit", "Debit", "None"];
export const FEE_FIELDS = ["commission", "clearing-fees", "regulatory-fees", "proprietary-index-option-fees", "other-charge", "currency-conversion-fees"];
export function occSymbol(value: unknown): string | null {
  return typeof value === "string" && /^SPXW? {0,5}\d{6}[CP]\d{8}$/.test(value) ? value : null;
}
function contract(symbol: string | null): BrokerTransaction["contract"] {
  const match = symbol?.match(/(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;
  return {
    expiration: normalizeDate(`20${match[1]}-${match[2]}-${match[3]}`, "expiration"),
    side: match[4] === "C" ? "CALL" : "PUT",
    strike: ExactDecimal.parse(match[5]).divide(ExactDecimal.parse("1000")).toString(),
  };
}
function fill(raw: unknown): BrokerFill {
  const f = record(raw);
  return {
    id: identifier(f["fill-id"] ?? f["id"] ?? f["exec-id"]),
    quantity: decimalString(f.quantity), price: decimalString(f["fill-price"] ?? f.price),
    time: brokerTime(f["filled-at"] ?? f["executed-at"]),
    venue: f["destination-venue"] ? `venue:${privateReference(String(f["destination-venue"]))}` : null,
  };
}
function order(raw: unknown): BrokerOrder {
  const o = record(raw), id = identifier(o.id);
  if (!id || !Array.isArray(o.legs)) throw new Error("INVALID_PROVIDER_ORDER");
  const timestamps: Record<string, BrokerTime> = {};
  for (const key of ["created-at", "received-at", "in-flight-at", "live-at", "updated-at", "cancelled-at", "terminal-at"]) {
    const t = brokerTime(o[key]); if (t) timestamps[key] = t;
  }
  if (o["order-rule"]) {
    const rule = record(o["order-rule"]);
    for (const key of ["route-after", "routed-at", "cancel-at", "cancelled-at"]) {
      const t = brokerTime(rule[key]); if (t) timestamps[`rule-${key}`] = t;
    }
  }
  const legs = o.legs.map(rawLeg => {
    const l = record(rawLeg), symbol = occSymbol(l.symbol);
    // Non-SPX legs are not exposed, but invalidate a mixed package rather than misrepresent it.
    if (!symbol) throw new Error("NON_SPXW_PACKAGE");
    return {
      symbol, action: enumValue(l.action, ACTIONS) ?? "UNKNOWN",
      quantity: decimalString(l.quantity), remaining_quantity: decimalString(l["remaining-quantity"]),
      fills: Array.isArray(l.fills) ? l.fills.map(fill) : [],
    };
  });
  return {
    id, status: enumValue(o.status, ["Received", "Routed", "In Flight", "Live", "Working", "Filled", "Cancelled", "Canceled", "Rejected", "Expired", "Replaced", "Partially Filled"]) ?? "UNKNOWN",
    price: decimalString(o.price), price_effect: enumValue(o["price-effect"], EFFECTS),
    order_type: enumValue(o["order-type"], ["Limit", "Market", "Stop", "Stop Limit", "Notional Market"]),
    tif: enumValue(o["time-in-force"], ["Day", "GTC", "GTD", "IOC", "FOK"]),
    source: typeof o.source === "string" && /^(OptionOmega|Option Omega)$/i.test(o.source) ? "OptionOmega" : "UNKNOWN",
    // Provider free text may contain names, account numbers or credentials. Never return it.
    rejection_reason: o["reject-reason"] ? "PROVIDER_REASON_PRESENT_REDACTED" : null,
    timestamps, replaces_order_id: identifier(o["replaces-order-id"]),
    replacing_order_id: identifier(o["replacing-order-id"]),
    complex_order_id: identifier(o["complex-order-id"]), legs,
  };
}
function transaction(raw: unknown): BrokerTransaction {
  const t = record(raw), id = identifier(t.id);
  if (!id) throw new Error("INVALID_PROVIDER_TRANSACTION");
  const fees: BrokerTransaction["fees"] = {};
  for (const k of FEE_FIELDS) {
    const amount = decimalString(t[k]);
    if (amount !== null) fees[k] = { amount, effect: enumValue(t[`${k}-effect`], EFFECTS) };
  }
  const date = t["transaction-date"];
  return {
    id, order_id: identifier(t["order-id"]), fill_id: identifier(t["exec-id"] ?? t["ext-exec-id"]),
    symbol: occSymbol(t.symbol), action: enumValue(t.action, ACTIONS),
    type: enumValue(t["transaction-type"], ["Trade", "Receive Deliver", "Money Movement"]),
    quantity: decimalString(t.quantity), price: decimalString(t.price), time: brokerTime(t["executed-at"]),
    venue: t["destination-venue"] || t.exchange ? `venue:${privateReference(String(t["destination-venue"] ?? t.exchange))}` : null,
    currency: enumValue(t.currency, ["USD"]), value: decimalString(t.value),
    value_effect: enumValue(t["value-effect"], EFFECTS), net_value: decimalString(t["net-value"]),
    net_value_effect: enumValue(t["net-value-effect"], EFFECTS), fees,
    fees_estimated: t["is-estimated-fee"] === true, reverses_id: identifier(t["reverses-id"]),
    transaction_date: typeof date === "string" ? normalizeDate(date, "transaction_date") : null,
    transaction_sub_type: enumValue(t["transaction-sub-type"], ["Buy to Open", "Sell to Open", "Buy to Close", "Sell to Close", "Expiration", "Exercise", "Assignment", "Cash Settlement"]),
    contract: contract(occSymbol(t.symbol)),
    settlement: enumValue(t["settlement-type"], ["Cash", "Physical", "AM", "PM"]),
    lots: Array.isArray(t.lots) ? t.lots.map(fill) : t.lots ? [fill(t.lots)] : [],
  };
}

export class TastytradeBrokerHistoryClient implements BrokerHistoryService {
  private readonly http: Pick<AxiosInstance, "get">;
  private readonly accessTokens = new Set<string>();
  constructor(
    private readonly oauth = new TastytradeOAuthClient(),
    http?: Pick<AxiosInstance, "get">,
  ) {
    assertTrustedHosts();
    const target = new URL(OAUTH_BASE_URL);
    if (target.protocol !== "https:" || target.origin !== "https://api.tastyworks.com" || target.pathname !== "/" || target.username || target.password) {
      throw new Error("UNTRUSTED_BROKER_TARGET");
    }
    this.http = http ?? axios.create({
      baseURL: target.origin, timeout: 30000, maxRedirects: 0,
      maxContentLength: 10 * 1024 * 1024,
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    });
  }
  private async get(path: string, params?: RecordData): Promise<RecordData> {
    try {
      const token = await this.oauth.getAccessToken();
      this.accessTokens.add(token);
      return record((await this.http.get(path, { params, headers: { Authorization: `Bearer ${token}` } })).data);
    } catch (error) {
      // Never propagate Axios config, response body, token-refresh errors or URLs.
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      throw new Error(status === 401 || status === 403 ? "HISTORY_ACCESS_DENIED" :
        status === 429 ? "HISTORY_RATE_LIMITED" : "HISTORY_PROVIDER_ERROR");
    }
  }
  private async account(input: BrokerHistoryInput): Promise<string> {
    const response = await this.get("/customers/me/accounts");
    const data = record(response.data);
    if (!Array.isArray(data.items)) throw new Error("INVALID_ACCOUNT_RESPONSE");
    if (response.pagination) {
      const pagination = record(response.pagination);
      if (Number(pagination["total-pages"] ?? 1) > 1 || Number(pagination["total-items"] ?? data.items.length) > data.items.length) {
        throw new Error("ACCOUNT_LIST_INCOMPLETE");
      }
    }
    const matches = data.items.map(item => record(record(item).account))
      .filter(a => a["account-type-name"] === "Traditional IRA" && a["is-closed"] !== true && !a["closed-at"])
      .filter(a => !input.account.account_number || a["account-number"] === input.account.account_number);
    if (matches.length !== 1) throw new Error(matches.length ? "AMBIGUOUS_TRADITIONAL_IRA" : "TRADITIONAL_IRA_NOT_ACCESSIBLE");
    const number = matches[0]["account-number"];
    if (typeof number !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(number)) throw new Error("INVALID_ACCOUNT_RESPONSE");
    return number;
  }
  private async history<T>(input: BrokerHistoryInput, kind: "orders" | "transactions", normalize: (v: unknown) => T): Promise<HistoryResult<T>> {
    validateInput(input);
    const window = historyWindow(input);
    const coverage: Coverage = {
      status: "INCOMPLETE", pagination_complete: false, pages: 0, total_items: null,
      unique_items: 0, duplicates: 0, gaps: [], scope: "PROVIDER_QUERY_RESULT_NOT_EVENT_STREAM",
    };
    const result: HistoryResult<T> = { account: "Traditional IRA [masked]", account_reference: null, window, coverage, items: [] };
    const seen = new Map<string, string>();
    const gap = (code: string) => { if (!coverage.gaps.includes(code)) coverage.gaps.push(code); };
    let account: string;
    try { account = await this.account(input); } catch (error) {
      coverage.status = "INACCESSIBLE";
      gap(error instanceof Error && ["AMBIGUOUS_TRADITIONAL_IRA", "TRADITIONAL_IRA_NOT_ACCESSIBLE", "INVALID_ACCOUNT_RESPONSE", "ACCOUNT_LIST_INCOMPLETE", "HISTORY_ACCESS_DENIED", "HISTORY_RATE_LIMITED"].includes(error.message) ? error.message : "ACCOUNT_LOOKUP_FAILED");
      return result;
    }
    result.account = `Traditional IRA [****${account.slice(-4)}]`;
    result.account_reference = privateReference(account);
    let totalPages: number | null = null, reachedEnd = false;
    for (let page = 0; page < (input.max_pages ?? 100); page++) {
      let response: RecordData;
      try {
        response = await this.get(`/accounts/${encodeURIComponent(account)}/${kind}`, {
          "start-at": window.start_utc, "end-at": window.end_utc,
          "page-offset": page, "per-page": input.page_size ?? 100, sort: "Asc",
          "underlying-symbol": "SPX",
        });
      } catch (error) {
        gap(error instanceof Error ? error.message : "HISTORY_PROVIDER_ERROR");
        coverage.status = page === 0 ? "INACCESSIBLE" : "INCOMPLETE";
        break;
      }
      coverage.pages++;
      let rows: unknown[], pagination: RecordData;
      try {
        if (response.error) throw new Error();
        const data = record(response.data);
        if (!Array.isArray(data.items) || data.items.length > (input.page_size ?? 100)) throw new Error();
        rows = data.items; pagination = record(response.pagination);
        const totals = pagination["total-items"], pages = pagination["total-pages"];
        if (!Number.isSafeInteger(totals) || Number(totals) < 0 || !Number.isSafeInteger(pages) || Number(pages) < 0 ||
            pagination["page-offset"] !== page || (pagination["current-item-count"] !== undefined && pagination["current-item-count"] !== rows.length)) throw new Error();
        if ((coverage.total_items !== null && coverage.total_items !== totals) || (totalPages !== null && totalPages !== pages)) gap("PAGINATION_CHANGED_DURING_QUERY");
        coverage.total_items = Number(totals); totalPages = Number(pages);
      } catch {
        gap("INVALID_OR_MISSING_PAGINATION"); break;
      }
      let newRows = 0;
      for (const raw of rows) {
        try {
          const row = record(raw), id = identifier(row.id);
          if (!id) throw new Error();
          const fingerprint = JSON.stringify(row);
          if (seen.has(id)) {
            coverage.duplicates++;
            if (seen.get(id) !== fingerprint) gap("CONFLICTING_DUPLICATE");
            continue;
          }
          seen.set(id, fingerprint); newRows++;
          // A broad provider response can include other underlyings. Scope is exact SPX/SPXW.
          if (kind === "orders" && Array.isArray(row.legs) && !row.legs.some(l => occSymbol(record(l).symbol))) continue;
          if (kind === "transactions" && !occSymbol(row.symbol)) continue;
          const normalized = normalize(row);
          const outward = JSON.stringify(normalized);
          if (outward.includes(account) || [...this.accessTokens].some(token => token && outward.includes(token))) {
            gap("SENSITIVE_IDENTIFIER_IN_TECHNICAL_FIELDS"); continue;
          }
          const eventTime = kind === "transactions"
            ? (normalized as BrokerTransaction).time?.utc
            : (normalized as BrokerOrder).timestamps["received-at"]?.utc ?? (normalized as BrokerOrder).timestamps["created-at"]?.utc;
          if (!eventTime) gap("RECORD_WINDOW_MEMBERSHIP_UNVERIFIED");
          if (eventTime && (eventTime < window.start_utc || eventTime >= window.end_utc)) {
            gap("PROVIDER_RECORD_OUTSIDE_WINDOW");
            continue;
          }
          result.items.push(normalized);
        } catch {
          gap("INVALID_OR_UNSUPPORTED_RECORD");
        }
      }
      coverage.unique_items = seen.size;
      if (page + 1 >= (totalPages ?? 0)) { reachedEnd = true; break; }
      if (!newRows) { gap(rows.length ? "REPEATED_PAGE" : "PREMATURE_EMPTY_PAGE"); break; }
    }
    if (!reachedEnd && coverage.status !== "INACCESSIBLE" && !coverage.gaps.length) gap("PAGE_BUDGET_EXHAUSTED");
    if (reachedEnd && coverage.unique_items !== coverage.total_items) gap("TOTAL_ITEMS_MISMATCH");
    coverage.pagination_complete = reachedEnd && coverage.gaps.length === 0;
    if (coverage.pagination_complete) {
      coverage.status = result.items.length ? "COMPLETE" : "EMPTY";
      if (!result.items.length) coverage.gaps.push("NO_ELIGIBLE_SPXW_EVIDENCE");
    }
    return result;
  }
  getOrders(input: BrokerHistoryInput) { return this.history(input, "orders", order); }
  getTransactions(input: BrokerHistoryInput) { return this.history(input, "transactions", transaction); }
}
