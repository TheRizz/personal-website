import {
  affordableCount,
  availableUpgrades,
  secondsToAfford,
  type GameState,
} from "@site/tycoon-core";

// Three one-line tips for a brand-new game, shown once each in the scene's toast. Which have
// fired is kept in this browser's localStorage; a game that already has progress when the page
// opens gets none.

export interface Hint {
  id: "core" | "intern" | "upgrades";
  text: string;
  /** True once the moment for this tip has come. */
  due: (state: GameState) => boolean;
}

export const HINTS: readonly Hint[] = [
  {
    id: "core",
    text: "Tap the core",
    due: (state) => state.clicks === 0,
  },
  {
    id: "intern",
    text: "Buy an intern, it works while you don't",
    due: (state) => (state.owned[0] ?? 0) === 0 && affordableCount(state, 0, 1) > 0,
  },
  {
    id: "upgrades",
    text: "Upgrades tab has something for you",
    due: (state) =>
      state.upgrades.length === 0 &&
      availableUpgrades(state).some((upgrade) => secondsToAfford(state, upgrade.cost) === 0),
  },
];

export type HintId = Hint["id"];

const HINTS_KEY = "games.tycoon.hints";

/** A game that has been played before, so it needs no tips. */
export function isReturning(state: GameState): boolean {
  return state.lifetimeRecords > 0 || state.migrations > 0 || state.owned.some((n) => n > 0);
}

/** The first tip not yet seen whose moment has come, if any. */
export function dueHint(state: GameState, seen: ReadonlySet<HintId>): Hint | null {
  return HINTS.find((hint) => !seen.has(hint.id) && hint.due(state)) ?? null;
}

export function loadSeenHints(): Set<HintId> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(HINTS_KEY) ?? "[]");
    const ids = new Set<string>(Array.isArray(saved) ? saved : []);
    return new Set(HINTS.map((hint) => hint.id).filter((id) => ids.has(id)));
  } catch {
    return new Set();
  }
}

export function saveSeenHints(seen: ReadonlySet<HintId>) {
  try {
    window.localStorage.setItem(HINTS_KEY, JSON.stringify([...seen]));
  } catch {
    // Not remembered; at worst a tip shows again next visit.
  }
}
