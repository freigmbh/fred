function datePart(timestampMs: number, timezone: string, options: Intl.DateTimeFormatOptions) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, ...options }).formatToParts(new Date(timestampMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return { year: value("year"), month: value("month"), day: value("day") };
}

// The yyyy-mm budget bucket for an instant, in the org timezone.
export function monthOf(timestampMs: number, timezone: string) {
  const { year, month } = datePart(timestampMs, timezone, { year: "numeric", month: "2-digit" });
  return `${year}-${month}`;
}

// The yyyy-mm-dd calendar day for an instant, in the org timezone.
export function dayOf(timestampMs: number, timezone: string) {
  const { year, month, day } = datePart(timestampMs, timezone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${year}-${month}-${day}`;
}

function parseMonth(month: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new Error("month must be yyyy-mm");
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

// Every yyyy-mm-dd calendar day of a yyyy-mm month, in order, cut off after `today` so the current month has no empty future tail.
export function daysOfMonth(month: string, today: string) {
  const { year, monthIndex } = parseMonth(month);
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`).filter((day) => day <= today);
}

// Working days, Monday to Friday, in a yyyy-mm month. `elapsed` counts through `today` as yyyy-mm-dd.
export function workingDays(month: string, today: string) {
  const { year, monthIndex } = parseMonth(month);
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  let total = 0;
  let elapsed = 0;
  for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber++) {
    const weekday = new Date(Date.UTC(year, monthIndex, dayNumber)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    total++;
    if (`${month}-${String(dayNumber).padStart(2, "0")}` <= today) elapsed++;
  }
  return { total, elapsed };
}
