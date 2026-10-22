import { displayNameSchema } from "@site/game-core";
import { CHARACTERS } from "./characters";
import type { CourtId, Input, Match, Side } from "./engine";
import { COURTS, TARGETS } from "./setup";

// Online play, 1v1. One Durable Object per room (worker/volley-room.ts) runs the match at the
// engine's fixed step and is the only judge of what happened. Each player's page runs the same
// engine a little ahead of the room, from the room's latest snapshot plus the inputs it knows
// about, so its own player moves the moment a button is pressed (lib/games/volley/online.ts).
// Messages are JSON text frames.

/** A player's seat: 0 plays on the left, 1 on the right. */
export type Seat = Side;

export const SEATS = [0, 1] as const satisfies readonly Seat[];

/** How long a disconnected player's seat is held, and the match paused, for them. */
export const ROOM_GRACE_MS = 2 * 60_000;
/** A room is deleted after this long without a message from anyone. */
export const ROOM_IDLE_TTL_MS = 30 * 60_000;
/** A match nobody touches the controls in is paused after this long. */
export const MATCH_IDLE_MS = 2 * 60_000;
/** The 3, 2, 1 before a match starts or resumes. */
export const COUNTDOWN_MS = 3_000;
/** Snapshots per second while a match runs. */
export const SNAPSHOT_HZ = 30;
/** Joined spectators per room. */
export const MAX_SPECTATORS = 8;
/** Per socket; going over closes the socket with 1008. Inputs are sent at most once a frame. */
export const MAX_ROOM_MESSAGES_PER_SECOND = 90;
export const MAX_ROOM_MESSAGE_BYTES = 512;
/** An input may be stamped at most this many frames ahead of the room (5 s). */
export const MAX_INPUT_LEAD = 600;

/** The buttons as three bits, the way they travel: left 1, right 2, jump 4. */
export const encodeInput = (input: Input) =>
  (input.left ? 1 : 0) | (input.right ? 2 : 0) | (input.jump ? 4 : 0);

export const decodeInput = (bits: number): Input => ({
  left: (bits & 1) !== 0,
  right: (bits & 2) !== 0,
  jump: (bits & 4) !== 0,
});

/**
 * lobby: seats filling up and players picking; the match starts once both are ready.
 * countdown, playing: the match. paused: a player dropped out, or nobody moved for a while.
 * over: someone won; both ask for a rematch to play again.
 */
export type RoomPhase = "lobby" | "countdown" | "playing" | "paused" | "over";

export interface RoomPlayer {
  name: string;
  character: string;
  connected: boolean;
  /** Epoch ms when a disconnected player's seat is given up; null while connected. */
  releaseAt: number | null;
  /** Ready to start (in the lobby) or asked for a rematch (after a match). */
  ready: boolean;
}

/** The room as every socket sees it. Sent whenever it changes. */
export interface RoomView {
  code: string;
  court: CourtId;
  target: number;
  players: [RoomPlayer | null, RoomPlayer | null];
  spectators: number;
  phase: RoomPhase;
  /** countdown only: milliseconds left when the message was sent. */
  startsIn: number | null;
  pausedFor: "disconnect" | "idle" | null;
  winner: Seat | null;
  /** Matches won in this room by each seat. */
  wins: [number, number];
}

export type ClientMessage =
  | { t: "join"; name: string; character: string; token?: string }
  /** The buttons held from frame `f` on. */
  | { t: "input"; f: number; i: number }
  /** For the round trip time; `c` comes back in the pong. */
  | { t: "ping"; c: number }
  | { t: "pick"; character: string }
  | { t: "ready" }
  | { t: "leave" };

export type ServerMessage =
  | { t: "joined"; seat: Seat | null; token: string | null }
  | { t: "room"; room: RoomView }
  /**
   * The match after `f` steps, the buttons each seat holds at that point, and `e`, which changes
   * whenever the room's clock restarts (a new match or a resume). `slack`: how many frames early
   * this socket's inputs arrived since the last snapshot (negative: late), or null if none came.
   */
  | { t: "snap"; f: number; e: number; m: Match; i: [number, number]; slack: number | null }
  /** Another seat's buttons, from frame `f` on (the frame the room applies them at). */
  | { t: "in"; s: Seat; f: number; i: number }
  | { t: "pong"; c: number }
  | { t: "error"; message: string };

/** Body of POST /api/volley. */
export interface CreateRoomRequest {
  court: CourtId;
  target: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFrame = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const isCharacterId = (value: unknown): value is string =>
  CHARACTERS.some((character) => character.id === value);

const hasOnlyKeys = (data: Record<string, unknown>, keys: string[]) =>
  Object.keys(data).every((key) => keys.includes(key));

/** Parses one client frame; null for anything malformed, too large or unknown. */
export function parseClientMessage(text: string): ClientMessage | null {
  if (text.length > MAX_ROOM_MESSAGE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  switch (data.t) {
    case "join": {
      if (!hasOnlyKeys(data, ["t", "name", "character", "token"])) return null;
      const name = displayNameSchema.safeParse(data.name);
      if (!name.success || !isCharacterId(data.character)) return null;
      if (data.token !== undefined && typeof data.token !== "string") return null;
      if (typeof data.token === "string" && data.token.length > 64) return null;
      const message: ClientMessage = { t: "join", name: name.data, character: data.character };
      return typeof data.token === "string" ? { ...message, token: data.token } : message;
    }
    case "input":
      if (!hasOnlyKeys(data, ["t", "f", "i"]) || !isFrame(data.f)) return null;
      if (typeof data.i !== "number" || !Number.isInteger(data.i) || data.i < 0 || data.i > 7) {
        return null;
      }
      return { t: "input", f: data.f, i: data.i };
    case "ping":
      if (!hasOnlyKeys(data, ["t", "c"]) || typeof data.c !== "number") return null;
      return Number.isFinite(data.c) ? { t: "ping", c: data.c } : null;
    case "pick":
      if (!hasOnlyKeys(data, ["t", "character"]) || !isCharacterId(data.character)) return null;
      return { t: "pick", character: data.character };
    case "ready":
    case "leave":
      return hasOnlyKeys(data, ["t"]) ? { t: data.t } : null;
    default:
      return null;
  }
}

/** Checks the body of POST /api/volley. */
export function parseCreateRoom(body: unknown): CreateRoomRequest | null {
  if (!isObject(body) || !hasOnlyKeys(body, ["court", "target"])) return null;
  const court = COURTS.find((entry) => entry.id === body.court)?.id;
  const target = TARGETS.find((entry) => entry === body.target);
  return court && target ? { court, target } : null;
}

/**
 * Parses one server frame. The room is trusted, so this only checks the message type: a page
 * that is older than the room it talks to ignores what it doesn't know.
 */
export function parseServerMessage(text: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  const known = ["joined", "room", "snap", "in", "pong", "error"];
  return known.includes(data.t as string) ? (data as ServerMessage) : null;
}
