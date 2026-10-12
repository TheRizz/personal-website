/** A player seat. X and O are generic seat names shared by every two-player game. */
export type Seat = "X" | "O";

export const SEATS = ["X", "O"] as const satisfies readonly Seat[];

/** Narrows a role (or anything else) to a player seat. */
export const isSeat = (value: unknown): value is Seat =>
  (SEATS as readonly unknown[]).includes(value);

/** The opposing seat. */
export const otherSeat = (seat: Seat): Seat => (seat === "X" ? "O" : "X");

export type GameStatus =
  | { kind: "playing"; turn: Seat }
  | { kind: "won"; winner: Seat; line?: number[] }
  | { kind: "draw" };

export type GameErrorCode = "NOT_YOUR_TURN" | "INVALID_MOVE" | "GAME_OVER";

/** Result of validating an untrusted move: the parsed move, or why it was rejected. */
export type MoveResult<M> =
  { ok: true; move: M } | { ok: false; code: GameErrorCode; message: string };

/** Everything the lobby needs to host a two-player, turn-based game. All functions are pure. */
export interface GameDefinition<S, M> {
  id: string;
  name: string;
  players: 2;
  /** A fresh game where `firstSeat` moves first (rematches alternate who starts). */
  init(firstSeat: Seat): S;
  /** Parses the move's shape and checks it is legal for `seat` right now. */
  validateMove(state: S, seat: Seat, move: unknown): MoveResult<M>;
  /** Applies a move that passed validateMove. Returns a new state; never mutates `state`. */
  applyMove(state: S, seat: Seat, move: M): S;
  status(state: S): GameStatus;
}
