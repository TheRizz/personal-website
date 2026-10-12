/** Characters used in lobby codes: no 0/O/1/I/L so codes can be read aloud and typed. */
export const LOBBY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LOBBY_CODE_LENGTH = 6;
export const MAX_NAME_LENGTH = 20;
/** Max size of one client WebSocket frame, in UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 4096;
/**
 * Joined sockets: 2 players + up to 8 spectators. Spectators are capped when they join
 * (MAX_SPECTATORS_PER_LOBBY), so only sockets that haven't joined yet are limited at upgrade.
 */
export const MAX_SOCKETS_PER_LOBBY = 10;
/**
 * Hard cap on sockets that are open but haven't sent `join`: room for a whole lobby (2 players and
 * 8 spectators) plus both seat holders reconnecting at once. The Durable Object never refuses an
 * upgrade: past the cap it closes the oldest unjoined socket (CLOSE_CODES.joinTimeout), so sockets
 * that never join can't keep a player reclaiming a held seat out.
 */
export const MAX_UNJOINED_SOCKETS = MAX_SOCKETS_PER_LOBBY + 2;
/**
 * An unjoined socket younger than this may still be mid-join (its `join` is one round trip away),
 * so it is only closed to stay under MAX_UNJOINED_SOCKETS. Older ones are also closed, oldest
 * first, once the unjoined sockets outnumber the lobby's free places.
 */
export const UNJOINED_GRACE_MS = 3_000;
/** A socket that hasn't sent `join` this long after connecting is closed (CLOSE_CODES.joinTimeout). */
export const JOIN_TIMEOUT_MS = 10_000;
/** A join that would add a spectator past this is refused with LOBBY_FULL (close 4002). */
export const MAX_SPECTATORS_PER_LOBBY = MAX_SOCKETS_PER_LOBBY - 2;
/** Per socket; going over closes the socket with 1008. */
export const MAX_MESSAGES_PER_SECOND = 10;
/** How long a disconnected player's seat is held for them. */
export const RECONNECT_GRACE_MS = 2 * 60_000;
/** A lobby is deleted after this long without a client message. */
export const LOBBY_IDLE_TTL_MS = 30 * 60_000;
/** Lobby creates per client IP per minute. Must match the limiter's `limit` in wrangler.jsonc. */
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
  /** Both seats are taken and the spectator cap is reached. Clients may retry later. */
  lobbyFull: 4002,
  /** The socket didn't join within JOIN_TIMEOUT_MS, or a newer one needed its slot. May retry. */
  joinTimeout: 4003,
} as const;
