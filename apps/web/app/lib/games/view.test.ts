import { describe, expect, it } from "vitest";
import { tictactoe, type PublicState } from "@site/game-core";
import { cellLabel, opponentOf, playerName, statusHeadline } from "./view";

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
