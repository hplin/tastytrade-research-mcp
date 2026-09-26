const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_PATTERN =
  /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/;

export type LocalCheckpointInput = {
  local_date: string;
  local_time: string;
  timezone: string;
};

export type ResolvedCheckpoint = {
  kind: "RFC3339" | "IANA_LOCAL";
  instant: string;
  timezone: string | null;
  local_date: string | null;
  local_time: string | null;
};

export function normalizeRfc3339(value: string, field: string): string {
  if (!RFC3339_PATTERN.test(value)) {
    throw new Error(
      `${field} must be an RFC3339 timestamp with Z or an explicit UTC offset.`,
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} must be a valid RFC3339 timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

export function normalizeDate(value: string, field: string): string {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  const normalized = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(normalized.getTime()) ||
    normalized.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} must be a valid calendar date.`);
  }
  return value;
}

function normalizeTimezone(value: string, field: string): string {
  const timezone = value.trim();
  if (!timezone) throw new Error(`${field} must be a non-empty IANA timezone.`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
      new Date(0),
    );
  } catch {
    throw new Error(`${field} must be a valid IANA timezone.`);
  }
  return timezone;
}

function localParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function resolveLocalCheckpoint(
  input: LocalCheckpointInput,
  field: string,
): ResolvedCheckpoint {
  const localDate = normalizeDate(input.local_date, `${field}.local_date`);
  const timeMatch = LOCAL_TIME_PATTERN.exec(input.local_time);
  if (!timeMatch) {
    throw new Error(
      `${field}.local_time must use HH:mm, HH:mm:ss, or HH:mm:ss.SSS.`,
    );
  }
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? "0");
  const milliseconds = Number((timeMatch[4] ?? "").padEnd(3, "0") || "0");
  const normalizedLocalTime =
    `${timeMatch[1]}:${timeMatch[2]}:${String(second).padStart(2, "0")}` +
    (milliseconds === 0 ? "" : `.${String(milliseconds).padStart(3, "0")}`);
  const timezone = normalizeTimezone(input.timezone, `${field}.timezone`);
  const [year, month, day] = localDate.split("-").map(Number);
  const wallClockUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    milliseconds,
  );
  const matches: number[] = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 1) {
    const candidate = wallClockUtc - offsetMinutes * 60_000;
    const parts = localParts(candidate, timezone);
    if (
      Number(parts.year) === year &&
      Number(parts.month) === month &&
      Number(parts.day) === day &&
      Number(parts.hour) === hour &&
      Number(parts.minute) === minute &&
      Number(parts.second) === second
    ) {
      matches.push(candidate);
    }
  }
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length === 0) {
    throw new Error(
      `${field} does not exist in ${timezone} because of a timezone transition.`,
    );
  }
  if (uniqueMatches.length > 1) {
    throw new Error(
      `${field} is ambiguous in ${timezone} because of a timezone transition.`,
    );
  }
  return {
    kind: "IANA_LOCAL",
    instant: new Date(uniqueMatches[0]).toISOString(),
    timezone,
    local_date: localDate,
    local_time: normalizedLocalTime,
  };
}

export function resolveCheckpoint(
  asOf: string | undefined,
  localCheckpoint: LocalCheckpointInput | undefined,
  field = "checkpoint",
): ResolvedCheckpoint {
  if ((asOf === undefined) === (localCheckpoint === undefined)) {
    throw new Error(
      `Exactly one of as_of or local_checkpoint must be provided for ${field}.`,
    );
  }
  if (localCheckpoint) {
    return resolveLocalCheckpoint(localCheckpoint, `${field}.local_checkpoint`);
  }
  return {
    kind: "RFC3339",
    instant: normalizeRfc3339(asOf!, `${field}.as_of`),
    timezone: null,
    local_date: null,
    local_time: null,
  };
}
