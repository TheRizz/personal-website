import { createLobbyRequestSchema, generateLobbyCode, isLobbyCode } from "@site/game-core";
import { parseCreateRoom } from "../app/lib/games/volley/net";

const noStore = { "Cache-Control": "no-store" };
/** Fresh codes tried when /init reports that a code is already taken. */
const MAX_CODE_ATTEMPTS = 3;
const LOBBY_PATH = /^\/api\/lobbies\/([^/]+)(\/ws)?$/;
const VOLLEY_PATH = /^\/api\/volley\/([^/]+)(\/ws)?$/;

/** The JSON error shape every /api route uses (design doc §4.5). Never cached. */
export function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { ...noStore, ...headers } },
  );
}

/** 405 with the allowed methods. */
export function methodNotAllowed(allow: string): Response {
  return jsonError(405, "method_not_allowed", `Use ${allow}.`, { Allow: allow });
}

/**
 * Rate-limit key for a client IP. IPv6 addresses collapse to their /64 (one subscriber usually
 * gets a whole /64, so rotating within it must not reset the limit); IPv4-mapped IPv6 addresses
 * count as the IPv4 address.
 */
export function rateLimitKey(ip: string | null): string {
  const address = (ip ?? "").trim().toLowerCase();
  if (!address.includes(":")) return `lobby-create:${address || "unknown"}`;
  const hextets = expandIpv6(address.split("%")[0] ?? "");
  if (!hextets) return `lobby-create:${address}`;
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    const [hi = 0, lo = 0] = hextets.slice(6);
    return `lobby-create:${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `lobby-create:${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (with "::" and a dotted IPv4 tail), or null. */
function expandIpv6(address: string): number[] | null {
  let text = address;
  const ipv4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (ipv4) {
    const bytes = ipv4.slice(1).map(Number);
    if (bytes.some((b) => b > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = bytes;
    text = `${text.slice(0, ipv4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** The two kinds of room: turn-based lobbies (tic-tac-toe) and Power Volley rooms. */
type Rooms = "lobbies" | "volley";

const namespace = (env: Env, rooms: Rooms) =>
  rooms === "lobbies" ? env.GAME_LOBBY : env.VOLLEY_ROOM;

async function createRoom(request: Request, env: Env, rooms: Rooms): Promise<Response> {
  const mediaType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return jsonError(415, "unsupported_media_type", "Send the body as application/json.");
  }
  // Counted before the body is read, so malformed requests use up the quota too. Both kinds of
  // room share one quota.
  const key = rateLimitKey(request.headers.get("CF-Connecting-IP"));
  const { success } = await env.LOBBY_CREATE_LIMITER.limit({ key });
  if (!success) {
    return jsonError(429, "rate_limited", "Too many lobbies created; try again in a minute.", {
      "Retry-After": "60",
    });
  }
  const body: unknown = await request.json().catch(() => undefined);
  let settings: object;
  if (rooms === "lobbies") {
    const parsed = createLobbyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "bad_request", 'Expected a JSON body like { "game": "tictactoe" }.');
    }
    settings = { game: parsed.data.game };
  } else {
    const parsed = parseCreateRoom(body);
    if (!parsed) {
      return jsonError(
        400,
        "bad_request",
        'Expected a JSON body like { "court": "beach", "target": 11 }.',
      );
    }
    settings = parsed;
  }

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateLobbyCode();
    const response = await namespace(env, rooms)
      .getByName(code)
      .fetch(
        new Request("https://lobby/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, ...settings }),
        }),
      );
    if (response.status === 409) continue;
    if (response.status !== 201) throw new Error(`Lobby init failed with ${response.status}`);
    return Response.json(await response.json(), {
      status: 201,
      headers: { ...noStore, Location: `/api/${rooms}/${code}` },
    });
  }
  return jsonError(503, "unavailable", "Could not allocate a lobby code; try again.");
}

async function getLobby(code: string, env: Env, rooms: Rooms): Promise<Response> {
  const response = await namespace(env, rooms).getByName(code).fetch("https://lobby/info");
  if (response.status === 404) return jsonError(404, "not_found", "Lobby not found.");
  if (!response.ok) throw new Error(`Lobby info failed with ${response.status}`);
  return Response.json(await response.json(), { headers: noStore });
}

function connectLobby(
  request: Request,
  code: string,
  env: Env,
  rooms: Rooms,
): Promise<Response> | Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return jsonError(426, "upgrade_required", "Connect with a WebSocket.", {
      Upgrade: "websocket",
    });
  }
  // Browsers always send Origin on WebSocket upgrades; block other sites' pages from joining.
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return jsonError(
      403,
      "forbidden_origin",
      "Cross-origin WebSocket connections are not allowed.",
    );
  }
  if (!isLobbyCode(code)) return jsonError(404, "not_found", "Lobby not found.");
  // The DO answers 404 (unknown lobby) or 101 with the socket.
  return namespace(env, rooms).getByName(code).fetch(new Request("https://lobby/ws", request));
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/lobbies" || pathname === "/api/volley") {
    const rooms = pathname === "/api/lobbies" ? "lobbies" : "volley";
    return request.method === "POST" ? createRoom(request, env, rooms) : methodNotAllowed("POST");
  }
  const lobby = LOBBY_PATH.exec(pathname);
  const volley = lobby ? null : VOLLEY_PATH.exec(pathname);
  const match = lobby ?? volley;
  if (match) {
    const rooms = lobby ? "lobbies" : "volley";
    if (request.method !== "GET") return methodNotAllowed("GET");
    const code = match[1] ?? "";
    if (match[2]) return connectLobby(request, code, env, rooms);
    // Malformed codes never reach (or create) a Durable Object.
    if (!isLobbyCode(code)) return jsonError(404, "not_found", "Lobby not found.");
    return getLobby(code, env, rooms);
  }
  return jsonError(404, "not_found", "No such API route.");
}

/** Handles every /api/* route except /api/health. Errors are JSON and never cached. */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  try {
    return await route(request, env);
  } catch (error) {
    console.error("API error", error);
    return jsonError(500, "internal_error", "Something went wrong.");
  }
}
