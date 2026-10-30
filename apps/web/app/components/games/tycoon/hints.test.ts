import { afterEach, describe, expect, it, vi } from "vitest";
import { newGame, type GameState } from "@site/tycoon-core";
import { dueHint, isReturning, loadSeenHints, saveSeenHints, type HintId } from "./hints";

function game(change: Partial<GameState> = {}): GameState {
  return { ...newGame(), ...change };
}

const none = new Set<HintId>();

describe("dueHint", () => {
  it("starts a new game with the core tip", () => {
    expect(dueHint(game(), none)?.text).toBe("Tap the core");
  });

  it("suggests an intern once one is affordable and none is owned", () => {
    const seen = new Set<HintId>(["core"]);
    expect(dueHint(game({ clicks: 5, records: 5 }), seen)).toBeNull();
    expect(dueHint(game({ clicks: 15, records: 15 }), seen)?.id).toBe("intern");
    const owned = game({ clicks: 15, records: 15, owned: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(dueHint(owned, seen)).toBeNull();
  });

  it("points at the upgrades tab once the first upgrade is affordable", () => {
    const seen = new Set<HintId>(["core", "intern"]);
    const owned = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(dueHint(game({ clicks: 30, records: 20, owned }), seen)).toBeNull();
    expect(dueHint(game({ clicks: 300, records: 1_000, owned }), seen)?.id).toBe("upgrades");
    const bought = game({ clicks: 300, records: 1_000, owned, upgrades: ["intern-1"] });
    expect(dueHint(bought, seen)).toBeNull();
  });

  it("never repeats a tip that has fired", () => {
    expect(dueHint(game(), new Set<HintId>(["core", "intern", "upgrades"]))).toBeNull();
  });
});

describe("isReturning", () => {
  it("is false only for an untouched game", () => {
    expect(isReturning(game())).toBe(false);
    expect(isReturning(game({ lifetimeRecords: 1 }))).toBe(true);
    expect(isReturning(game({ migrations: 1 }))).toBe(true);
  });
});

describe("seen hints storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips through localStorage and ignores unknown ids", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    expect(loadSeenHints().size).toBe(0);
    saveSeenHints(new Set<HintId>(["core"]));
    expect([...loadSeenHints()]).toEqual(["core"]);
    store.set("games.tycoon.hints", '["intern","nonsense"]');
    expect([...loadSeenHints()]).toEqual(["intern"]);
  });

  it("falls back to nothing seen when storage is blocked", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(loadSeenHints().size).toBe(0);
    expect(() => saveSeenHints(new Set<HintId>(["core"]))).not.toThrow();
  });
});
