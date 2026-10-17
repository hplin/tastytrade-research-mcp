export const RTH_CALENDAR_VERSION = "us-cash-rth-2026/1";
export const RTH_CALENDAR_SOURCE = "https://www.nyse.com/trade/hours-calendars";

// Published 2026 cash-market schedule, not an options or universal exchange calendar.
const holidays = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
  "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
  "2026-11-26", "2026-12-25",
]);
const halfDays = new Set(["2026-11-27", "2026-12-24"]);
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", timeZoneName: "longOffset",
});

export type RthSession = { date: string; open: number; close: number };
export type RthCalendarPlan = {
  supported: boolean;
  reason: string | null;
  sessions: RthSession[];
};

export function rthDate(timestamp: number): string {
  return dateFormatter.format(new Date(timestamp));
}

export function rthSession(date: string): RthSession | null {
  if (!/^2026-\d{2}-\d{2}$/.test(date)) return null;
  const noon = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(noon) || new Date(noon).toISOString().slice(0, 10) !== date) return null;
  const weekday = new Date(noon).getUTCDay();
  if (weekday === 0 || weekday === 6 || holidays.has(date)) return null;
  const offset = offsetFormatter.formatToParts(new Date(noon))
    .find((part) => part.type === "timeZoneName")!.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset)!;
  const offsetMs = (match[1] === "+" ? 1 : -1) *
    (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  return {
    date,
    open: Date.parse(`${date}T09:30:00Z`) - offsetMs,
    close: Date.parse(`${date}T${halfDays.has(date) ? "13" : "16"}:00:00Z`) - offsetMs,
  };
}

export function planRthSessions(
  symbol: string,
  streamerSymbol: string,
  instrumentType: string,
  timezone: string,
  start: number,
  end: number,
  now: number,
): RthCalendarPlan {
  const known = instrumentType === "INDEX"
    ? symbol === "SPX" && ["SPX", "$SPX"].includes(streamerSymbol)
    : instrumentType === "EQUITY" &&
      ["SPY", "QQQ", "IWM"].includes(symbol) && streamerSymbol === symbol;
  const first = rthDate(start);
  const last = rthDate(end);
  if (!known || timezone !== "America/New_York") {
    return { supported: false, reason: "CALENDAR_SYMBOL_OR_SESSION_UNSUPPORTED", sessions: [] };
  }
  if (first < "2026-01-01" || last > "2026-12-31") {
    return { supported: false, reason: "CALENDAR_RANGE_UNSUPPORTED", sessions: [] };
  }
  const sessions: RthSession[] = [];
  for (let timestamp = Date.parse(`${first}T12:00:00Z`);
    timestamp <= Date.parse(`${last}T12:00:00Z`); timestamp += 86_400_000) {
    const session = rthSession(new Date(timestamp).toISOString().slice(0, 10));
    if (session && session.open >= start && session.close <= Math.min(end, now)) {
      sessions.push(session);
    }
  }
  return { supported: true, reason: null, sessions };
}
