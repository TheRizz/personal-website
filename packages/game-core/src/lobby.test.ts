import { beforeEach, describe, expect, it } from "vitest";
import {
  CLOSE_CODES,
  LOBBY_IDLE_TTL_MS,
  MAX_NAME_LENGTH,
  MAX_SPECTATORS_PER_LOBBY,
  RECONNECT_GRACE_MS,
} from "./constants";
import {
  closeConnection,
  createLobby,
  handleAlarm,
  handleClose,
  handleMessage,
  handleText,
  lobbyExpiresAt,
  lobbySummary,
  nextAlarmAt,
  publicState,
  stateMessage,
  touch,
  type Connection,
  type LobbyEffect,
  type LobbyRecord,
  type LobbyResult,
} from "./lobby";
import { serverMsgSchema, type ClientMsg, type PublicState, type ServerMsg } from "./protocol";

const T0 = 1_700_000_000_000;
const CODE = "K7QXM2";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

interface Socket {
  conn: Connection;
  inbox: ServerMsg[];
  closed: { code: number; reason: string } | null;
}

/**
 * A miniature Durable Object: keeps the lobby and sockets, runs effects the way the real DO must,
 * and checks the LobbyResult invariants on every step. Like workerd, it still lists a socket the
 * client closed, so roles (attachments) are the only thing deciding broadcasts and the count.
 */
class Sim {
  lobby: LobbyRecord;
  now = T0;
  sockets = new Map<string, Socket>();
  expired = false;
  issued: string[] = [];
  private nextConn = 1;

  constructor() {
    this.lobby = createLobby({ code: CODE, game: "tictactoe", now: this.now });
  }

  get ctx() {
    return {
      now: this.now,
      spectators: this.spectators(),
      newToken: () => {
        const token = `00000000-0000-4000-8000-${String(this.issued.length + 1).padStart(12, "0")}`;
        this.issued.push(token);
        return token;
      },
    };
  }

  /** A WebSocket upgrade. */
  connect(): string {
    const connId = `c${this.nextConn++}`;
    this.sockets.set(connId, { conn: { connId, role: null }, inbox: [], closed: null });
    this.lobby = touch(this.lobby, this.now);
    return connId;
  }

  socket(connId: string): Socket {
    const socket = this.sockets.get(connId);
    if (!socket) throw new Error(`no socket ${connId}`);
    return socket;
  }

  role(connId: string) {
    return this.socket(connId).conn.role;
  }

  spectators(): number {
    return [...this.sockets.values()].filter((s) => s.conn.role === "spectator").length;
  }

  run(step: (lobby: LobbyRecord) => LobbyResult): LobbyEffect[] {
    const before = deepFreeze(this.lobby);
    const { lobby, effects } = step(before);
    checkInvariants(before, lobby, effects);
    this.lobby = lobby;
    for (const effect of effects) this.execute(effect);
    return effects;
  }

  private execute(effect: LobbyEffect): void {
    switch (effect.type) {
      case "send":
        this.deliver(effect.connId, effect.msg);
        break;
      case "setRole":
        this.socket(effect.connId).conn = { connId: effect.connId, role: effect.role };
        break;
      case "close":
        this.socket(effect.connId).closed = { code: effect.code, reason: effect.reason };
        break;
      case "broadcastState": {
        const msg = stateMessage(this.lobby, this.spectators());
        for (const [connId, socket] of this.sockets) {
          if (socket.conn.role !== null) this.deliver(connId, msg);
        }
        break;
      }
      case "expire":
        this.expired = true;
        for (const socket of this.sockets.values()) {
          socket.closed ??= { code: CLOSE_CODES.lobbyExpired, reason: "Lobby expired" };
        }
        break;
    }
  }

  private deliver(connId: string, msg: ServerMsg): void {
    // Everything the server sends must pass the schema the client validates with.
    expect(serverMsgSchema.parse(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
    if (msg.t === "state") {
      const json = JSON.stringify(msg);
      for (const token of this.issued) expect(json).not.toContain(token);
      expect(json).not.toContain('"connId"');
    }
    const socket = this.socket(connId);
    expect(socket.closed, `send to closed socket ${connId}`).toBeNull();
    socket.inbox.push(msg);
  }

  send(connId: string, msg: ClientMsg): LobbyEffect[] {
    return this.run((lobby) => handleMessage(lobby, this.socket(connId).conn, msg, this.ctx));
  }

  text(connId: string, text: string): LobbyEffect[] {
    return this.run((lobby) => handleText(lobby, this.socket(connId).conn, text, this.ctx));
  }

  join(connId: string, name: string, token?: string): ServerMsg {
    this.send(connId, token === undefined ? { t: "join", name } : { t: "join", name, token });
    return this.socket(connId).inbox.find((m) => m.t === "joined")!;
  }

  move(connId: string, cell: number, seq = this.lobby.seq): LobbyEffect[] {
    return this.send(connId, { t: "move", move: { cell }, seq });
  }

  /** The socket closes or errors on the client side. */
  drop(connId: string): LobbyEffect[] {
    const socket = this.socket(connId);
    socket.closed ??= { code: 1006, reason: "" };
    return this.run((lobby) => handleClose(lobby, socket.conn, this.ctx));
  }

  alarm(): LobbyEffect[] {
    return this.run((lobby) => handleAlarm(lobby, this.ctx));
  }

  lastState(connId: string): PublicState {
    const msg = [...this.socket(connId).inbox].reverse().find((m) => m.t === "state");
    if (msg?.t !== "state") throw new Error(`${connId} has no state`);
    return msg.state;
  }

  lastError(connId: string) {
    const msg = this.socket(connId).inbox.at(-1);
    return msg?.t === "error" ? msg.code : undefined;
  }

  tokenOf(connId: string): string {
    const msg = [...this.socket(connId).inbox].reverse().find((m) => m.t === "joined");
    if (msg?.t !== "joined" || !msg.token) throw new Error(`${connId} has no token`);
    return msg.token;
  }

  /** X = first socket, O = second, both joined. */
  seatTwo(): [string, string] {
    const x = this.connect();
    const o = this.connect();
    this.join(x, "Ada");
    this.join(o, "Bob");
    return [x, o];
  }
}

function checkInvariants(before: LobbyRecord, after: LobbyRecord, effects: LobbyEffect[]) {
  const broadcasts = effects.filter((e) => e.type === "broadcastState").length;
  expect(broadcasts).toBeLessThanOrEqual(1);
  if (broadcasts) expect(effects.at(-1)).toEqual({ type: "broadcastState" });
  // seq moves by at most one per event, and only together with a broadcast.
  expect([before.seq, before.seq + 1]).toContain(after.seq);
  if (after.seq !== before.seq) expect(broadcasts).toBe(1);
  // The record round-trips through JSON (it is what the DO persists).
  expect(JSON.parse(JSON.stringify(after))).toEqual(after);
}

let sim: Sim;
beforeEach(() => {
  sim = new Sim();
});

describe("createLobby", () => {
  it("starts waiting, round 1, X first, seq 0", () => {
    expect(sim.lobby).toMatchObject({
      code: CODE,
      game: "tictactoe",
      createdAt: T0,
      lastActivityAt: T0,
      seq: 0,
      phase: "waiting",
      seats: { X: null, O: null },
      round: 1,
      firstSeat: "X",
      score: { X: 0, O: 0, draws: 0 },
      rematch: { X: false, O: false },
    });
    expect(sim.lobby.board).toEqual({ board: Array(9).fill(null), turn: "X" });
  });
});

describe("joining", () => {
  it("seats X then O, starts the game and broadcasts each change", () => {
    const x = sim.connect();
    const o = sim.connect();

    expect(sim.join(x, "Ada")).toEqual({ t: "joined", role: "X", token: sim.issued[0] });
    expect(sim.role(x)).toBe("X");
    expect(sim.lobby.seq).toBe(1);
    expect(sim.lastState(x)).toMatchObject({
      phase: "waiting",
      players: { X: { name: "Ada", connected: true, releaseAt: null }, O: null },
    });

    expect(sim.join(o, "Bob")).toEqual({ t: "joined", role: "O", token: sim.issued[1] });
    expect(sim.lobby.seq).toBe(2);
    for (const id of [x, o]) {
      expect(sim.lastState(id)).toMatchObject({
        phase: "playing",
        players: { X: { name: "Ada" }, O: { name: "Bob" } },
        result: { kind: "playing", turn: "X" },
        round: 1,
        firstSeat: "X",
      });
    }
    // Sockets that have not joined get nothing.
    const lurker = sim.connect();
    sim.move(x, 4);
    expect(sim.socket(lurker).inbox).toEqual([]);
  });

  it("sends the joined message before the state broadcast", () => {
    const x = sim.connect();
    const effects = sim.send(x, { t: "join", name: "Ada" });
    expect(effects.map((e) => e.type)).toEqual(["setRole", "send", "broadcastState"]);
  });

  it("makes a third socket a spectator with no token, without bumping seq", () => {
    const [x] = sim.seatTwo();
    const seq = sim.lobby.seq;
    const s = sim.connect();
    expect(sim.join(s, "Eve")).toEqual({ t: "joined", role: "spectator", token: null });
    expect(sim.role(s)).toBe("spectator");
    expect(sim.lobby.seq).toBe(seq);
    expect(sim.lastState(x).spectators).toBe(1);
    expect(sim.lastState(s).spectators).toBe(1);
  });

  it("rejects a second join on the same socket", () => {
    const [x] = sim.seatTwo();
    const seq = sim.lobby.seq;
    sim.join(x, "Again");
    expect(sim.lastError(x)).toBe("BAD_MESSAGE");
    expect(sim.lobby.seq).toBe(seq);
    expect(sim.lobby.seats.X?.name).toBe("Ada");
  });

  it("treats an unknown token like no token", () => {
    const x = sim.connect();
    sim.join(x, "Ada", "11111111-1111-4111-8111-111111111111");
    expect(sim.role(x)).toBe("X");
  });

  it("uses crypto.randomUUID for tokens by default", () => {
    const x = sim.connect();
    const { lobby, effects } = handleMessage(
      sim.lobby,
      sim.socket(x).conn,
      { t: "join", name: "Ada" },
      { now: T0 },
    );
    expect(lobby.seats.X?.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(effects).toContainEqual({
      type: "send",
      connId: x,
      msg: { t: "joined", role: "X", token: lobby.seats.X?.token },
    });
  });
});

describe("before joining", () => {
  it.each<ClientMsg>([{ t: "move", move: { cell: 0 }, seq: 0 }, { t: "rematch" }, { t: "leave" }])(
    "%j -> NOT_JOINED, socket stays open",
    (msg) => {
      const c = sim.connect();
      const effects = sim.send(c, msg);
      expect(effects).toEqual([
        {
          type: "send",
          connId: c,
          msg: { t: "error", code: "NOT_JOINED", message: expect.any(String) },
        },
      ]);
      expect(sim.socket(c).closed).toBeNull();
    },
  );
});

describe("playing", () => {
  it("plays a full game to a win", () => {
    const [x, o] = sim.seatTwo();
    for (const [id, cell] of [
      [x, 0],
      [o, 3],
      [x, 1],
      [o, 4],
    ] as const)
      sim.move(id, cell);
    expect(sim.lobby.phase).toBe("playing");
    sim.move(x, 2);
    expect(sim.lobby.phase).toBe("finished");
    expect(sim.lastState(o)).toMatchObject({
      phase: "finished",
      result: { kind: "won", winner: "X", line: [0, 1, 2] },
      score: { X: 1, O: 0, draws: 0 },
    });
  });

  it("plays a full game to a draw", () => {
    const [x, o] = sim.seatTwo();
    const cells = [0, 1, 2, 4, 3, 5, 7, 6, 8];
    cells.forEach((cell, i) => sim.move(i % 2 === 0 ? x : o, cell));
    expect(sim.lastState(x)).toMatchObject({
      phase: "finished",
      result: { kind: "draw" },
      score: { X: 0, O: 0, draws: 1 },
    });
  });

  it("increments seq on every move", () => {
    const [x, o] = sim.seatTwo();
    const start = sim.lobby.seq;
    sim.move(x, 0);
    sim.move(o, 1);
    expect(sim.lobby.seq).toBe(start + 2);
    expect(sim.socket(x).inbox.at(-1)).toMatchObject({ t: "state", seq: start + 2 });
  });

  it("rejects a move out of turn without changing anything", () => {
    const [x, o] = sim.seatTwo();
    const before = sim.lobby;
    const effects = sim.move(o, 4);
    expect(sim.lastError(o)).toBe("NOT_YOUR_TURN");
    expect(effects).toHaveLength(1);
    expect({ ...sim.lobby, lastActivityAt: 0 }).toEqual({ ...before, lastActivityAt: 0 });
    expect(sim.socket(x).inbox.at(-1)?.t).toBe("state");
  });

  it("rejects a stale seq before validating the move", () => {
    const [x, o] = sim.seatTwo();
    sim.move(x, 0);
    sim.move(o, 1, sim.lobby.seq - 1);
    expect(sim.lastError(o)).toBe("STALE_STATE");
    // A seq from the future is stale too, and is checked before whose turn it is.
    sim.move(x, 2, sim.lobby.seq + 1);
    expect(sim.lastError(x)).toBe("STALE_STATE");
  });

  it("passes game errors through", () => {
    const [x, o] = sim.seatTwo();
    sim.move(x, 4);
    sim.move(o, 4);
    expect(sim.lastError(o)).toBe("INVALID_MOVE");
    sim.send(o, { t: "move", move: "nonsense", seq: sim.lobby.seq });
    expect(sim.lastError(o)).toBe("INVALID_MOVE");
  });

  it("rejects moves after the game is over", () => {
    const [x, o] = sim.seatTwo();
    for (const [id, cell] of [
      [x, 0],
      [o, 3],
      [x, 1],
      [o, 4],
      [x, 2],
    ] as const)
      sim.move(id, cell);
    sim.move(o, 8);
    expect(sim.lastError(o)).toBe("GAME_OVER");
  });

  it("rejects moves while waiting for an opponent", () => {
    const x = sim.connect();
    sim.join(x, "Ada");
    sim.move(x, 4);
    expect(sim.lastError(x)).toBe("NOT_YOUR_TURN");
    expect(sim.lobby.board.board[4]).toBeNull();
  });

  it("does not let spectators move or ask for a rematch", () => {
    sim.seatTwo();
    const s = sim.connect();
    sim.join(s, "Eve");
    sim.move(s, 0);
    expect(sim.lastError(s)).toBe("NOT_A_PLAYER");
    sim.send(s, { t: "rematch" });
    expect(sim.lastError(s)).toBe("BAD_MESSAGE");
    expect(sim.lobby.board.board[0]).toBeNull();
  });
});

describe("spectators", () => {
  it("leave closes the socket with 1000 and updates the count", () => {
    const [x] = sim.seatTwo();
    const s = sim.connect();
    sim.join(s, "Eve");
    const seq = sim.lobby.seq;
    const effects = sim.send(s, { t: "leave" });
    expect(effects).toContainEqual({
      type: "close",
      connId: s,
      code: 1000,
      reason: "Left the lobby",
    });
    expect(sim.role(s)).toBeNull();
    expect(sim.lastState(x).spectators).toBe(0);
    expect(sim.lobby.seq).toBe(seq);
  });

  it("disconnecting only changes the count", () => {
    const [x] = sim.seatTwo();
    const s = sim.connect();
    sim.join(s, "Eve");
    const before = sim.lobby;
    const inbox = sim.socket(s).inbox.length;
    expect(sim.drop(s)).toEqual([
      { type: "setRole", connId: s, role: null },
      { type: "broadcastState" },
    ]);
    expect(sim.lobby).toEqual(before);
    expect(sim.lastState(x).spectators).toBe(0);
    expect(sim.socket(s).inbox).toHaveLength(inbox);
    // webSocketError then webSocketClose for the same socket: the second call does nothing.
    expect(sim.drop(s)).toEqual([]);
  });

  it("refuses spectators past the cap but always lets a seat holder back in", () => {
    const [x, o] = sim.seatTwo();
    const tokenX = sim.tokenOf(x);
    for (let i = 0; i < MAX_SPECTATORS_PER_LOBBY; i++) sim.join(sim.connect(), `Fan ${i}`);
    expect(sim.spectators()).toBe(MAX_SPECTATORS_PER_LOBBY);
    sim.drop(x);

    // X's seat is held, so a newcomer would be another spectator: refused and closed.
    const lurker = sim.connect();
    const seq = sim.lobby.seq;
    expect(sim.send(lurker, { t: "join", name: "Lurker" })).toEqual([
      {
        type: "send",
        connId: lurker,
        msg: { t: "error", code: "LOBBY_FULL", message: "This lobby is full." },
      },
      { type: "close", connId: lurker, code: CLOSE_CODES.lobbyFull, reason: "Lobby full" },
    ]);
    expect(sim.role(lurker)).toBeNull();
    expect(sim.lobby.seq).toBe(seq);
    expect(sim.lastState(o).spectators).toBe(MAX_SPECTATORS_PER_LOBBY);

    // X comes back with the token and gets the seat.
    const x2 = sim.connect();
    expect(sim.join(x2, "Ada", tokenX)).toMatchObject({ t: "joined", role: "X" });
    expect(sim.lastState(o).players.X).toMatchObject({ connected: true, releaseAt: null });

    // A free seat is never refused either.
    sim.send(o, { t: "leave" });
    expect(sim.join(sim.connect(), "Cleo")).toMatchObject({ t: "joined", role: "O" });
  });
});

describe("disconnect and reconnect", () => {
  it("holds a disconnected player's seat and shows it to the opponent", () => {
    const [x, o] = sim.seatTwo();
    sim.move(x, 4);
    sim.now += 5_000;
    sim.drop(x);
    expect(sim.lobby.seats.X).toMatchObject({
      connId: null,
      releaseAt: sim.now + RECONNECT_GRACE_MS,
    });
    expect(sim.lastState(o).players.X).toEqual({
      name: "Ada",
      connected: false,
      releaseAt: sim.now + RECONNECT_GRACE_MS,
    });
    expect(sim.lobby.phase).toBe("playing");
  });

  it("clears the closing socket's role first, so it gets no broadcast and a repeat is a no-op", () => {
    const [x, o] = sim.seatTwo();
    const inbox = sim.socket(x).inbox.length;
    const seq = sim.lobby.seq;
    expect(sim.drop(x)).toEqual([
      { type: "setRole", connId: x, role: null },
      { type: "broadcastState" },
    ]);
    expect(sim.socket(x).inbox).toHaveLength(inbox);
    expect(sim.lastState(o).players.X?.connected).toBe(false);
    expect(sim.drop(x)).toEqual([]);
    expect(sim.lobby.seq).toBe(seq + 1);
  });

  it("does not give a held seat to a newcomer during the grace period", () => {
    const [x] = sim.seatTwo();
    sim.drop(x);
    const n = sim.connect();
    sim.join(n, "Newcomer");
    expect(sim.role(n)).toBe("spectator");
  });

  it("reconnects with the token: same seat, new name, new token, game intact", () => {
    const [x, o] = sim.seatTwo();
    sim.move(x, 4);
    const oldToken = sim.tokenOf(x);
    sim.drop(x);

    const x2 = sim.connect();
    const joined = sim.join(x2, "Ada L", oldToken);
    expect(joined).toMatchObject({ t: "joined", role: "X" });
    const newToken = sim.tokenOf(x2);
    expect(newToken).not.toBe(oldToken);
    expect(sim.lobby.seats.X).toEqual({
      name: "Ada L",
      token: newToken,
      connId: x2,
      releaseAt: null,
    });
    expect(sim.lastState(o)).toMatchObject({
      phase: "playing",
      players: { X: { name: "Ada L", connected: true, releaseAt: null } },
    });
    expect(sim.lobby.board.board[4]).toBe("X");
    sim.move(o, 0);
    expect(sim.lobby.board.board[0]).toBe("O");

    // The old token no longer reclaims anything.
    sim.drop(x2);
    const thief = sim.connect();
    sim.join(thief, "Mallory", oldToken);
    expect(sim.role(thief)).toBe("spectator");
  });

  it("takes over a seat that is still connected, closing the old socket with 4000", () => {
    const [x, o] = sim.seatTwo();
    const tab2 = sim.connect();
    const effects = sim.send(tab2, { t: "join", name: "Ada", token: sim.tokenOf(x) });
    expect(effects.slice(0, 2)).toEqual([
      { type: "setRole", connId: x, role: null },
      { type: "close", connId: x, code: 4000, reason: "Seat taken over" },
    ]);
    expect(sim.socket(x).closed?.code).toBe(CLOSE_CODES.seatTakenOver);
    expect(sim.role(tab2)).toBe("X");
    expect(sim.lastState(o).players.X?.connected).toBe(true);

    // The old socket's close event arrives later and must not disconnect the new one.
    const before = sim.lobby;
    expect(sim.drop(x)).toEqual([]);
    expect(sim.lobby).toBe(before);
  });

  it("ignores close events from sockets that never joined", () => {
    const c = sim.connect();
    const before = sim.lobby;
    expect(sim.drop(c)).toEqual([]);
    expect(sim.lobby).toBe(before);
  });

  it("treats a socket whose seat moved on as not joined", () => {
    const [x] = sim.seatTwo();
    const tab2 = sim.connect();
    sim.join(tab2, "Ada", sim.tokenOf(x));
    // Pretend the DO never applied the setRole for the old socket.
    const stale: Connection = { connId: x, role: "X" };
    const { effects } = handleMessage(sim.lobby, stale, { t: "rematch" }, sim.ctx);
    expect(effects).toEqual([
      { type: "setRole", connId: x, role: null },
      {
        type: "send",
        connId: x,
        msg: { t: "error", code: "NOT_JOINED", message: expect.any(String) },
      },
    ]);
    // ... and a stale socket may join afresh (here: as a spectator, the seats are full).
    const rejoin = handleMessage(sim.lobby, stale, { t: "join", name: "Ada" }, sim.ctx);
    expect(rejoin.effects).toContainEqual({ type: "setRole", connId: x, role: "spectator" });
    // A late close from it changes nothing in the lobby; it only clears the stale role.
    expect(handleClose(sim.lobby, stale, sim.ctx)).toEqual({
      lobby: sim.lobby,
      effects: [{ type: "setRole", connId: x, role: null }],
    });
  });
});

describe("seat release", () => {
  function finishedMatch(): [string, string] {
    const [x, o] = sim.seatTwo();
    for (const [id, cell] of [
      [x, 0],
      [o, 3],
      [x, 1],
      [o, 4],
      [x, 2],
    ] as const)
      sim.move(id, cell);
    return [x, o];
  }

  it("keeps the seat until the grace period ends, then resets the match", () => {
    const [x, o] = finishedMatch();
    sim.send(o, { t: "rematch" });
    sim.drop(x);
    const releaseAt = sim.lobby.seats.X!.releaseAt!;
    expect(nextAlarmAt(sim.lobby)).toBe(releaseAt);

    sim.now = releaseAt - 1;
    expect(sim.alarm()).toEqual([]);
    expect(sim.lobby.seats.X).not.toBeNull();

    sim.now = releaseAt;
    sim.alarm();
    expect(sim.lobby.seats.X).toBeNull();
    expect(sim.lastState(o)).toMatchObject({
      phase: "waiting",
      players: { X: null, O: { name: "Bob" } },
      round: 1,
      firstSeat: "X",
      score: { X: 0, O: 0, draws: 0 },
      rematch: { X: false, O: false },
      board: { board: Array(9).fill(null), turn: "X" },
    });

    const n = sim.connect();
    sim.join(n, "Cy");
    expect(sim.role(n)).toBe("X");
    expect(sim.lastState(o)).toMatchObject({
      phase: "playing",
      result: { kind: "playing", turn: "X" },
    });
  });

  it("releases both seats in one step when both grace periods are over", () => {
    const [x, o] = sim.seatTwo();
    sim.drop(x);
    sim.now += 1_000;
    sim.drop(o);
    const seq = sim.lobby.seq;
    sim.now += RECONNECT_GRACE_MS;
    sim.alarm();
    expect(sim.lobby.seats).toEqual({ X: null, O: null });
    expect(sim.lobby.phase).toBe("waiting");
    expect(sim.lobby.seq).toBe(seq + 1);
  });

  it("leave releases the seat at once and closes the socket with 1000", () => {
    const [x, o] = finishedMatch();
    const effects = sim.send(x, { t: "leave" });
    expect(effects).toContainEqual({
      type: "close",
      connId: x,
      code: 1000,
      reason: "Left the lobby",
    });
    expect(sim.role(x)).toBeNull();
    expect(sim.lastState(o)).toMatchObject({
      phase: "waiting",
      players: { X: null },
      score: { X: 0 },
    });
    // The leaver's close event is a no-op afterwards.
    expect(sim.drop(x)).toEqual([]);
  });

  it("lets a newcomer take the seat O left", () => {
    const [x, o] = sim.seatTwo();
    sim.send(o, { t: "leave" });
    const n = sim.connect();
    sim.join(n, "Cy");
    expect(sim.role(n)).toBe("O");
    expect(sim.lastState(x).phase).toBe("playing");
  });

  it("resets to an empty lobby when the last player leaves", () => {
    const x = sim.connect();
    sim.join(x, "Ada");
    sim.send(x, { t: "leave" });
    expect(sim.lobby).toMatchObject({ phase: "waiting", seats: { X: null, O: null } });
  });
});

describe("rematch", () => {
  function finishedMatch(): [string, string] {
    const [x, o] = sim.seatTwo();
    for (const [id, cell] of [
      [x, 0],
      [o, 3],
      [x, 1],
      [o, 4],
      [x, 2],
    ] as const)
      sim.move(id, cell);
    return [x, o];
  }

  it("is rejected before the game ends", () => {
    const [x] = sim.seatTwo();
    sim.send(x, { t: "rematch" });
    expect(sim.lastError(x)).toBe("BAD_MESSAGE");
    expect(sim.lobby.rematch).toEqual({ X: false, O: false });
  });

  it("needs both players, then swaps who starts and keeps the score", () => {
    const [x, o] = finishedMatch();
    const seq = sim.lobby.seq;
    sim.send(x, { t: "rematch" });
    expect(sim.lobby.seq).toBe(seq + 1);
    expect(sim.lastState(o)).toMatchObject({ phase: "finished", rematch: { X: true, O: false } });

    // Asking twice changes nothing.
    expect(sim.send(x, { t: "rematch" })).toEqual([]);
    expect(sim.lobby.seq).toBe(seq + 1);

    sim.send(o, { t: "rematch" });
    expect(sim.lastState(x)).toMatchObject({
      phase: "playing",
      round: 2,
      firstSeat: "O",
      score: { X: 1, O: 0, draws: 0 },
      rematch: { X: false, O: false },
      board: { board: Array(9).fill(null), turn: "O" },
      result: { kind: "playing", turn: "O" },
    });

    sim.move(x, 4);
    expect(sim.lastError(x)).toBe("NOT_YOUR_TURN");
    sim.move(o, 4);
    expect(sim.lobby.board.board[4]).toBe("O");
  });

  it("alternates the first seat every round", () => {
    const [x, o] = finishedMatch();
    sim.send(x, { t: "rematch" });
    sim.send(o, { t: "rematch" });
    // Round 2: O starts and wins down the middle column.
    for (const [id, cell] of [
      [o, 1],
      [x, 0],
      [o, 4],
      [x, 2],
      [o, 7],
    ] as const)
      sim.move(id, cell);
    expect(sim.lobby.score).toEqual({ X: 1, O: 1, draws: 0 });
    sim.send(o, { t: "rematch" });
    sim.send(x, { t: "rematch" });
    expect(sim.lobby).toMatchObject({ round: 3, firstSeat: "X", board: { turn: "X" } });
  });
});

describe("activity and expiry", () => {
  it("every client message and connect updates lastActivityAt", () => {
    const x = sim.connect();
    sim.now += 1_000;
    sim.send(x, { t: "rematch" }); // NOT_JOINED, still activity
    expect(sim.lobby.lastActivityAt).toBe(sim.now);
    sim.now += 1_000;
    sim.join(x, "Ada");
    expect(sim.lobby.lastActivityAt).toBe(sim.now);
    sim.now += 1_000;
    sim.join(x, "Ada"); // BAD_MESSAGE, still activity
    expect(sim.lastError(x)).toBe("BAD_MESSAGE");
    expect(sim.lobby.lastActivityAt).toBe(sim.now);
    sim.now += 1_000;
    sim.connect();
    expect(sim.lobby.lastActivityAt).toBe(sim.now);
    expect(lobbyExpiresAt(sim.lobby)).toBe(sim.now + LOBBY_IDLE_TTL_MS);
  });

  it("does not count a disconnect as activity", () => {
    const [x] = sim.seatTwo();
    const last = sim.lobby.lastActivityAt;
    sim.now += 1_000;
    sim.drop(x);
    expect(sim.lobby.lastActivityAt).toBe(last);
  });

  it("expires an idle lobby on the alarm", () => {
    sim.seatTwo();
    sim.now += LOBBY_IDLE_TTL_MS - 1;
    expect(sim.alarm()).toEqual([]);
    expect(sim.expired).toBe(false);
    sim.now += 1;
    expect(sim.alarm()).toEqual([{ type: "expire" }]);
    expect(sim.expired).toBe(true);
    for (const socket of sim.sockets.values()) expect(socket.closed?.code).toBe(4001);
  });

  it("expires rather than releasing seats when both are due", () => {
    const [x] = sim.seatTwo();
    sim.drop(x);
    sim.now += LOBBY_IDLE_TTL_MS;
    expect(sim.alarm()).toEqual([{ type: "expire" }]);
  });

  it("nextAlarmAt is the earliest of every releaseAt and the idle expiry", () => {
    expect(nextAlarmAt(sim.lobby)).toBe(T0 + LOBBY_IDLE_TTL_MS);
    const [x, o] = sim.seatTwo();
    expect(nextAlarmAt(sim.lobby)).toBe(T0 + LOBBY_IDLE_TTL_MS);
    sim.now += 10_000;
    sim.drop(o);
    sim.now += 10_000;
    sim.drop(x);
    expect(nextAlarmAt(sim.lobby)).toBe(T0 + 10_000 + RECONNECT_GRACE_MS);
    // An idle expiry earlier than any release wins.
    const idleSoon = { ...sim.lobby, lastActivityAt: T0 - LOBBY_IDLE_TTL_MS };
    expect(nextAlarmAt(idleSoon)).toBe(T0);
  });
});

describe("handleText", () => {
  it("delegates valid frames to handleMessage", () => {
    const x = sim.connect();
    sim.text(x, JSON.stringify({ t: "join", name: "  Ada  " }));
    expect(sim.lobby.seats.X?.name).toBe("Ada");
  });

  it.each([
    ["bad JSON", "{"],
    ["unknown type", JSON.stringify({ t: "chat" })],
    ["oversized frame", JSON.stringify({ t: "leave", pad: "x".repeat(5000) })],
    ["a name too long", JSON.stringify({ t: "join", name: "x".repeat(MAX_NAME_LENGTH + 1) })],
    ["a negative seq", JSON.stringify({ t: "move", move: { cell: 0 }, seq: -1 })],
    ["a junk key", JSON.stringify({ t: "leave", x: 1 })],
  ])("closes a seated player's socket with 1008 on %s and starts the grace period", (_n, text) => {
    const [x, o] = sim.seatTwo();
    const effects = sim.text(x, text);
    expect(effects.slice(0, 2)).toEqual([
      { type: "setRole", connId: x, role: null },
      { type: "close", connId: x, code: 1008, reason: expect.any(String) },
    ]);
    expect(sim.lobby.seats.X).toMatchObject({
      connId: null,
      releaseAt: sim.now + RECONNECT_GRACE_MS,
    });
    expect(sim.lastState(o).players.X?.connected).toBe(false);
  });

  it("closes on a schema-invalid frame with a short fixed reason", () => {
    const c = sim.connect();
    const junkKey = "k".repeat(200);
    expect(sim.text(c, JSON.stringify({ t: "join", name: "A\u0007", [junkKey]: 1 }))).toEqual([
      { type: "close", connId: c, code: 1008, reason: "Invalid message." },
    ]);
  });

  it("closes an unjoined socket with 1008 without touching the lobby", () => {
    const c = sim.connect();
    const before = sim.lobby;
    expect(sim.text(c, "nope")).toEqual([
      { type: "close", connId: c, code: 1008, reason: "Message is not valid JSON." },
    ]);
    expect(sim.lobby).toEqual(before);
  });

  it("closes a spectator with 1008 and updates the count", () => {
    const [x] = sim.seatTwo();
    const s = sim.connect();
    sim.join(s, "Eve");
    sim.text(s, "[]");
    expect(sim.socket(s).closed?.code).toBe(1008);
    expect(sim.lastState(x).spectators).toBe(0);
  });
});

describe("closeConnection", () => {
  it("lets the DO close a seated socket (e.g. rate limit) as a disconnect", () => {
    const [x, o] = sim.seatTwo();
    sim.run((lobby) =>
      closeConnection(lobby, sim.socket(x).conn, 1008, "Too many messages", sim.ctx),
    );
    expect(sim.socket(x).closed).toEqual({ code: 1008, reason: "Too many messages" });
    expect(sim.lastState(o).players.X?.connected).toBe(false);
    // The runtime's close event afterwards is a no-op.
    expect(sim.drop(x)).toEqual([]);
  });
});

describe("views", () => {
  it("publicState exposes no tokens or connection ids and copies mutable parts", () => {
    const [x] = sim.seatTwo();
    sim.move(x, 4);
    const state = publicState(sim.lobby, 3);
    expect(state).toEqual({
      code: CODE,
      game: "tictactoe",
      phase: "playing",
      players: {
        X: { name: "Ada", connected: true, releaseAt: null },
        O: { name: "Bob", connected: true, releaseAt: null },
      },
      spectators: 3,
      board: { board: [null, null, null, null, "X", null, null, null, null], turn: "O" },
      result: { kind: "playing", turn: "O" },
      round: 1,
      firstSeat: "X",
      score: { X: 0, O: 0, draws: 0 },
      rematch: { X: false, O: false },
    });
    expect(state.board.board).not.toBe(sim.lobby.board.board);
    expect(stateMessage(sim.lobby, 3)).toEqual({ t: "state", state, seq: sim.lobby.seq });
  });

  it("lobbySummary counts seats, including held ones, and connected seats", () => {
    expect(lobbySummary(sim.lobby, 0)).toEqual({
      code: CODE,
      game: "tictactoe",
      phase: "waiting",
      seatsTaken: 0,
      connectedSeats: 0,
      spectators: 0,
    });
    const [x] = sim.seatTwo();
    sim.drop(x);
    expect(lobbySummary(sim.lobby, 2)).toMatchObject({
      phase: "playing",
      seatsTaken: 2,
      connectedSeats: 1,
      spectators: 2,
    });
  });

  it("touch only moves lastActivityAt", () => {
    const touched = touch(sim.lobby, T0 + 5);
    expect(touched).toEqual({ ...sim.lobby, lastActivityAt: T0 + 5 });
    expect(touched).not.toBe(sim.lobby);
  });
});
