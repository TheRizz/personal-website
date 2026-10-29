import { COST_GROWTH, GENERATORS, UPGRADES, type Achievement } from "./data";
import { baseRate, currentRate, generatorCost, tierRate, type GameState } from "./rules";

// Read-only figures for the shop and the stats tab. Nothing here changes the rules, so the server
// never needs them and RULES_VERSION stays put when they change.

/** Seconds until the bank holds `cost` at today's rate: 0 if it already does, null if never. */
export function secondsToAfford(state: GameState, cost: number): number | null {
  if (state.records >= cost) return 0;
  const rate = currentRate(state);
  if (rate <= 0) return null;
  return (cost - state.records) / rate;
}

/** The most of a tier the bank can buy right now (no upper limit). */
export function maxAffordable(state: GameState, tier: number): number {
  const generator = GENERATORS[tier];
  if (!generator || state.records <= 0) return 0;
  const owned = state.owned[tier] ?? 0;
  const first = generator.baseCost * COST_GROWTH ** owned;
  // Sum of a geometric series: first × (g^n − 1) / (g − 1) ≤ records.
  let count = Math.floor(
    Math.log((state.records * (COST_GROWTH - 1)) / first + 1) / Math.log(COST_GROWTH),
  );
  // Floating point can land one either side; settle it against the exact price.
  while (count > 0 && generatorCost(state, tier, count) > state.records) count--;
  while (generatorCost(state, tier, count + 1) <= state.records) count++;
  return Math.max(0, count);
}

/** The next ownership count that unlocks a ×2 upgrade for a tier, or null past the last. */
export function nextMilestone(state: GameState, tier: number): number | null {
  const owned = state.owned[tier] ?? 0;
  let next: number | null = null;
  for (const upgrade of UPGRADES) {
    const { requires, effect } = upgrade;
    if (effect.kind !== "tier" || effect.tier !== tier || requires.kind !== "owned") continue;
    if (requires.count > owned && (next === null || requires.count < next)) next = requires.count;
  }
  return next;
}

/** A tier's share of base production, 0 to 1. */
export function tierShare(state: GameState, tier: number): number {
  const total = baseRate(state);
  return total > 0 ? tierRate(state, tier) / total : 0;
}

/** How far a locked achievement has got, for the ones that count something. */
export function achievementProgress(
  state: GameState,
  achievement: Achievement,
): { current: number; target: number } | null {
  const test = achievement.test;
  switch (test.kind) {
    case "lifetime":
      return { current: state.lifetimeRecords, target: test.records };
    case "owned":
      return { current: state.owned[test.tier] ?? 0, target: test.count };
    case "totalOwned":
      return { current: state.owned.reduce((a, b) => a + b, 0), target: test.count };
    case "clicks":
      return { current: state.clicks, target: test.count };
    case "golden":
      return { current: state.goldenCaught, target: test.count };
    case "migrations":
      return { current: state.migrations, target: test.count };
    case "upgrades":
      return { current: state.upgrades.length, target: test.count };
    case "rate":
      return { current: state.bestRate, target: test.perSecond };
    case "ended":
    case "linked":
      return null;
  }
}
