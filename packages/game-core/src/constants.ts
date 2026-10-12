/** Characters used in lobby codes: no 0/O/1/I/L so codes can be read aloud and typed. */
export const LOBBY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LOBBY_CODE_LENGTH = 6;
export const MAX_NAME_LENGTH = 20;
/** Max size of one client WebSocket frame, in UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 4096;
/** 2 players + up to 8 spectators; enforced by the Durable Object at upgrade time. */
export const MAX_SOCKETS_PER_LOBBY = 10;
/** Per socket; going over closes the socket with 1008. */
export const MAX_MESSAGES_PER_SECOND = 10;
/** How long a disconnected player's seat is held for them. */
export const RECONNECT_GRACE_MS = 2 * 60_000;
/** A lobby is deleted after this long without a client message. */
export const LOBBY_IDLE_TTL_MS = 30 * 60_000;
export const LOBBY_CREATE_LIMIT_PER_MINUTE = 10;

/** WebSocket close codes used by the lobby. */
export const CLOSE_CODES = {
  /** The client sent `leave`. */
  normal: 1000,
  /** Binary, oversized, non-JSON or schema-invalid frame, unknown message type, or rate limit. */
  policyViolation: 1008,
  /** Another socket reconnected with this seat's token. Clients must not auto-reconnect. */
  seatTakenOver: 4000,
  /** The lobby idled out and was deleted. Clients must not auto-reconnect. */
  lobbyExpired: 4001,
} as const;
