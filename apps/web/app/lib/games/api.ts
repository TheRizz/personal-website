import { isLobbyCode, MAX_SOCKETS_PER_LOBBY } from "@site/game-core";

type Fetch = typeof fetch;

export type CreateLobbyResult =
  { ok: true; code: string } | { ok: false; error: "rate_limited" | "failed" };

export const CREATE_ERROR_TEXT = {
  rate_limited: "You've created a lot of games — try again in a minute.",
  failed: "Couldn't create a game. Check your connection and try again.",
} as const;

/** POST /api/lobbies for a new tic-tac-toe lobby. */
export function createLobby(fetchFn: Fetch = fetch, signal?: AbortSignal) {
  return createRoom("/api/lobbies", { game: "tictactoe" }, fetchFn, signal);
}

/** POST /api/volley for a new online Power Volley room. */
export function createVolleyRoom(
  settings: { court: string; target: number },
  fetchFn: Fetch = fetch,
  signal?: AbortSignal,
) {
  return createRoom("/api/volley", settings, fetchFn, signal);
}

async function createRoom(
  path: string,
  body: object,
  fetchFn: Fetch,
  signal?: AbortSignal,
): Promise<CreateLobbyResult> {
  try {
    const response = await fetchFn(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 429) return { ok: false, error: "rate_limited" };
    if (response.status !== 201) return { ok: false, error: "failed" };
    const created: unknown = await response.json();
    const code =
      typeof created === "object" && created !== null ? (created as { code?: unknown }).code : null;
    return isLobbyCode(code) ? { ok: true, code } : { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export type LobbyLookup =
  | { kind: "found"; full: boolean }
  | { kind: "notFound" }
  /** Network or server trouble: worth retrying. */
  | { kind: "error" };

/** GET /api/lobbies/:code: does the lobby still exist? */
export function lookupLobby(code: string, fetchFn: Fetch = fetch, signal?: AbortSignal) {
  return lookupRoom(`/api/lobbies/${encodeURIComponent(code)}`, fetchFn, signal);
}

/** GET /api/volley/:code: does the Power Volley room still exist? */
export function lookupVolleyRoom(code: string, fetchFn: Fetch = fetch, signal?: AbortSignal) {
  return lookupRoom(`/api/volley/${encodeURIComponent(code)}`, fetchFn, signal);
}

async function lookupRoom(
  path: string,
  fetchFn: Fetch,
  signal?: AbortSignal,
): Promise<LobbyLookup> {
  try {
    const response = await fetchFn(path, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status === 404) return { kind: "notFound" };
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as { connectedSeats?: unknown; spectators?: unknown };
    // Connected seats only: a seat held for a disconnected player may be this client's own.
    const seats = typeof body.connectedSeats === "number" ? body.connectedSeats : 0;
    const spectators = typeof body.spectators === "number" ? body.spectators : 0;
    // Only approximate: the server has the final say when the socket joins.
    return { kind: "found", full: seats + spectators >= MAX_SOCKETS_PER_LOBBY };
  } catch {
    return { kind: "error" };
  }
}
