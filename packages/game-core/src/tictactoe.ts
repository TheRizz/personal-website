import { otherSeat, type GameDefinition, type GameStatus, type Seat } from "./game";

export type TicTacToeCell = Seat | null;

export interface TicTacToeState {
  /** 9 cells, row-major: index = row * 3 + column. */
  board: TicTacToeCell[];
  /** Whose move it is (meaningless once the game is over). */
  turn: Seat;
}

export interface TicTacToeMove {
  /** Integer 0..8. */
  cell: number;
}

/** The 8 winning lines, each ascending. */
export const WIN_LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function status(state: TicTacToeState): GameStatus {
  const { board } = state;
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    const owner = board[a];
    if (owner && owner === board[b] && owner === board[c]) {
      return { kind: "won", winner: owner, line: [...line] };
    }
  }
  if (board.every((cell) => cell !== null)) return { kind: "draw" };
  return { kind: "playing", turn: state.turn };
}

/** Classic 3x3 tic-tac-toe. */
export const tictactoe: GameDefinition<TicTacToeState, TicTacToeMove> = {
  id: "tictactoe",
  name: "Tic-tac-toe",
  players: 2,

  init(firstSeat) {
    return { board: Array<TicTacToeCell>(9).fill(null), turn: firstSeat };
  },

  validateMove(state, seat, move) {
    if (status(state).kind !== "playing") {
      return { ok: false, code: "GAME_OVER", message: "The game is over." };
    }
    if (seat !== state.turn) {
      return { ok: false, code: "NOT_YOUR_TURN", message: "It is not your turn." };
    }
    const cell =
      typeof move === "object" && move !== null ? (move as { cell?: unknown }).cell : undefined;
    if (typeof cell !== "number" || !Number.isInteger(cell) || cell < 0 || cell > 8) {
      return { ok: false, code: "INVALID_MOVE", message: "A move must pick a cell from 0 to 8." };
    }
    if (state.board[cell] !== null) {
      return { ok: false, code: "INVALID_MOVE", message: "That cell is already taken." };
    }
    return { ok: true, move: { cell } };
  },

  applyMove(state, seat, move) {
    const board = state.board.slice();
    board[move.cell] = seat;
    return { board, turn: otherSeat(seat) };
  },

  status,
};
