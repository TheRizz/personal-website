import { describe, expect, it } from "vitest";
import { isSeat } from "./game";
import { GAME_IDS, GAMES, isGameId } from "./games";

describe("games registry", () => {
  it("lists tic-tac-toe under its own id", () => {
    expect(GAME_IDS).toEqual(["tictactoe"]);
    for (const id of GAME_IDS) expect(GAMES[id].id).toBe(id);
  });

  it("isGameId guards untrusted ids", () => {
    expect(isGameId("tictactoe")).toBe(true);
    expect(isGameId("chess")).toBe(false);
    expect(isGameId("toString")).toBe(false);
    expect(isGameId(undefined)).toBe(false);
  });
});

describe("isSeat", () => {
  it("accepts only the player seats", () => {
    expect(isSeat("X")).toBe(true);
    expect(isSeat("O")).toBe(true);
    expect(isSeat("spectator")).toBe(false);
    expect(isSeat(null)).toBe(false);
  });
});
