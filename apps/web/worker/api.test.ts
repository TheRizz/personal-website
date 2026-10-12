import { isLobbyCode } from "@site/game-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi, rateLimitKey } from "./api";

type DoHandler = (request: Request, name: string) => Response | Promise<Response>;

/** A fake Env: GAME_LOBBY records every stub call, the limiter allows `allowed` calls per key. */
function fakeEnv({
  handler = () => new Response(null, { status: 500 }),
  allowed = 10,
}: { handler?: DoHandler; allowed?: number } = {}) {
  const doCalls: { name: string; request: Request }[] = [];
  const limitKeys: string[] = [];
  const env = {
    GAME_LOBBY: {
      getByName: (name: string) => ({
        fetch: async (input: RequestInfo, init?: RequestInit) => {
          const request = new Request(input, init);
          doCalls.push({ name, request });
          return handler(request, name);
        },
      }),
    },
    LOBBY_CREATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        limitKeys.push(key);
        return { success: limitKeys.filter((k) => k === key).length <= allowed };
      },
    },
  } as unknown as Env;
  return { env, doCalls, limitKeys };
}

const ORIGIN = "https://ry-mart.com";
const CODE = "ABCDEF";

function createRequest(body: unknown = { game: "tictactoe" }, headers: HeadersInit = {}) {
  return new Request(`${ORIGIN}/api/lobbies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The DO's /init: 201 with the created lobby (409 for names in `taken`). */
function initHandler(taken: (name: string) => boolean = () => false): DoHandler {
  return async (request, name) => {
    if (taken(name)) return Response.json({ error: { code: "conflict" } }, { status: 409 });
    const { code, game } = (await request.json()) as { code: string; game: string };
    return Response.json({ code, game, expiresAt: 123 }, { status: 201 });
  };
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/lobbies", () => {
  it("creates a lobby through the DO's /init and returns 201", async () => {
    const { env, doCalls } = fakeEnv({ handler: initHandler() });
    const response = await handleApi(createRequest(), env);

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { code: string; game: string; expiresAt: number };
    expect(isLobbyCode(body.code)).toBe(true);
    expect(body).toEqual({ code: body.code, game: "tictactoe", expiresAt: 123 });
    expect(response.headers.get("Location")).toBe(`/api/lobbies/${body.code}`);

    expect(doCalls).toHaveLength(1);
    const [call] = doCalls;
    expect(call?.name).toBe(body.code);
    expect(call?.request.method).toBe("POST");
    expect(call?.request.url).toBe("https://lobby/init");
  });

  it("accepts a JSON content type with parameters", async () => {
    const { env } = fakeEnv({ handler: initHandler() });
    const request = createRequest(undefined, { "Content-Type": "Application/JSON; charset=utf-8" });
    expect((await handleApi(request, env)).status).toBe(201);
  });

  it("retries with a new code when /init reports a collision", async () => {
    let calls = 0;
    const { env, doCalls } = fakeEnv({ handler: initHandler(() => ++calls < 3) });
    const response = await handleApi(createRequest(), env);

    expect(response.status).toBe(201);
    expect(doCalls).toHaveLength(3);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe(doCalls[2]?.name);
  });

  it("gives up with 503 after three collisions", async () => {
    const { env, doCalls } = fakeEnv({ handler: initHandler(() => true) });
    await expectError(await handleApi(createRequest(), env), 503, "unavailable");
    expect(doCalls).toHaveLength(3);
  });

  it("returns 500 JSON when the DO fails unexpectedly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = fakeEnv({ handler: () => new Response("boom", { status: 500 }) });
    await expectError(await handleApi(createRequest(), env), 500, "internal_error");
  });

  it.each([
    ["no content type", { "Content-Type": "" }],
    ["text/plain", { "Content-Type": "text/plain" }],
    ["a form", { "Content-Type": "application/x-www-form-urlencoded" }],
  ])("rejects %s with 415 before rate limiting", async (_, headers) => {
    const { env, doCalls, limitKeys } = fakeEnv();
    await expectError(
      await handleApi(createRequest(undefined, headers), env),
      415,
      "unsupported_media_type",
    );
    expect(limitKeys).toHaveLength(0);
    expect(doCalls).toHaveLength(0);
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["an empty body", ""],
    ["an unknown game", { game: "chess" }],
    ["a missing game", {}],
    ["extra keys", { game: "tictactoe", extra: 1 }],
    ["an array", ["tictactoe"]],
  ])("rejects %s with 400", async (_, body) => {
    const { env, doCalls } = fakeEnv();
    await expectError(await handleApi(createRequest(body), env), 400, "bad_request");
    expect(doCalls).toHaveLength(0);
  });

  it("rate limits per IP with 429 and Retry-After: 60", async () => {
    const { env, doCalls, limitKeys } = fakeEnv({ handler: initHandler() });
    for (let i = 0; i < 10; i++) {
      expect((await handleApi(createRequest(), env)).status).toBe(201);
    }
    const limited = await handleApi(createRequest(), env);
    expect(limited.headers.get("Retry-After")).toBe("60");
    await expectError(limited, 429, "rate_limited");
    expect(doCalls).toHaveLength(10);
    expect(new Set(limitKeys)).toEqual(new Set(["lobby-create:203.0.113.7"]));

    const otherIp = createRequest(undefined, { "CF-Connecting-IP": "203.0.113.8" });
    expect((await handleApi(otherIp, env)).status).toBe(201);
  });

  it("counts every IPv6 address of a /64 against one limit", async () => {
    const { env, limitKeys } = fakeEnv({ handler: initHandler(), allowed: 2 });
    const from = (ip: string) =>
      handleApi(createRequest(undefined, { "CF-Connecting-IP": ip }), env);

    expect((await from("2001:db8:aa:bb::1")).status).toBe(201);
    expect((await from("2001:0DB8:00aa:00bb:ffff:1:2:3")).status).toBe(201);
    expect((await from("2001:db8:aa:bb:1::9")).status).toBe(429);
    expect((await from("2001:db8:aa:bc::1")).status).toBe(201);
    expect(limitKeys).toEqual([
      "lobby-create:2001:db8:aa:bb::/64",
      "lobby-create:2001:db8:aa:bb::/64",
      "lobby-create:2001:db8:aa:bb::/64",
      "lobby-create:2001:db8:aa:bc::/64",
    ]);
  });
});

describe("rateLimitKey", () => {
  it.each([
    ["198.51.100.4", "lobby-create:198.51.100.4"],
    [" 198.51.100.4 ", "lobby-create:198.51.100.4"],
    [null, "lobby-create:unknown"],
    ["", "lobby-create:unknown"],
    ["2001:db8::1", "lobby-create:2001:db8:0:0::/64"],
    ["2001:DB8:1:2:3:4:5:6", "lobby-create:2001:db8:1:2::/64"],
    ["::1", "lobby-create:0:0:0:0::/64"],
    ["::", "lobby-create:0:0:0:0::/64"],
    ["fe80::1%eth0", "lobby-create:fe80:0:0:0::/64"],
    ["2001:db8:1:2::1.2.3.4", "lobby-create:2001:db8:1:2::/64"],
    ["::ffff:198.51.100.4", "lobby-create:198.51.100.4"],
    ["::ffff:c633:6404", "lobby-create:198.51.100.4"],
    // Not parseable: used verbatim rather than lumped together.
    ["2001:db8::1::2", "lobby-create:2001:db8::1::2"],
    ["1:2:3:4:5:6:7:8:9", "lobby-create:1:2:3:4:5:6:7:8:9"],
    ["2001:db8:zz::1", "lobby-create:2001:db8:zz::1"],
    ["::ffff:300.1.1.1", "lobby-create:::ffff:300.1.1.1"],
  ])("%s -> %s", (ip, key) => {
    expect(rateLimitKey(ip)).toBe(key);
  });
});

describe("GET /api/lobbies/:code", () => {
  it("returns the DO's summary", async () => {
    const summary = {
      code: CODE,
      game: "tictactoe",
      phase: "waiting",
      seatsTaken: 1,
      spectators: 0,
    };
    const { env, doCalls } = fakeEnv({ handler: () => Response.json(summary) });
    const response = await handleApi(new Request(`${ORIGIN}/api/lobbies/${CODE}`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(summary);
    expect(doCalls.map((c) => [c.name, c.request.method, c.request.url])).toEqual([
      [CODE, "GET", "https://lobby/info"],
    ]);
  });

  it("returns 404 when the DO has no lobby", async () => {
    const { env } = fakeEnv({ handler: () => Response.json({}, { status: 404 }) });
    await expectError(
      await handleApi(new Request(`${ORIGIN}/api/lobbies/${CODE}`), env),
      404,
      "not_found",
    );
  });

  it.each(["abcdef", "ABCDE", "ABCDEFG", "ABCDE0", "ABC%20EF", "ABCDEI"])(
    "returns 404 for the malformed code %s without touching the DO",
    async (code) => {
      const { env, doCalls } = fakeEnv();
      await expectError(
        await handleApi(new Request(`${ORIGIN}/api/lobbies/${code}`), env),
        404,
        "not_found",
      );
      expect(doCalls).toHaveLength(0);
    },
  );
});

describe("GET /api/lobbies/:code/ws", () => {
  const wsUrl = `${ORIGIN}/api/lobbies/${CODE}/ws`;
  const upgrade = { Upgrade: "websocket", Connection: "Upgrade" };

  it("forwards the original upgrade request to the DO and returns its response", async () => {
    const reply = new Response("from the DO", { status: 200 });
    const { env, doCalls } = fakeEnv({ handler: () => reply });
    const request = new Request(wsUrl, {
      headers: { ...upgrade, Origin: ORIGIN, "Sec-WebSocket-Key": "abc" },
    });
    const response = await handleApi(request, env);

    expect(response).toBe(reply);
    expect(doCalls).toHaveLength(1);
    const forwarded = doCalls[0]?.request;
    expect(doCalls[0]?.name).toBe(CODE);
    expect(forwarded?.url).toBe("https://lobby/ws");
    expect(forwarded?.method).toBe("GET");
    expect(forwarded?.headers.get("Upgrade")).toBe("websocket");
    expect(forwarded?.headers.get("Sec-WebSocket-Key")).toBe("abc");
  });

  it("allows upgrades without an Origin header", async () => {
    const { env, doCalls } = fakeEnv({ handler: () => new Response(null, { status: 204 }) });
    await handleApi(new Request(wsUrl, { headers: upgrade }), env);
    expect(doCalls).toHaveLength(1);
  });

  it("passes the DO's rejection (404 or 409) through", async () => {
    const full = Response.json({ error: { code: "LOBBY_FULL" } }, { status: 409 });
    const { env } = fakeEnv({ handler: () => full });
    const response = await handleApi(new Request(wsUrl, { headers: upgrade }), env);
    expect(response.status).toBe(409);
  });

  it("requires a WebSocket upgrade (426)", async () => {
    const { env, doCalls } = fakeEnv();
    const response = await handleApi(new Request(wsUrl), env);
    expect(response.headers.get("Upgrade")).toBe("websocket");
    await expectError(response, 426, "upgrade_required");
    expect(doCalls).toHaveLength(0);
  });

  it.each(["https://evil.example", "http://ry-mart.com", "https://www.ry-mart.com", "null"])(
    "rejects Origin %s with 403",
    async (origin) => {
      const { env, doCalls } = fakeEnv();
      const request = new Request(wsUrl, { headers: { ...upgrade, Origin: origin } });
      await expectError(await handleApi(request, env), 403, "forbidden_origin");
      expect(doCalls).toHaveLength(0);
    },
  );

  it("returns 404 for a malformed code without touching the DO", async () => {
    const { env, doCalls } = fakeEnv();
    const request = new Request(`${ORIGIN}/api/lobbies/nope/ws`, { headers: upgrade });
    await expectError(await handleApi(request, env), 404, "not_found");
    expect(doCalls).toHaveLength(0);
  });
});

describe("routing", () => {
  it.each([
    ["GET", "/api/lobbies", "POST"],
    ["PUT", "/api/lobbies", "POST"],
    ["POST", `/api/lobbies/${CODE}`, "GET"],
    ["DELETE", `/api/lobbies/${CODE}`, "GET"],
    ["POST", `/api/lobbies/${CODE}/ws`, "GET"],
  ])("%s %s -> 405 with Allow: %s", async (method, path, allow) => {
    const { env, doCalls } = fakeEnv();
    const response = await handleApi(new Request(`${ORIGIN}${path}`, { method }), env);
    expect(response.headers.get("Allow")).toBe(allow);
    await expectError(response, 405, "method_not_allowed");
    expect(doCalls).toHaveLength(0);
  });

  it.each(["/api/nope", "/api/lobbies/", `/api/lobbies/${CODE}/ws/extra`, "/api/lobbies/A/B"])(
    "%s -> 404",
    async (path) => {
      const { env, doCalls } = fakeEnv();
      await expectError(await handleApi(new Request(`${ORIGIN}${path}`), env), 404, "not_found");
      expect(doCalls).toHaveLength(0);
    },
  );
});
