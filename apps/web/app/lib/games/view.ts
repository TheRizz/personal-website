import { otherSeat, type PublicState, type Role, type Seat } from "@site/game-core";

/** A player's display name, or "Player X" while the seat is empty. */
export function playerName(state: PublicState, seat: Seat): string {
  return state.players[seat]?.name ?? `Player ${seat}`;
}

/** The other player's seat from `role`'s point of view, or null for spectators. */
export function opponentOf(role: Role | null): Seat | null {
  return role === "X" || role === "O" ? otherSeat(role) : null;
}

export type Outcome = "win" | "lose" | "draw" | "other-win";

/** The headline above the board: whose turn it is, or how the round ended. */
export function statusHeadline(
  state: PublicState,
  role: Role | null,
): { text: string; outcome: Outcome | null; yourMove: boolean } {
  const { result } = state;
  if (state.phase === "waiting") {
    return { text: "Waiting for an opponent…", outcome: null, yourMove: false };
  }
  if (result.kind === "draw") return { text: "Draw", outcome: "draw", yourMove: false };
  if (result.kind === "won") {
    if (role === result.winner) return { text: "You win", outcome: "win", yourMove: false };
    if (role === otherSeat(result.winner)) {
      return { text: "You lose", outcome: "lose", yourMove: false };
    }
    return {
      text: `${playerName(state, result.winner)} wins`,
      outcome: "other-win",
      yourMove: false,
    };
  }
  if (role === result.turn) return { text: "Your move", outcome: null, yourMove: true };
  const mover = playerName(state, result.turn);
  if (role === "spectator") return { text: `${mover}'s move`, outcome: null, yourMove: false };
  return { text: `Waiting for ${mover}`, outcome: null, yourMove: false };
}

/** Accessible name for a board cell, e.g. "Row 1, column 2, empty". */
export function cellLabel(index: number, value: Seat | null): string {
  const row = Math.floor(index / 3) + 1;
  const column = (index % 3) + 1;
  return `Row ${row}, column ${column}, ${value ?? "empty"}`;
}
