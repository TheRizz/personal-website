import { RULES_VERSION, type GameState, type SaveLog } from "@site/tycoon-core";

// The three Pipeline Tycoon endpoints (worker/tycoon-api.ts). The player's id and secret live in
// localStorage under "games.tycoon.player"; nothing else about the game is stored in the browser.

const PLAYER_KEY = "games.tycoon.player";

export type ApiFailure =
  | { kind: "session_replaced" }
  | { kind: "out_of_sync" }
  | { kind: "update_required" }
  | { kind: "unauthorized" }
  | { kind: "rate_limited" }
  | { kind: "network"; detail: string };

export class TycoonApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.kind);
  }
}

export interface SessionStart {
  state: GameState;
  session: string;
  seq: number;
  offline: { ms: number; earned: number };
}

export interface SaveAck {
  state: GameState;
  seq: number;
  dropped: number;
  creditedMs: number;
}

function loadPlayer(): string | null {
  try {
    return window.localStorage.getItem(PLAYER_KEY);
  } catch {
    return null;
  }
}

function storePlayer(value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(PLAYER_KEY);
    else window.localStorage.setItem(PLAYER_KEY, value);
  } catch {
    // Storage blocked: the player lasts as long as this page.
  }
}

let memoryPlayer: string | null = null;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  keepalive = false,
): Promise<T> {
  const auth = memoryPlayer ?? loadPlayer();
  let response: Response;
  try {
    response = await fetch(`/api/tycoon/${path}`, {
      method,
      keepalive,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new TycoonApiError({ kind: "network", detail: String(error) });
  }
  if (response.ok) return (await response.json()) as T;
  const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
  const code = payload?.error?.code;
  if (code === "session_replaced" || code === "out_of_sync" || code === "update_required") {
    throw new TycoonApiError({ kind: code });
  }
  if (response.status === 401) throw new TycoonApiError({ kind: "unauthorized" });
  if (response.status === 429) throw new TycoonApiError({ kind: "rate_limited" });
  throw new TycoonApiError({ kind: "network", detail: `HTTP ${response.status}` });
}

async function createPlayer(): Promise<void> {
  const { player, token } = await request<{ player: string; token: string }>("POST", "players");
  memoryPlayer = `${player}.${token}`;
  storePlayer(memoryPlayer);
}

/** Starts a session, creating an anonymous player first if this browser has none. */
export async function startSession(): Promise<SessionStart> {
  if (!memoryPlayer && !loadPlayer()) await createPlayer();
  try {
    return await request<SessionStart>("POST", "session", { v: RULES_VERSION });
  } catch (error) {
    // The stored player no longer exists (or the secret is wrong): start over as a new one.
    if (error instanceof TycoonApiError && error.failure.kind === "unauthorized") {
      memoryPlayer = null;
      storePlayer(null);
      await createPlayer();
      return request<SessionStart>("POST", "session", { v: RULES_VERSION });
    }
    throw error;
  }
}

/** Uploads the log since the last save. `keepalive` lets it finish while the page unloads. */
export function uploadSave(
  session: string,
  seq: number,
  log: SaveLog,
  keepalive = false,
): Promise<SaveAck> {
  return request<SaveAck>("PUT", "save", { v: RULES_VERSION, session, seq, log }, keepalive);
}
