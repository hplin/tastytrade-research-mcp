import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

export const LIMIT_MS = 120_000;
export const MAX_REQUESTS = 3;
const TYPES = ["Quote", "Greeks", "Summary"];
const FIELDS = new Set([
  "eventType", "eventSymbol", "bidTime", "askTime", "bidPrice", "askPrice",
  "bidSize", "askSize", "eventFlags", "index", "time", "sequence", "price",
  "volatility", "delta", "gamma", "theta", "rho", "vega", "eventTime", "openInterest",
]);
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
export const hash = (text) => createHash("sha256").update(text).digest("hex");

// This is one dated owner authorization, not an evergreen exchange calendar.
export function authorizedSession(now) {
  const start = "2026-10-15T00:15:00.000Z";
  const end = "2026-10-15T13:25:00.000Z";
  if (now < Date.parse(start) || now >= Date.parse(end)) throw new Error("AUTHORIZED_GTH_WINDOW_CLOSED");
  return {
    verified_at: new Date(now).toISOString(),
    calendar_date_new_york: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now),
    weekday_new_york: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(now),
    trade_date: "2026-10-15",
    scope: "SPX_SPXW_GTH_20:15_TO_09:25_ET",
    exchange_hours_source: "https://www.cboe.com/en/tradable-products/sp-500/spx-options/spx-specifications/",
    holiday_source: "https://www.cboe.com/en/about/hours/us-options/",
    entitlement: "UNVERIFIED_UNTIL_PROVIDER_RESPONSE",
    policy_session: { start_at: start, end_at: end, time_zone: "America/New_York", utc_offset_minutes: -240 },
  };
}

export function assertUnusedBudget(budget) {
  if (budget.state !== "NOT_STARTED" || budget.requests_started !== 0 || budget.live_started_at !== null ||
      !Array.isArray(budget.attempts) || budget.attempts.length !== 0 ||
      budget.max_snapshot_requests !== MAX_REQUESTS || budget.max_total_live_wall_ms !== LIMIT_MS) {
    throw new Error("CAPTURE_BUDGET_NOT_UNUSED");
  }
}

export function beginAttempt(budget, elapsedMs, name, startedAt) {
  if (budget.state !== "RUNNING" || budget.requests_started >= MAX_REQUESTS ||
      !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= 110_000) {
    throw new Error("CAPTURE_BUDGET_EXHAUSTED");
  }
  budget.requests_started += 1;
  const attempt = { number: budget.requests_started, name, started_at: startedAt, outcome: "STARTED" };
  budget.attempts.push(attempt);
  return attempt;
}

export function sanitizeFeed(message, fields, symbols) {
  if (message.channel !== 3) return null;
  if (message.type === "FEED_CONFIG") {
    const eventFields = {};
    for (const type of TYPES) {
      if (!message.eventFields?.[type]) continue;
      const layout = message.eventFields[type];
      if (!Array.isArray(layout) || layout.some((field) => !FIELDS.has(field))) throw new Error("UNRECOGNIZED_FEED_LAYOUT");
      eventFields[type] = [...layout];
    }
    return { type: "FEED_CONFIG", channel: 3, eventFields };
  }
  if (message.type !== "FEED_DATA") return null;
  if (!Array.isArray(message.data) || message.data.length % 2) throw new Error("UNRECOGNIZED_FEED_DATA");
  const data = [];
  for (let i = 0; i < message.data.length; i += 2) {
    const type = message.data[i];
    const layout = fields[type];
    if (!TYPES.includes(type) || !layout) throw new Error("UNRECOGNIZED_FEED_TYPE");
    const values = message.data[i + 1];
    if (!Array.isArray(values)) throw new Error("UNRECOGNIZED_FEED_ROWS");
    const nested = Array.isArray(values[0]);
    if (!nested && values.length % layout.length) throw new Error("UNRECOGNIZED_FEED_ROWS");
    const rows = nested ? values : Array.from({ length: values.length / layout.length }, (_, j) =>
      values.slice(j * layout.length, (j + 1) * layout.length));
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== layout.length) throw new Error("UNRECOGNIZED_FEED_ROWS");
      if (!symbols.has(row[layout.indexOf("eventSymbol")])) throw new Error("UNEXPECTED_FEED_SYMBOL");
      for (let k = 0; k < row.length; k += 1) {
        const field = layout[k], value = row[k];
        if (field === "eventSymbol") continue;
        if (field === "eventType" && value === type) continue;
        if (value !== null && typeof value !== "number" &&
            !(typeof value === "string" && /^(?:-?\d+(?:\.\d+)?|NaN|Infinity|-Infinity)$/.test(value))) {
          throw new Error("UNRECOGNIZED_FEED_VALUE");
        }
      }
    }
    data.push(type, nested ? rows : rows.flat());
  }
  return { type: "FEED_DATA", channel: 3, data };
}

export function safeError(error) {
  const localCodes = [
    "AUTHORIZED_GTH_WINDOW_CLOSED", "CAPTURE_BUDGET_NOT_UNUSED", "CAPTURE_BUDGET_EXHAUSTED",
    "MISSING_EXISTING_CREDENTIAL", "MISSING_LISTED_SPXW_PM_EXPIRATIONS", "INSUFFICIENT_LISTED_STRIKES",
    "INSUFFICIENT_CENTER_STRIKES", "UNRECOGNIZED_FEED_LAYOUT", "UNRECOGNIZED_FEED_DATA",
    "UNRECOGNIZED_FEED_TYPE", "UNRECOGNIZED_FEED_ROWS", "UNEXPECTED_FEED_SYMBOL",
    "UNRECOGNIZED_FEED_VALUE", "CAPTURE_DEADLINE", "EXPLICIT_PRIVATE_PATHS_REQUIRED",
  ];
  return {
    code: ["ERR_CANCELED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(error?.code)
      ? error.code : localCodes.includes(error?.message) ? error.message : "CAPTURE_OPERATION_FAILED",
    http_status: Number.isInteger(error?.response?.status) ? error.response.status : null,
  };
}

function sanitizeContract(contract) {
  const result = pick(contract, [
    "provider_symbol", "occ_symbol", "streamer_symbol", "underlying", "root_symbol", "strike", "option_type",
    "expiration", "dte", "multiplier", "settlement", "exercise_style", "exercise_style_source",
  ]);
  const timing = ["provider_event_timestamp", "provider_event_timestamp_source", "as_of", "available_at",
    "retrieved_at", "received_at", "provider_symbol", "source", "timestamp", "timestamp_source", "timestamp_provenance"];
  for (const type of ["quote", "greeks", "summary"]) {
    result[type] = contract[type] ? pick(contract[type], [
      ...timing, "bid", "ask", "bid_size", "ask_size", "bid_time", "ask_time", "delta", "gamma", "theta", "vega",
      "rho", "implied_volatility", "price", "calculation_timestamp", "calculation_timestamp_source", "iv_source",
      "event_flags", "content_complete", "open_interest", "day_volume", "day_volume_source",
    ]) : null;
  }
  return result;
}

export function selectPackages(response, session) {
  const root = response?.data?.items?.find((item) => item["root-symbol"] === "SPXW" && item["shares-per-contract"] === 100);
  const expirations = root?.expirations?.filter((expiry) =>
    expiry["settlement-type"] === "PM" && expiry["expiration-date"] >= session.trade_date)
    .sort((a, b) => a["expiration-date"].localeCompare(b["expiration-date"]));
  if (!expirations || expirations.length < 2) throw new Error("MISSING_LISTED_SPXW_PM_EXPIRATIONS");
  const [front, back] = expirations;
  const strikes = front.strikes.filter((strike) => strike.call && strike.put && strike["call-streamer-symbol"] && strike["put-streamer-symbol"])
    .sort((a, b) => Number(a["strike-price"]) - Number(b["strike-price"]));
  const common = strikes.filter((strike) => back.strikes.some((other) => other["strike-price"] === strike["strike-price"] && other.call && other["call-streamer-symbol"]));
  if (common.length < 7) throw new Error("INSUFFICIENT_LISTED_STRIKES");
  const center = common[Math.floor(common.length / 2)];
  const index = strikes.indexOf(center);
  if (index < 2 || index + 2 >= strikes.length) throw new Error("INSUFFICIENT_CENTER_STRIKES");
  const policy = {
    max_quote_age_ms: 5000, max_greeks_age_ms: 5000, max_iv_age_ms: 5000,
    max_quote_greek_skew_ms: 1000, max_cross_leg_skew_ms: 1000, max_receive_skew_ms: 1000,
    require_quote_size: true, require_open_interest: true, require_volume: false,
    session: session.policy_session,
  };
  const leg = (strike, side, action, ratio = 1) => ({
    provider_symbol: strike[side], action, ratio, settlement: "PM", multiplier: "100", exercise_style: "EUROPEAN",
  });
  const definitions = [
    ["calendar", [leg(center, "call", "SELL_TO_OPEN"), leg(back.strikes.find((strike) => strike["strike-price"] === center["strike-price"]), "call", "BUY_TO_OPEN")]],
    ["broken-wing", [leg(strikes[index - 1], "call", "BUY_TO_OPEN"), leg(center, "call", "SELL_TO_OPEN", 2), leg(strikes[index + 2], "call", "BUY_TO_OPEN")]],
    ["iron-condor", [leg(strikes[index - 2], "put", "BUY_TO_OPEN"), leg(strikes[index - 1], "put", "SELL_TO_OPEN"),
      leg(strikes[index + 1], "call", "SELL_TO_OPEN"), leg(strikes[index + 2], "call", "BUY_TO_OPEN")]],
  ];
  return definitions.map(([name, legs]) => {
    const symbols = new Set(legs.map((item) => item.provider_symbol));
    const selectedChain = { data: { items: [{
      ...pick(root, ["underlying-symbol", "root-symbol", "shares-per-contract"]),
      expirations: [front, back].map((expiry) => ({
        ...pick(expiry, ["expiration-date", "days-to-expiration", "settlement-type"]),
        strikes: expiry.strikes.filter((strike) => symbols.has(strike.call) || symbols.has(strike.put))
          .map((strike) => pick(strike, ["strike-price", "call", "put", "call-streamer-symbol", "put-streamer-symbol"])),
      })).filter((expiry) => expiry.strikes.length),
    }] } };
    return {
      name, chain: selectedChain,
      request: {
        underlying: "SPXW", expirations: [...new Set(legs.map((item) => `20${item.provider_symbol.slice(6, 8)}-${item.provider_symbol.slice(8, 10)}-${item.provider_symbol.slice(10, 12)}`))],
        around_price: String(center["strike-price"]), strike_count: 1,
        include_quotes: true, include_greeks: true, include_summary: true,
        phase: "LIVE_SUPPORT", deadline_ms: 20_000, max_temporal_skew_ms: 1000,
        exact_package: { legs, policy },
      },
    };
  });
}

async function capture(budgetPath, outputPath) {
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  assertUnusedBudget(budget);
  const session = authorizedSession(Date.now());
  for (const name of ["TASTYTRADE_CLIENT_ID", "TASTYTRADE_CLIENT_SECRET", "TASTYTRADE_REFRESH_TOKEN"]) {
    if (!process.env[name]?.trim()) throw new Error("MISSING_EXISTING_CREDENTIAL");
  }
  const axios = (await import("axios")).default;
  const { TastytradeOAuthClient } = await import("../dist/oauth-client.js");
  const { createTastytradeApiHttpClient, TastytradeDxlinkTokenClient } = await import("../dist/dxlink.js");
  const { TastytradeLiveOptionSnapshotClient } = await import("../dist/live-option-snapshot.js");
  const { evaluateExactLiveOptionPackage } = await import("../dist/live-option-quality.js");
  const http = createTastytradeApiHttpClient();
  const oauth = new TastytradeOAuthClient();
  const controller = new AbortController();
  const sockets = [];
  const start = performance.now();
  const elapsed = () => performance.now() - start;
  budget.state = "RUNNING";
  budget.live_started_at = new Date().toISOString();
  budget.session = session;
  save(budgetPath, budget);
  process.send?.({ type: "STARTED" });
  const timer = setTimeout(() => controller.abort(), 112_000);
  const bound = (config) => {
    if (controller.signal.aborted || elapsed() >= 112_000) throw new Error("CAPTURE_DEADLINE");
    config.signal = controller.signal;
    config.timeout = Math.max(1, Math.min(15_000, 112_000 - elapsed()));
    return config;
  };
  const interceptor = axios.interceptors.request.use(bound);
  http.interceptors.request.use(bound);
  let active;
  let attemptStarted;
  try {
    const token = await oauth.getAccessToken();
    const discovery = await http.get("/option-chains/SPX/nested", { headers: { Authorization: `Bearer ${token}` } });
    const packages = selectPackages(discovery.data, session);
    const quoteTokens = new TastytradeDxlinkTokenClient(oauth, http);
    mkdirSync(outputPath, { recursive: true, mode: 0o700 });
    for (const item of packages) {
      authorizedSession(Date.now());
      active = beginAttempt(budget, elapsed(), item.name, new Date().toISOString());
      attemptStarted = performance.now();
      active.legs = item.request.exact_package.legs;
      save(budgetPath, budget);
      const frames = [];
      const framePath = `${outputPath}/${active.number}-${item.name}-frames.json`;
      active.observed_frames_path = framePath;
      save(budgetPath, budget);
      let fields = {};
      const symbols = new Set(item.chain.data.items[0].expirations.flatMap((expiry) =>
        expiry.strikes.flatMap((strike) => ["call", "put"].filter((side) =>
          item.request.exact_package.legs.some((leg) => leg.provider_symbol === strike[side]))
          .map((side) => strike[`${side}-streamer-symbol`]))));
      const client = new TastytradeLiveOptionSnapshotClient({
        oauth, http, quoteTokens,
        socketFactory: (url) => {
          const socket = new WebSocket(url);
          sockets.push(socket);
          socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") { controller.abort(); return; }
            try {
              for (const line of event.data.split(/\n+/).filter(Boolean)) {
                const sanitized = sanitizeFeed(JSON.parse(line), fields, symbols);
                if (!sanitized) continue;
                if (sanitized.type === "FEED_CONFIG") fields = sanitized.eventFields;
                frames.push({ observer_received_at: new Date().toISOString(), message: sanitized });
                save(framePath, { evidence_kind: "SANITIZED_ACTUAL_LIVE_TRANSPORT_OBSERVATION", frames });
              }
            } catch (error) {
              active.sanitizer_failure = safeError(error);
              controller.abort();
            }
          });
          return socket;
        },
      });
      const result = await client.getLiveOptionSnapshot({ ...item.request, signal: controller.signal });
      const contracts = result.contracts.map(sanitizeContract);
      const quality = evaluateExactLiveOptionPackage(item.request.exact_package, contracts,
        result.retrieved_at, result.exact_package_quality.transport_complete, result.chain_retrieved_at);
      const fixture = {
        evidence_kind: "SANITIZED_ACTUAL_LIVE_OBSERVATION",
        source: "tastytrade canonical chain + DXLink Quote/Greeks/Summary",
        session, selection_reference: { value: item.request.around_price, source: "MEDIAN_LISTED_COMMON_STRIKE_NOT_OBSERVED_SPOT" },
        request: item.request, chain: item.chain, frames, contracts, quality,
        retrieved_at: result.retrieved_at, chain_retrieved_at: result.chain_retrieved_at,
        transport: pick(result.transport, ["requested_subscriptions", "batch_count", "complete_batches", "partial_batches", "timed_out_batches", "failed_batches"]),
        dxlink_auth_status: result.dxlink_auth.status,
        publication: "PRIVATE_ONLY_NO_VERIFIED_PUBLIC_MARKET_DATA_REDISTRIBUTION_AUTHORITY",
      };
      const path = `${outputPath}/${active.number}-${item.name}.json`;
      save(path, fixture);
      Object.assign(active, {
        outcome: quality.status, finished_at: new Date().toISOString(),
        elapsed_ms: Math.round(performance.now() - attemptStarted),
        fixture_path: path, sha256: hash(readFileSync(path, "utf8")),
        quality: pick(quality, ["status", "reasons", "content_complete", "transport_complete", "oldest_age_ms", "cross_leg_skew_ms", "receive_skew_ms"]),
        contracts: contracts.length, transport: fixture.transport, dxlink_auth_status: fixture.dxlink_auth_status,
      });
      save(budgetPath, budget);
      active = null;
    }
    budget.state = "COMPLETED";
  } catch (error) {
    budget.state = "STOPPED_FAILURE";
    budget.error = safeError(error);
    if (active) {
      Object.assign(active, {
        outcome: "FAILED", finished_at: new Date().toISOString(),
        elapsed_ms: Math.round(performance.now() - attemptStarted), error: safeError(error),
      });
      if (active.observed_frames_path && existsSync(active.observed_frames_path)) {
        active.observed_frames_sha256 = hash(readFileSync(active.observed_frames_path, "utf8"));
      }
    }
  } finally {
    controller.abort();
    for (const socket of sockets) if (socket.readyState < 2) socket.close(1000, "bounded capture cleanup");
    await Promise.all(sockets.map((socket) => socket.readyState === 3 ? Promise.resolve() :
      new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }))));
    clearTimeout(timer);
    axios.interceptors.request.eject(interceptor);
    budget.sockets_created = sockets.length;
    budget.sockets_closed = sockets.filter((socket) => socket.readyState === 3).length;
    budget.live_finished_at = new Date().toISOString();
    budget.elapsed_live_ms = Math.round(elapsed());
    save(budgetPath, budget);
    process.send?.({ type: "SETTLED" });
  }
}

export function armWatchdog(child, schedule = setTimeout) {
  return [
    schedule(() => child.kill("SIGTERM"), 117_000),
    schedule(() => child.kill("SIGKILL"), 118_000),
  ];
}

export async function supervise(budgetPath, outputPath) {
  assertUnusedBudget(JSON.parse(readFileSync(budgetPath, "utf8")));
  authorizedSession(Date.now());
  const supervisorStart = performance.now();
  const child = fork(fileURLToPath(import.meta.url), ["--child", budgetPath, outputPath], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: process.execArgv,
  });
  let settled = false, started = false, stopTimer, killTimer;
  child.on("message", (message) => {
    if (message.type === "STARTED" && !started) {
      started = true;
      [stopTimer, killTimer] = armWatchdog(child);
    }
    if (message.type === "SETTLED") settled = true;
  });
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  clearTimeout(stopTimer);
  clearTimeout(killTimer);
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  if (!settled && (started || budget.state !== "NOT_STARTED")) {
    budget.state = "WATCHDOG_STOPPED_UNCERTAIN_NO_RETRY";
    budget.watchdog_finished_at = new Date().toISOString();
    budget.elapsed_live_ms_upper_bound = Math.ceil(performance.now() - supervisorStart);
    budget.elapsed_live_ms_basis = "SUPERVISOR_SPAWN_TO_CHILD_EXIT_UPPER_BOUND_INCLUDES_PREFLIGHT";
    save(budgetPath, budget);
  }
  console.log(JSON.stringify({ state: budget.state, requests_started: budget.requests_started, settled, child_exited: true }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = process.argv[2] === "--child";
  const [budgetPath, outputPath] = process.argv.slice(child ? 3 : 2);
  try {
    if (!budgetPath || !outputPath) throw new Error("EXPLICIT_PRIVATE_PATHS_REQUIRED");
    if (child) await capture(budgetPath, outputPath);
    else await supervise(budgetPath, outputPath);
  } catch (error) {
    if (budgetPath) {
      const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
      if (budget.state === "NOT_STARTED") {
        budget.state = "PREFLIGHT_BLOCKED";
        budget.error = safeError(error);
        save(budgetPath, budget);
      }
    }
    console.error(JSON.stringify(safeError(error)));
    process.exitCode = 1;
  }
  if (child) process.disconnect?.();
}
