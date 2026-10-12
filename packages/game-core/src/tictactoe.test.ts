import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { otherSeat, SEATS, type Seat } from "./game";
import { tictactoe, WIN_LINES, type TicTacToeCell, type TicTacToeState } from "./tictactoe";

const { init, validateMove, applyMove, status } = tictactoe;

/** Builds a state from a 9-char picture like "XO.X....." ('.' = empty). */
function boardOf(picture: string, turn: Seat = "X"): TicTacToeState {
  const board = [...picture].map((c): TicTacToeCell => (c === "." ? null : (c as Seat)));
  return { board, turn };
}

/** Plays the cells in order, alternating from `first`, validating each move. */
function play(cells: number[], first: Seat = "X"): TicTacToeState {
  return cells.reduce((state, cell) => {
    const result = validateMove(state, state.turn, { cell });
    if (!result.ok) throw new Error(`${result.code} at ${cell}`);
    return applyMove(state, state.turn, result.move);
  }, init(first));
}

describe("tictactoe", () => {
  it("describes itself", () => {
    expect(tictactoe).toMatchObject({ id: "tictactoe", name: "Tic-tac-toe", players: 2 });
  });

  it.each(SEATS)("init(%s) is an empty board with that seat to move", (seat) => {
    const state = init(seat);
    expect(state.board).toEqual(Array(9).fill(null));
    expect(state.turn).toBe(seat);
    expect(status(state)).toEqual({ kind: "playing", turn: seat });
  });

  describe.each(SEATS)("a win for %s", (seat) => {
    it.each(WIN_LINES.map((line) => [line.join(",") as string, line] as const))(
      "on line %s",
      (_name, line) => {
        const board = Array<TicTacToeCell>(9).fill(null);
        for (const cell of line) board[cell] = seat;
        // Fill one other cell with the opponent so the board looks like a real game.
        const spare = [...Array(9).keys()].find((c) => !line.includes(c));
        board[spare!] = otherSeat(seat);
        expect(status({ board, turn: otherSeat(seat) })).toEqual({
          kind: "won",
          winner: seat,
          line: [...line],
        });
      },
    );
  });

  it("reports the winning line ascending after real play", () => {
    // X: 6, 4, 2 (anti-diagonal played out of order)
    expect(status(play([6, 0, 4, 1, 2]))).toEqual({ kind: "won", winner: "X", line: [2, 4, 6] });
  });

  it("reports a draw on a full board without a line", () => {
    const state = play([0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(state.board.join("")).toBe("XOXXOOOXX");
    expect(status(state)).toEqual({ kind: "draw" });
  });

  it("prefers a win over a draw when the last move fills the board", () => {
    expect(status(boardOf("XOXOXOOXX"))).toMatchObject({ kind: "won", winner: "X" });
  });

  it("alternates turns starting from either seat", () => {
    expect(play([0], "X").turn).toBe("O");
    expect(play([0, 1], "X").turn).toBe("X");
    const fromO = play([4], "O");
    expect(fromO.board[4]).toBe("O");
    expect(fromO.turn).toBe("X");
  });

  it("applyMove does not mutate its input", () => {
    const before = init("X");
    const snapshot = structuredClone(before);
    const after = applyMove(before, "X", { cell: 4 });
    expect(before).toEqual(snapshot);
    expect(after.board).not.toBe(before.board);
    expect(after.board[4]).toBe("X");
  });

  describe("validateMove", () => {
    it("accepts a legal move and returns a clean copy", () => {
      expect(validateMove(init("X"), "X", { cell: 3, extra: true })).toEqual({
        ok: true,
        move: { cell: 3 },
      });
    });

    it.each(SEATS)("rejects any move by %s once the game is won", (seat) => {
      const won = play([0, 3, 1, 4, 2]);
      // GAME_OVER wins over NOT_YOUR_TURN (only O is "to move") and over INVALID_MOVE.
      expect(validateMove(won, seat, { cell: 8 })).toMatchObject({ ok: false, code: "GAME_OVER" });
      expect(validateMove(won, seat, "garbage")).toMatchObject({ ok: false, code: "GAME_OVER" });
    });

    it.each(SEATS)("rejects any move by %s once the game is drawn", (seat) => {
      const drawn = play([0, 1, 2, 4, 3, 5, 7, 6, 8]);
      expect(validateMove(drawn, seat, { cell: 0 })).toMatchObject({ code: "GAME_OVER" });
    });

    it("rejects the wrong seat before looking at the move", () => {
      expect(validateMove(init("X"), "O", "garbage")).toMatchObject({
        ok: false,
        code: "NOT_YOUR_TURN",
      });
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a number", 4],
      ["a string", "4"],
      ["an array", [4]],
      ["missing cell", {}],
      ["string cell", { cell: "4" }],
      ["non-integer", { cell: 1.5 }],
      ["negative", { cell: -1 }],
      ["9", { cell: 9 }],
      ["NaN", { cell: Number.NaN }],
      ["Infinity", { cell: Number.POSITIVE_INFINITY }],
    ])("rejects %s as INVALID_MOVE", (_name, move) => {
      const result = validateMove(init("X"), "X", move);
      expect(result).toMatchObject({ ok: false, code: "INVALID_MOVE" });
      expect(result.ok || result.message).toMatch(/cell from 0 to 8/);
    });

    it("rejects an occupied cell", () => {
      const state = play([4]);
      const result = validateMove(state, "O", { cell: 4 });
      expect(result).toMatchObject({ ok: false, code: "INVALID_MOVE" });
      expect(result.ok || result.message).toMatch(/already taken/);
    });
  });

  it("random legal play always ends consistently within 9 moves", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SEATS),
        fc.array(fc.nat(), { minLength: 9, maxLength: 9 }),
        (first, picks) => {
          let state = init(first);
          let moves = 0;
          let expectedTurn: Seat = first;
          while (status(state).kind === "playing") {
            const current = status(state);
            expect(current).toEqual({ kind: "playing", turn: expectedTurn });
            const free = [...state.board.keys()].filter((c) => state.board[c] === null);
            expect(free.length).toBeGreaterThan(0);
            const cell = free[picks[moves]! % free.length]!;
            const result = validateMove(state, state.turn, { cell });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            // The other seat can never move out of turn.
            expect(validateMove(state, otherSeat(state.turn), { cell }).ok).toBe(false);
            state = applyMove(state, state.turn, result.move);
            expectedTurn = otherSeat(expectedTurn);
            moves += 1;
            expect(moves).toBeLessThanOrEqual(9);
          }

          const final = status(state);
          const lines = (seat: Seat) =>
            WIN_LINES.filter((line) => line.every((c) => state.board[c] === seat));
          const xCount = state.board.filter((c) => c === "X").length;
          const oCount = state.board.filter((c) => c === "O").length;
          expect(xCount + oCount).toBe(moves);
          expect(Math.abs(xCount - oCount)).toBeLessThanOrEqual(1);
          // Never two winners.
          expect(lines("X").length > 0 && lines("O").length > 0).toBe(false);
          if (final.kind === "won") {
            expect(lines(final.winner).length).toBeGreaterThan(0);
            expect(final.line?.every((c) => state.board[c] === final.winner)).toBe(true);
            // The winner made the last move.
            expect(otherSeat(state.turn)).toBe(final.winner);
          } else {
            expect(final.kind).toBe("draw");
            expect(moves).toBe(9);
            expect(lines("X")).toEqual([]);
            expect(lines("O")).toEqual([]);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
