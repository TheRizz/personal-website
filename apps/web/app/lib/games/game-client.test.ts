import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tictactoe, type PublicState, type ServerMsg } from "@site/game-core";
import type { LobbyLookup } from "./api";
import { GameClient, type SocketLike } from "./game-client";

const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const NEW_TOKEN = "9b2d0c3e-1a7f-4c55-8e21-6f0a4b8d9e10";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;

  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // Server side helpers.
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: ServerMsg | string) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get messages() {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as unknown);
  }
}

const player = (name: string) => ({ name, connected: true, releaseAt: null });
const playing: PublicState = {
  code: "ABC234",
  game: "tictactoe",
  phase: "playing",
  players: { X: player("Ada"), O: player("Bo") },
  spectators: 0,
  board: tictactoe.init("X"),
  result: { kind: "playing", turn: "X" },
  round: 1,
  firstSeat: "X",
  score: { X: 0, O: 0, draws: 0 },
  rematch: { X: false, O: false },
};

function setup({
  token = null as string | null,
  lookup = { kind: "found", full: false } as LobbyLookup,
} = {}) {
  const sockets: FakeSocket[] = [];
  let stored = token;
  const lookups = vi.fn(async () => lookup);
  const client = new GameClient("Ada", {
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    lookupLobby: lookups,
    loadToken: () => stored,
    saveToken: (value) => {
      stored = value;
    },
  });
  return {
    client,
    sockets,
    lookups,
    stored: () => stored,
    last: () => {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("no socket");
      return socket;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("GameClient", () => {
  it("joins with the stored token and stores the new one", () => {
    const { client, last, stored } = setup({ token: TOKEN });
    client.start();
    last().open();
    expect(last().messages).toEqual([{ t: "join", name: "Ada", token: TOKEN }]);
    last().receive({ t: "joined", role: "X", token: NEW_TOKEN });
    expect(stored()).toBe(NEW_TOKEN);
    expect(client.getSnapshot()).toMatchObject({ connection: "open", role: "X" });
  });

  it("joins without a token when none is stored", () => {
    const { client, last } = setup();
    client.start();
    last().open();
    expect(last().messages).toEqual([{ t: "join", name: "Ada" }]);
  });

  it("forgets the token when it comes back as a spectator", () => {
    const { client, last, stored } = setup({ token: TOKEN });
    client.start();
    last().open();
    last().receive({ t: "joined", role: "spectator", token: null });
    expect(stored()).toBeNull();
  });

  it("ignores invalid and unknown messages", () => {
    const { client, last } = setup();
    client.start();
    last().open();
    const before = client.getSnapshot();
    last().receive("pong");
    last().receive("not json");
    last().receive(JSON.stringify({ t: "joined", role: "Z", token: null }));
    last().receive(JSON.stringify({ t: "state", state: { ...playing, board: null }, seq: 1 }));
    expect(client.getSnapshot()).toBe(before);
  });

  it("sends ping every 30 seconds while open", () => {
    const { client, last } = setup();
    client.start();
    last().open();
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    expect(last().sent.filter((s) => s === "ping")).toHaveLength(2);
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(last().sent.filter((s) => s === "ping")).toHaveLength(2);
  });

  it("plays optimistically and reconciles", () => {
    const { client, last } = setup();
    client.start();
    last().open();
    last().receive({ t: "joined", role: "X", token: NEW_TOKEN });
    last().receive({ t: "state", state: playing, seq: 5 });
    expect(client.play(4)).toBe(true);
    expect(last().messages.at(-1)).toEqual({ t: "move", move: { cell: 4 }, seq: 5 });
    expect(client.getSnapshot().pending?.cell).toBe(4);
    expect(client.play(5)).toBe(false);
    last().receive({ t: "error", code: "NOT_YOUR_TURN", message: "no" });
    expect(client.getSnapshot().pending).toBeNull();
    expect(client.getSnapshot().lastError?.code).toBe("NOT_YOUR_TURN");
  });

  it("reconnects with backoff, re-checking the lobby before each attempt", async () => {
    const { client, sockets, last, lookups } = setup();
    client.start();
    last().open();
    last().receive({ t: "joined", role: "X", token: NEW_TOKEN });

    for (const [index, delay] of [500, 1000, 2000, 4000, 8000].entries()) {
      last().drop(1006);
      expect(client.getSnapshot()).toMatchObject({
        connection: "reconnecting",
        attempt: index + 1,
      });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(index + 2);
      expect(lookups).toHaveBeenCalledTimes(index + 1);
    }
    last().drop(1006);
    expect(client.getSnapshot().connection).toBe("failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(6);

    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(7);
    last().open();
    last().receive({ t: "joined", role: "X", token: NEW_TOKEN });
    expect(client.getSnapshot()).toMatchObject({ connection: "open", attempt: 0 });
  });

  it("shows not found instead of reconnecting to a lobby that is gone", async () => {
    const { client, sockets, last } = setup({ lookup: { kind: "notFound" } });
    client.start();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.getSnapshot().connection).toBe("notFound");
    expect(sockets).toHaveLength(1);
  });

  it("gives up on a server that drops every connection right after joining", async () => {
    const { client, sockets, last } = setup();
    client.start();
    for (let i = 0; i < 6; i++) {
      last().open();
      last().receive({ t: "joined", role: "X", token: NEW_TOKEN });
      last().drop(1011);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(client.getSnapshot().connection).toBe("failed");
    expect(sockets).toHaveLength(6);
  });

  it("restores the full reconnect budget after a stable connection", async () => {
    const { client, last } = setup();
    client.start();
    last().open();
    last().receive({ t: "joined", role: "X", token: NEW_TOKEN });
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    last().open();
    last().receive({ t: "joined", role: "X", token: NEW_TOKEN });
    expect(client.getSnapshot().attempt).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.getSnapshot().attempt).toBe(0);
    last().drop(1006);
    expect(client.getSnapshot()).toMatchObject({ connection: "reconnecting", attempt: 1 });
  });

  it("does not reconnect after 4000, 4001 or 1008", async () => {
    for (const code of [4000, 4001, 1008]) {
      const { client, sockets, last } = setup();
      client.start();
      last().open();
      last().drop(code);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      expect(client.getSnapshot().connection).not.toBe("reconnecting");
    }
  });

  it("forgets the token after another tab takes the seat (4000) and rejoins without it", async () => {
    const { client, sockets, last, stored } = setup({ token: TOKEN });
    client.start();
    last().open();
    last().receive({ t: "joined", role: "O", token: NEW_TOKEN });
    last().drop(4000);
    expect(client.getSnapshot().connection).toBe("replaced");
    expect(stored()).toBeNull();

    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    last().open();
    expect(last().messages).toEqual([{ t: "join", name: "Ada" }]);
  });

  it("is safe to stop and start again (React StrictMode)", async () => {
    const { client, sockets } = setup();
    client.start();
    client.stop();
    client.start();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(sockets[0]?.onclose).toBeNull();
    // A stopped client never reconnects on its own.
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
  });

  it("sends leave, forgets the token and stops", async () => {
    const { client, sockets, last, stored } = setup({ token: TOKEN });
    client.start();
    last().open();
    last().receive({ t: "joined", role: "X", token: NEW_TOKEN });
    client.leave();
    expect(sockets[0]?.messages.at(-1)).toEqual({ t: "leave" });
    expect(stored()).toBeNull();
    expect(client.getSnapshot().connection).toBe("left");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("does nothing when sending on a closed socket", () => {
    const { client } = setup();
    client.start();
    expect(client.rematch()).toBe(false);
    expect(client.play(0)).toBe(false);
  });
});
