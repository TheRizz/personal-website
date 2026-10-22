import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACHIEVEMENTS, ENDING_UPGRADE, GENERATORS, UPGRADES } from "./data";
import { formatDuration, formatShort } from "./format";
import { goldenSpawn, upcomingGolden } from "./golden";
import {
  OFFLINE_CAP_MS,
  advance,
  apply,
  availableUpgrades,
  baseRate,
  buyGenerator,
  buyUpgrade,
  catchGolden,
  checkAchievements,
  click,
  cloneState,
  currentRate,
  generatorCost,
  migrate,
  migrationGain,
  newGame,
  type Action,
  type GameState,
} from "./rules";
import { MAX_CLICKS_PER_SECOND, applyOffline, replay } from "./replay";
import { gameStateSchema, saveLogSchema } from "./schema";

/** A mid-game state: some of every tier and a fat bank. */
function midGame(): GameState {
  const state = newGame();
  state.owned = GENERATORS.map((_, i) => Math.max(0, 30 - i * 3));
  state.records = 1e12;
  state.golden = { seed: 7, start: 0, next: 0 };
  return state;
}

const close = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

describe("content", () => {
  it("has unique ids and ten tiers, each pricier than the last", () => {
    expect(GENERATORS).toHaveLength(10);
    expect(new Set(UPGRADES.map((u) => u.id)).size).toBe(UPGRADES.length);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
    for (let i = 1; i < GENERATORS.length; i++) {
      expect(GENERATORS[i]!.baseCost).toBeGreaterThan(GENERATORS[i - 1]!.baseCost * 5);
    }
  });
});

describe("advance", () => {
  it("is the same in one step or many (what lets the server replay the client)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 600_000 }), { minLength: 1, maxLength: 40 }),
        (steps) => {
          const one = midGame();
          one.records = 0;
          one.overclockUntil = 30_000;
          const many = cloneState(one);
          advance(
            one,
            steps.reduce((a, b) => a + b, 0),
          );
          for (const step of steps) advance(many, step);
          return (
            close(one.records, many.records) && one.achievements.join() === many.achievements.join()
          );
        },
      ),
    );
  });

  it("applies an overclock only until it ends", () => {
    const state = midGame();
    // Every lifetime achievement already unlocked, so the rate can't change mid-test.
    state.lifetimeRecords = 1e30;
    checkAchievements(state);
    const rate = baseRate(state);
    state.overclockUntil = 10_000;
    const before = state.records;
    advance(state, 20_000);
    expect(close(state.records - before, rate * (10 * 7 + 10))).toBe(true);
  });
});

describe("purchases", () => {
  it("charges the geometric price and refuses what the bank can't cover", () => {
    const state = newGame();
    state.records = 15;
    expect(buyGenerator(state, 0, 1)).toEqual({ ok: true });
    expect(state.records).toBe(0);
    expect(generatorCost(state, 0)).toBeCloseTo(15 * 1.15);
    expect(buyGenerator(state, 0, 1)).toEqual({ ok: false, reason: "too_expensive" });
    expect(buyGenerator(state, 99, 1)).toEqual({ ok: false, reason: "bad_purchase" });
  });

  it("only sells upgrades whose requirements are met, once", () => {
    const state = midGame();
    const available = availableUpgrades(state).map((u) => u.id);
    expect(available).toContain("intern-1");
    expect(available).not.toContain(ENDING_UPGRADE);
    const rate = baseRate(state);
    expect(buyUpgrade(state, "intern-1").ok).toBe(true);
    expect(baseRate(state)).toBeGreaterThan(rate);
    expect(buyUpgrade(state, "intern-1")).toEqual({ ok: false, reason: "unavailable" });
    expect(buyUpgrade(state, "nope")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("ends the game with Integrate Earth, which can't be bought again", () => {
    const state = midGame();
    state.owned[9] = 10;
    state.records = 2e15;
    expect(buyUpgrade(state, ENDING_UPGRADE).ok).toBe(true);
    expect(state.ended).toBe(true);
    expect(state.achievements).toContain("the-end");
    migrate(state);
    state.owned[9] = 10;
    state.records = 2e15;
    expect(availableUpgrades(state).map((u) => u.id)).not.toContain(ENDING_UPGRADE);
  });
});

describe("migration", () => {
  it("needs a billion records this run, then resets the run for Architecture Points", () => {
    const state = midGame();
    expect(migrate(state)).toEqual({ ok: false, reason: "too_early" });
    state.runRecords = 4.2e9;
    expect(migrationGain(state)).toBe(2);
    const rate = baseRate(state);
    expect(migrate(state).ok).toBe(true);
    expect(state.ap).toBe(2);
    expect(state.owned.every((n) => n === 0)).toBe(true);
    expect(state.records).toBe(0);
    state.owned = midGame().owned;
    // 2 AP = +200 %, plus the achievements unlocked on the way.
    expect(baseRate(state)).toBeGreaterThan(rate * 2.9);
  });
});

describe("golden packets", () => {
  it("can be caught only while on screen, once each", () => {
    const state = midGame();
    const first = goldenSpawn(state.golden, 0);
    expect(catchGolden(state, 0)).toEqual({ ok: false, reason: "not_visible" });
    advance(state, first.at + 1000);
    const outcome = catchGolden(state, 0);
    expect(outcome.ok).toBe(true);
    expect(catchGolden(state, 0)).toEqual({ ok: false, reason: "gone" });
    expect(upcomingGolden(state.golden, state.playMs).index).toBe(1);
  });

  it("follows the seed, so client and server agree", () => {
    expect(goldenSpawn({ seed: 99, start: 0 }, 3)).toEqual(goldenSpawn({ seed: 99, start: 0 }, 3));
    expect(goldenSpawn({ seed: 99, start: 0 }, 3)).not.toEqual(
      goldenSpawn({ seed: 100, start: 0 }, 3),
    );
  });
});

/** Plays like a client: ticks every frame, acts as it goes and records the log. */
function playLikeClient(
  start: GameState,
  script: (now: number) => Action["a"] | null,
  durationMs: number,
) {
  const local = cloneState(start);
  const actions: Action[] = [];
  for (let now = 16; now <= durationMs; now += 16) {
    advance(local, 16);
    const kind = script(now);
    let action: Action | null = null;
    if (kind === "click") action = { t: now, a: "click", n: 1 };
    if (kind === "buy") {
      const tier = GENERATORS.findIndex((_, i) => generatorCost(local, i) <= local.records);
      if (tier >= 0) action = { t: now, a: "buy", g: tier, n: 1 };
    }
    if (action && apply(local, action).ok) actions.push(action);
  }
  return { local, log: { elapsed: durationMs, actions } };
}

describe("replay", () => {
  it("reproduces an honest client exactly, dropping nothing", () => {
    const { local, log } = playLikeClient(
      newGame(),
      (now) => (now % 160 === 0 ? "click" : now % 1600 === 0 ? "buy" : null),
      120_000,
    );
    const result = replay(newGame(), log, log.elapsed + 5_000);
    expect(result.dropped).toEqual([]);
    expect(result.state.owned).toEqual(local.owned);
    expect(close(result.state.records, local.records)).toBe(true);
  });

  it("credits only the time the server saw, so purchases bought with extra time are dropped", () => {
    const start = newGame();
    start.owned[1] = 10; // 10 records/s
    const log = { elapsed: 3_600_000, actions: [{ t: 3_600_000, a: "buy", g: 3, n: 1 } as Action] };
    const result = replay(start, log, 60_000);
    expect(result.creditedMs).toBe(60_000);
    expect(result.dropped).toEqual([{ index: 0, reason: "too_expensive" }]);
    expect(result.state.records).toBeLessThan(700);
  });

  it(`caps clicks at ${MAX_CLICKS_PER_SECOND} a second`, () => {
    const actions: Action[] = Array.from({ length: 10 }, (_, i) => ({
      t: (i + 1) * 1000,
      a: "click",
      n: 1_000,
    }));
    const result = replay(newGame(), { elapsed: 10_000, actions }, 10_000);
    expect(result.state.clicks).toBeLessThanOrEqual(MAX_CLICKS_PER_SECOND * 11);
    expect(result.dropped.every((d) => d.reason === "click_rate")).toBe(true);
  });

  it("never lets times run backwards", () => {
    const actions: Action[] = [
      { t: 5_000, a: "click", n: 1 },
      { t: 1_000, a: "click", n: 1 },
    ];
    const result = replay(newGame(), { elapsed: 6_000, actions }, 6_000);
    expect(result.state.playMs).toBe(6_000);
    expect(result.state.clicks).toBe(2);
  });

  it("can't invent golden packets", () => {
    const start = midGame();
    const result = replay(
      start,
      { elapsed: 10_000, actions: [{ t: 5_000, a: "gold", i: 0 }] },
      10_000,
    );
    expect(result.dropped).toEqual([{ index: 0, reason: "not_visible" }]);
  });

  it("does not change the starting state", () => {
    const start = midGame();
    const copy = cloneState(start);
    replay(start, { elapsed: 1000, actions: [{ t: 0, a: "buy", g: 0, n: 1 }] });
    expect(start).toEqual(copy);
  });
});

describe("offline", () => {
  it("credits at most 8 hours", () => {
    const start = midGame();
    const rate = currentRate(start);
    const { creditedMs, earned } = applyOffline(start, 3 * OFFLINE_CAP_MS);
    expect(creditedMs).toBe(OFFLINE_CAP_MS);
    expect(earned).toBeGreaterThanOrEqual((rate * OFFLINE_CAP_MS) / 1000);
    expect(earned).toBeLessThan((rate * OFFLINE_CAP_MS * 1.3) / 1000);
  });
});

describe("schemas", () => {
  it("round-trips a state and rejects malformed logs", () => {
    const state = midGame();
    click(state, 3);
    expect(gameStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(
      saveLogSchema.safeParse({ elapsed: 1, actions: [{ t: 0, a: "buy", g: 10, n: 1 }] }).success,
    ).toBe(false);
    expect(saveLogSchema.safeParse({ elapsed: -1, actions: [] }).success).toBe(false);
    expect(saveLogSchema.safeParse({ elapsed: 1, actions: [{ t: 0, a: "hack" }] }).success).toBe(
      false,
    );
  });
});

describe("format", () => {
  it("shortens big numbers", () => {
    expect(formatShort(950)).toBe("950");
    expect(formatShort(2.5)).toBe("2.5");
    expect(formatShort(12_345)).toBe("12.3K");
    expect(formatShort(1.5e9)).toBe("1.50B");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
  });
});
