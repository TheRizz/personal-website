// Pipeline Tycoon saves (docs/04-pipeline-tycoon.md §2.2–2.4, ADR-0006). The server never trusts a
// client's state: it keeps the canonical one and replays each uploaded action log onto it, with
// time and randomness from this side.
//
//   POST /api/tycoon/players   new anonymous player → { player, token }    (rate-limited per IP)
//   POST /api/tycoon/session   start a session: offline earnings, seed      (supersedes the last)
//   PUT  /api/tycoon/save      replay the log since the last save
//
// Players authenticate with `Authorization: Bearer <player>.<token>`.

import {
  MAX_SAVE_BYTES,
  RULES_VERSION,
  applyOffline,
  gameStateSchema,
  newGame,
  newGoldenSeed,
  replay,
  saveRequestSchema,
  sessionRequestSchema,
  upgradeState,
  type GameState,
} from "@site/tycoon-core";
import { jsonError, methodNotAllowed, rateLimitKey } from "./api";

const noStore = { "Cache-Control": "no-store" };
/** Network jitter allowed between the client's clock and ours for one save. */
export const SAVE_SLACK_MS = 5_000;
const PLAYER_ID = /^[0-9a-f-]{36}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface PlayerRow {
  id: string;
  token_hash: string;
  state: string;
  rules_version: number;
  state_at: number;
  session: string | null;
  seq: number;
}

/** The parts of Env this module uses, so tests can pass just these. */
export type TycoonEnv = Pick<Env, "TYCOON_DB" | "TYCOON_PLAYER_LIMITER">;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two equal-length hex strings. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const upgradeRequired = () =>
  jsonError(
    426,
    "update_required",
    "The game has been updated. Reload the page (or update the CLI) to keep playing.",
  );

async function readJson(request: Request): Promise<{ body: unknown } | Response> {
  const mediaType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return jsonError(415, "unsupported_media_type", "Send the body as application/json.");
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_SAVE_BYTES) return jsonError(413, "too_large", "Save is too large.");
  const text = await request.text();
  if (text.length > MAX_SAVE_BYTES) return jsonError(413, "too_large", "Save is too large.");
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return jsonError(400, "bad_request", "Body is not valid JSON.");
  }
}

/** The player row for a valid `Authorization` header, or the error response. */
async function authenticate(request: Request, env: TycoonEnv): Promise<PlayerRow | Response> {
  const header = request.headers.get("Authorization") ?? "";
  const [id = "", token = ""] = header.replace(/^Bearer\s+/i, "").split(".");
  const unauthorized = jsonError(401, "unauthorized", "Unknown player.");
  if (!PLAYER_ID.test(id) || !TOKEN.test(token)) return unauthorized;
  const row = await env.TYCOON_DB.prepare(
    "SELECT id, token_hash, state, rules_version, state_at, session, seq FROM players WHERE id = ?",
  )
    .bind(id)
    .first<PlayerRow>();
  if (!row || !sameHash(row.token_hash, await sha256Hex(token))) return unauthorized;
  return row;
}

function storedState(row: PlayerRow): GameState {
  return upgradeState(gameStateSchema.parse(JSON.parse(row.state)));
}

async function createPlayer(request: Request, env: TycoonEnv, now: number): Promise<Response> {
  const key = rateLimitKey(request.headers.get("CF-Connecting-IP"), "tycoon-player");
  const { success } = await env.TYCOON_PLAYER_LIMITER.limit({ key });
  if (!success) {
    return jsonError(429, "rate_limited", "Too many new players; try again in a minute.", {
      "Retry-After": "60",
    });
  }
  const id = crypto.randomUUID();
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.TYCOON_DB.prepare(
    `INSERT INTO players (id, token_hash, state, rules_version, state_at, seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, await sha256Hex(token), JSON.stringify(newGame()), RULES_VERSION, now, now, now)
    .run();
  return Response.json({ player: id, token }, { status: 201, headers: noStore });
}

async function startSession(request: Request, env: TycoonEnv, now: number): Promise<Response> {
  const parsed = await readJson(request);
  if (parsed instanceof Response) return parsed;
  const body = sessionRequestSchema.safeParse(parsed.body);
  if (!body.success) return jsonError(400, "bad_request", 'Expected a JSON body like { "v": 1 }.');
  if (body.data.v !== RULES_VERSION) return upgradeRequired();
  const row = await authenticate(request, env);
  if (row instanceof Response) return row;

  // Offline earnings, by our clock and capped (rules.ts OFFLINE_CAP_MS).
  const offline = applyOffline(storedState(row), now - row.state_at);
  const state = offline.state;
  state.golden = { seed: newGoldenSeed(), start: state.playMs, next: 0 };
  const session = crypto.randomUUID();
  await env.TYCOON_DB.prepare(
    `UPDATE players SET state = ?, rules_version = ?, state_at = ?, session = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(JSON.stringify(state), RULES_VERSION, now, session, now, row.id)
    .run();
  return Response.json(
    {
      state,
      session,
      seq: row.seq,
      offline: { ms: offline.creditedMs, earned: offline.earned },
    },
    { headers: noStore },
  );
}

async function save(request: Request, env: TycoonEnv, now: number): Promise<Response> {
  const parsed = await readJson(request);
  if (parsed instanceof Response) return parsed;
  const body = saveRequestSchema.safeParse(parsed.body);
  if (!body.success) return jsonError(400, "bad_request", "Malformed save.");
  if (body.data.v !== RULES_VERSION) return upgradeRequired();
  const row = await authenticate(request, env);
  if (row instanceof Response) return row;
  if (row.session !== body.data.session) {
    return jsonError(
      409,
      "session_replaced",
      "You're playing on another device. Reload to continue.",
    );
  }
  if (row.seq !== body.data.seq) {
    return jsonError(409, "out_of_sync", "This save is out of date. Reload to continue.");
  }

  const result = replay(storedState(row), body.data.log, now - row.state_at + SAVE_SLACK_MS);
  const seq = row.seq + 1;
  // Only if nothing else saved meanwhile: two concurrent saves can't both apply.
  const written = await env.TYCOON_DB.prepare(
    `UPDATE players SET state = ?, rules_version = ?, state_at = ?, seq = ?, updated_at = ?
     WHERE id = ? AND seq = ? AND session = ?`,
  )
    .bind(JSON.stringify(result.state), RULES_VERSION, now, seq, now, row.id, row.seq, row.session)
    .run();
  if (written.meta.changes !== 1) {
    return jsonError(409, "out_of_sync", "This save is out of date. Reload to continue.");
  }
  return Response.json(
    { state: result.state, seq, dropped: result.dropped.length, creditedMs: result.creditedMs },
    { headers: noStore },
  );
}

/** Handles /api/tycoon/*. `now` is injectable for tests. */
export async function handleTycoon(
  request: Request,
  env: TycoonEnv,
  now: number = Date.now(),
): Promise<Response> {
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case "/api/tycoon/players":
      return request.method === "POST" ? createPlayer(request, env, now) : methodNotAllowed("POST");
    case "/api/tycoon/session":
      return request.method === "POST" ? startSession(request, env, now) : methodNotAllowed("POST");
    case "/api/tycoon/save":
      return request.method === "PUT" ? save(request, env, now) : methodNotAllowed("PUT");
    default:
      return jsonError(404, "not_found", "No such API route.");
  }
}
