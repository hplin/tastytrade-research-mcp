const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
