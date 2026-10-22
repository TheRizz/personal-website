// A greedy player, for the pacing test (pacing.test.ts) and for tuning numbers by hand.
import { GENERATORS, ENDING_UPGRADE } from "./data";
import { goldenSpawn } from "./golden";
import {
  AP_BONUS,
  advance,
  availableUpgrades,
  baseRate,
  buyGenerator,
  buyUpgrade,
  catchGolden,
  click,
  cloneState,
  generatorCost,
  migrate,
  migrationGain,
  newGame,
  type GameState,
} from "./rules";

export interface BotOptions {
  /** Clicks per second while playing. */
  clicksPerSecond: number;
  /** Migrate when the gain would multiply the AP bonus by at least this much. */
  migrateRatio: number;
  /** Stop after this much play time. */
  limitMs: number;
  /** Simulation step; coarser is faster and a little pessimistic. */
  stepMs?: number;
}

export interface BotReport {
  firstPurchaseMs: number | null;
  firstMigrationAvailableMs: number | null;
  migrationTimesMs: number[];
  endingMs: number | null;
  state: GameState;
}

function bestPurchase(
  state: GameState,
): { kind: "gen"; tier: number; cost: number } | { kind: "up"; id: string; cost: number } | null {
  const rate = Math.max(baseRate(state), 0.1);
  let best:
    { kind: "gen"; tier: number; cost: number } | { kind: "up"; id: string; cost: number } | null =
    null;
  let bestScore = Infinity;
  const consider = (candidate: NonNullable<typeof best>, after: GameState) => {
    const gain = baseRate(after) - baseRate(state);
    const wait = Math.max(0, candidate.cost - state.records) / rate;
    const score = gain > 0 ? wait + candidate.cost / gain : wait * 4 + candidate.cost / rate;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  };
  GENERATORS.forEach((_, tier) => {
    const after = cloneState(state);
    after.records = Infinity;
    buyGenerator(after, tier, 1);
    consider({ kind: "gen", tier, cost: generatorCost(state, tier) }, after);
  });
  for (const upgrade of availableUpgrades(state)) {
    if (upgrade.id === ENDING_UPGRADE) continue;
    const after = cloneState(state);
    after.records = Infinity;
    buyUpgrade(after, upgrade.id);
    consider({ kind: "up", id: upgrade.id, cost: upgrade.cost }, after);
  }
  return best;
}

export function runBot(options: BotOptions): BotReport {
  const state = newGame();
  state.golden = { seed: 42, start: 0, next: 0 };
  const report: BotReport = {
    firstPurchaseMs: null,
    firstMigrationAvailableMs: null,
    migrationTimesMs: [],
    endingMs: null,
    state,
  };
  const step = options.stepMs ?? 5000;
  while (state.playMs < options.limitMs && !state.ended) {
    advance(state, step);
    if (options.clicksPerSecond > 0) click(state, options.clicksPerSecond * (step / 1000));
    const spawn = goldenSpawn(state.golden, state.golden.next);
    if (state.playMs >= spawn.at + 2000) catchGolden(state, spawn.index);

    if (
      availableUpgrades(state).some((u) => u.id === ENDING_UPGRADE) &&
      buyUpgrade(state, ENDING_UPGRADE).ok
    ) {
      report.endingMs = state.playMs;
      break;
    }
    for (let i = 0; i < 50; i++) {
      const purchase = bestPurchase(state);
      if (!purchase || purchase.cost > state.records) break;
      const ok =
        purchase.kind === "gen"
          ? buyGenerator(state, purchase.tier, 1).ok
          : buyUpgrade(state, purchase.id).ok;
      if (!ok) break;
      report.firstPurchaseMs ??= state.playMs;
    }
    const gain = migrationGain(state);
    if (gain >= 1) report.firstMigrationAvailableMs ??= state.playMs;
    if (
      gain >= 1 &&
      1 + AP_BONUS * (state.ap + gain) >= options.migrateRatio * (1 + AP_BONUS * state.ap)
    ) {
      migrate(state);
      report.migrationTimesMs.push(state.playMs);
    }
  }
  return report;
}
