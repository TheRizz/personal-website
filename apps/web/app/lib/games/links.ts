import { normalizeLobbyCode } from "@site/game-core";

/** Path of a tic-tac-toe lobby page. */
export const lobbyPath = (code: string) => `/games/tictactoe/${code}`;

/** The link a player shares to invite someone, e.g. https://ry-mart.com/games/tictactoe/K7QXM2. */
export function inviteUrl(origin: string, code: string): string {
  return new URL(lobbyPath(code), origin).href;
}

/** Same-origin WebSocket URL for a lobby: wss: on https pages, ws: on http (local dev). */
export function socketUrl(location: { protocol: string; host: string }, code: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/lobbies/${encodeURIComponent(code)}/ws`;
}

/**
 * The lobby code in what someone typed or pasted into the join box: a code (normalised as usual)
 * or an invite link / path, whose last segment is the code.
 */
export function codeFromInput(raw: string): string {
  if (!raw.includes("/")) return normalizeLobbyCode(raw);
  const path = raw.split(/[?#]/)[0] ?? "";
  const segment =
    /\/tictactoe\/([^/\s]+)/i.exec(path)?.[1] ??
    // Host names ("ry-mart.com", "localhost:5173") are never codes.
    path
      .split("/")
      .filter((part) => part.trim() && !/[.:]/.test(part))
      .at(-1) ??
    "";
  return normalizeLobbyCode(segment);
}
