import {
  CLOSE_CODES,
  LOBBY_IDLE_TTL_MS,
  MAX_SPECTATORS_PER_LOBBY,
  RECONNECT_GRACE_MS,
} from "./constants";
import { otherSeat, SEATS, type Seat } from "./game";
import { GAMES, type GameId } from "./games";
import {
  parseClientMessage,
  type ClientMsg,
  type ErrorCode,
  type JoinMsg,
  type MoveMsg,
  type PublicPlayer,
  type PublicState,
  type Role,
  type ServerMsg,
} from "./protocol";
import type { TicTacToeState } from "./tictactoe";

/*
 * Pure state machine for one lobby. The Durable Object is a thin shell around it:
 *
 *   1. Persist a LobbyRecord (plain JSON) and give every socket an attachment `Connection`
 *      ({ connId, role }), with role null until the socket joins. Accepting with the connId as a
 *      tag lets effects find their socket with ctx.getWebSockets(connId), also after hibernation.
 *   2. Feed events in: handleText / handleMessage for frames, handleClose when a socket goes away,
 *      handleAlarm from alarm(), touch() on upgrade.
 *   3. Persist `result.lobby`, then run `result.effects` in order, then setAlarm(nextAlarmAt(lobby))
 *      (unless an "expire" effect deleted the lobby).
 */

export type LobbyPhase = "waiting" | "playing" | "finished";

/** A held seat. While the player is disconnected `connId` is null and `releaseAt` is set. */
export interface SeatRecord {
  name: string;
  /** Secret that reclaims this seat; replaced on every seated join. Never sent to other sockets. */
  token: string;
  /** The connection currently bound to this seat, or null while disconnected. */
  connId: string | null;
  /** Epoch ms at which the seat is released if the player has not reconnected. */
  releaseAt: number | null;
}

/** Everything the Durable Object persists for a lobby. JSON-serialisable. */
export interface LobbyRecord {
  version: 1;
  code: string;
  game: GameId;
  createdAt: number;
  /** Last client message, join or connect. Drives idle expiry. */
  lastActivityAt: number;
  /** Version of this record; +1 on every change that is broadcast (see LobbyResult). */
  seq: number;
  phase: LobbyPhase;
  seats: Record<Seat, SeatRecord | null>;
  round: number;
  firstSeat: Seat;
  score: { X: number; O: number; draws: number };
  rematch: Record<Seat, boolean>;
  board: TicTacToeState;
}

/** What the Durable Object keeps per socket (in its serialized attachment). */
export interface Connection {
  /** Unique per socket, e.g. crypto.randomUUID() at upgrade time. */
  connId: string;
  /** null until the socket has joined. */
  role: Role | null;
}

/** Injected clock and randomness, so handlers stay deterministic under test. */
export interface LobbyContext {
  /** Epoch ms. */
  now: number;
  /** Seat token generator. Defaults to crypto.randomUUID. */
  newToken?: () => string;
  /** Live spectator sockets, for the MAX_SPECTATORS_PER_LOBBY cap on join. Defaults to 0. */
  spectators?: number;
}

/**
 * Side effects for the Durable Object to execute, in order. A connId whose socket is gone is
 * skipped.
 * - send: send `msg` as JSON to that socket.
 * - setRole: store the role in that socket's attachment (null = not joined / going away; such
 *   sockets receive no broadcasts and are not counted as spectators). Every effect that removes a
 *   joined socket (close, leave, takeover, handleClose) is preceded by setRole null for it.
 * - close: close that socket with `code` / `reason` (reasons stay under the 123-byte limit). The
 *   lobby has already accounted for it, so a later handleClose for it is a no-op.
 * - broadcastState: send stateMessage(lobby, spectators) to every socket whose role is not null,
 *   counting spectators from the live attachments after applying earlier setRole effects.
 * - expire: close every socket with CLOSE_CODES.lobbyExpired "Lobby expired", delete all storage
 *   and do not set another alarm.
 */
export type LobbyEffect =
  | { type: "send"; connId: string; msg: ServerMsg }
  | { type: "setRole"; connId: string; role: Role | null }
  | { type: "close"; connId: string; code: number; reason: string }
  | { type: "broadcastState" }
  | { type: "expire" };

/**
 * New record plus effects. `lobby === input` means nothing changed (no need to persist).
 * Invariant: seq increments exactly when the record's public state changed, and such a result
 * always ends with one broadcastState. A spectator arriving or leaving also broadcasts (the count
 * changed) but keeps seq, so spectators can't make a player's in-flight move STALE_STATE.
 */
export interface LobbyResult {
  lobby: LobbyRecord;
  effects: LobbyEffect[];
}

/** Response body of GET /api/lobbies/:code. */
export interface LobbySummary {
  code: string;
  game: GameId;
  phase: LobbyPhase;
  /** Seats with a player, including seats held for a disconnected player. */
  seatsTaken: number;
  /** Seats whose player is connected right now (each has a live socket). */
  connectedSeats: number;
  spectators: number;
}

const emptyScore = () => ({ X: 0, O: 0, draws: 0 });

/** A fresh lobby: phase waiting, round 1, X starts. */
export function createLobby({
  code,
  game,
  now,
}: {
  code: string;
  game: GameId;
  now: number;
}): LobbyRecord {
  return {
    version: 1,
    code,
    game,
    createdAt: now,
    lastActivityAt: now,
    seq: 0,
    phase: "waiting",
    seats: { X: null, O: null },
    round: 1,
    firstSeat: "X",
    score: emptyScore(),
    rematch: { X: false, O: false },
    board: GAMES[game].init("X"),
  };
}

/** Records activity (e.g. a WebSocket upgrade) so the lobby does not idle out. */
export function touch(lobby: LobbyRecord, now: number): LobbyRecord {
  return { ...lobby, lastActivityAt: now };
}

/** When the lobby expires if nothing else happens. */
export function lobbyExpiresAt(lobby: LobbyRecord): number {
  return lobby.lastActivityAt + LOBBY_IDLE_TTL_MS;
}

/** When alarm() must next run: the earliest seat release or the idle expiry. */
export function nextAlarmAt(lobby: LobbyRecord): number {
  let at = lobbyExpiresAt(lobby);
  for (const seat of SEATS) {
    const releaseAt = lobby.seats[seat]?.releaseAt;
    if (releaseAt != null && releaseAt < at) at = releaseAt;
  }
  return at;
}

function publicPlayer(seat: SeatRecord | null): PublicPlayer | null {
  return seat && { name: seat.name, connected: seat.connId !== null, releaseAt: seat.releaseAt };
}

/** The snapshot sent to clients. Never includes tokens or connection ids. */
export function publicState(lobby: LobbyRecord, spectators: number): PublicState {
  return {
    code: lobby.code,
    game: lobby.game,
    phase: lobby.phase,
    players: { X: publicPlayer(lobby.seats.X), O: publicPlayer(lobby.seats.O) },
    spectators,
    board: { board: [...lobby.board.board], turn: lobby.board.turn },
    result: GAMES[lobby.game].status(lobby.board),
    round: lobby.round,
    firstSeat: lobby.firstSeat,
    score: { ...lobby.score },
    rematch: { ...lobby.rematch },
  };
}

/** The `state` message for a broadcastState effect. */
export function stateMessage(
  lobby: LobbyRecord,
  spectators: number,
): Extract<ServerMsg, { t: "state" }> {
  return { t: "state", state: publicState(lobby, spectators), seq: lobby.seq };
}

/** For GET /api/lobbies/:code. */
export function lobbySummary(lobby: LobbyRecord, spectators: number): LobbySummary {
  return {
    code: lobby.code,
    game: lobby.game,
    phase: lobby.phase,
    seatsTaken: SEATS.filter((seat) => lobby.seats[seat] !== null).length,
    connectedSeats: SEATS.filter((seat) => lobby.seats[seat]?.connId != null).length,
    spectators,
  };
}

/** A mutable working copy for one handler call. */
interface Tx {
  lobby: LobbyRecord;
  effects: LobbyEffect[];
  /** Public state changed: bump seq and broadcast. */
  changed: boolean;
  /** Only the spectator count changed: broadcast without bumping seq. */
  spectatorsChanged: boolean;
}

function begin(lobby: LobbyRecord): Tx {
  return {
    lobby: structuredClone(lobby),
    effects: [],
    changed: false,
    spectatorsChanged: false,
  };
}

function commit(tx: Tx): LobbyResult {
  if (tx.changed) tx.lobby.seq += 1;
  if (tx.changed || tx.spectatorsChanged) tx.effects.push({ type: "broadcastState" });
  return { lobby: tx.lobby, effects: tx.effects };
}

function sendError(tx: Tx, connId: string, code: ErrorCode, message: string): void {
  tx.effects.push({ type: "send", connId, msg: { t: "error", code, message } });
}

/** Back to a fresh match for whoever is seated: new opponent, new match. */
function resetMatch(lobby: LobbyRecord): void {
  lobby.phase = "waiting";
  lobby.round = 1;
  lobby.firstSeat = "X";
  lobby.score = emptyScore();
  lobby.rematch = { X: false, O: false };
  lobby.board = GAMES[lobby.game].init("X");
}

function releaseSeat(tx: Tx, seat: Seat): void {
  tx.lobby.seats[seat] = null;
  resetMatch(tx.lobby);
  tx.changed = true;
}

/** True when `conn` claims a seat that is no longer bound to it. */
function holdsStaleSeat(lobby: LobbyRecord, conn: Connection): boolean {
  return (
    conn.role !== null &&
    conn.role !== "spectator" &&
    lobby.seats[conn.role]?.connId !== conn.connId
  );
}

/** Marks the socket as gone: a seated player starts the grace period, a spectator stops counting. */
function dropConnection(tx: Tx, conn: Connection, now: number): void {
  if (conn.role === "spectator") {
    tx.spectatorsChanged = true;
    return;
  }
  const seat = conn.role && tx.lobby.seats[conn.role];
  if (!seat || seat.connId !== conn.connId) return;
  seat.connId = null;
  seat.releaseAt = now + RECONNECT_GRACE_MS;
  tx.changed = true;
}

function join(tx: Tx, conn: Connection, msg: JoinMsg, ctx: LobbyContext): void {
  const { lobby } = tx;
  const reclaimed =
    msg.token === undefined ? undefined : SEATS.find((s) => lobby.seats[s]?.token === msg.token);
  const seat = reclaimed ?? SEATS.find((s) => lobby.seats[s] === null);

  if (seat === undefined) {
    // Seat claims and token reconnects are never refused; only extra spectators are.
    if ((ctx.spectators ?? 0) >= MAX_SPECTATORS_PER_LOBBY) {
      sendError(tx, conn.connId, "LOBBY_FULL", "This lobby is full.");
      tx.effects.push({
        type: "close",
        connId: conn.connId,
        code: CLOSE_CODES.lobbyFull,
        reason: "Lobby full",
      });
      return;
    }
    tx.effects.push(
      { type: "setRole", connId: conn.connId, role: "spectator" },
      { type: "send", connId: conn.connId, msg: { t: "joined", role: "spectator", token: null } },
    );
    tx.spectatorsChanged = true;
    return;
  }

  const previous = lobby.seats[seat]?.connId;
  if (previous) {
    tx.effects.push(
      { type: "setRole", connId: previous, role: null },
      {
        type: "close",
        connId: previous,
        code: CLOSE_CODES.seatTakenOver,
        reason: "Seat taken over",
      },
    );
  }
  const token = (ctx.newToken ?? (() => crypto.randomUUID()))();
  lobby.seats[seat] = { name: msg.name, token, connId: conn.connId, releaseAt: null };
  tx.effects.push(
    { type: "setRole", connId: conn.connId, role: seat },
    { type: "send", connId: conn.connId, msg: { t: "joined", role: seat, token } },
  );
  if (lobby.phase === "waiting" && lobby.seats.X && lobby.seats.O) {
    lobby.phase = "playing";
    lobby.board = GAMES[lobby.game].init(lobby.firstSeat);
  }
  tx.changed = true;
}

function move(tx: Tx, conn: Connection, seat: Seat, msg: MoveMsg): void {
  const { lobby } = tx;
  if (msg.seq !== lobby.seq) {
    sendError(tx, conn.connId, "STALE_STATE", "The game changed; try again on the new board.");
    return;
  }
  if (lobby.phase === "waiting") {
    sendError(tx, conn.connId, "NOT_YOUR_TURN", "Waiting for an opponent to join.");
    return;
  }
  const game = GAMES[lobby.game];
  const result = game.validateMove(lobby.board, seat, msg.move);
  if (!result.ok) {
    sendError(tx, conn.connId, result.code, result.message);
    return;
  }
  lobby.board = game.applyMove(lobby.board, seat, result.move);
  const status = game.status(lobby.board);
  if (status.kind === "won") lobby.score[status.winner] += 1;
  if (status.kind === "draw") lobby.score.draws += 1;
  if (status.kind !== "playing") lobby.phase = "finished";
  tx.changed = true;
}

function rematch(tx: Tx, conn: Connection, seat: Seat): void {
  const { lobby } = tx;
  if (lobby.phase !== "finished") {
    sendError(tx, conn.connId, "BAD_MESSAGE", "A rematch is only possible after the game ends.");
    return;
  }
  if (lobby.rematch[seat]) return;
  lobby.rematch[seat] = true;
  if (lobby.rematch[otherSeat(seat)]) {
    lobby.round += 1;
    lobby.firstSeat = otherSeat(lobby.firstSeat);
    lobby.board = GAMES[lobby.game].init(lobby.firstSeat);
    lobby.phase = "playing";
    lobby.rematch = { X: false, O: false };
  }
  tx.changed = true;
}

function leave(tx: Tx, conn: Connection, role: Role): void {
  tx.effects.push(
    { type: "setRole", connId: conn.connId, role: null },
    { type: "close", connId: conn.connId, code: CLOSE_CODES.normal, reason: "Left the lobby" },
  );
  if (role === "spectator") tx.spectatorsChanged = true;
  else releaseSeat(tx, role);
}

/**
 * Handles a parsed client message from `conn`. Every message counts as activity.
 *
 * A join that would add a spectator past MAX_SPECTATORS_PER_LOBBY (ctx.spectators) gets LOBBY_FULL
 * and the socket is closed with CLOSE_CODES.lobbyFull.
 *
 * Other errors are sent only to `conn` and leave the socket open: NOT_JOINED (anything before join),
 * BAD_MESSAGE (second join, rematch outside a finished game or from a spectator),
 * NOT_A_PLAYER (spectator move), STALE_STATE (move.seq !== lobby.seq), NOT_YOUR_TURN
 * (also while waiting for an opponent), INVALID_MOVE, GAME_OVER.
 */
export function handleMessage(
  lobby: LobbyRecord,
  conn: Connection,
  msg: ClientMsg,
  ctx: LobbyContext,
): LobbyResult {
  const tx = begin(lobby);
  tx.lobby.lastActivityAt = ctx.now;

  // Defensive: a socket whose seat was taken over or released is treated as not joined.
  let role = conn.role;
  if (holdsStaleSeat(tx.lobby, conn)) {
    tx.effects.push({ type: "setRole", connId: conn.connId, role: null });
    role = null;
  }

  if (msg.t === "join") {
    if (role !== null) sendError(tx, conn.connId, "BAD_MESSAGE", "Already joined.");
    else join(tx, conn, msg, ctx);
    return commit(tx);
  }
  if (role === null) {
    sendError(tx, conn.connId, "NOT_JOINED", "Join the lobby first.");
    return commit(tx);
  }
  switch (msg.t) {
    case "move":
      if (role === "spectator") {
        sendError(tx, conn.connId, "NOT_A_PLAYER", "Spectators cannot move.");
      } else {
        move(tx, conn, role, msg);
      }
      break;
    case "rematch":
      if (role === "spectator") {
        sendError(tx, conn.connId, "BAD_MESSAGE", "Spectators cannot ask for a rematch.");
      } else {
        rematch(tx, conn, role);
      }
      break;
    case "leave":
      leave(tx, conn, role);
      break;
  }
  return commit(tx);
}

/**
 * Closes `conn` from the server side (e.g. the DO's rate limiter) and accounts for it as a
 * disconnect: a seated player gets the reconnect grace period.
 */
export function closeConnection(
  lobby: LobbyRecord,
  conn: Connection,
  code: number,
  reason: string,
  ctx: LobbyContext,
): LobbyResult {
  const tx = begin(lobby);
  if (conn.role !== null) tx.effects.push({ type: "setRole", connId: conn.connId, role: null });
  tx.effects.push({ type: "close", connId: conn.connId, code, reason });
  dropConnection(tx, conn, ctx.now);
  return commit(tx);
}

/** Close reasons sent for frames that fail parseClientMessage; each well under 123 UTF-8 bytes. */
const PARSE_CLOSE_REASONS = {
  too_large: "Message too large.",
  bad_json: "Message is not valid JSON.",
  unknown_type: "Unknown message type.",
  invalid: "Invalid message.",
} as const;

/**
 * Handles one raw text frame: a frame that is oversized, not JSON, of an unknown type or fails the
 * schema closes the socket with 1008 (via closeConnection); anything else goes to handleMessage.
 * Binary frames should go to closeConnection(…, CLOSE_CODES.policyViolation, …) directly.
 */
export function handleText(
  lobby: LobbyRecord,
  conn: Connection,
  text: string,
  ctx: LobbyContext,
): LobbyResult {
  const parsed = parseClientMessage(text);
  if (parsed.ok) return handleMessage(lobby, conn, parsed.msg, ctx);
  const reason = PARSE_CLOSE_REASONS[parsed.reason];
  return closeConnection(lobby, conn, CLOSE_CODES.policyViolation, reason, ctx);
}

/**
 * A socket closed or errored (webSocketClose / webSocketError). A seated player keeps the seat
 * for RECONNECT_GRACE_MS; a spectator just stops counting. Starts with setRole null for `conn`, so
 * the closing socket (still listed by getWebSockets) gets no broadcast and is not counted.
 * Idempotent: once that setRole is applied, a repeat call (error then close) returns no effects.
 */
export function handleClose(lobby: LobbyRecord, conn: Connection, ctx: LobbyContext): LobbyResult {
  if (conn.role === null) return { lobby, effects: [] };
  const setRole: LobbyEffect = { type: "setRole", connId: conn.connId, role: null };
  // A socket whose seat was already taken over or released: nothing in the lobby changes.
  if (holdsStaleSeat(lobby, conn)) return { lobby, effects: [setRole] };
  const tx = begin(lobby);
  tx.effects.push(setRole);
  dropConnection(tx, conn, ctx.now);
  return commit(tx);
}

/**
 * alarm(): expires an idle lobby (single "expire" effect), otherwise releases every seat whose
 * grace period is over. Releasing a seat resets the match for whoever is left.
 */
export function handleAlarm(lobby: LobbyRecord, ctx: LobbyContext): LobbyResult {
  if (ctx.now >= lobbyExpiresAt(lobby)) return { lobby, effects: [{ type: "expire" }] };
  const due = SEATS.filter((seat) => {
    const releaseAt = lobby.seats[seat]?.releaseAt;
    return releaseAt != null && releaseAt <= ctx.now;
  });
  if (due.length === 0) return { lobby, effects: [] };
  const tx = begin(lobby);
  for (const seat of due) releaseSeat(tx, seat);
  return commit(tx);
}
