import {
  CLOSE_CODES,
  JOIN_TIMEOUT_MS,
  LOBBY_IDLE_TTL_MS,
  MAX_SOCKETS_PER_LOBBY,
  MAX_SPECTATORS_PER_LOBBY,
  MAX_UNJOINED_SOCKETS,
  RECONNECT_GRACE_MS,
  UNJOINED_GRACE_MS,
  serverMsgSchema,
  type LobbyRecord,
  type ServerMsg,
} from "@site/game-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameLobby } from "./game-lobby";

/** The parts of a hibernatable server-side WebSocket the DO uses. */
class FakeSocket {
  /** OPEN until the server closes it; then CLOSING, as long as the client doesn't answer. */
  readyState = 1;
  attachment: unknown = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Simulates a socket the runtime already tore down. */
  broken = false;

  serializeAttachment(value: unknown) {
    if (this.broken) throw new Error("socket closed");
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(text: string) {
    if (this.broken || this.closed) throw new Error("socket closed");
    this.sent.push(text);
  }
  close(code: number, reason: string) {
    if (this.broken || this.closed) throw new Error("socket closed");
    this.closed = { code, reason };
    this.readyState = 2;
  }
  /** Server messages received since the last call, validated against the protocol. */
  take(): ServerMsg[] {
    const messages = this.sent.map((text) => serverMsgSchema.parse(JSON.parse(text)));
    this.sent = [];
    return messages;
  }
}

/** An in-memory DurableObjectState: sync KV, alarms and tagged hibernatable sockets. */
function fakeState() {
  const kv = new Map<string, unknown>();
  const sockets: { ws: FakeSocket; tags: string[] }[] = [];
  const storage = {
    alarm: null as number | null,
    kv: {
      get: (key: string) => structuredClone(kv.get(key)),
      put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
      delete: (key: string) => kv.delete(key),
    },
    setAlarm: vi.fn(async (at: number) => {
      storage.alarm = at;
    }),
    deleteAll: vi.fn(async () => {
      kv.clear();
      storage.alarm = null;
    }),
  };
  const state = {
    storage,
    acceptWebSocket: (ws: FakeSocket, tags: string[] = []) => void sockets.push({ ws, tags }),
    getWebSockets: (tag?: string) =>
      sockets.filter((s) => tag === undefined || s.tags.includes(tag)).map((s) => s.ws),
    getTags: (ws: FakeSocket) => sockets.find((s) => s.ws === ws)?.tags ?? [],
    setWebSocketAutoResponse: vi.fn(),
  };
  /** The runtime forgets a socket once its close has been delivered. */
  const forget = (ws: FakeSocket) => {
    sockets.splice(
      sockets.findIndex((s) => s.ws === ws),
      1,
    );
  };
  return { state, kv, sockets, forget, storage };
}

const CODE = "ABCDEF";
let now = 1_800_000_000_000;

beforeEach(() => {
  vi.spyOn(Date, "now").mockImplementation(() => now);
  // Workerd-only globals.
  vi.stubGlobal(
    "WebSocketRequestResponsePair",
    class {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    },
  );
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    },
  );
  // Node's Response rejects status 101; keep the socket so tests can check it.
  const NodeResponse = Response;
  vi.stubGlobal(
    "Response",
    class extends NodeResponse {
      readonly socket: unknown;
      readonly upgraded: boolean;
      constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        const upgraded = init?.status === 101;
        super(body, upgraded ? { ...init, status: 200 } : init);
        this.upgraded = upgraded;
        this.socket = init?.webSocket;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const fake = fakeState();
  const make = () => new GameLobby(fake.state as unknown as DurableObjectState, {} as Env);
  return { ...fake, lobby: make(), make };
}

type Setup = ReturnType<typeof setup>;

async function init(lobby: GameLobby, body: unknown = { code: CODE, game: "tictactoe" }) {
  return lobby.fetch(
    new Request("https://lobby/init", { method: "POST", body: JSON.stringify(body) }),
  );
}

const upgradeRequest = () => new Request("https://lobby/ws", { headers: { Upgrade: "websocket" } });

/** Upgrades and returns the server-side socket the DO accepted. */
async function connect(t: Setup): Promise<FakeSocket> {
  const response = (await t.lobby.fetch(upgradeRequest())) as Response & { upgraded: boolean };
  expect(response.upgraded).toBe(true);
  return t.sockets.at(-1)!.ws;
}

const ws = (socket: FakeSocket) => socket as unknown as WebSocket;
type Attachment = { connId: string; role: string | null; openedAt: number };

async function send(t: Setup, socket: FakeSocket, msg: unknown) {
  await t.lobby.webSocketMessage(ws(socket), typeof msg === "string" ? msg : JSON.stringify(msg));
}

async function join(t: Setup, name: string, token?: string) {
  const socket = await connect(t);
  await send(t, socket, { t: "join", name, ...(token ? { token } : {}) });
  return socket;
}

const stored = (t: Setup) => t.kv.get("lobby") as LobbyRecord | undefined;
const states = (messages: ServerMsg[]) =>
  messages.filter((m): m is Extract<ServerMsg, { t: "state" }> => m.t === "state");

describe("GameLobby /init and /info", () => {
  it("creates the lobby once, persists it and arms the idle alarm", async () => {
    const t = setup();
    expect(t.state.setWebSocketAutoResponse).toHaveBeenCalledOnce();
    expect((await t.lobby.fetch(new Request("https://lobby/info"))).status).toBe(404);

    const created = await init(t.lobby);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      code: CODE,
      game: "tictactoe",
      expiresAt: now + LOBBY_IDLE_TTL_MS,
    });
    expect(stored(t)).toMatchObject({ code: CODE, seq: 0, phase: "waiting" });
    expect(t.storage.alarm).toBe(now + LOBBY_IDLE_TTL_MS);

    expect((await init(t.lobby)).status).toBe(409);
    const info = await t.lobby.fetch(new Request("https://lobby/info"));
    expect(await info.json()).toEqual({
      code: CODE,
      game: "tictactoe",
      phase: "waiting",
      seatsTaken: 0,
      connectedSeats: 0,
      spectators: 0,
    });
  });

  it.each([{}, { code: "nope", game: "tictactoe" }, { code: CODE, game: "chess" }, "x"])(
    "rejects the init body %j with 400 and writes nothing",
    async (body) => {
      const t = setup();
      expect((await init(t.lobby, body)).status).toBe(400);
      expect(t.kv.size).toBe(0);
    },
  );

  it("does not write storage for requests to an unknown lobby", async () => {
    const t = setup();
    expect((await t.lobby.fetch(new Request("https://lobby/info"))).status).toBe(404);
    expect((await t.lobby.fetch(upgradeRequest())).status).toBe(404);
    expect((await t.lobby.fetch(new Request("https://lobby/other"))).status).toBe(404);
    expect(t.kv.size).toBe(0);
    expect(t.storage.setAlarm).not.toHaveBeenCalled();
  });
});

describe("GameLobby /ws", () => {
  it("accepts a tagged socket with an empty attachment and counts it as activity", async () => {
    const t = setup();
    await init(t.lobby);
    now += 60_000;
    const socket = await connect(t);
    const [entry] = t.sockets;
    expect(entry?.tags).toHaveLength(1);
    expect(socket.attachment).toEqual({ connId: entry?.tags[0], role: null, openedAt: now });
    expect(stored(t)?.lastActivityAt).toBe(now);
    // Until it joins, the alarm is due at its join timeout.
    expect(t.storage.alarm).toBe(now + JOIN_TIMEOUT_MS);
    await send(t, socket, { t: "join", name: "Xena" });
    expect(socket.attachment).toMatchObject({ role: "X", openedAt: now });
    expect(t.storage.alarm).toBe(now + LOBBY_IDLE_TTL_MS);
  });

  it("requires an upgrade", async () => {
    const t = setup();
    await init(t.lobby);
    expect((await t.lobby.fetch(new Request("https://lobby/ws"))).status).toBe(426);
  });

  it(`keeps at most ${MAX_UNJOINED_SOCKETS} unjoined sockets, closing the oldest with 4003`, async () => {
    const t = setup();
    await init(t.lobby);
    const sockets = [];
    for (let i = 0; i < MAX_UNJOINED_SOCKETS + 2; i++) {
      sockets.push(await connect(t));
      now += 1;
    }
    // All of them are young enough to be mid-join, so only the hard cap closes any.
    const timedOut = { code: CLOSE_CODES.joinTimeout, reason: "Join timed out" };
    expect(sockets.map((s) => s.closed)).toEqual([
      timedOut,
      timedOut,
      ...Array<null>(MAX_UNJOINED_SOCKETS).fill(null),
    ]);
    // A socket closed this way can't join afterwards.
    await send(t, sockets[0]!, { t: "join", name: "Late" });
    expect(sockets[0]!.take()).toEqual([]);
    expect(stored(t)?.seats.X).toBeNull();
  });

  it("closes a socket that doesn't join in time, from the alarm or the next upgrade", async () => {
    const t = setup();
    await init(t.lobby);
    const idle = await connect(t);
    now += JOIN_TIMEOUT_MS - 1;
    await t.lobby.alarm();
    expect(idle.closed).toBeNull();
    expect(t.storage.alarm).toBe(now + 1);
    now += 1;
    await t.lobby.alarm();
    expect(idle.closed).toEqual({ code: CLOSE_CODES.joinTimeout, reason: "Join timed out" });
    expect(t.storage.alarm).toBe(stored(t)!.lastActivityAt + LOBBY_IDLE_TTL_MS);

    // Without an alarm in between (e.g. it was delayed), the next upgrade closes it.
    const stale = await connect(t);
    now += JOIN_TIMEOUT_MS;
    const fresh = await connect(t);
    expect(stale.closed?.code).toBe(CLOSE_CODES.joinTimeout);
    expect(fresh.closed).toBeNull();
  });

  it("closes stale unjoined sockets, oldest first, past the lobby's free places", async () => {
    const t = setup();
    await init(t.lobby);
    await join(t, "Xena");
    await join(t, "Oscar");
    for (let i = 0; i < MAX_SPECTATORS_PER_LOBBY; i++) await join(t, `Fan ${i}`);
    // The lobby is full, which leaves room for the two seat holders' token reconnects.
    const squatters = [await connect(t), await connect(t), await connect(t)];
    expect(squatters.map((s) => s.closed)).toEqual([null, null, null]);

    // Once they are past the grace period, they no longer count as mid-join.
    now += UNJOINED_GRACE_MS;
    const fresh = await connect(t);
    expect(squatters.map((s) => s.closed?.code ?? null)).toEqual([
      CLOSE_CODES.joinTimeout,
      CLOSE_CODES.joinTimeout,
      null,
    ]);
    expect(fresh.closed).toBeNull();
    // Just under the grace period, a socket is still left alone.
    now += UNJOINED_GRACE_MS - 1;
    await connect(t);
    expect(fresh.closed).toBeNull();
    expect(squatters[2]!.closed?.code).toBe(CLOSE_CODES.joinTimeout);
  });

  it("closes no one when a whole lobby reconnects at once after a restart", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const o = await join(t, "Oscar");
    const tokens = [x, o].map((s) => s.take().find((m) => m.t === "joined")?.token ?? undefined);
    const fans = [];
    for (let i = 0; i < MAX_SPECTATORS_PER_LOBBY; i++) fans.push(await join(t, `Fan ${i}`));
    // A deploy drops every socket.
    const everyone = [x, o, ...fans];
    expect(everyone).toHaveLength(MAX_SOCKETS_PER_LOBBY);
    for (const socket of everyone) {
      await t.lobby.webSocketClose(ws(socket));
      t.forget(socket);
    }
    t.lobby = t.make();

    // Every client upgrades before any of their joins arrives...
    const back = [];
    for (let i = 0; i < everyone.length; i++) {
      back.push(await connect(t));
      now += 100;
    }
    // ...and then they all join, the seat holders with their tokens.
    const names = ["Xena", "Oscar", ...fans.map((_, i) => `Fan ${i}`)];
    for (const [i, socket] of back.entries()) {
      await send(t, socket, {
        t: "join",
        name: names[i],
        ...(tokens[i] ? { token: tokens[i] } : {}),
      });
    }
    expect(back.map((s) => s.closed)).toEqual(Array<null>(everyone.length).fill(null));
    expect(back.map((s) => s.take()[0])).toMatchObject([
      { t: "joined", role: "X" },
      { t: "joined", role: "O" },
      ...Array(MAX_SPECTATORS_PER_LOBBY).fill({ t: "joined", role: "spectator" }),
    ]);
    const connId = (socket: FakeSocket | undefined) => (socket?.attachment as Attachment).connId;
    expect(stored(t)?.seats).toMatchObject({
      X: { connId: connId(back[0]), name: "Xena" },
      O: { connId: connId(back[1]), name: "Oscar" },
    });
    expect(stored(t)?.phase).toBe("playing");
  });

  it("lets a dropped player back in however many sockets sit unjoined", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const token = x.take().find((m) => m.t === "joined")?.token ?? undefined;
    const o = await join(t, "Oscar");
    for (let i = 0; i < MAX_SPECTATORS_PER_LOBBY; i++) await join(t, `Fan ${i}`);
    await t.lobby.webSocketClose(ws(x));
    t.forget(x);

    // Squatters open as many sockets as they may and never join...
    const squatters = [];
    for (let i = 0; i < MAX_UNJOINED_SOCKETS; i++) squatters.push(await connect(t));
    // ...but X still connects and reclaims the seat, and nothing is ever refused.
    o.take();
    const back = await join(t, "Xena", token);
    expect(back.take()[0]).toMatchObject({ t: "joined", role: "X" });
    expect(states(o.take())[0]?.state).toMatchObject({ players: { X: { connected: true } } });
    expect(squatters.filter((s) => s.closed === null)).toHaveLength(MAX_UNJOINED_SOCKETS - 1);
  });

  it("refuses an extra spectator but lets a dropped player reclaim the seat", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const token = x.take().find((m) => m.t === "joined")?.token ?? undefined;
    const o = await join(t, "Oscar");
    for (let i = 0; i < MAX_SPECTATORS_PER_LOBBY; i++) await join(t, `Fan ${i}`);
    await t.lobby.webSocketClose(ws(x));
    t.forget(x);
    o.take();

    // A newcomer's socket takes X's old slot before X is back...
    const lurker = await connect(t);
    // ...but X can still connect and reclaim the seat.
    const back = await join(t, "Xena", token);
    expect(back.take()[0]).toMatchObject({ t: "joined", role: "X" });
    expect(states(o.take())[0]?.state).toMatchObject({
      players: { X: { connected: true } },
      spectators: MAX_SPECTATORS_PER_LOBBY,
    });

    // The newcomer would be spectator number 9: refused and closed.
    await send(t, lurker, { t: "join", name: "Lurker" });
    expect(lurker.take()).toMatchObject([{ t: "error", code: "LOBBY_FULL" }]);
    expect(lurker.closed).toEqual({ code: CLOSE_CODES.lobbyFull, reason: "Lobby full" });
    expect(o.take()).toEqual([]);
  });
});

describe("GameLobby messages", () => {
  it("plays through join, moves and broadcasts with validated messages", async () => {
    const t = setup();
    await init(t.lobby);
    const lurker = await connect(t);
    const x = await join(t, "Xena");
    expect(x.take()).toMatchObject([
      { t: "joined", role: "X" },
      { t: "state", seq: 1 },
    ]);
    expect(x.attachment).toMatchObject({ role: "X" });

    const o = await join(t, "Oscar");
    expect(o.take()).toMatchObject([
      { t: "joined", role: "O" },
      { t: "state", seq: 2 },
    ]);
    expect(states(x.take())).toMatchObject([{ seq: 2, state: { phase: "playing" } }]);

    await send(t, x, { t: "move", move: { cell: 4 }, seq: 2 });
    for (const socket of [x, o]) {
      expect(states(socket.take())[0]?.state.board.board[4]).toBe("X");
    }
    expect(stored(t)?.seq).toBe(3);

    await send(t, x, { t: "move", move: { cell: 0 }, seq: 3 });
    expect(x.take()).toMatchObject([{ t: "error", code: "NOT_YOUR_TURN" }]);
    expect(o.take()).toEqual([]);
    // Sockets that never joined get no broadcasts.
    expect(lurker.take()).toEqual([]);
  });

  it("counts spectators from attachments and keeps state on reload (hibernation)", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const o = await join(t, "Oscar");
    const watcher = await join(t, "Watcher");
    expect(watcher.take()).toMatchObject([
      { t: "joined", role: "spectator", token: null },
      { t: "state", seq: 2, state: { spectators: 1 } },
    ]);
    x.take();
    o.take();

    // Evicted: a new instance with the same storage and sockets.
    t.lobby = t.make();
    const info = await t.lobby.fetch(new Request("https://lobby/info"));
    expect(await info.json()).toMatchObject({ phase: "playing", seatsTaken: 2, spectators: 1 });
    await send(t, x, { t: "move", move: { cell: 0 }, seq: 2 });
    for (const socket of [x, o, watcher]) {
      expect(states(socket.take())).toMatchObject([{ seq: 3, state: { spectators: 1 } }]);
    }
    await send(t, watcher, { t: "move", move: { cell: 1 }, seq: 3 });
    expect(watcher.take()).toMatchObject([{ t: "error", code: "NOT_A_PLAYER" }]);
  });

  it("closes binary frames with 1008 and starts the seat's grace period", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const o = await join(t, "Oscar");
    o.take();

    await t.lobby.webSocketMessage(ws(x), new ArrayBuffer(2));
    expect(x.closed).toEqual({ code: 1008, reason: "Binary frames are not supported." });
    expect(x.attachment).toMatchObject({ role: null });
    expect(states(o.take())[0]?.state.players.X).toMatchObject({
      connected: false,
      releaseAt: now + RECONNECT_GRACE_MS,
    });
    expect(t.storage.alarm).toBe(now + RECONNECT_GRACE_MS);

    // Frames still in flight from the closed socket are ignored (not even counted as activity).
    const before = stored(t);
    now += 5_000;
    await send(t, x, { t: "leave" });
    expect(stored(t)).toEqual(before);
  });

  it("ignores a socket it closed even after eviction, so it can't take its seat back", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const token = x.take().find((m) => m.t === "joined")?.token ?? undefined;
    const o = await join(t, "Oscar");
    await t.lobby.webSocketMessage(ws(x), new ArrayBuffer(2));
    expect(x.closed?.code).toBe(1008);
    o.take();

    // Evicted: the new instance has no memory of closing it, and the client never answered.
    t.lobby = t.make();
    await send(t, x, { t: "join", name: "Zed", token });
    expect(o.take()).toEqual([]);
    expect(stored(t)?.seats.X).toMatchObject({ name: "Xena", connId: null });
    const info = await t.lobby.fetch(new Request("https://lobby/info"));
    expect(await info.json()).toMatchObject({ seatsTaken: 2, connectedSeats: 1 });
  });

  it("closes a socket that sends more than 10 frames in a second", async () => {
    const t = setup();
    await init(t.lobby);
    const socket = await connect(t);
    for (let i = 0; i < 10; i++) await send(t, socket, { t: "rematch" });
    expect(socket.closed).toBeNull();
    // A new one-second window starts fresh.
    now += 1_000;
    for (let i = 0; i < 10; i++) await send(t, socket, { t: "rematch" });
    expect(socket.closed).toBeNull();
    await send(t, socket, { t: "rematch" });
    expect(socket.closed).toEqual({ code: 1008, reason: "Too many messages" });
  });

  it("closes malformed text frames with 1008", async () => {
    const t = setup();
    await init(t.lobby);
    const socket = await connect(t);
    await send(t, socket, "{nope");
    expect(socket.closed).toEqual({ code: 1008, reason: "Message is not valid JSON." });
  });

  it("handles error then close for one socket as a single disconnect", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const o = await join(t, "Oscar");
    o.take();
    const seq = stored(t)?.seq ?? 0;

    x.broken = true;
    await t.lobby.webSocketError(ws(x));
    await t.lobby.webSocketClose(ws(x));
    t.forget(x);
    expect(states(o.take())).toMatchObject([{ seq: seq + 1 }]);
    expect(stored(t)?.seq).toBe(seq + 1);
  });

  it("survives a socket that throws on send during a broadcast", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const o = await join(t, "Oscar");
    x.broken = true;
    await send(t, o, { t: "leave" });
    expect(o.closed).toEqual({ code: 1000, reason: "Left the lobby" });
    expect(stored(t)?.seats.O).toBeNull();
  });

  it("lets a token holder take over the seat, closing the old socket with 4000", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const joined = x.take()[0];
    const token = joined?.t === "joined" ? (joined.token ?? undefined) : undefined;
    const tab2 = await join(t, "Xena", token);
    expect(x.closed).toEqual({ code: 4000, reason: "Seat taken over" });
    expect(tab2.take()[0]).toMatchObject({ t: "joined", role: "X" });
    // The old socket's close event changes nothing.
    const seq = stored(t)?.seq;
    await t.lobby.webSocketClose(ws(x));
    expect(stored(t)?.seq).toBe(seq);
  });
});

describe("GameLobby alarm", () => {
  it("releases a seat whose grace period ran out", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const o = await join(t, "Oscar");
    await t.lobby.webSocketClose(ws(x));
    t.forget(x);
    o.take();

    now += RECONNECT_GRACE_MS;
    await t.lobby.alarm();
    expect(states(o.take())).toMatchObject([
      { state: { phase: "waiting", players: { X: null, O: { name: "Oscar" } } } },
    ]);
    expect(t.storage.alarm).toBe(stored(t)!.lastActivityAt + LOBBY_IDLE_TTL_MS);
  });

  it("expires an idle lobby: closes sockets with 4001 and deletes storage", async () => {
    const t = setup();
    await init(t.lobby);
    const x = await join(t, "Xena");
    const o = await join(t, "Oscar");

    now += LOBBY_IDLE_TTL_MS;
    await t.lobby.alarm();
    expect(x.closed).toEqual({ code: 4001, reason: "Lobby expired" });
    expect(o.closed).toEqual({ code: 4001, reason: "Lobby expired" });
    expect(t.storage.deleteAll).toHaveBeenCalledOnce();
    expect(t.kv.size).toBe(0);
    expect(t.storage.alarm).toBeNull();
    expect((await t.lobby.fetch(new Request("https://lobby/info"))).status).toBe(404);

    // Late close events and alarms for the deleted lobby are no-ops.
    await t.lobby.webSocketClose(ws(x));
    await t.lobby.alarm();
    expect(t.kv.size).toBe(0);
    expect(t.storage.alarm).toBeNull();
  });

  it("re-arms an early alarm without changing anything", async () => {
    const t = setup();
    await init(t.lobby);
    now += 1_000;
    await t.lobby.alarm();
    expect(stored(t)?.seq).toBe(0);
    expect(t.storage.alarm).toBe(stored(t)!.lastActivityAt + LOBBY_IDLE_TTL_MS);
  });
});
