import { test as base, expect, type APIResponse } from "@playwright/test";
import {
  CLOSE_CODES,
  MAX_MESSAGE_BYTES,
  MAX_SOCKETS_PER_LOBBY,
  RECONNECT_GRACE_MS,
  generateLobbyCode,
  isLobbyCode,
  type ServerMsg,
} from "../packages/game-core/src/index";
import {
  BASE_URL,
  LobbyClient,
  createLobby,
  handshakeStatus,
  sleep,
  uniqueIp,
  type CreatedLobby,
} from "./helpers";

type StateMsg = Extract<ServerMsg, { t: "state" }>;

/** A fresh lobby per test, plus join/connect helpers whose sockets are closed afterwards. */
const test = base.extend<{
  lobby: CreatedLobby & {
    connect: () => Promise<LobbyClient>;
    join: (name: string, token?: string) => ReturnType<typeof LobbyClient.join>;
  };
}>({
  lobby: async ({ request }, use) => {
    const created = await createLobby(request);
    const clients: LobbyClient[] = [];
    await use({
      ...created,
      connect: async () => {
        const client = await LobbyClient.connect(created.code);
        clients.push(client);
        return client;
      },
      join: async (name, token) => {
        const joined = await LobbyClient.join(created.code, name, token);
        clients.push(joined.client);
        return joined;
      },
    });
    for (const client of clients) {
      client.close();
      client.assertNoProblems();
    }
  },
});

async function expectApiError(response: APIResponse, status: number, code: string) {
  expect(response.status()).toBe(status);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(body.error.message).toEqual(expect.any(String));
}

/** A code that was (almost certainly) never created. */
const unknownCode = () => generateLobbyCode();

/** Sends a move and waits until every client has seen the resulting state (seq + 1). */
async function move(mover: LobbyClient, everyone: LobbyClient[], cell: number, seq: number) {
  mover.send({ t: "move", move: { cell }, seq });
  const states = await Promise.all(everyone.map((c) => c.next("state", (m) => m.seq === seq + 1)));
  return states[0]!;
}

/** X and O both joined; resolves once both have seen the "playing" state. */
async function startGame(lobby: { join: (name: string) => ReturnType<typeof LobbyClient.join> }) {
  const x = await lobby.join("Xena");
  const o = await lobby.join("Oscar");
  // O's join returned the state it caused; X gets the same broadcast.
  expect(o.state.state.phase).toBe("playing");
  await x.client.next("state", (m) => m.seq === o.state.seq);
  return { x, o, seq: o.state.seq };
}

test.describe("HTTP API", () => {
  test("POST /api/lobbies creates a lobby", async ({ request }) => {
    const before = Date.now();
    const response = await request.post("/api/lobbies", {
      headers: { "CF-Connecting-IP": uniqueIp() },
      data: { game: "tictactoe" },
    });
    expect(response.status()).toBe(201);
    expect(response.headers()["cache-control"]).toBe("no-store");
    const body = (await response.json()) as CreatedLobby;
    expect(Object.keys(body).sort()).toEqual(["code", "expiresAt", "game"]);
    expect(isLobbyCode(body.code)).toBe(true);
    expect(body.game).toBe("tictactoe");
    // Idle TTL is 30 minutes from creation.
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1_000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1_000);
  });

  test("GET /api/lobbies/:code returns the summary", async ({ request }) => {
    const { code } = await createLobby(request);
    const response = await request.get(`/api/lobbies/${code}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toEqual({
      code,
      game: "tictactoe",
      phase: "waiting",
      seatsTaken: 0,
      spectators: 0,
    });
  });

  test("GET for an unknown or malformed code is 404", async ({ request }) => {
    for (const code of [unknownCode(), "abc", "abcdef", "ABCDE0", "ABCDEFG"]) {
      await expectApiError(await request.get(`/api/lobbies/${code}`), 404, "not_found");
    }
  });

  test("POST rejects a wrong content type (415) and a bad body (400)", async ({ request }) => {
    const headers = { "CF-Connecting-IP": uniqueIp() };
    await expectApiError(
      await request.post("/api/lobbies", {
        headers: { ...headers, "Content-Type": "text/plain" },
        data: '{"game":"tictactoe"}',
      }),
      415,
      "unsupported_media_type",
    );
    for (const data of ['{"game":"chess"}', "{nope", '{"game":"tictactoe","x":1}']) {
      await expectApiError(
        await request.post("/api/lobbies", {
          headers: { ...headers, "Content-Type": "application/json" },
          data,
        }),
        400,
        "bad_request",
      );
    }
  });

  test("wrong methods get 405 with Allow, unknown routes 404", async ({ request }) => {
    const list = await request.get("/api/lobbies");
    expect(list.headers()["allow"]).toBe("POST");
    await expectApiError(list, 405, "method_not_allowed");

    const del = await request.delete(`/api/lobbies/${unknownCode()}`);
    expect(del.headers()["allow"]).toBe("GET");
    await expectApiError(del, 405, "method_not_allowed");

    await expectApiError(await request.get("/api/nope"), 404, "not_found");
  });

  test("the 11th create from one /64 within a minute is rate limited", async ({ request }) => {
    test.setTimeout(60_000);
    // The local limiter uses clock-aligned 60 s windows: don't straddle a minute boundary.
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 52_000) await sleep(60_000 - intoMinute + 500);

    // Different addresses inside one /64 share a limit.
    const prefix = uniqueIp().replace(/::1$/, "");
    for (let i = 1; i <= 10; i++) await createLobby(request, `${prefix}::${i.toString(16)}`);
    const limited = await request.post("/api/lobbies", {
      headers: { "CF-Connecting-IP": `${prefix}:1:2:3:4` },
      data: { game: "tictactoe" },
    });
    expect(limited.headers()["retry-after"]).toBe("60");
    await expectApiError(limited, 429, "rate_limited");

    // Other clients are unaffected.
    await createLobby(request);
  });
});

/**
 * A refused WebSocket handshake. `vite preview` drops the connection instead of relaying a
 * non-101 handshake response (status 0), so the status itself is checked with a plain request
 * that only carries `Upgrade: websocket`, which the dev server relays like any other response.
 */
function expectRefusedHandshake(status: number) {
  expect(status).not.toBe(101);
}

test.describe("WebSocket handshake", () => {
  test("a plain GET is 426", async ({ request, lobby }) => {
    // The Upgrade response header is hop-by-hop, so the dev server strips it; unit tests cover it.
    const response = await request.get(`/api/lobbies/${lobby.code}/ws`);
    await expectApiError(response, 426, "upgrade_required");
  });

  test("a cross-origin upgrade is 403", async ({ request, lobby }) => {
    const path = `/api/lobbies/${lobby.code}/ws`;
    const response = await request.get(path, {
      headers: { Upgrade: "websocket", Origin: "https://evil.example" },
    });
    await expectApiError(response, 403, "forbidden_origin");
    expectRefusedHandshake(await handshakeStatus(path, { Origin: "https://evil.example" }));
    // Same origin is fine.
    expect(await handshakeStatus(path, { Origin: BASE_URL })).toBe(101);
  });

  test("an unknown or malformed lobby cannot be joined", async ({ request }) => {
    const code = unknownCode();
    await expect(LobbyClient.connect(code)).rejects.toThrow();
    expectRefusedHandshake(await handshakeStatus(`/api/lobbies/${code}/ws`));
    await expectApiError(
      await request.get(`/api/lobbies/${code}/ws`, { headers: { Upgrade: "websocket" } }),
      404,
      "not_found",
    );
    await expectApiError(
      await request.get("/api/lobbies/nope/ws", { headers: { Upgrade: "websocket" } }),
      404,
      "not_found",
    );
    // The attempts above did not create the lobby.
    await expectApiError(await request.get(`/api/lobbies/${code}`), 404, "not_found");
  });

  test(`the ${MAX_SOCKETS_PER_LOBBY + 1}th socket is rejected with 409`, async ({
    request,
    lobby,
  }) => {
    const sockets = [];
    for (let i = 0; i < MAX_SOCKETS_PER_LOBBY; i++) sockets.push(await lobby.connect());

    await expect(LobbyClient.connect(lobby.code)).rejects.toThrow();
    await expectApiError(
      await request.get(`/api/lobbies/${lobby.code}/ws`, { headers: { Upgrade: "websocket" } }),
      409,
      "LOBBY_FULL",
    );

    // Closing one socket frees a slot.
    sockets[0]!.close();
    await sockets[0]!.waitForClose();
    await expect(async () => {
      const client = await LobbyClient.connect(lobby.code);
      client.close();
    }).toPass({ timeout: 5_000 });
  });
});

test.describe("WebSocket protocol", () => {
  test('"ping" is answered with "pong"', async ({ lobby }) => {
    const client = await lobby.connect();
    client.send("ping");
    expect(await client.nextText()).toBe("pong");
  });

  test("a socket must join before anything else", async ({ lobby }) => {
    const client = await lobby.connect();
    client.send({ t: "move", move: { cell: 0 }, seq: 0 });
    expect(await client.next("error")).toMatchObject({ code: "NOT_JOINED" });
    client.send({ t: "rematch" });
    expect(await client.next("error")).toMatchObject({ code: "NOT_JOINED" });

    client.send({ t: "join", name: "Late" });
    expect(await client.next("joined")).toMatchObject({ role: "X" });
    client.send({ t: "join", name: "Again" });
    expect(await client.next("error")).toMatchObject({ code: "BAD_MESSAGE" });
  });

  test("two players play a full game to an X win", async ({ request, lobby }) => {
    const x = await lobby.join("Xena");
    expect(x.joined.role).toBe("X");
    expect(x.joined.token).toEqual(expect.any(String));
    expect(x.state.seq).toBe(1);
    expect(x.state.state).toMatchObject({
      code: lobby.code,
      game: "tictactoe",
      phase: "waiting",
      players: { X: { name: "Xena", connected: true, releaseAt: null }, O: null },
      spectators: 0,
      round: 1,
      firstSeat: "X",
    });

    const o = await lobby.join("Oscar");
    expect(o.joined.role).toBe("O");
    expect(o.joined.token).not.toBe(x.joined.token);
    expect(o.state).toMatchObject({ seq: 2, state: { phase: "playing" } });
    const playing = await x.client.next("state", (m) => m.seq === 2);
    expect(playing.state.players.O).toEqual({ name: "Oscar", connected: true, releaseAt: null });
    expect(playing.state.result).toEqual({ kind: "playing", turn: "X" });

    const both = [x.client, o.client];
    let state: StateMsg = playing;
    for (const [mover, cell] of [
      [x.client, 0],
      [o.client, 3],
      [x.client, 1],
      [o.client, 4],
      [x.client, 2],
    ] as const) {
      state = await move(mover, both, cell, state.seq);
    }
    expect(state.seq).toBe(7);
    expect(state.state.board.board).toEqual(["X", "X", "X", "O", "O", null, null, null, null]);
    expect(state.state.phase).toBe("finished");
    expect(state.state.result).toEqual({ kind: "won", winner: "X", line: [0, 1, 2] });
    expect(state.state.score).toEqual({ X: 1, O: 0, draws: 0 });

    o.client.send({ t: "move", move: { cell: 5 }, seq: 7 });
    expect(await o.client.next("error")).toMatchObject({ code: "GAME_OVER" });

    const summary = await request.get(`/api/lobbies/${lobby.code}`);
    expect(await summary.json()).toMatchObject({ phase: "finished", seatsTaken: 2 });
  });

  test("moves out of turn, on a stale seq or to a taken cell are refused", async ({ lobby }) => {
    const { x, o, seq } = await startGame(lobby);

    o.client.send({ t: "move", move: { cell: 0 }, seq });
    expect(await o.client.next("error")).toMatchObject({ code: "NOT_YOUR_TURN" });

    const after = await move(x.client, [x.client, o.client], 4, seq);
    o.client.send({ t: "move", move: { cell: 0 }, seq });
    expect(await o.client.next("error")).toMatchObject({ code: "STALE_STATE" });

    o.client.send({ t: "move", move: { cell: 4 }, seq: after.seq });
    expect(await o.client.next("error")).toMatchObject({ code: "INVALID_MOVE" });
    o.client.send({ t: "move", move: { cell: 9 }, seq: after.seq });
    expect(await o.client.next("error")).toMatchObject({ code: "INVALID_MOVE" });

    // Refused moves change nothing: the next valid move gets seq + 1.
    const next = await move(o.client, [x.client, o.client], 0, after.seq);
    expect(next.seq).toBe(after.seq + 1);
  });

  test("malformed frames close the socket with 1008", async ({ lobby }) => {
    const { x, o } = await startGame(lobby);

    x.client.send("{not json");
    expect(await x.client.waitForClose()).toEqual({
      code: CLOSE_CODES.policyViolation,
      reason: "Message is not valid JSON.",
    });
    // A seated player closed by the server keeps the seat for the grace period.
    const dropped = await o.client.next("state", (m) => m.state.players.X?.connected === false);
    expect(dropped.state.players.X?.releaseAt).toEqual(expect.any(Number));

    const big = await lobby.connect();
    big.send({ t: "join", name: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(await big.waitForClose()).toEqual({
      code: CLOSE_CODES.policyViolation,
      reason: "Message too large.",
    });

    const binary = await lobby.connect();
    binary.ws.send(new Uint8Array([1, 2, 3]));
    expect(await binary.waitForClose()).toEqual({
      code: CLOSE_CODES.policyViolation,
      reason: "Binary frames are not supported.",
    });

    const unknown = await lobby.connect();
    unknown.send({ t: "dance" });
    expect(await unknown.waitForClose()).toMatchObject({ code: CLOSE_CODES.policyViolation });
  });

  test("more than 10 messages a second close the socket with 1008", async ({ lobby }) => {
    const client = await lobby.connect();
    for (let i = 0; i < 12; i++) client.send({ t: "leave" });
    expect(await client.waitForClose()).toEqual({
      code: CLOSE_CODES.policyViolation,
      reason: "Too many messages",
    });
  });

  test("a player reconnects with their token and keeps the seat", async ({ lobby }) => {
    const { x, o, seq } = await startGame(lobby);
    const oldToken = x.joined.token!;

    const before = Date.now();
    x.client.close();
    const dropped = await o.client.next("state", (m) => m.seq === seq + 1);
    expect(dropped.state.players.X).toMatchObject({ name: "Xena", connected: false });
    const releaseAt = dropped.state.players.X?.releaseAt ?? 0;
    expect(releaseAt).toBeGreaterThanOrEqual(before + RECONNECT_GRACE_MS - 1_000);
    expect(releaseAt).toBeLessThanOrEqual(Date.now() + RECONNECT_GRACE_MS + 1_000);
    expect(dropped.state.phase).toBe("playing");

    const back = await lobby.join("Xena 2", oldToken);
    expect(back.joined.role).toBe("X");
    expect(back.joined.token).not.toBe(oldToken);
    const restored = await o.client.next("state", (m) => m.seq === seq + 2);
    expect(restored.state.players.X).toEqual({ name: "Xena 2", connected: true, releaseAt: null });
    expect(back.state.seq).toBe(seq + 2);

    // The old token no longer reclaims the seat; both seats are held, so it's a spectator.
    const stale = await lobby.join("Thief", oldToken);
    expect(stale.joined).toEqual({ t: "joined", role: "spectator", token: null });

    // The game carries on from where it was.
    await move(back.client, [back.client, o.client], 4, seq + 2);
  });

  test("joining with a seat's token takes the seat over from the open socket", async ({
    lobby,
  }) => {
    const { x, o, seq } = await startGame(lobby);

    const tab2 = await lobby.join("Xena", x.joined.token!);
    expect(tab2.joined.role).toBe("X");
    expect(await x.client.waitForClose()).toEqual({
      code: CLOSE_CODES.seatTakenOver,
      reason: "Seat taken over",
    });
    const state = await o.client.next("state", (m) => m.seq === seq + 1);
    expect(state.state.players.X).toEqual({ name: "Xena", connected: true, releaseAt: null });

    await move(tab2.client, [tab2.client, o.client], 0, seq + 1);
  });

  test("a third socket becomes a spectator and cannot play", async ({ request, lobby }) => {
    const { x, o, seq } = await startGame(lobby);

    const watcher = await lobby.join("Watcher");
    expect(watcher.joined).toEqual({ t: "joined", role: "spectator", token: null });
    // Spectators don't bump seq, so players' in-flight moves stay valid.
    expect(watcher.state.seq).toBe(seq);
    expect(watcher.state.state.spectators).toBe(1);
    expect((await x.client.next("state")).state.spectators).toBe(1);
    await o.client.next("state", (m) => m.state.spectators === 1);

    watcher.client.send({ t: "move", move: { cell: 0 }, seq });
    expect(await watcher.client.next("error")).toMatchObject({ code: "NOT_A_PLAYER" });

    // Spectators receive every state.
    await move(x.client, [x.client, o.client, watcher.client], 0, seq);
    expect(await (await request.get(`/api/lobbies/${lobby.code}`)).json()).toMatchObject({
      seatsTaken: 2,
      spectators: 1,
    });

    watcher.client.close();
    const left = await x.client.next("state", (m) => m.state.spectators === 0);
    expect(left.seq).toBe(seq + 1);
  });

  test("a rematch starts round 2 with O moving first", async ({ lobby }) => {
    const { x, o, seq: start } = await startGame(lobby);
    const both = [x.client, o.client];
    let seq = start;
    for (const [mover, cell] of [
      [x.client, 0],
      [o.client, 3],
      [x.client, 1],
      [o.client, 4],
      [x.client, 2],
    ] as const) {
      seq = (await move(mover, both, cell, seq)).seq;
    }

    x.client.send({ t: "rematch" });
    const asked = await o.client.next("state", (m) => m.seq === seq + 1);
    expect(asked.state.rematch).toEqual({ X: true, O: false });
    expect(asked.state.phase).toBe("finished");

    o.client.send({ t: "rematch" });
    const round2 = await x.client.next("state", (m) => m.seq === seq + 2);
    expect(round2.state).toMatchObject({
      phase: "playing",
      round: 2,
      firstSeat: "O",
      board: { board: Array(9).fill(null), turn: "O" },
      result: { kind: "playing", turn: "O" },
      score: { X: 1, O: 0, draws: 0 },
      rematch: { X: false, O: false },
    });
    await o.client.next("state", (m) => m.seq === seq + 2);

    x.client.send({ t: "move", move: { cell: 4 }, seq: seq + 2 });
    expect(await x.client.next("error")).toMatchObject({ code: "NOT_YOUR_TURN" });
    await move(o.client, both, 4, seq + 2);
  });

  test("leaving frees the seat and resets the match", async ({ request, lobby }) => {
    const { x, o, seq } = await startGame(lobby);
    await move(x.client, [x.client, o.client], 0, seq);

    x.client.send({ t: "leave" });
    expect(await x.client.waitForClose()).toEqual({
      code: CLOSE_CODES.normal,
      reason: "Left the lobby",
    });
    const state = await o.client.next("state", (m) => m.seq === seq + 2);
    expect(state.state).toMatchObject({
      phase: "waiting",
      players: { X: null, O: { name: "Oscar", connected: true } },
      round: 1,
      board: { board: Array(9).fill(null) },
    });
    expect(await (await request.get(`/api/lobbies/${lobby.code}`)).json()).toMatchObject({
      phase: "waiting",
      seatsTaken: 1,
    });

    // The free seat goes to the next player and a new match starts.
    const newcomer = await lobby.join("Nina");
    expect(newcomer.joined.role).toBe("X");
    expect(newcomer.state.state.phase).toBe("playing");
  });

  test("the lobby survives hibernation", async ({ request, lobby }) => {
    // Locally an idle Durable Object is evicted after ~10 s; its sockets stay connected.
    test.slow();
    const { x, o, seq: start } = await startGame(lobby);
    const watcher = await lobby.join("Watcher");
    await x.client.next("state", (m) => m.state.spectators === 1);
    await o.client.next("state", (m) => m.state.spectators === 1);
    const everyone = [x.client, o.client, watcher.client];
    let seq = start;
    for (const [mover, cell] of [
      [x.client, 0],
      [o.client, 4],
      [x.client, 8],
    ] as const) {
      seq = (await move(mover, everyone, cell, seq)).seq;
    }

    await sleep(13_000);

    expect(await (await request.get(`/api/lobbies/${lobby.code}`)).json()).toEqual({
      code: lobby.code,
      game: "tictactoe",
      phase: "playing",
      seatsTaken: 2,
      spectators: 1,
    });
    x.client.send("ping");
    expect(await x.client.nextText()).toBe("pong");

    // Seats, seq and roles come back from storage and attachments.
    x.client.send({ t: "move", move: { cell: 2 }, seq });
    expect(await x.client.next("error")).toMatchObject({ code: "NOT_YOUR_TURN" });
    watcher.client.send({ t: "move", move: { cell: 2 }, seq });
    expect(await watcher.client.next("error")).toMatchObject({ code: "NOT_A_PLAYER" });
    o.client.send({ t: "move", move: { cell: 2 }, seq: seq - 1 });
    expect(await o.client.next("error")).toMatchObject({ code: "STALE_STATE" });

    const after = await move(o.client, everyone, 2, seq);
    expect(after.seq).toBe(seq + 1);
    expect(after.state).toMatchObject({
      phase: "playing",
      players: {
        X: { name: "Xena", connected: true, releaseAt: null },
        O: { name: "Oscar", connected: true, releaseAt: null },
      },
      spectators: 1,
      board: { board: ["X", null, "O", null, "O", null, null, null, "X"], turn: "X" },
    });

    // Closes after hibernation are still accounted for.
    o.client.close();
    const dropped = await x.client.next("state", (m) => m.seq === seq + 2);
    expect(dropped.state.players.O).toMatchObject({ connected: false });
  });
});
