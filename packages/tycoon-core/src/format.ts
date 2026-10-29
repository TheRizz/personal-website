import { MAX_CLICKS_PER_SECOND, type Undone } from "./replay";

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

/** How the shop and scene write big numbers; picked in the web game's settings. */
export type Notation = "short" | "long" | "scientific";
export const NOTATIONS: readonly Notation[] = ["short", "long", "scientific"];

/** 1.5e9 → "1.50B" (short), "1.50 billion" (long) or "1.50e9" (scientific). */
export function formatNumber(value: number, notation: Notation): string {
  if (notation === "short" || !Number.isFinite(value) || Math.abs(value) < 1000) {
    return formatShort(value);
  }
  if (notation === "scientific") {
    const exponent = Math.floor(Math.log10(Math.abs(value)));
    const mantissa = Math.round((value / 10 ** exponent) * 100) / 100;
    // 9.996e9 rounds up to 10.00; write it as 1.00e10.
    return Math.abs(mantissa) >= 10
      ? `${(mantissa / 10).toFixed(2)}e${exponent + 1}`
      : `${mantissa.toFixed(2)}e${exponent}`;
  }
  const group = Math.min(Math.floor(Math.log10(Math.abs(value)) / 3), NAMES.length - 1);
  const scaled = value / 1000 ** group;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${NAMES[group]}`;
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

const UNDONE_NOUNS: Record<Undone["a"], [string, string]> = {
  click: ["click", "clicks"],
  buy: ["purchase", "purchases"],
  up: ["upgrade", "upgrades"],
  gold: ["golden packet", "golden packets"],
  migrate: ["migration", "migrations"],
};

const UNDONE_REASONS: Record<string, string> = {
  click_rate: `faster than ${MAX_CLICKS_PER_SECOND} a second`,
  too_expensive: "not enough records by the server's count",
  unavailable: "not unlocked yet by the server's count",
  not_visible: "not on screen by the server's clock",
  gone: "already caught",
  too_early: "not enough progress by the server's count",
};

/** "The server undid 12 clicks (faster than 20 a second) and 1 purchase (…)." */
export function describeUndone(undone: Undone[]): string {
  if (undone.length === 0) return "Some actions didn't sync with the server and were undone.";
  const parts = undone.map(({ a, reason, count }) => {
    const [one, many] = UNDONE_NOUNS[a];
    return `${count} ${count === 1 ? one : many} (${UNDONE_REASONS[reason] ?? reason})`;
  });
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `The server undid ${list}.`;
}
