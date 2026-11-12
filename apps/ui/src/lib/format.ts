const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWholeFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const countFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const timeFormat = new Intl.DateTimeFormat("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export const usd = (value: number) => usdFormat.format(value);
export const usdWhole = (value: number) => usdWholeFormat.format(value);
export const count = (value: number) => countFormat.format(value);
export const compact = (value: number) => compactFormat.format(value);
export const percent = (part: number, whole: number) => (whole === 0 ? "·" : percentFormat.format(part / whole));
export const time = (timestampMs: number) => timeFormat.format(new Date(timestampMs));

// A yyyy-mm-dd string rendered as "Sep 14" without timezone drift.
export const day = (value: string) => dayFormat.format(new Date(`${value}T00:00:00Z`));

// A yyyy-mm-dd string rendered as "Apr 15, 2027".
export const date = (value: string) => dateFormat.format(new Date(`${value}T00:00:00Z`));

// A yyyy-mm string rendered as "September 2026".
export const monthName = (value: string) => monthFormat.format(new Date(`${value}-15T00:00:00Z`));

// Shifts a yyyy-mm string by whole months.
export function shiftMonth(value: string, delta: number) {
  const [year, month] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

// File sizes in binary units, as the reference states limits: "812 B", "14.2 KiB", "3.1 MiB".
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  return kib < 1024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1024).toFixed(1)} MiB`;
}

// Durations as "4m 20s", "1h 02m", or "12s". Null when unknown.
export function duration(ms: number | null) {
  if (ms === null) return "·";
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}
