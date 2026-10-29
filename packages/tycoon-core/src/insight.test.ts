import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACHIEVEMENTS, GENERATORS } from "./data";
import {
  achievementProgress,
  maxAffordable,
  nextMilestone,
  secondsToAfford,
  tierShare,
} from "./insight";
import { baseRate, buyGenerator, generatorCost, newGame } from "./rules";

describe("maxAffordable", () => {
  it("is the largest count whose price fits the bank", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: GENERATORS.length - 1 }),
        fc.integer({ min: 0, max: 300 }),
        fc.double({ min: 0, max: 1e30, noNaN: true }),
        (tier, owned, records) => {
          const state = newGame();
          state.owned[tier] = owned;
          state.records = records;
          const n = maxAffordable(state, tier);
          expect(n).toBeGreaterThanOrEqual(0);
          if (n > 0) expect(generatorCost(state, tier, n)).toBeLessThanOrEqual(records);
          expect(generatorCost(state, tier, n + 1)).toBeGreaterThan(records);
        },
      ),
    );
  });

  it("matches what the rules let you buy in chunks of 100", () => {
    const state = newGame();
    state.records = 1e9;
    let left = maxAffordable(state, 0);
    expect(left).toBeGreaterThan(100);
    while (left > 0) {
      const chunk = Math.min(100, left);
      expect(buyGenerator(state, 0, chunk).ok).toBe(true);
      left -= chunk;
    }
    expect(maxAffordable(state, 0)).toBe(0);
  });
});

describe("secondsToAfford", () => {
  it("is 0 when affordable, null with no production, else the wait at today's rate", () => {
    const state = newGame();
    state.records = 50;
    expect(secondsToAfford(state, 40)).toBe(0);
    expect(secondsToAfford(state, 100)).toBeNull();
    state.owned[1] = 1;
    const rate = baseRate(state);
    expect(secondsToAfford(state, 100)).toBeCloseTo(50 / rate);
  });
});

describe("nextMilestone", () => {
  it("walks 1, 10, 25, 50 and then stops", () => {
    const state = newGame();
    const seen: (number | null)[] = [];
    for (const owned of [0, 1, 9, 10, 30, 50]) {
      state.owned[2] = owned;
      seen.push(nextMilestone(state, 2));
    }
    expect(seen).toEqual([1, 10, 10, 25, 50, null]);
  });
});

describe("tierShare", () => {
  it("adds up to 1 across tiers", () => {
    const state = newGame();
    state.owned = GENERATORS.map((_, i) => 10 - i);
    const total = GENERATORS.reduce((sum, _, tier) => sum + tierShare(state, tier), 0);
    expect(total).toBeCloseTo(1);
    expect(tierShare(newGame(), 0)).toBe(0);
  });
});

describe("achievementProgress", () => {
  it("counts toward every achievement that has a number", () => {
    const state = newGame();
    state.clicks = 60;
    const hundred = ACHIEVEMENTS.find((a) => a.test.kind === "clicks")!;
    expect(achievementProgress(state, hundred)).toEqual({ current: 60, target: 100 });
    for (const achievement of ACHIEVEMENTS) {
      const progress = achievementProgress(state, achievement);
      if (achievement.test.kind === "ended" || achievement.test.kind === "linked") {
        expect(progress).toBeNull();
      } else {
        expect(progress?.target).toBeGreaterThan(0);
      }
    }
  });
});
