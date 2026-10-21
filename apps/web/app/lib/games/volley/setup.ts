import type { CpuLevel } from "./ai";
import { CHARACTERS, characterById, type Character } from "./characters";
import type { CourtId } from "./engine";

/** The choices made before a match. */
export interface Setup {
  format: "1v1" | "2v2";
  /** Who plays: see MODES. */
  mode: Mode;
  level: CpuLevel;
  court: CourtId;
  target: number;
  p1: string;
  p2: string;
}

export type Mode = "cpu" | "local" | "coop" | "versus";

/** Who controls a player. */
export type Controller = "p1" | "p2" | "cpu";

export const MODES: Record<Setup["format"], { mode: Mode; label: string; hint: string }[]> = {
  "1v1": [
    { mode: "cpu", label: "Vs computer", hint: "You against the computer." },
    { mode: "local", label: "2 players", hint: "Two of you on one device." },
  ],
  "2v2": [
    {
      mode: "cpu",
      label: "Vs computer",
      hint: "You and a computer teammate against two computers.",
    },
    { mode: "coop", label: "2 players, same team", hint: "Two of you against two computers." },
    { mode: "versus", label: "2 players, rivals", hint: "Each of you with a computer teammate." },
  ],
};

export const TARGETS = [7, 11, 15] as const;
export const LEVELS: CpuLevel[] = ["easy", "normal", "hard"];
export const COURTS: { id: CourtId; label: string }[] = [
  { id: "beach", label: "Beach" },
  { id: "jungle", label: "Jungle" },
];

export const DEFAULT_SETUP: Setup = {
  format: "1v1",
  mode: "cpu",
  level: "normal",
  court: "beach",
  target: 11,
  p1: "blaze",
  p2: "rio",
};

/** A saved setup, or the default for anything missing or unknown. */
export function parseSetup(value: unknown): Setup {
  const saved = (typeof value === "object" && value !== null ? value : {}) as Partial<Setup>;
  const format = saved.format === "2v2" ? "2v2" : "1v1";
  const modes = MODES[format].map((entry) => entry.mode);
  const known = (id: unknown) => CHARACTERS.some((character) => character.id === id);
  return {
    format,
    mode: modes.includes(saved.mode as Mode) ? (saved.mode as Mode) : "cpu",
    level: LEVELS.includes(saved.level as CpuLevel) ? (saved.level as CpuLevel) : "normal",
    court: COURTS.some((court) => court.id === saved.court) ? saved.court! : "beach",
    target: (TARGETS as readonly number[]).includes(saved.target as number)
      ? saved.target!
      : DEFAULT_SETUP.target,
    p1: known(saved.p1) ? saved.p1! : DEFAULT_SETUP.p1,
    p2: known(saved.p2) ? saved.p2! : DEFAULT_SETUP.p2,
  };
}

/** Whether a second person plays. */
export const hasPlayerTwo = (setup: Setup) => setup.mode !== "cpu";

/**
 * Who controls each player, in match order: the left team (back, then front), then the right
 * team (back, then front). A person in 2v2 plays at the front, nearer the net.
 */
export function controllers(setup: Setup): Controller[] {
  if (setup.format === "1v1") return ["p1", setup.mode === "local" ? "p2" : "cpu"];
  if (setup.mode === "coop") return ["p2", "p1", "cpu", "cpu"];
  if (setup.mode === "versus") return ["cpu", "p1", "cpu", "p2"];
  return ["cpu", "p1", "cpu", "cpu"];
}

/** Each player's character: the people's picks, and different ones for the computers. */
export function charactersFor(setup: Setup): Character[] {
  const roles = controllers(setup);
  const taken = new Set(
    roles.map((role) => (role === "p1" ? setup.p1 : role === "p2" ? setup.p2 : null)),
  );
  const spare = CHARACTERS.filter((character) => !taken.has(character.id));
  let next = 0;
  return roles.map((role) => {
    if (role === "p1") return characterById(setup.p1);
    if (role === "p2") return characterById(setup.p2);
    return spare[next++ % spare.length]!;
  });
}

/** What the banners call each side. */
export function sideNames(setup: Setup, characters: Character[]): [string, string] {
  if (setup.format === "2v2") {
    return setup.mode === "versus" ? ["P1's team", "P2's team"] : ["Your team", "Computer team"];
  }
  const [left, right] = [characters[0]!.name, characters[1]!.name];
  return left === right ? ["P1", "P2"] : [left, right];
}
