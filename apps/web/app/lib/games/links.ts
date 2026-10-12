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
