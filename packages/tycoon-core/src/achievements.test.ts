import { describe, expect, it } from "vitest";
import { ACHIEVEMENTS, ENDING_UPGRADE, GENERATORS, HOTFIX_RUN_MS, UPGRADES_BY_ID } from "./data";
import { goldenSpawn } from "./golden";
import { achievementProgress } from "./insight";
import {
  AP_BASE_RECORDS,
  RULES_VERSION,
  advance,
  buyGenerator,
  buyUpgrade,
  catchGolden,
  click,
  cloneState,
  migrate,
  newGame,
  type GameState,
} from "./rules";
import { replay } from "./replay";
import { gameStateSchema, upgradeState } from "./schema";

// The rules-v3 achievements (backlog: "More achievements").

const has = (state: GameState, id: string) => state.achievements.includes(id);
const byId = (id: string) => ACHIEVEMENTS.find((a) => a.id === id)!;

/** A state with a seeded golden schedule and a bank big enough for anything early. */
function rich(): GameState {
  const state = newGame();
  state.records = 1e15;
  state.golden = { seed: 11, start: 0, next: 0 };
  return state;
}

/** Moves the clock to golden packet `index` and catches it. */
function catchAt(state: GameState, index: number) {
  const spawn = goldenSpawn(state.golden, index);
  advance(state, spawn.at + 1 - state.playMs);
  return { spawn, outcome: catchGolden(state, index) };
}

/** A run ready to migrate for exactly `points` AP, `runMs` into it. */
function readyToMigrate(points: number, runMs: number): GameState {
  const state = newGame();
  state.runRecords = AP_BASE_RECORDS * points ** 2;
  state.runMs = runMs;
  state.playMs = runMs;
  return state;
}

describe("rules v3 achievements", () => {
  it("adds eight new ones with unique ids", () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "unpaid-workforce",
      "full-stack",
      "zero-packet-loss",
      "hands-off",
      "overclocked-overclock",
      "minimum-viable-migration",
      "hotfix",
      "fully-automated",
    ]) {
      expect(ids).toContain(id);
    }
    expect(RULES_VERSION).toBeGreaterThanOrEqual(3);
  });

  it("Unpaid workforce: 25 interns and nothing else", () => {
    const state = rich();
    buyGenerator(state, 0, 24);
    expect(has(state, "unpaid-workforce")).toBe(false);
    expect(achievementProgress(state, byId("unpaid-workforce"))).toEqual({
      current: 24,
      target: 25,
    });
    buyGenerator(state, 0, 1);
    expect(has(state, "unpaid-workforce")).toBe(true);

    const mixed = rich();
    buyGenerator(mixed, 1, 1);
    buyGenerator(mixed, 0, 30);
    expect(has(mixed, "unpaid-workforce")).toBe(false);
    expect(achievementProgress(mixed, byId("unpaid-workforce"))).toBeNull();
  });

  it("Full stack: one of every generator", () => {
    const state = rich();
    state.records = 1e30;
    for (let tier = 0; tier < GENERATORS.length - 1; tier++) buyGenerator(state, tier, 1);
    expect(has(state, "full-stack")).toBe(false);
    expect(achievementProgress(state, byId("full-stack"))).toEqual({
      current: GENERATORS.length - 1,
      target: GENERATORS.length,
    });
    buyGenerator(state, GENERATORS.length - 1, 1);
    expect(has(state, "full-stack")).toBe(true);
  });

  it("Zero packet loss: three golden packets in a row, a missed one starts over", () => {
    const state = rich();
    catchAt(state, 0);
    catchAt(state, 1);
    // Packet 2 goes by uncaught.
    catchAt(state, 3);
    expect(state.goldenStreak).toBe(1);
    catchAt(state, 4);
    expect(has(state, "zero-packet-loss")).toBe(false);
    catchAt(state, 5);
    expect(state.goldenStreak).toBe(3);
    expect(has(state, "zero-packet-loss")).toBe(true);
  });

  it("Overclocked overclock: catch a golden packet during an overclock", () => {
    // Find a seed whose first packet overclocks and whose second comes before that ends.
    let seed = 1;
    for (; seed < 10_000; seed++) {
      const schedule = { seed, start: 0 };
      const first = goldenSpawn(schedule, 0);
      const second = goldenSpawn(schedule, 1);
      if (first.kind === "overclock" && second.at - (first.at + 1) < 77_000) break;
    }
    const state = rich();
    state.golden = { seed, start: 0, next: 0 };
    catchAt(state, 0);
    expect(has(state, "overclocked-overclock")).toBe(false);
    catchAt(state, 1);
    expect(has(state, "overclocked-overclock")).toBe(true);
  });

  it("Hands off: ten minutes without a click, split exactly so replays agree", () => {
    const state = newGame();
    buyGenerator(Object.assign(state, { records: 1e6 }), 1, 10);
    click(state, 1);
    advance(state, 9 * 60_000);
    expect(has(state, "hands-off")).toBe(false);
    expect(achievementProgress(state, byId("hands-off"))).toEqual({ current: 9, target: 10 });
    click(state, 1);
    advance(state, 9 * 60_000);
    expect(has(state, "hands-off")).toBe(false);

    // One long step and many short ones earn the same (the +1 % starts at exactly 10 minutes).
    const one = cloneState(state);
    const many = cloneState(state);
    advance(one, 5 * 60_000);
    for (let i = 0; i < 300; i++) advance(many, 1_000);
    expect(has(one, "hands-off")).toBe(true);
    expect(many.achievements).toEqual(one.achievements);
    expect(many.records).toBeCloseTo(one.records, 6);
  });

  it("Minimum viable migration and Hotfix come from the migration itself", () => {
    const quick = readyToMigrate(1, HOTFIX_RUN_MS - 1);
    expect(migrate(quick)).toEqual({ ok: true });
    expect(has(quick, "minimum-viable-migration")).toBe(true);
    expect(has(quick, "hotfix")).toBe(true);

    const slow = readyToMigrate(2, HOTFIX_RUN_MS);
    migrate(slow);
    expect(has(slow, "minimum-viable-migration")).toBe(false);
    expect(has(slow, "hotfix")).toBe(false);
    expect(slow.runClicks).toBe(0);
  });

  it("Fully automated: the ending with no click since the last migration", () => {
    const ending = (state: GameState) => {
      state.records = UPGRADES_BY_ID.get(ENDING_UPGRADE)!.cost * 2;
      state.owned = GENERATORS.map(() => 500);
      state.lifetimeRecords = 1e30;
      expect(buyUpgrade(state, ENDING_UPGRADE)).toEqual({ ok: true });
      return state;
    };
    const automated = readyToMigrate(1, HOTFIX_RUN_MS);
    click(automated, 5);
    migrate(automated);
    expect(has(ending(automated), "fully-automated")).toBe(true);
    expect(automated.ended).toBe(true);

    const clicked = readyToMigrate(1, HOTFIX_RUN_MS);
    migrate(clicked);
    click(clicked, 1);
    expect(has(ending(clicked), "fully-automated")).toBe(false);

    // Never migrated: doesn't count.
    expect(has(ending(newGame()), "fully-automated")).toBe(false);
  });

  it("replays the same on the server as on the client", () => {
    const start = rich();
    const client = cloneState(start);
    const actions = [
      { t: 0, a: "buy" as const, g: 0, n: 25 },
      { t: 1_000, a: "buy" as const, g: 1, n: 1 },
    ];
    advance(client, 0);
    buyGenerator(client, 0, 25);
    advance(client, 1_000);
    buyGenerator(client, 1, 1);
    for (let i = 0; i < 700; i++) advance(client, 1_000);
    const server = replay(start, { elapsed: 701_000, actions }).state;
    expect(server.achievements).toEqual(client.achievements);
    expect(server.achievements).toEqual(expect.arrayContaining(["unpaid-workforce", "hands-off"]));
    expect(Math.abs(server.records - client.records) / client.records).toBeLessThan(1e-9);
  });
});

describe("rules v2 saves", () => {
  it("fill in the new fields: past clicks count as this run's, the idle clock starts now", () => {
    const {
      runClicks: _r,
      lastClickMs: _l,
      goldenStreak: _g,
      ...v2
    } = {
      ...newGame(),
      v: 2,
      clicks: 40,
      playMs: 3_600_000,
    };
    const upgraded = upgradeState(gameStateSchema.parse(JSON.parse(JSON.stringify(v2))));
    expect(upgraded.v).toBe(RULES_VERSION);
    expect(upgraded.runClicks).toBe(40);
    expect(upgraded.lastClickMs).toBe(3_600_000);
    expect(upgraded.goldenStreak).toBe(0);
    // A later save keeps them as they are.
    const again = gameStateSchema.parse(JSON.parse(JSON.stringify({ ...upgraded, runClicks: 0 })));
    expect(again.runClicks).toBe(0);
  });
});
