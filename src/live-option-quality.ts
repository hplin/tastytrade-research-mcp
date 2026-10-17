import { createHash } from "node:crypto";
import { ExactDecimal } from "./decimal.js";
import { parseHistoricalOptionSymbol } from "./historical-option-package.js";
import type { LiveOptionSnapshotContract } from "./live-option-snapshot.js";

export type ExactLiveOptionPackage = {
  legs: Array<{
    provider_symbol: string;
    action: "BUY_TO_OPEN" | "SELL_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_CLOSE";
    ratio: number;
    settlement: "AM" | "PM";
    multiplier: string;
    exercise_style: "EUROPEAN";
  }>;
  policy: {
    max_quote_age_ms: number;
    max_greeks_age_ms: number;
    max_iv_age_ms: number;
    max_quote_greek_skew_ms: number;
    max_cross_leg_skew_ms: number;
    max_receive_skew_ms: number;
    require_quote_size: boolean;
    require_open_interest: boolean;
    require_volume: boolean;
    session: {
      start_at: string;
      end_at: string;
      time_zone: "America/New_York";
      utc_offset_minutes: -240 | -300;
    };
  };
};

const legSchema = {
  type: "object",
  properties: {
    provider_symbol: { type: "string", minLength: 21, maxLength: 21 },
    action: { type: "string", enum: ["BUY_TO_OPEN", "SELL_TO_OPEN", "BUY_TO_CLOSE", "SELL_TO_CLOSE"] },
    ratio: { type: "integer", minimum: 1 },
    settlement: { type: "string", enum: ["AM", "PM"] },
    multiplier: { type: "string", const: "100" },
    exercise_style: { type: "string", const: "EUROPEAN" },
  },
  required: ["provider_symbol", "action", "ratio", "settlement", "multiplier", "exercise_style"],
  additionalProperties: false,
} as const;

export const EXACT_LIVE_OPTION_PACKAGE_SCHEMA = {
  type: "object",
  properties: {
    legs: { type: "array", minItems: 2, maxItems: 4, items: legSchema },
    policy: {
      type: "object",
      properties: {
        ...Object.fromEntries([
          "max_quote_age_ms", "max_greeks_age_ms", "max_iv_age_ms",
          "max_quote_greek_skew_ms", "max_cross_leg_skew_ms", "max_receive_skew_ms",
        ].map((key) => [key, { type: "integer", minimum: 0 }])),
        require_quote_size: { type: "boolean" },
        require_open_interest: { type: "boolean" },
        require_volume: { type: "boolean" },
        session: {
          type: "object",
          properties: {
            start_at: { type: "string" },
            end_at: { type: "string" },
            time_zone: { type: "string", const: "America/New_York" },
            utc_offset_minutes: { type: "integer", enum: [-240, -300] },
          },
          required: ["start_at", "end_at", "time_zone", "utc_offset_minutes"],
          additionalProperties: false,
        },
      },
      required: [
        "max_quote_age_ms", "max_greeks_age_ms", "max_iv_age_ms",
        "max_quote_greek_skew_ms", "max_cross_leg_skew_ms", "max_receive_skew_ms",
        "require_quote_size", "require_open_interest", "require_volume", "session",
      ],
      additionalProperties: false,
    },
  },
  required: ["legs", "policy"],
  additionalProperties: false,
} as const;

function explicitInstant(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("Session timestamps must be explicit ISO instants with a UTC offset.");
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const time = Date.parse(value);
  if (!Number.isFinite(time) || Number(value.slice(11, 13)) > 23 ||
      calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error("Invalid session timestamp.");
  }
  return time;
}

export function validateExactLiveOptionPackage(input: ExactLiveOptionPackage): ExactLiveOptionPackage {
  if (!input || !Array.isArray(input.legs) || input.legs.length < 2 || input.legs.length > 4) {
    throw new Error("exact_package requires 2, 3, or 4 exact legs.");
  }
  const seen = new Set<string>();
  for (const leg of input.legs) {
    parseHistoricalOptionSymbol(leg.provider_symbol);
    if (seen.has(leg.provider_symbol)) throw new Error("Duplicate exact-package OCC symbol.");
    seen.add(leg.provider_symbol);
    if (!["BUY_TO_OPEN", "SELL_TO_OPEN", "BUY_TO_CLOSE", "SELL_TO_CLOSE"].includes(leg.action) ||
        !Number.isSafeInteger(leg.ratio) || leg.ratio < 1 ||
        !["AM", "PM"].includes(leg.settlement) ||
        leg.multiplier !== "100" || leg.exercise_style !== "EUROPEAN") {
      throw new Error("Invalid exact-package action, ratio, settlement, multiplier, or exercise style.");
    }
  }
  const policy = input.policy;
  if (!policy) throw new Error("exact_package requires an explicit quality policy.");
  for (const key of [
    "max_quote_age_ms", "max_greeks_age_ms", "max_iv_age_ms",
    "max_quote_greek_skew_ms", "max_cross_leg_skew_ms", "max_receive_skew_ms",
  ] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) throw new Error(`Invalid explicit policy.${key}.`);
  }
  for (const key of ["require_quote_size", "require_open_interest", "require_volume"] as const) {
    if (typeof policy[key] !== "boolean") throw new Error(`Missing explicit policy.${key}.`);
  }
  const session = policy.session;
  if (!session || session.time_zone !== "America/New_York" ||
      ![-240, -300].includes(session.utc_offset_minutes) ||
      explicitInstant(session.start_at) >= explicitInstant(session.end_at)) {
    throw new Error("Invalid explicit policy.session.");
  }
  return structuredClone(input);
}

export type LiveOptionQualityReason =
  | "MISSING_LEG" | "MISSING_QUOTE" | "ABSENT_QUOTE_TIME" | "INVALID_QUOTE"
  | "CROSSED_QUOTE" | "MISSING_QUOTE_SIZE" | "PARTIAL_GREEKS" | "ABSENT_GREEKS_TIME"
  | "STALE_QUOTE" | "STALE_GREEKS" | "STALE_IV" | "MISSING_IV"
  | "MISSING_OPEN_INTEREST" | "MISSING_VOLUME" | "PROVIDER_SYMBOL_MISMATCH"
  | "INCOMPATIBLE_CONTRACT" | "INCOMPATIBLE_SETTLEMENT" | "FUTURE_TIMESTAMP"
  | "QUOTE_GREEK_SKEW" | "CROSS_LEG_SKEW" | "PARTIAL_COHORT"
  | "TRANSPORT_INCOMPLETE" | "SESSION_ANOMALY" | "DST_ANOMALY";

function positive(value: string | null | undefined): boolean {
  return value != null && ExactDecimal.parse(value).compare(ExactDecimal.zero()) > 0;
}

function nativeTime(value: string | null | undefined): number | null {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

function range(values: number[]): number | null {
  return values.length ? Math.max(...values) - Math.min(...values) : null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : item,
  );
}

export function evaluateExactLiveOptionPackage(
  request: ExactLiveOptionPackage,
  contracts: LiveOptionSnapshotContract[],
  retrievedAt: string,
  transportComplete: boolean,
  acquiredAfter: string,
) {
  const input = validateExactLiveOptionPackage(request);
  const now = explicitInstant(retrievedAt);
  const cohortStart = explicitInstant(acquiredAfter);
  const policy = input.policy;
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: policy.session.time_zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const reasons = new Set<LiveOptionQualityReason>();
  const roots = new Set(input.legs.map((leg) => leg.provider_symbol.slice(0, 6).trim()));
  if (roots.size > 1) reasons.add("INCOMPATIBLE_CONTRACT");
  if (new Set(input.legs.map((leg) => leg.settlement)).size > 1) reasons.add("INCOMPATIBLE_SETTLEMENT");
  if (!transportComplete) reasons.add("TRANSPORT_INCOMPLETE");
  if (now < explicitInstant(policy.session.start_at) || now > explicitInstant(policy.session.end_at)) {
    reasons.add("SESSION_ANOMALY");
  }
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: policy.session.time_zone, timeZoneName: "longOffset",
  }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value;
  if (offset !== (policy.session.utc_offset_minutes === -240 ? "GMT-04:00" : "GMT-05:00")) {
    reasons.add("DST_ANOMALY");
  }
  const allNativeTimes: number[] = [];
  const allReceiveTimes: number[] = [];
  const legs = input.legs.map((leg) => {
    const legReasons = new Set<LiveOptionQualityReason>();
    const matches = contracts.filter((contract) => contract.provider_symbol === leg.provider_symbol);
    const contract = matches.length === 1 ? matches[0] : undefined;
    const parsed = parseHistoricalOptionSymbol(leg.provider_symbol);
    let oldestAge: number | null = null;
    let quoteGreekSkew: number | null = null;
    let receiveSkew: number | null = null;
    if (!contract) {
      legReasons.add("MISSING_LEG");
    } else {
      const root = leg.provider_symbol.slice(0, 6).trim();
      if (contract.occ_symbol !== leg.provider_symbol || contract.streamer_symbol !== parsed.streamer_symbol) {
        legReasons.add("PROVIDER_SYMBOL_MISMATCH");
      }
      if (contract.root_symbol !== root || contract.underlying !== "SPX" ||
          contract.expiration !== parsed.expiration || contract.option_type !== parsed.option_side ||
          contract.strike !== parsed.strike || contract.multiplier !== leg.multiplier ||
          contract.exercise_style !== leg.exercise_style ||
          parsed.expiration < localDate ||
          (root === "SPX" && parsed.expiration === localDate)) {
        legReasons.add("INCOMPATIBLE_CONTRACT");
      }
      if (contract.settlement !== leg.settlement ||
          contract.settlement !== (root === "SPXW" ? "PM" : "AM")) {
        legReasons.add("INCOMPATIBLE_SETTLEMENT");
      }
      const quote = contract.quote;
      const greeks = contract.greeks;
      for (const event of [quote, greeks, contract.summary]) {
        if (event && event.provider_symbol !== contract.streamer_symbol) {
          legReasons.add("PROVIDER_SYMBOL_MISMATCH");
        }
      }
      if (!quote) legReasons.add("MISSING_QUOTE");
      if (!positive(quote?.bid) || !positive(quote?.ask)) legReasons.add("INVALID_QUOTE");
      if (quote?.bid != null && quote.ask != null &&
          ExactDecimal.parse(quote.bid).compare(ExactDecimal.parse(quote.ask)) > 0) {
        legReasons.add("CROSSED_QUOTE");
      }
      if (policy.require_quote_size && (!positive(quote?.bid_size) || !positive(quote?.ask_size))) {
        legReasons.add("MISSING_QUOTE_SIZE");
      }
      if (!greeks || !greeks.content_complete ||
          [greeks.delta, greeks.gamma, greeks.theta, greeks.vega, greeks.rho].some((value) => value === null)) {
        legReasons.add("PARTIAL_GREEKS");
      }
      if (!positive(greeks?.implied_volatility)) legReasons.add("MISSING_IV");
      if (policy.require_open_interest && contract.summary?.open_interest == null) legReasons.add("MISSING_OPEN_INTEREST");
      if (policy.require_volume && contract.summary?.day_volume == null) legReasons.add("MISSING_VOLUME");
      const summaryTime = nativeTime(contract.summary?.provider_event_timestamp);
      if (summaryTime !== null && summaryTime > now) legReasons.add("FUTURE_TIMESTAMP");
      // Both quote sides matter: the last change alone cannot prove the oldest side fresh.
      const bidTime = quote?.timestamp_source === "PROVIDER_SIDE_TIME" ? nativeTime(quote.bid_time) : null;
      const askTime = quote?.timestamp_source === "PROVIDER_SIDE_TIME" ? nativeTime(quote.ask_time) : null;
      const greekTime = greeks?.timestamp_source === "PROVIDER_EVENT_TIME" ? nativeTime(greeks.provider_event_timestamp) : null;
      if (bidTime === null || askTime === null) legReasons.add("ABSENT_QUOTE_TIME");
      if (greekTime === null) legReasons.add("ABSENT_GREEKS_TIME");
      const times = [bidTime, askTime, greekTime].filter((value): value is number => value !== null);
      if (times.some((time) => time < explicitInstant(policy.session.start_at) ||
          time > explicitInstant(policy.session.end_at))) {
        legReasons.add("SESSION_ANOMALY");
      }
      allNativeTimes.push(...times);
      if (times.length) oldestAge = now - Math.min(...times);
      if (times.some((time) => time > now)) legReasons.add("FUTURE_TIMESTAMP");
      if ([bidTime, askTime].some((time) => time !== null && now - time > policy.max_quote_age_ms)) legReasons.add("STALE_QUOTE");
      if (greekTime !== null && now - greekTime > policy.max_greeks_age_ms) legReasons.add("STALE_GREEKS");
      if (greekTime !== null && now - greekTime > policy.max_iv_age_ms) legReasons.add("STALE_IV");
      if (bidTime !== null && askTime !== null && greekTime !== null) {
        quoteGreekSkew = Math.max(Math.abs(bidTime - greekTime), Math.abs(askTime - greekTime));
        if (quoteGreekSkew > policy.max_quote_greek_skew_ms) legReasons.add("QUOTE_GREEK_SKEW");
      }
      const received = [quote?.received_at, greeks?.received_at,
        ...(policy.require_open_interest || policy.require_volume ? [contract.summary?.received_at] : []),
      ].map(nativeTime);
      const validReceived = received.filter((value): value is number => value !== null);
      allReceiveTimes.push(...validReceived);
      receiveSkew = range(validReceived);
      if (received.some((time) => time === null) ||
          validReceived.some((time) => time > now || time < cohortStart) ||
          (receiveSkew !== null && receiveSkew > policy.max_receive_skew_ms)) {
        legReasons.add("PARTIAL_COHORT");
      }
    }
    for (const reason of legReasons) reasons.add(reason);
    return {
      ...leg, expiration: parsed.expiration, streamer_symbol: parsed.streamer_symbol,
      valid: legReasons.size === 0, reasons: [...legReasons].sort(),
      oldest_age_ms: oldestAge, quote_greek_skew_ms: quoteGreekSkew, receive_skew_ms: receiveSkew,
      observation: contract ?? null,
    };
  });
  const crossLegSkew = range(allNativeTimes);
  const receiveSkew = range(allReceiveTimes);
  if (crossLegSkew !== null && crossLegSkew > policy.max_cross_leg_skew_ms) reasons.add("CROSS_LEG_SKEW");
  if (receiveSkew !== null && receiveSkew > policy.max_receive_skew_ms) reasons.add("PARTIAL_COHORT");
  return {
    status: reasons.size === 0 ? "READY" as const : "NOT_READY" as const,
    destination: "FINPILOT_GATE" as const,
    research_only: true as const,
    order_authorized: false as const,
    production_gate_eligible: false as const,
    fingerprint: `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`,
    policy, legs, reasons: [...reasons].sort(),
    content_complete: !reasons.has("MISSING_LEG") && !reasons.has("MISSING_QUOTE") &&
      !reasons.has("PARTIAL_GREEKS") && !reasons.has("MISSING_IV") &&
      !reasons.has("MISSING_QUOTE_SIZE") && !reasons.has("ABSENT_QUOTE_TIME") &&
      !reasons.has("ABSENT_GREEKS_TIME") &&
      !reasons.has("MISSING_OPEN_INTEREST") && !reasons.has("MISSING_VOLUME"),
    transport_complete: transportComplete,
    cross_leg_skew_ms: crossLegSkew,
    receive_skew_ms: receiveSkew,
    oldest_age_ms: allNativeTimes.length ? now - Math.min(...allNativeTimes) : null,
    retrieved_at: retrievedAt,
    available_at: retrievedAt,
    acquired_after: acquiredAfter,
    timestamp_provenance: {
      retrieved_at: "LOCAL_COLLECTION_TIME", available_at: "LOCAL_COLLECTION_TIME",
      acquired_after: "LOCAL_CHAIN_RETRIEVAL_TIME",
    },
    live_permission_backfill: false as const,
  };
}
