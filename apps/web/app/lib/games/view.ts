import {
  isSeat,
  otherSeat,
  RECONNECT_GRACE_MS,
  SEATS,
  type PublicState,
  type Role,
  type Seat,
} from "@site/game-core";

/** A player's display name, or "Player X" while the seat is empty. */
export function playerName(state: PublicState, seat: Seat): string {
  return state.players[seat]?.name ?? `Player ${seat}`;
}

/** The other player's seat from `role`'s point of view, or null for spectators. */
export function opponentOf(role: Role | null): Seat | null {
  return isSeat(role) ? otherSeat(role) : null;
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

/** "row 1", "column 3" or "diagonal" for a winning line of cell indexes. */
function lineName(line: number[]): string {
  const rows = new Set(line.map((cell) => Math.floor(cell / 3)));
  const columns = new Set(line.map((cell) => cell % 3));
  if (rows.size === 1) return `row ${[...rows][0]! + 1}`;
  if (columns.size === 1) return `column ${[...columns][0]! + 1}`;
  return "diagonal";
}

const sentence = (text: string) => (/[.…!?]$/.test(text) ? text : `${text}.`);

/**
 * What a screen reader should hear when the lobby changes from `prev` to `next` (null: the first
 * snapshot), or null for nothing. Covers what the screen only shows visually: the game starting
 * (including joining one that already has two players), where the other player moved, how a round
 * ended, rematch requests and players dropping out or coming back.
 */
export function announcement(
  prev: PublicState | null,
  next: PublicState,
  role: Role | null,
): string | null {
  const opponent = opponentOf(role);
  const headline = sentence(statusHeadline(next, role).text);
  if (!prev) {
    if (next.phase !== "playing" || role === null) return null;
    return opponent
      ? `You are ${role}. ${headline}`
      : `${playerName(next, "X")} and ${playerName(next, "O")} are playing. ${headline}`;
  }
  const parts: string[] = [];

  for (const seat of opponent ? [opponent] : SEATS) {
    const before = prev.players[seat];
    const after = next.players[seat];
    if (before?.connected && after && !after.connected) {
      const minutes = RECONNECT_GRACE_MS / 60_000;
      parts.push(`${after.name} disconnected. Their seat is held for ${minutes} minutes.`);
    } else if (before && !before.connected && after?.connected) {
      parts.push(`${after.name} is back.`);
    }
  }

  if (prev.phase === "waiting" && next.phase !== "waiting") {
    const intro = opponent
      ? `${playerName(next, opponent)} joined. You are ${role}.`
      : `${playerName(next, "X")} and ${playerName(next, "O")} are playing.`;
    parts.push(`${intro} ${headline}`);
  } else if (next.phase === "waiting" && prev.phase !== "waiting") {
    for (const seat of SEATS) {
      const gone = prev.players[seat];
      if (gone && !next.players[seat] && seat !== role) parts.push(`${gone.name} left.`);
    }
    parts.push(headline);
  } else if (next.round !== prev.round) {
    parts.push(`Round ${next.round}. ${headline}`);
  } else {
    const cell = next.board.board.findIndex((v, i) => v !== null && prev.board.board[i] === null);
    const mover = next.board.board[cell];
    if (mover) {
      const where = cellLabel(cell, null)
        .replace(/, empty$/, "")
        .toLowerCase();
      const moved = mover === role ? "" : `${playerName(next, mover)} played ${where}. `;
      const line = next.result.kind === "won" && next.result.line;
      parts.push(line ? `${moved}${headline.slice(0, -1)}: ${lineName(line)}.` : moved + headline);
    }
    const asked = opponent && next.rematch[opponent] && !prev.rematch[opponent];
    if (asked && isSeat(role) && !next.rematch[role]) {
      parts.push(`${playerName(next, opponent)} wants a rematch.`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
