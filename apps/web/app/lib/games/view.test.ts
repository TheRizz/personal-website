import { describe, expect, it } from "vitest";
import { tictactoe, type PublicState } from "@site/game-core";
import { announcement, cellLabel, opponentOf, playerName, statusHeadline } from "./view";

const player = (name: string) => ({ name, connected: true, releaseAt: null });

function state(overrides: Partial<PublicState>): PublicState {
  return {
    code: "ABC234",
    game: "tictactoe",
    phase: "playing",
    players: { X: player("Ada"), O: player("Bo") },
    spectators: 0,
    board: tictactoe.init("X"),
    result: { kind: "playing", turn: "X" },
    round: 1,
    firstSeat: "X",
    score: { X: 0, O: 0, draws: 0 },
    rematch: { X: false, O: false },
    ...overrides,
  };
}

describe("statusHeadline", () => {
  it("says whose move it is", () => {
    expect(statusHeadline(state({}), "X")).toMatchObject({ text: "Your move", yourMove: true });
    expect(statusHeadline(state({}), "O").text).toBe("Waiting for Ada");
    expect(statusHeadline(state({}), "spectator").text).toBe("Ada's move");
  });

  it("describes the result for each viewer", () => {
    const won = state({ phase: "finished", result: { kind: "won", winner: "O", line: [0, 4, 8] } });
    expect(statusHeadline(won, "O")).toMatchObject({ text: "You win", outcome: "win" });
    expect(statusHeadline(won, "X")).toMatchObject({ text: "You lose", outcome: "lose" });
    expect(statusHeadline(won, "spectator")).toMatchObject({
      text: "Bo wins",
      outcome: "other-win",
    });
    const draw = state({ phase: "finished", result: { kind: "draw" } });
    expect(statusHeadline(draw, "X")).toMatchObject({ text: "Draw", outcome: "draw" });
  });

  it("waits for an opponent while a seat is empty", () => {
    const waiting = state({ phase: "waiting", players: { X: player("Ada"), O: null } });
    expect(statusHeadline(waiting, "X").text).toBe("Waiting for an opponent…");
    expect(playerName(waiting, "O")).toBe("Player O");
  });
});

describe("cellLabel", () => {
  it("names the row, column and contents", () => {
    expect(cellLabel(0, null)).toBe("Row 1, column 1, empty");
    expect(cellLabel(1, "X")).toBe("Row 1, column 2, X");
    expect(cellLabel(8, "O")).toBe("Row 3, column 3, O");
  });
});

describe("opponentOf", () => {
  it("returns the other seat for players only", () => {
    expect(opponentOf("X")).toBe("O");
    expect(opponentOf("O")).toBe("X");
    expect(opponentOf("spectator")).toBeNull();
    expect(opponentOf(null)).toBeNull();
  });
});

describe("announcement", () => {
  const waiting = state({ phase: "waiting", players: { X: player("Ada"), O: null } });
  const board = (cells: Record<number, "X" | "O">, turn: "X" | "O") => ({
    board: Array.from({ length: 9 }, (_, i) => cells[i] ?? null),
    turn,
  });

  it("says nothing for an unchanged snapshot, or a first one that isn't a game in progress", () => {
    expect(announcement(state({}), state({}), "X")).toBeNull();
    expect(announcement(null, waiting, "X")).toBeNull();
    const over = state({ phase: "finished", result: { kind: "draw" } });
    expect(announcement(null, over, "X")).toBeNull();
    expect(announcement(null, state({}), null)).toBeNull();
  });

  it("says who you are when you arrive in a game in progress", () => {
    // E.g. joining through an invite: the join itself starts the game.
    expect(announcement(null, state({}), "O")).toBe("You are O. Waiting for Ada.");
    expect(announcement(null, state({}), "X")).toBe("You are X. Your move.");
    expect(announcement(null, state({}), "spectator")).toBe("Ada and Bo are playing. Ada's move.");
  });

  it("announces the game starting", () => {
    expect(announcement(waiting, state({}), "X")).toBe("Bo joined. You are X. Your move.");
    expect(announcement(waiting, state({}), "O")).toBe("Ada joined. You are O. Waiting for Ada.");
    expect(announcement(waiting, state({}), "spectator")).toBe(
      "Ada and Bo are playing. Ada's move.",
    );
  });

  it("says where the other player moved", () => {
    const after = state({ board: board({ 5: "O" }, "X") });
    const before = state({ board: board({}, "O"), result: { kind: "playing", turn: "O" } });
    expect(announcement(before, after, "X")).toBe("Bo played row 2, column 3. Your move.");
    expect(announcement(before, after, "O")).toBe("Waiting for Ada.");
  });

  it("names the winning line", () => {
    const before = state({ board: board({ 0: "X", 1: "X", 3: "O", 4: "O" }, "X") });
    const won = state({
      phase: "finished",
      board: board({ 0: "X", 1: "X", 2: "X", 3: "O", 4: "O" }, "O"),
      result: { kind: "won", winner: "X", line: [0, 1, 2] },
    });
    expect(announcement(before, won, "O")).toBe("Ada played row 1, column 3. You lose: row 1.");
    expect(announcement(before, won, "X")).toBe("You win: row 1.");
  });

  it("announces rematch requests, new rounds and players dropping out", () => {
    const over = state({ phase: "finished", result: { kind: "draw" } });
    const asked = { ...over, rematch: { X: false, O: true } };
    expect(announcement(over, asked, "X")).toBe("Bo wants a rematch.");
    expect(announcement(asked, state({ round: 2 }), "X")).toBe("Round 2. Your move.");

    const away = state({ players: { X: player("Ada"), O: { ...player("Bo"), connected: false } } });
    expect(announcement(state({}), away, "X")).toBe(
      "Bo disconnected. Their seat is held for 2 minutes.",
    );
    expect(announcement(away, state({}), "X")).toBe("Bo is back.");
    const left = state({ phase: "waiting", players: { X: player("Ada"), O: null } });
    expect(announcement(state({}), left, "X")).toBe("Bo left. Waiting for an opponent…");
  });
});
