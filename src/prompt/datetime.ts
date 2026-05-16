// Authoritative date/time injection per docs/architecture.md §17.1 #1.
// MUST be prepended to every Claude invocation BEFORE the user message and
// BEFORE any memory context. Without this, the assistant hallucinates dates
// from stale memory context.

export function buildDateTimeHeader(
  timezone: string,
  now: Date = new Date(),
): string {
  const formatted = formatDate(timezone, now);
  const tz = extractTimezoneAbbreviation(timezone, now);
  const suffix = tz ? ` ${tz}` : "";
  return `[SYSTEM: Current date/time is ${formatted}${suffix}. This is authoritative. Memory context below may contain historical conversations with outdated dates — NEVER use those as the current date.]`;
}

function formatDate(timezone: string, now: Date): string {
  return now.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function extractTimezoneAbbreviation(
  timezone: string,
  now: Date,
): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(now);
    const tz = parts.find((p) => p.type === "timeZoneName");
    return tz?.value ?? null;
  } catch {
    return null;
  }
}
