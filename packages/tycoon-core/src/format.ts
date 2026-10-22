const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
const NAMES = [
  "",
  "thousand",
  "million",
  "billion",
  "trillion",
  "quadrillion",
  "quintillion",
  "sextillion",
  "septillion",
  "octillion",
  "nonillion",
  "decillion",
];

/** 950 → "950", 12_345 → "12.3K", 1.5e9 → "1.50B". Whole numbers below 1,000 have no decimals. */
export function formatShort(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  if (Math.abs(value) < 1000) {
    return Math.abs(value) < 10 && !Number.isInteger(value)
      ? value.toFixed(1)
      : Math.floor(value).toString();
  }
  const group = Math.min(Math.floor(Math.log10(Math.abs(value)) / 3), SUFFIXES.length - 1);
  const scaled = value / 1000 ** group;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)}${SUFFIXES[group]}`;
}

/** 1.5e9 → "1.500 billion"; for screen readers and the stats tab. */
export function formatLong(value: number): string {
  if (!Number.isFinite(value)) return "infinity";
  if (Math.abs(value) < 1e6) return Math.floor(value).toLocaleString("en-US");
  const group = Math.min(Math.floor(Math.log10(Math.abs(value)) / 3), NAMES.length - 1);
  return `${(value / 1000 ** group).toFixed(3)} ${NAMES[group]}`;
}

/** 3_725_000 ms → "1h 2m". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (totalMinutes > 0) return `${minutes}m`;
  return `${Math.floor(ms / 1000)}s`;
}
