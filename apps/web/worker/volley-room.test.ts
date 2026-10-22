import { CLOSE_CODES } from "@site/game-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STEP, type Match } from "../app/lib/games/volley/engine";
import {
  COUNTDOWN_MS,
  MATCH_IDLE_MS,
  MAX_ROOM_MESSAGES_PER_SECOND,
  ROOM_GRACE_MS,
  ROOM_IDLE_TTL_MS,
  type RoomView,
  type ServerMessage,
} from "../app/lib/games/volley/net";
import { VolleyRoom } from "./volley-room";

/** The parts of a hibernatable server-side WebSocket the room uses. */
class FakeSocket {
  readyState = 1;
  attachment: unknown = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;

  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(text: string) {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(text);
  }
  close(code: number, reason: string) {
    if (this.closed) throw new Error("socket closed");
    this.closed = { code, reason };
    this.readyState = 2;
  }
  /** Messages received since the last call. */
  take(): ServerMessage[] {
    const messages = this.sent.map((text) => JSON.parse(text) as ServerMessage);
    this.sent = [];
    return messages;
  }
}

function fakeState() {
  const kv = new Map<string, unknown>();
  const sockets: { ws: FakeSocket; tags: string[] }[] = [];
  const storage = {
    alarm: null as number | null,
    kv: {
      get: (key: string) => structuredClone(kv.get(key)),
      put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
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
  return { state, kv, sockets, storage };
}

const CODE = "ABCDEF";
const START = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: START });
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
  const NodeResponse = Response;
  vi.stubGlobal(
    "Response",
    class extends NodeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      }
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  const fake = fakeState();
  const make = () => new VolleyRoom(fake.state as unknown as DurableObjectState, {} as Env);
  const room = make();
  const created = await room.fetch(
    new Request("https://lobby/init", {
      method: "POST",
      body: JSON.stringify({ code: CODE, court: "beach", target: 7 }),
    }),
  );
  expect(created.status).toBe(201);
  return { ...fake, room, make };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const ws = (socket: FakeSocket) => socket as unknown as WebSocket;

async function connect(t: Setup): Promise<FakeSocket> {
  await t.room.fetch(new Request("https://lobby/ws", { headers: { Upgrade: "websocket" } }));
  return t.sockets.at(-1)!.ws;
}

async function send(t: Setup, socket: FakeSocket, msg: unknown) {
  await t.room.webSocketMessage(ws(socket), typeof msg === "string" ? msg : JSON.stringify(msg));
}

async function join(t: Setup, name: string, character = "rio", token?: string) {
  const socket = await connect(t);
  await send(t, socket, { t: "join", name, character, ...(token ? { token } : {}) });
  return socket;
}

function lastRoom(messages: ServerMessage[]): RoomView {
  const rooms = messages.filter((m) => m.t === "room");
  return rooms.at(-1)!.room;
}

function snaps(messages: ServerMessage[]) {
  return messages.filter((m): m is Extract<ServerMessage, { t: "snap" }> => m.t === "snap");
}

/** Two players in, both ready, countdown over: the match is running. */
async function playing(t: Setup) {
  const a = await join(t, "Ryan", "rio");
  const b = await join(t, "Sam", "rio");
  await send(t, a, { t: "ready" });
  await send(t, b, { t: "ready" });
  await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
  a.take();
  b.take();
  return { a, b };
}

describe("VolleyRoom", () => {
  it("rejects bad settings and a second init", async () => {
    const t = await setup();
    const again = await t.room.fetch(
      new Request("https://lobby/init", {
        method: "POST",
        body: JSON.stringify({ code: CODE, court: "beach", target: 11 }),
      }),
    );
    expect(again.status).toBe(409);
    const fresh = fakeState();
    const room = new VolleyRoom(fresh.state as unknown as DurableObjectState, {} as Env);
    for (const body of [
      { code: CODE, court: "moon", target: 11 },
      { code: CODE, court: "beach", target: 4 },
    ]) {
      const response = await room.fetch(
        new Request("https://lobby/init", { method: "POST", body: JSON.stringify(body) }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("seats two players with different looks and starts after both are ready", async () => {
    const t = await setup();
    const a = await join(t, "Ryan", "zip");
    expect(a.take()[0]).toMatchObject({ t: "joined", seat: 0 });
    const b = await join(t, "Sam", "zip");
    const joined = b.take();
    expect(joined[0]).toMatchObject({ t: "joined", seat: 1 });
    const room = lastRoom(joined);
    expect(room.phase).toBe("lobby");
    expect(room.players[0]).toMatchObject({ name: "Ryan", character: "zip", ready: false });
    // Same pick as the opponent: the second player gets another colour.
    expect(room.players[1]!.character).not.toBe("zip");

    await send(t, a, { t: "ready" });
    expect(lastRoom(b.take()).players[0]!.ready).toBe(true);
    await send(t, b, { t: "ready" });
    const countdown = lastRoom(a.take());
    expect(countdown).toMatchObject({ phase: "countdown", startsIn: COUNTDOWN_MS });

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    expect(lastRoom(a.take()).phase).toBe("playing");
    await vi.advanceTimersByTimeAsync(1000);
    const received = snaps(b.take());
    expect(received.length).toBeGreaterThanOrEqual(29);
    // 120 steps a second.
    expect(received.at(-1)!.f).toBeGreaterThanOrEqual(118);
    expect(received.at(-1)!.f).toBeLessThanOrEqual(121);
  });

  it("refuses an opponent's colour when picking", async () => {
    const t = await setup();
    const a = await join(t, "Ryan", "rio");
    const b = await join(t, "Sam", "kiki");
    b.take();
    await send(t, b, { t: "pick", character: "rio" });
    expect(b.take()).toContainEqual(expect.objectContaining({ t: "error" }));
    await send(t, b, { t: "pick", character: "zip" });
    expect(lastRoom(a.take()).players[1]!.character).toBe("zip");
  });

  it("applies inputs at the frame they were stamped with and passes them on", async () => {
    const t = await setup();
    const { a, b } = await playing(t);
    await vi.advanceTimersByTimeAsync(100);
    const frame = snaps(a.take()).at(-1)!.f;
    // Ryan holds right from a few frames ahead.
    await send(t, a, { t: "input", f: frame + 6, i: 2 });
    expect(b.take()).toContainEqual({ t: "in", s: 0, f: frame + 6, i: 2 });
    await vi.advanceTimersByTimeAsync(200);
    const snap = snaps(a.take()).at(-1)!;
    expect(snap.i).toEqual([2, 0]);
    // He has run right since frame + 6 (340 px/s).
    const moved = snap.m.players[0]!.x - 200;
    expect(moved).toBeCloseTo((snap.f - frame - 6) * STEP * 340, 0);
  });

  it("applies a late input at once and reports how late it was", async () => {
    const t = await setup();
    const { a, b } = await playing(t);
    await vi.advanceTimersByTimeAsync(200);
    const frame = snaps(a.take()).at(-1)!.f;
    await send(t, a, { t: "input", f: frame - 5, i: 1 });
    expect(b.take()).toContainEqual({ t: "in", s: 0, f: frame, i: 1 });
    await vi.advanceTimersByTimeAsync(40);
    expect(snaps(a.take())[0]!.slack).toBe(-5);
  });

  it("pauses when a player drops out and resumes when they're back with their token", async () => {
    const t = await setup();
    const { a, b } = await playing(t);
    await vi.advanceTimersByTimeAsync(300);
    await t.room.webSocketClose(ws(b));
    const paused = lastRoom(a.take());
    expect(paused).toMatchObject({ phase: "paused", pausedFor: "disconnect" });
    expect(paused.players[1]).toMatchObject({
      connected: false,
      releaseAt: START + 3300 + ROOM_GRACE_MS,
    });

    // The match stays still while paused.
    await vi.advanceTimersByTimeAsync(2000);
    expect(snaps(a.take())).toEqual([]);

    const seatToken = (t.kv.get("room") as { seats: { token: string }[] }).seats[1]!.token;
    const back = await join(t, "Sam", "kiki", seatToken);
    expect(back.take()[0]).toMatchObject({ t: "joined", seat: 1 });
    expect(lastRoom(a.take()).phase).toBe("countdown");
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 100);
    expect(lastRoom(a.take()).phase).toBe("playing");
  });

  it("gives the seat up after the grace period and goes back to the lobby", async () => {
    const t = await setup();
    const { a, b } = await playing(t);
    await t.room.webSocketClose(ws(b));
    vi.setSystemTime(START + COUNTDOWN_MS + ROOM_GRACE_MS + 1);
    await t.room.alarm();
    const room = lastRoom(a.take());
    expect(room).toMatchObject({ phase: "lobby", players: [{ name: "Ryan", ready: false }, null] });
  });

  it("frees the seat at once when a player leaves", async () => {
    const t = await setup();
    const { a, b } = await playing(t);
    await send(t, b, { t: "leave" });
    expect(b.closed?.code).toBe(CLOSE_CODES.normal);
    expect(lastRoom(a.take()).players[1]).toBeNull();
  });

  it("ends the match, counts the win and plays again when both ask", async () => {
    const t = await setup();
    const { a, b } = await playing(t);
    // Match point for Ryan, serving, with the ball about to land on Sam's side.
    const saved = t.kv.get("room") as { match: Match };
    saved.match.score = [6, 0];
    saved.match.serving = 0;
    saved.match.phase = { kind: "rally" };
    Object.assign(saved.match.ball, { x: 760, y: 200, vx: 0, vy: 0, live: true, serving: false });
    t.kv.set("room", saved);
    // A restarted instance (the old one's timers are gone) picks the saved match up.
    vi.clearAllTimers();
    t.room = t.make();
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 3000);
    const room = lastRoom(a.take());
    expect(room).toMatchObject({ phase: "over", winner: 0, wins: [1, 0] });
    b.take();
    await send(t, a, { t: "ready" });
    await send(t, b, { t: "ready" });
    expect(lastRoom(a.take()).phase).toBe("countdown");
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 100);
    expect(snaps(a.take()).at(-1)!.f).toBeLessThan(20);
  });

  it("pauses a match nobody plays", async () => {
    const t = await setup();
    const { a } = await playing(t);
    await send(t, a, { t: "input", f: 0, i: 0 });
    await vi.advanceTimersByTimeAsync(MATCH_IDLE_MS + 1000);
    const messages = a.take();
    const pausedAt = messages.findIndex((m) => m.t === "room" && m.room.phase === "paused");
    expect(pausedAt).toBeGreaterThan(-1);
    expect((messages[pausedAt] as { room: RoomView }).room.pausedFor).toBe("idle");
    await send(t, a, { t: "ready" });
    expect(lastRoom(a.take()).phase).toBe("countdown");
  });

  it("lets spectators watch and closes sockets that flood or send junk", async () => {
    const t = await setup();
    await playing(t);
    const watcher = await join(t, "Ana");
    const received = watcher.take();
    expect(received[0]).toMatchObject({ t: "joined", seat: null, token: null });
    expect(lastRoom(received).spectators).toBe(1);
    expect(snaps(received)).toHaveLength(1);

    const junk = await join(t, "Bo");
    await send(t, junk, "not json");
    expect(junk.closed?.code).toBe(CLOSE_CODES.policyViolation);

    const flood = await join(t, "Cy");
    for (let i = 0; i <= MAX_ROOM_MESSAGES_PER_SECOND; i++) {
      await send(t, flood, { t: "ping", c: i });
    }
    expect(flood.closed?.code).toBe(CLOSE_CODES.policyViolation);
  });

  it("answers pings and expires when idle", async () => {
    const t = await setup();
    const a = await join(t, "Ryan");
    a.take();
    await send(t, a, { t: "ping", c: 42 });
    expect(a.take()).toEqual([{ t: "pong", c: 42 }]);
    vi.setSystemTime(Date.now() + ROOM_IDLE_TTL_MS);
    await t.room.alarm();
    expect(a.closed?.code).toBe(CLOSE_CODES.lobbyExpired);
    expect(t.kv.size).toBe(0);
  });

  it("after a restart, waits for both players before resuming a running match", async () => {
    const t = await setup();
    const { a } = await playing(t);
    await vi.advanceTimersByTimeAsync(500);
    a.take();
    // A new instance (after a deploy) finds the match it saved, with both sockets still there.
    vi.clearAllTimers();
    const restarted = t.make();
    const info = await restarted.fetch(new Request("https://lobby/info"));
    expect(await info.json()).toMatchObject({ phase: "countdown", connectedSeats: 2 });
  });
});
