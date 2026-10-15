import { describe, expect, test } from "@jest/globals";
import { authorizedSession, assertUnusedBudget, beginAttempt, sanitizeFeed, safeError, armWatchdog } from "../scripts/capture-live-option-quality.mjs";

const unused = () => ({
  state: "NOT_STARTED", requests_started: 0, live_started_at: null,
  max_snapshot_requests: 3, max_total_live_wall_ms: 120000, attempts: [],
});

describe("bounded owner-authorized capture safeguards (fully offline)", () => {
  test("dated GTH window crosses calendar dates without inventing a trade date", () => {
    const session = authorizedSession(Date.parse("2026-10-15T03:10:00Z"));
    expect(session.calendar_date_new_york).toBe("2026-10-14");
    expect(session.trade_date).toBe("2026-10-15");
    expect(session.weekday_new_york).toBe("Wednesday");
    expect(session.entitlement).toBe("UNVERIFIED_UNTIL_PROVIDER_RESPONSE");
    expect(authorizedSession(Date.parse("2026-10-15T05:00:00Z")).calendar_date_new_york).toBe("2026-10-15");
    for (const time of ["2026-10-15T00:14:59Z", "2026-10-15T13:25:00Z", "2026-10-16T03:00:00Z"]) {
      expect(() => authorizedSession(Date.parse(time))).toThrow("AUTHORIZED_GTH_WINDOW_CLOSED");
    }
  });

  test("used or uncertain ledger cannot restart; failed started attempts consume cap", () => {
    assertUnusedBudget(unused());
    for (const state of ["RUNNING", "COMPLETED", "STOPPED_FAILURE", "WATCHDOG_STOPPED_UNCERTAIN_NO_RETRY"]) {
      expect(() => assertUnusedBudget({ ...unused(), state })).toThrow("CAPTURE_BUDGET_NOT_UNUSED");
    }
    const budget = { ...unused(), state: "RUNNING" };
    for (let i = 0; i < 3; i += 1) beginAttempt(budget, i * 20000, `package-${i}`, "offline");
    expect(budget.requests_started).toBe(3);
    expect(() => beginAttempt(budget, 60000, "fourth", "offline")).toThrow("CAPTURE_BUDGET_EXHAUSTED");
    expect(() => beginAttempt({ ...unused(), state: "RUNNING" }, 110000, "late", "offline")).toThrow();
    expect(() => beginAttempt({ ...unused(), state: "RUNNING" }, NaN, "unknown", "offline")).toThrow();
    expect(() => assertUnusedBudget({ ...unused(), attempts: [{ outcome: "STARTED" }] })).toThrow();
  });

  test("watchdog terminates only its own child before the hard wall", () => {
    const scheduled = [], signals = [];
    armWatchdog({ kill: (signal) => signals.push(signal) }, (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    });
    expect(scheduled.map((entry) => entry.delay)).toEqual([117000, 118000]);
    for (const entry of scheduled) entry.callback();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("only feed metadata and approved values survive; zeros/null/flags/layout preserved", () => {
    const fields = { Greeks: ["eventSymbol", "time", "eventFlags", "eventType", "gamma"] };
    const symbols = new Set([".SPXW261015C6000"]);
    const message = {
      type: "FEED_DATA", channel: 3, token: "must-not-persist",
      data: ["Greeks", [".SPXW261015C6000", 0, 4, "Greeks", null]],
    };
    expect(sanitizeFeed(message, fields, symbols)).toEqual({ type: "FEED_DATA", channel: 3, data: message.data });
    expect(sanitizeFeed({ type: "AUTH", channel: 0, token: "secret" }, {}, symbols)).toBeNull();
    expect(sanitizeFeed({ type: "FEED_CONFIG", channel: 3, eventFields: fields, url: "signed-secret" }, {}, symbols))
      .toEqual({ type: "FEED_CONFIG", channel: 3, eventFields: fields });
    const nested = { ...message, data: ["Greeks", [message.data[1]]] };
    expect(sanitizeFeed(nested, fields, symbols).data).toEqual(nested.data);
    expect(() => sanitizeFeed({ ...message, data: ["Greeks", ["account-123", 0, 4, "Greeks", null]] }, fields, symbols)).toThrow();
    expect(() => sanitizeFeed({ type: "FEED_CONFIG", channel: 3, eventFields: { Greeks: ["token"] } }, {}, symbols)).toThrow();
    expect(() => sanitizeFeed({ ...message, data: ["Greeks", [".SPXW261015C6000", "signed-url", 4, "Greeks", null]] }, fields, symbols)).toThrow();
  });

  test("errors never emit raw auth responses, URLs, config, or arbitrary strings", () => {
    const error = { message: "secret", config: { headers: { Authorization: "secret" } }, response: { status: 401, data: "secret" } };
    expect(safeError(error)).toEqual({ code: "CAPTURE_OPERATION_FAILED", http_status: 401 });
    expect(safeError(new Error("MISSING_EXISTING_CREDENTIAL")).code).toBe("MISSING_EXISTING_CREDENTIAL");
  });
});
