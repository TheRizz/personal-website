import { tictactoe } from "./tictactoe";

/** Every game the site can host, keyed by id. */
export const GAMES = { tictactoe } as const;

export type GameId = keyof typeof GAMES;

export const GAME_IDS = Object.keys(GAMES) as GameId[];

/** Type guard for an untrusted game id. */
export function isGameId(value: unknown): value is GameId {
  return typeof value === "string" && Object.hasOwn(GAMES, value);
}
