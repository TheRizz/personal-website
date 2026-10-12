import { describe, expect, it } from "vitest";
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
