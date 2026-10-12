import { z } from "zod";
import { MAX_MESSAGE_BYTES, MAX_NAME_LENGTH } from "./constants";
import { GAME_IDS, type GameId } from "./games";
import type { GameStatus } from "./game";

// C0/C1 controls, line/paragraph separators and bidi marks/embeddings/overrides/isolates: they
// break layout or can disguise a name. Zero-width joiners stay allowed because emoji need them.
const FORBIDDEN_NAME_CHARS = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
// A character that draws something: not a format char, space, combining mark/variation selector,
// or one of the Hangul/Braille fillers that render blank.
const VISIBLE_NAME_CHAR = /[^\p{Cf}\p{Z}\p{M}\u115F\u1160\u2800\u3164\uFFA0]/u;

/** A display name: trimmed, 1..MAX_NAME_LENGTH UTF-16 units (matches an input's maxLength). */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(MAX_NAME_LENGTH, `Name must be at most ${MAX_NAME_LENGTH} characters.`)
  .refine((name) => !FORBIDDEN_NAME_CHARS.test(name), "Name contains control characters.")
  // An empty name is already reported by min(); zod runs every check, so skip it here.
  .refine(
    (name) => name === "" || VISIBLE_NAME_CHAR.test(name),
    "Name must contain a visible character.",
  );

export const seatSchema = z.enum(["X", "O"]);
export const roleSchema = z.enum(["X", "O", "spectator"]);
export const gameIdSchema = z.enum(GAME_IDS as [GameId, ...GameId[]]);
/** Seat token handed out in `joined`; the client sends it back to reclaim the seat. */
export const tokenSchema = z.uuid();
export const seqSchema = z.int().min(0);

export const errorCodeSchema = z.enum([
  "NOT_YOUR_TURN",
  "INVALID_MOVE",
  "GAME_OVER",
  "LOBBY_FULL",
  "BAD_MESSAGE",
  "NOT_JOINED",
  "NOT_A_PLAYER",
  "STALE_STATE",
]);

// Client messages are strict so junk keys are rejected rather than silently dropped.
export const joinMsgSchema = z.strictObject({
  t: z.literal("join"),
  name: displayNameSchema,
  token: tokenSchema.optional(),
});
export const moveMsgSchema = z.strictObject({
  t: z.literal("move"),
  /** Shape is game-specific; checked by GameDefinition.validateMove. */
  move: z.unknown(),
  /** The seq of the latest state the client has seen. */
  seq: seqSchema,
});
export const rematchMsgSchema = z.strictObject({ t: z.literal("rematch") });
export const leaveMsgSchema = z.strictObject({ t: z.literal("leave") });

/** Any client -> server message (JSON text frame). */
export const clientMsgSchema = z.discriminatedUnion("t", [
  joinMsgSchema,
  moveMsgSchema,
  rematchMsgSchema,
  leaveMsgSchema,
]);

export const CLIENT_MSG_TYPES = ["join", "move", "rematch", "leave"] as const;

export const gameStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("playing"), turn: seatSchema }),
  z.object({
    kind: z.literal("won"),
    winner: seatSchema,
    line: z.array(z.int().min(0)).optional(),
  }),
  z.object({ kind: z.literal("draw") }),
]);

export const publicPlayerSchema = z.object({
  name: z.string(),
  connected: z.boolean(),
  /** Epoch ms when the seat is released; set only while the player is disconnected. */
  releaseAt: z.number().nullable(),
});

export const ticTacToeStateSchema = z.object({
  board: z.array(seatSchema.nullable()).length(9),
  turn: seatSchema,
});

/** The full lobby snapshot every joined socket receives after each change. */
export const publicStateSchema = z.object({
  code: z.string(),
  game: gameIdSchema,
  /** "waiting" while a seat is empty. */
  phase: z.enum(["waiting", "playing", "finished"]),
  players: z.object({ X: publicPlayerSchema.nullable(), O: publicPlayerSchema.nullable() }),
  spectators: z.int().min(0),
  board: ticTacToeStateSchema,
  result: gameStatusSchema,
  /** Starts at 1; increments on each rematch. */
  round: z.int().min(1),
  /** Who moved first this round. */
  firstSeat: seatSchema,
  score: z.object({ X: z.int().min(0), O: z.int().min(0), draws: z.int().min(0) }),
  rematch: z.object({ X: z.boolean(), O: z.boolean() }),
});

// Server messages are non-strict so an older client tolerates fields added later.
export const joinedMsgSchema = z.object({
  t: z.literal("joined"),
  role: roleSchema,
  /** Null for spectators. */
  token: tokenSchema.nullable(),
});
export const stateMsgSchema = z.object({
  t: z.literal("state"),
  state: publicStateSchema,
  seq: seqSchema,
});
export const errorMsgSchema = z.object({
  t: z.literal("error"),
  code: errorCodeSchema,
  message: z.string(),
});

/** Any server -> client message. */
export const serverMsgSchema = z.discriminatedUnion("t", [
  joinedMsgSchema,
  stateMsgSchema,
  errorMsgSchema,
]);

/** Body of POST /api/lobbies. */
export const createLobbyRequestSchema = z.strictObject({ game: gameIdSchema });

export type Role = z.infer<typeof roleSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ClientMsg = z.infer<typeof clientMsgSchema>;
export type JoinMsg = z.infer<typeof joinMsgSchema>;
export type MoveMsg = z.infer<typeof moveMsgSchema>;
export type ServerMsg = z.infer<typeof serverMsgSchema>;
export type PublicPlayer = z.infer<typeof publicPlayerSchema>;
export type PublicState = z.infer<typeof publicStateSchema>;
export type CreateLobbyRequest = z.infer<typeof createLobbyRequestSchema>;

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Compile-time check that the schema and the GameDefinition status type agree.
const _statusTypesMatch: Equals<GameStatus, z.infer<typeof gameStatusSchema>> = true;

export type ParseClientMessageResult =
  | { ok: true; msg: ClientMsg }
  | {
      ok: false;
      /**
       * Every reason is a protocol violation: the DO closes the socket with 1008 (see handleText).
       * invalid = a known message type whose fields fail the schema.
       */
      reason: "too_large" | "bad_json" | "unknown_type" | "invalid";
      /** Human-readable detail (for invalid: the schema issues). May exceed a close reason's limit. */
      message: string;
    };

const encoder = new TextEncoder();

/** UTF-8 byte length of `text`, without encoding when the answer is obvious. */
function exceedsMessageBytes(text: string): boolean {
  if (text.length > MAX_MESSAGE_BYTES) return true; // every UTF-16 unit is at least 1 byte
  if (text.length * 3 <= MAX_MESSAGE_BYTES) return false; // every UTF-16 unit is at most 3 bytes
  return encoder.encode(text).byteLength > MAX_MESSAGE_BYTES;
}

/** Parses one client text frame: size check, JSON, then the ClientMsg schema. */
export function parseClientMessage(text: string): ParseClientMessageResult {
  if (exceedsMessageBytes(text)) {
    return { ok: false, reason: "too_large", message: "Message too large." };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "bad_json", message: "Message is not valid JSON." };
  }
  const type =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as { t?: unknown }).t
      : undefined;
  if (!(CLIENT_MSG_TYPES as readonly unknown[]).includes(type)) {
    return { ok: false, reason: "unknown_type", message: "Unknown message type." };
  }
  const parsed = clientMsgSchema.safeParse(data);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    return { ok: false, reason: "invalid", message };
  }
  return { ok: true, msg: parsed.data };
}
