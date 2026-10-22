import {
  ACHIEVEMENTS,
  ACHIEVEMENT_BONUS,
  COST_GROWTH,
  GENERATORS,
  UPGRADES,
  UPGRADES_BY_ID,
  type AchievementTest,
  type Requirement,
  type Upgrade,
} from "./data";
import { goldenSpawn, type GoldenKind } from "./golden";

/**
 * Bumped whenever a rule or number changes, so the server can refuse clients that would replay
 * differently (docs/04-pipeline-tycoon.md §2.1). `upgradeState` migrates stored saves forward.
 */
export const RULES_VERSION = 2;

/** Offline time is credited up to this much, by the server's clock. */
export const OFFLINE_CAP_MS = 8 * 60 * 60 * 1000;
/** Each Architecture Point is a permanent +100 % production (tuned with the pacing bot). */
export const AP_BONUS = 1;
/** Records earned in one run for the first Architecture Point; AP grow with the square root. */
export const AP_BASE_RECORDS = 1e9;
/** Golden packet "overclock": production ×7 for 77 s. */
export const OVERCLOCK_FACTOR = 7;
export const OVERCLOCK_MS = 77_000;
/** Golden packet "burst": the smaller of 15 % of banked records and 15 minutes of production. */
export const BURST_BANK_SHARE = 0.15;
export const BURST_SECONDS = 15 * 60;

/** Everything about a player's progress. Plain JSON; the server stores it as is. */
export interface GameState {
  /** RULES_VERSION this state was produced under. */
  v: number;
  /** Banked records, to spend. */
  records: number;
  /** Records earned this run (since the last migration); decides Architecture Points. */
  runRecords: number;
  /** Records earned ever. */
  lifetimeRecords: number;
  /** Simulated play time, ever (ms). The clock everything else is measured on. */
  playMs: number;
  /** Simulated play time this run (ms). */
  runMs: number;
  clicks: number;
  /** Units owned per tier, cheapest first. */
  owned: number[];
  /** Upgrade ids bought this run. */
  upgrades: string[];
  /** Architecture Points. */
  ap: number;
  migrations: number;
  achievements: string[];
  goldenCaught: number;
  /** The highest production rate ever reached (records/s). */
  bestRate: number;
  /** Production ×OVERCLOCK_FACTOR until this playMs. */
  overclockUntil: number;
  ended: boolean;
  /** A second device (the CLI) has been linked to this player (since rules v2). */
  linked: boolean;
  /** This session's golden-packet schedule, issued by the server (golden.ts). */
  golden: { seed: number; start: number; next: number };
}

export function newGame(): GameState {
  return {
    v: RULES_VERSION,
    records: 0,
    runRecords: 0,
    lifetimeRecords: 0,
    playMs: 0,
    runMs: 0,
    clicks: 0,
    owned: GENERATORS.map(() => 0),
    upgrades: [],
    ap: 0,
    migrations: 0,
    achievements: [],
    goldenCaught: 0,
    bestRate: 0,
    overclockUntil: 0,
    ended: false,
    linked: false,
    golden: { seed: 0, start: 0, next: 0 },
  };
}

/**
 * Purchases may be this much short of the cost (relative), so rounding differences between a
 * client's many small steps and the server's replay never drop an honest purchase.
 */
const AFFORD_TOLERANCE = 1e-6;
const canAfford = (state: GameState, cost: number) =>
  state.records >= cost * (1 - AFFORD_TOLERANCE);
const spend = (state: GameState, cost: number) => {
  state.records = Math.max(0, state.records - cost);
};

const ownedUpgrades = (state: GameState): Upgrade[] =>
  state.upgrades.flatMap((id) => {
    const upgrade = UPGRADES_BY_ID.get(id);
    return upgrade ? [upgrade] : [];
  });

/** Production multiplier shared by every tier: Architecture Points × achievements. */
export function globalMultiplier(state: GameState): number {
  return (1 + AP_BONUS * state.ap) * (1 + ACHIEVEMENT_BONUS * state.achievements.length);
}

/** Records per second from one tier, overclock excluded. */
export function tierRate(state: GameState, tier: number): number {
  const generator = GENERATORS[tier];
  const owned = state.owned[tier] ?? 0;
  if (!generator || owned === 0) return 0;
  let factor = 1;
  let synergyPct = 0;
  for (const upgrade of ownedUpgrades(state)) {
    const effect = upgrade.effect;
    if (effect.kind === "tier" && effect.tier === tier) factor *= effect.factor;
    if (effect.kind === "synergy" && effect.tier === tier) {
      synergyPct += effect.pct * (state.owned[effect.from] ?? 0);
    }
  }
  return owned * generator.rate * factor * (1 + synergyPct / 100) * globalMultiplier(state);
}

/** Records per second right now, overclock excluded. */
export function baseRate(state: GameState): number {
  let total = 0;
  for (let tier = 0; tier < GENERATORS.length; tier++) total += tierRate(state, tier);
  return total;
}

export const overclocked = (state: GameState) => state.overclockUntil > state.playMs;

/** Records per second right now, including an overclock in progress. */
export function currentRate(state: GameState): number {
  return baseRate(state) * (overclocked(state) ? OVERCLOCK_FACTOR : 1);
}

/** Records one click earns right now. */
export function clickValue(state: GameState): number {
  let factor = 1;
  let share = 0;
  for (const upgrade of ownedUpgrades(state)) {
    if (upgrade.effect.kind === "click") factor *= upgrade.effect.factor;
    if (upgrade.effect.kind === "clickShare") share += upgrade.effect.share;
  }
  return factor * (1 + ACHIEVEMENT_BONUS * state.achievements.length) + share * currentRate(state);
}

/** The price of the next `count` units of a tier. */
export function generatorCost(state: GameState, tier: number, count = 1): number {
  const generator = GENERATORS[tier];
  if (!generator) return Infinity;
  const owned = state.owned[tier] ?? 0;
  return (
    (generator.baseCost * COST_GROWTH ** owned * (COST_GROWTH ** count - 1)) / (COST_GROWTH - 1)
  );
}

/** How many of a tier the bank can buy, up to `limit`. */
export function affordableCount(state: GameState, tier: number, limit = 100): number {
  let count = 0;
  while (count < limit && canAfford(state, generatorCost(state, tier, count + 1))) count++;
  return count;
}

function meets(state: GameState, requirement: Requirement): boolean {
  switch (requirement.kind) {
    case "owned":
      return (state.owned[requirement.tier] ?? 0) >= requirement.count;
    case "clicks":
      return state.clicks >= requirement.count;
    case "lifetime":
      return state.lifetimeRecords >= requirement.records;
    case "all":
      return requirement.of.every((r) => meets(state, r));
  }
}

/** Upgrades the shop shows: requirement met, not bought, and the ending only before it happens. */
export function availableUpgrades(state: GameState): Upgrade[] {
  return UPGRADES.filter(
    (upgrade) =>
      !state.upgrades.includes(upgrade.id) &&
      meets(state, upgrade.requires) &&
      !(upgrade.effect.kind === "ending" && state.ended),
  );
}

/** Architecture Points a migration right now would add. */
export function migrationGain(state: GameState): number {
  return Math.floor(Math.sqrt(state.runRecords / AP_BASE_RECORDS));
}

/** Records earned this run that the next Architecture Point needs in total. */
export function nextPointAt(state: GameState): number {
  return AP_BASE_RECORDS * (migrationGain(state) + 1) ** 2;
}

function passes(state: GameState, test: AchievementTest): boolean {
  switch (test.kind) {
    case "lifetime":
      return state.lifetimeRecords >= test.records;
    case "owned":
      return (state.owned[test.tier] ?? 0) >= test.count;
    case "totalOwned":
      return state.owned.reduce((a, b) => a + b, 0) >= test.count;
    case "clicks":
      return state.clicks >= test.count;
    case "golden":
      return state.goldenCaught >= test.count;
    case "migrations":
      return state.migrations >= test.count;
    case "upgrades":
      return state.upgrades.length >= test.count;
    case "rate":
      return state.bestRate >= test.perSecond;
    case "ended":
      return state.ended;
    case "linked":
      return state.linked;
  }
}

/** Unlocks achievements the state now passes and records the best rate. Returns the new ids. */
export function checkAchievements(state: GameState): string[] {
  state.bestRate = Math.max(state.bestRate, baseRate(state));
  const unlocked: string[] = [];
  for (const achievement of ACHIEVEMENTS) {
    if (!state.achievements.includes(achievement.id) && passes(state, achievement.test)) {
      state.achievements.push(achievement.id);
      unlocked.push(achievement.id);
    }
  }
  return unlocked;
}

function earn(state: GameState, amount: number): void {
  state.records += amount;
  state.runRecords += amount;
  state.lifetimeRecords += amount;
}

/** Lifetime-records thresholds of achievements, ascending; production changes when one unlocks. */
const LIFETIME_THRESHOLDS = ACHIEVEMENTS.flatMap((a) =>
  a.test.kind === "lifetime" ? [{ id: a.id, records: a.test.records }] : [],
).sort((a, b) => a.records - b.records);

/**
 * Lets `ms` of play time pass. Production accrues at a rate that only changes at an overclock's
 * end or when a lifetime achievement unlocks, so this splits at exactly those moments: passing
 * time in many small steps or one big one gives the same result (the client ticks every frame,
 * the server replays between actions).
 */
export function advance(state: GameState, ms: number): void {
  let left = ms;
  while (left > 0) {
    const rate = baseRate(state);
    const boosted = state.overclockUntil > state.playMs;
    const speed = rate * (boosted ? OVERCLOCK_FACTOR : 1);
    let step = boosted ? Math.min(left, state.overclockUntil - state.playMs) : left;
    const threshold = LIFETIME_THRESHOLDS.find((t) => !state.achievements.includes(t.id));
    if (threshold && speed > 0) {
      const untilThreshold = ((threshold.records - state.lifetimeRecords) * 1000) / speed;
      if (untilThreshold < step) step = Math.max(0, untilThreshold);
    }
    earn(state, (speed * step) / 1000);
    state.playMs += step;
    state.runMs += step;
    left -= step;
    const unlocked = checkAchievements(state);
    // A threshold that rounding left a hair short: unlock it rather than loop on a zero step.
    if (step === 0 && unlocked.length === 0 && threshold) {
      state.achievements.push(threshold.id);
    }
  }
}

/** One thing a player did. `t` is ms since the start of the log (see replay.ts). */
export type Action =
  | { t: number; a: "click"; n: number }
  | { t: number; a: "buy"; g: number; n: number }
  | { t: number; a: "up"; id: string }
  | { t: number; a: "gold"; i: number }
  | { t: number; a: "migrate" };

/** What happened when an action was applied; `ok: false` means it was dropped. */
export type Outcome =
  { ok: true; earned?: number; golden?: GoldenKind } | { ok: false; reason: string };

export function click(state: GameState, count: number): Outcome {
  if (!(Number.isInteger(count) && count > 0)) return { ok: false, reason: "bad_count" };
  const earned = clickValue(state) * count;
  earn(state, earned);
  state.clicks += count;
  checkAchievements(state);
  return { ok: true, earned };
}

export function buyGenerator(state: GameState, tier: number, count: number): Outcome {
  if (!GENERATORS[tier] || !(Number.isInteger(count) && count > 0 && count <= 100)) {
    return { ok: false, reason: "bad_purchase" };
  }
  const cost = generatorCost(state, tier, count);
  if (!canAfford(state, cost)) return { ok: false, reason: "too_expensive" };
  spend(state, cost);
  state.owned[tier] = (state.owned[tier] ?? 0) + count;
  checkAchievements(state);
  return { ok: true };
}

export function buyUpgrade(state: GameState, id: string): Outcome {
  const upgrade = availableUpgrades(state).find((u) => u.id === id);
  if (!upgrade) return { ok: false, reason: "unavailable" };
  if (!canAfford(state, upgrade.cost)) return { ok: false, reason: "too_expensive" };
  spend(state, upgrade.cost);
  state.upgrades.push(upgrade.id);
  if (upgrade.effect.kind === "ending") state.ended = true;
  checkAchievements(state);
  return { ok: true };
}

/** Catches golden packet `index` of this session's schedule, if it is on screen now. */
export function catchGolden(state: GameState, index: number): Outcome {
  if (!Number.isInteger(index) || index < state.golden.next) return { ok: false, reason: "gone" };
  const spawn = goldenSpawn(state.golden, index);
  if (state.playMs < spawn.at || state.playMs > spawn.at + spawn.visibleMs) {
    return { ok: false, reason: "not_visible" };
  }
  state.golden.next = index + 1;
  state.goldenCaught += 1;
  let earned: number | undefined;
  if (spawn.kind === "burst") {
    earned = Math.min(state.records * BURST_BANK_SHARE, baseRate(state) * BURST_SECONDS) + 13;
    earn(state, earned);
  } else {
    state.overclockUntil = state.playMs + OVERCLOCK_MS;
  }
  checkAchievements(state);
  return { ok: true, earned, golden: spawn.kind };
}

/** Platform Migration: trade this run's progress for Architecture Points. */
export function migrate(state: GameState): Outcome {
  const gain = migrationGain(state);
  if (gain < 1) return { ok: false, reason: "too_early" };
  state.ap += gain;
  state.migrations += 1;
  state.records = 0;
  state.runRecords = 0;
  state.runMs = 0;
  state.owned = GENERATORS.map(() => 0);
  state.upgrades = [];
  state.overclockUntil = 0;
  checkAchievements(state);
  return { ok: true };
}

/** Applies one action at the state's current time. Invalid actions change nothing. */
export function apply(state: GameState, action: Action): Outcome {
  switch (action.a) {
    case "click":
      return click(state, action.n);
    case "buy":
      return buyGenerator(state, action.g, action.n);
    case "up":
      return buyUpgrade(state, action.id);
    case "gold":
      return catchGolden(state, action.i);
    case "migrate":
      return migrate(state);
  }
}

/** A deep copy (states are plain JSON). */
export const cloneState = (state: GameState): GameState => structuredClone(state);
