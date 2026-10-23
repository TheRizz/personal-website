// Pipeline Tycoon saves (docs/04-pipeline-tycoon.md §2.2–2.4, ADR-0006). The server never trusts a
// client's state: it keeps the canonical one and replays each uploaded action log onto it, with
// time and randomness from this side.
//
//   POST /api/tycoon/players   new anonymous player → { player, token }    (rate-limited per IP)
//   POST /api/tycoon/session   start a session: offline earnings, seed      (supersedes the last)
//   PUT  /api/tycoon/save      replay the log since the last save
//   POST /api/tycoon/pair      a 6-character code another device can claim (10 min, single use)
//   POST /api/tycoon/pair/claim  claim a code → { player, token } for this device (rate-limited)
//   DELETE /api/tycoon/device  forget this device's secret (unlinking)
//
// Players authenticate with `Authorization: Bearer <player>.<token>`, where the token is the
// player's first secret or any linked device's (docs/04-pipeline-tycoon.md §3).

import {
  MAX_SAVE_BYTES,
  RULES_VERSION,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  applyOffline,
  checkAchievements,
  claimRequestSchema,
  gameStateSchema,
  normalisePairingCode,
  newGame,
  newGoldenSeed,
  replay,
  summariseDropped,
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
export type TycoonEnv = Pick<Env, "TYCOON_DB" | "TYCOON_PLAYER_LIMITER" | "TYCOON_PAIR_LIMITER">;

/** How long a pairing code works. */
export const PAIRING_CODE_MS = 10 * 60 * 1000;

interface Authenticated {
  row: PlayerRow;
  /** Hash of the secret this request used. */
  tokenHash: string;
}

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

/** The player for a valid `Authorization` header (first secret or a linked device's), or the error. */
async function authenticate(request: Request, env: TycoonEnv): Promise<Authenticated | Response> {
  const header = request.headers.get("Authorization") ?? "";
  const [id = "", token = ""] = header.replace(/^Bearer\s+/i, "").split(".");
  const unauthorized = jsonError(401, "unauthorized", "Unknown player.");
  if (!PLAYER_ID.test(id) || !TOKEN.test(token)) return unauthorized;
  const row = await env.TYCOON_DB.prepare(
    "SELECT id, token_hash, state, rules_version, state_at, session, seq FROM players WHERE id = ?",
  )
    .bind(id)
    .first<PlayerRow>();
  if (!row) return unauthorized;
  const tokenHash = await sha256Hex(token);
  if (sameHash(row.token_hash, tokenHash)) return { row, tokenHash };
  const device = await env.TYCOON_DB.prepare(
    "SELECT 1 AS ok FROM devices WHERE token_hash = ? AND player_id = ?",
  )
    .bind(tokenHash, id)
    .first();
  return device ? { row, tokenHash } : unauthorized;
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
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const { row } = auth;

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
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const { row } = auth;
  if (row.session !== body.data.session) {
    return jsonError(
      409,
      "session_replaced",
      "You're playing on another device. Reload to continue.",
    );
  }
  if (row.seq !== body.data.seq) {
    // Only this session saves here, so a save of its own landed without it hearing back (a phone
    // suspended the page mid-request). Say where the save stands so the client can pick up from
    // it without losing what was played since (client.ts).
    return Response.json(
      {
        error: { code: "out_of_sync", message: "This save is out of date. Reload to continue." },
        saved: { seq: row.seq, state: storedState(row), ageMs: Math.max(0, now - row.state_at) },
      },
      { status: 409, headers: noStore },
    );
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
    {
      state: result.state,
      seq,
      dropped: result.dropped.length,
      undone: summariseDropped(body.data.log, result.dropped),
      creditedMs: result.creditedMs,
    },
    { headers: noStore },
  );
}

function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH));
  // 256 isn't a multiple of the alphabet size; the bias (≤ 1 in 8) doesn't matter for a code
  // that lives 10 minutes and is rate-limited to claim.
  return [...bytes].map((b) => PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]).join("");
}

async function createPairingCode(request: Request, env: TycoonEnv, now: number): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const code = newPairingCode();
  const expiresAt = now + PAIRING_CODE_MS;
  // One live code per player; expired codes are swept on the way.
  await env.TYCOON_DB.batch([
    env.TYCOON_DB.prepare("DELETE FROM pairing_codes WHERE player_id = ? OR expires_at <= ?").bind(
      auth.row.id,
      now,
    ),
    env.TYCOON_DB.prepare(
      "INSERT INTO pairing_codes (code, player_id, expires_at) VALUES (?, ?, ?)",
    ).bind(code, auth.row.id, expiresAt),
  ]);
  return Response.json({ code, expiresInMs: PAIRING_CODE_MS }, { headers: noStore });
}

async function claimPairingCode(request: Request, env: TycoonEnv, now: number): Promise<Response> {
  const key = rateLimitKey(request.headers.get("CF-Connecting-IP"), "tycoon-pair");
  const { success } = await env.TYCOON_PAIR_LIMITER.limit({ key });
  if (!success) {
    return jsonError(429, "rate_limited", "Too many attempts; try again in a minute.", {
      "Retry-After": "60",
    });
  }
  const parsed = await readJson(request);
  if (parsed instanceof Response) return parsed;
  const body = claimRequestSchema.safeParse(parsed.body);
  if (!body.success) {
    return jsonError(400, "bad_request", 'Expected a JSON body like { "code": "ABC234" }.');
  }
  const code = normalisePairingCode(body.data.code);
  // Single use: the delete is what claims it, so two devices racing can't both win.
  const claimed = await env.TYCOON_DB.prepare(
    "DELETE FROM pairing_codes WHERE code = ? AND expires_at > ? RETURNING player_id",
  )
    .bind(code, now)
    .first<{ player_id: string }>();
  if (!claimed) return jsonError(404, "invalid_code", "That code is wrong or has expired.");

  const row = await env.TYCOON_DB.prepare("SELECT state FROM players WHERE id = ?")
    .bind(claimed.player_id)
    .first<{ state: string }>();
  if (!row) return jsonError(404, "invalid_code", "That code is wrong or has expired.");
  const state = upgradeState(gameStateSchema.parse(JSON.parse(row.state)));
  state.linked = true;
  checkAchievements(state);

  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.TYCOON_DB.batch([
    env.TYCOON_DB.prepare(
      "INSERT INTO devices (token_hash, player_id, client, created_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256Hex(token), claimed.player_id, body.data.client, now),
    env.TYCOON_DB.prepare(
      "UPDATE players SET state = ?, rules_version = ?, updated_at = ? WHERE id = ?",
    ).bind(JSON.stringify(state), RULES_VERSION, now, claimed.player_id),
  ]);
  return Response.json({ player: claimed.player_id, token }, { status: 201, headers: noStore });
}

async function forgetDevice(request: Request, env: TycoonEnv): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  // The player's first secret isn't a device row, so this is a no-op for it (it can't be
  // revoked without losing the player).
  await env.TYCOON_DB.prepare("DELETE FROM devices WHERE token_hash = ? AND player_id = ?")
    .bind(auth.tokenHash, auth.row.id)
    .run();
  return new Response(null, { status: 204, headers: noStore });
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
    case "/api/tycoon/pair":
      return request.method === "POST"
        ? createPairingCode(request, env, now)
        : methodNotAllowed("POST");
    case "/api/tycoon/pair/claim":
      return request.method === "POST"
        ? claimPairingCode(request, env, now)
        : methodNotAllowed("POST");
    case "/api/tycoon/device":
      return request.method === "DELETE" ? forgetDevice(request, env) : methodNotAllowed("DELETE");
    default:
      return jsonError(404, "not_found", "No such API route.");
  }
}
