import {
  CLOSE_CODES,
  tictactoe,
  type ErrorCode,
  type GameErrorCode,
  type MoveMsg,
  type PublicState,
  type Role,
  type Seat,
  type ServerMsg,
} from "@site/game-core";

/*
 * Pure state machine behind useGameSocket. GameClient feeds it socket events and runs the side
 * effects (timers, sockets, storage); everything here is deterministic and unit-tested.
 */

/** Delays before each automatic reconnect attempt; after the last one the client gives up. */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;
/** Keepalive interval for the bare "ping" frame (answered by the server without waking it). */
export const PING_INTERVAL_MS = 30_000;
/**
 * A connection must stay joined this long before the reconnect budget resets, so a server that
 * accepts and then drops every connection can't cause an endless fast reconnect loop.
 */
export const STABLE_CONNECTION_MS = 10_000;

/**
 * - connecting: first connection (or a manual reconnect) is being opened.
 * - open: connected and joined (the server answered `joined`).
 * - reconnecting: waiting for or making automatic attempt `attempt`.
 * - failed: gave up; the user can press Reconnect.
 * - replaced: this seat was taken over by another tab (close 4000); no auto-reconnect.
 * - expired: the lobby idled out (close 4001).
 * - notFound: the lobby does not exist (checked before reconnecting).
 * - left: the user left the game.
 */
export type ConnectionStatus =
  "connecting" | "open" | "reconnecting" | "failed" | "replaced" | "expired" | "notFound" | "left";

/** A move shown on the board before the server confirms it. */
export interface PendingMove {
  cell: number;
  seat: Seat;
  /** seq of the snapshot the move was made on. */
  baseSeq: number;
}

/** A user-facing error. `id` changes every time so the same error can be shown twice. */
export interface ClientError {
  code: ErrorCode | "CONNECTION_CLOSED";
  text: string;
  id: number;
}

export interface ClientState {
  connection: ConnectionStatus;
  /**
   * Automatic reconnect attempts since the connection was last stable (1..MAX_RECONNECT_ATTEMPTS
   * while reconnecting).
   */
  attempt: number;
  role: Role | null;
  /** Latest server snapshot. */
  server: { state: PublicState; seq: number } | null;
  pending: PendingMove | null;
  lastError: ClientError | null;
}

export type ClientAction =
  | { type: "message"; msg: ServerMsg }
  | { type: "closed"; code: number }
  | { type: "moveSent"; pending: PendingMove }
  /** A client-detected problem to show, e.g. the lobby looks full while reconnecting. */
  | { type: "error"; code: ClientError["code"] }
  /** The connection has stayed joined for STABLE_CONNECTION_MS. */
  | { type: "stable" }
  | { type: "reconnect" }
  | { type: "notFound" }
  | { type: "left" };

export const initialClientState: ClientState = {
  connection: "connecting",
  attempt: 0,
  role: null,
  server: null,
  pending: null,
  lastError: null,
};

const ERROR_TEXT: Record<ClientError["code"], string> = {
  NOT_YOUR_TURN: "It's not your turn yet.",
  INVALID_MOVE: "That square can't be played.",
  GAME_OVER: "This game is already over.",
  LOBBY_FULL: "This game is full. Try again in a little while.",
  BAD_MESSAGE: "That didn't work. Try again.",
  NOT_JOINED: "Still joining the game. Try again in a moment.",
  NOT_A_PLAYER: "You're watching this game, so you can't make moves.",
  STALE_STATE: "The board changed before your move arrived. Try again.",
  CONNECTION_CLOSED: "The server closed the connection. Press Reconnect to keep playing.",
};

/** Friendly text for a server error code (or a client-side connection error). */
export function errorText(code: ClientError["code"]): string {
  return ERROR_TEXT[code];
}

/** Delay before automatic reconnect attempt `attempt` (1-based), or null when out of attempts. */
export function reconnectDelay(attempt: number): number | null {
  return RECONNECT_DELAYS_MS[attempt - 1] ?? null;
}

/** What a WebSocket close code means for the client. */
export type CloseKind = "replaced" | "expired" | "policy" | "retry";

/** Classifies a close code: 4000/4001 and 1008 must not trigger an automatic reconnect loop. */
export function classifyClose(code: number): CloseKind {
  switch (code) {
    case CLOSE_CODES.seatTakenOver:
      return "replaced";
    case CLOSE_CODES.lobbyExpired:
      return "expired";
    case CLOSE_CODES.policyViolation:
      return "policy";
    default:
      return "retry";
  }
}

function withError(state: ClientState, code: ClientError["code"]): ClientState {
  const id = (state.lastError?.id ?? 0) + 1;
  return { ...state, lastError: { code, text: errorText(code), id } };
}

/** Applies one event. Never mutates `state`. */
export function clientReducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case "message": {
      const { msg } = action;
      if (msg.t === "joined") return { ...state, connection: "open", role: msg.role };
      if (msg.t === "state") {
        // A snapshot at the same seq (e.g. a spectator arrived) doesn't include our move yet.
        const keepPending = state.pending !== null && msg.seq === state.pending.baseSeq;
        return {
          ...state,
          server: { state: msg.state, seq: msg.seq },
          pending: keepPending ? state.pending : null,
        };
      }
      return withError({ ...state, pending: null }, msg.code);
    }

    case "closed": {
      // Whether or not an in-flight move landed, the snapshot after reconnecting is the truth.
      // The role and last snapshot stay so the board remains visible while reconnecting.
      const closed: ClientState = { ...state, pending: null };
      switch (classifyClose(action.code)) {
        case "replaced":
          return { ...closed, connection: "replaced", attempt: 0 };
        case "expired":
          return { ...closed, connection: "expired", attempt: 0 };
        case "policy":
          return withError({ ...closed, connection: "failed", attempt: 0 }, "CONNECTION_CLOSED");
        case "retry": {
          const attempt = state.attempt + 1;
          if (attempt > MAX_RECONNECT_ATTEMPTS)
            return { ...closed, connection: "failed", attempt: 0 };
          return { ...closed, connection: "reconnecting", attempt };
        }
      }
      break;
    }

    case "moveSent":
      return { ...state, pending: action.pending };

    case "error":
      return withError(state, action.code);

    case "stable":
      return state.attempt === 0 ? state : { ...state, attempt: 0 };

    case "reconnect":
      return { ...state, connection: "connecting", attempt: 0, pending: null };

    case "notFound":
      return { ...state, connection: "notFound", attempt: 0, pending: null };

    case "left":
      return { ...state, connection: "left", pending: null };
  }
  return state;
}

/** The snapshot to render: the server state with any pending move applied on top. */
export function viewState(state: ClientState): PublicState | null {
  const { server, pending } = state;
  if (!server) return null;
  if (!pending) return server.state;
  const board = tictactoe.applyMove(server.state.board, pending.seat, { cell: pending.cell });
  return { ...server.state, board, result: tictactoe.status(board) };
}

export type MovePlan =
  | { ok: true; pending: PendingMove; msg: MoveMsg }
  | { ok: false; code: GameErrorCode | "NOT_A_PLAYER" | "NOT_JOINED" };

/** Checks a move locally (game-core rules) before sending it optimistically. */
export function planMove(state: ClientState, cell: number): MovePlan {
  const { server, role } = state;
  if (state.connection !== "open" || !server || role === null)
    return { ok: false, code: "NOT_JOINED" };
  if (role === "spectator") return { ok: false, code: "NOT_A_PLAYER" };
  if (server.state.phase === "finished") return { ok: false, code: "GAME_OVER" };
  if (server.state.phase !== "playing" || state.pending)
    return { ok: false, code: "NOT_YOUR_TURN" };
  const result = tictactoe.validateMove(server.state.board, role, { cell });
  if (!result.ok) return { ok: false, code: result.code };
  return {
    ok: true,
    pending: { cell: result.move.cell, seat: role, baseSeq: server.seq },
    msg: { t: "move", move: result.move, seq: server.seq },
  };
}

/** "1:42" for a duration in ms, rounded up to whole seconds and clamped at zero. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
