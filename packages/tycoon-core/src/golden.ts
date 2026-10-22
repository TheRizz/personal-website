// Golden packets come from a schedule the server seeds per session, so a client can only catch
// packets that really appeared (ADR-0006). Times are on the state's playMs clock.

export type GoldenKind = "burst" | "overclock";

export interface GoldenSchedule {
  /** 32-bit seed issued by the server when the session starts. */
  seed: number;
  /** playMs when the session started. */
  start: number;
}

export interface GoldenSpawn {
  index: number;
  /** playMs it appears. */
  at: number;
  /** How long it stays on screen. */
  visibleMs: number;
  kind: GoldenKind;
  /** 0–1: where it enters, for the scene to place it. */
  lane: number;
}

export const GOLDEN_VISIBLE_MS = 12_000;
const MIN_GAP_MS = 60_000;
const GAP_SPREAD_MS = 120_000;

/** mulberry32: small, fast and the same in every JS engine (32-bit integer maths only). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The `index`-th golden packet of a session (0-based). */
export function goldenSpawn(schedule: GoldenSchedule, index: number): GoldenSpawn {
  const next = random(schedule.seed);
  let at = schedule.start;
  let kind: GoldenKind = "burst";
  let lane = 0.5;
  for (let i = 0; i <= index; i++) {
    at += Math.floor(MIN_GAP_MS + next() * GAP_SPREAD_MS);
    kind = next() < 0.5 ? "burst" : "overclock";
    lane = next();
  }
  return { index, at, visibleMs: GOLDEN_VISIBLE_MS, kind, lane };
}

/** The first packet of the schedule that is still to come or on screen at `playMs`. */
export function upcomingGolden(
  schedule: GoldenSchedule & { next: number },
  playMs: number,
): GoldenSpawn {
  const next = random(schedule.seed);
  let at = schedule.start;
  for (let index = 0; ; index++) {
    at += Math.floor(MIN_GAP_MS + next() * GAP_SPREAD_MS);
    const kind: GoldenKind = next() < 0.5 ? "burst" : "overclock";
    const lane = next();
    if (index >= schedule.next && at + GOLDEN_VISIBLE_MS >= playMs) {
      return { index, at, visibleMs: GOLDEN_VISIBLE_MS, kind, lane };
    }
  }
}

/** A fresh 32-bit seed (server side). */
export function newGoldenSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
}
