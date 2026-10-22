import { CLOSE_CODES, JOIN_TIMEOUT_MS, isLobbyCode } from "@site/game-core";
import { CHARACTERS, characterById } from "../app/lib/games/volley/characters";
import { STEP, createMatch, step, type Match } from "../app/lib/games/volley/engine";
import {
  COUNTDOWN_MS,
  MATCH_IDLE_MS,
  MAX_INPUT_LEAD,
  MAX_ROOM_MESSAGES_PER_SECOND,
  MAX_SPECTATORS,
  ROOM_GRACE_MS,
  ROOM_IDLE_TTL_MS,
  SEATS,
  SNAPSHOT_HZ,
  decodeInput,
  parseClientMessage,
  parseCreateRoom,
  type ClientMessage,
  type RoomPhase,
  type RoomView,
  type Seat,
  type ServerMessage,
} from "../app/lib/games/volley/net";

// Workerd-only globals (WebSocketPair, WebSocketRequestResponsePair) are referenced only inside
// methods: React Router's prerender imports this module in Node, where they don't exist.

const ROOM_KEY = "room";
const noStore = { "Cache-Control": "no-store" };
/** Steps the room catches up at most in one tick; after a longer stall its clock restarts. */
const MAX_CATCH_UP = 60;
/** Sockets beyond the two seats and the spectators, so reconnects and late joins fit. */
const SPARE_SOCKETS = 4;

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: noStore });
}

/** A taken seat. While the player is disconnected `connId` is null and `releaseAt` is set. */
interface SeatRecord {
  name: string;
  character: string;
  /** Secret that reclaims the seat; replaced on every join. Never sent to other sockets. */
  token: string;
  connId: string | null;
  releaseAt: number | null;
  ready: boolean;
}

/** Everything the room persists. The match in it is as of the last save (see `save`). */
interface RoomRecord {
  version: 1;
  code: string;
  court: RoomView["court"];
  target: number;
  createdAt: number;
  lastActivityAt: number;
  seats: [SeatRecord | null, SeatRecord | null];
  phase: RoomPhase;
  pausedFor: RoomView["pausedFor"];
  winner: Seat | null;
  wins: [number, number];
  match: Match | null;
  /** Steps the match has taken. */
  frame: number;
}

/** A socket's serialized attachment. */
interface Attachment {
  connId: string;
  /** null until the socket joins. */
  seat: Seat | "spectator" | null;
  openedAt: number;
}

type LiveSocket = { ws: WebSocket; conn: Attachment };

/**
 * One instance per online Power Volley room. Unlike the turn-based GameLobby it runs the match
 * itself: while both players are in, a timer steps the engine at its fixed 120 Hz, applying each
 * player's buttons at the frame their page stamped them with (or as soon as they arrive, if late),
 * and sends everyone a snapshot 30 times a second. Between matches nothing runs, and the object
 * can hibernate like the lobby does. The record is saved on every room change and at the end of
 * every rally, so after a deploy the match picks up from the last rally.
 */
export class VolleyRoom implements DurableObject {
  private room: RoomRecord | null;
  /** Sockets this instance has closed or seen close; excluded from broadcasts and counts. */
  private readonly gone = new Set<string>();
  private readonly rates = new Map<string, { windowStart: number; count: number }>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private countdown: ReturnType<typeof setTimeout> | null = null;
  private countdownEndsAt = 0;
  /** When the match clock last (re)started, and the frame it started from. */
  private clock = { start: 0, frame: 0 };
  /** Changes whenever the clock restarts, so pages re-measure it. */
  private epoch = 0;
  /** The buttons each seat holds now, and changes waiting for their frame. */
  private inputs: [number, number] = [0, 0];
  private pending: [{ f: number; i: number }[], { f: number; i: number }[]] = [[], []];
  /** Earliest arrival, in frames ahead of the room, of each seat's inputs since the last tick. */
  private slack: [number | null, number | null] = [null, null];
  private lastInputAt = 0;

  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {
    this.room = ctx.storage.kv.get<RoomRecord>(ROOM_KEY) ?? null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    if (this.room) this.restore(this.room);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/init" && request.method === "POST") return this.init(request);
    if (pathname === "/info" && request.method === "GET") {
      if (!this.room) return jsonError(404, "not_found", "Room not found.");
      const seats = this.room.seats;
      return Response.json(
        {
          code: this.room.code,
          phase: this.room.phase,
          seatsTaken: seats.filter(Boolean).length,
          connectedSeats: seats.filter((seat) => seat?.connId).length,
          spectators: this.spectatorCount(),
        },
        { headers: noStore },
      );
    }
    if (pathname === "/ws" && request.method === "GET") return this.upgrade(request);
    return jsonError(404, "not_found", "No such room route.");
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    const conn = this.connection(ws);
    if (!this.room || !conn || this.gone.has(conn.connId)) return;
    const now = Date.now();
    if (typeof message !== "string") {
      return this.drop(conn, CLOSE_CODES.policyViolation, "Binary frames are not supported.");
    }
    if (this.overRate(conn.connId, now)) {
      return this.drop(conn, CLOSE_CODES.policyViolation, "Too many messages");
    }
    const msg = parseClientMessage(message);
    if (!msg) return this.drop(conn, CLOSE_CODES.policyViolation, "Invalid message.");
    this.room.lastActivityAt = now;
    await this.handle(conn, msg, now);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  async alarm(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const now = Date.now();
    if (now >= room.lastActivityAt + ROOM_IDLE_TTL_MS) {
      this.stopClock();
      for (const { conn } of this.liveSockets()) {
        this.close(conn.connId, CLOSE_CODES.lobbyExpired, "Lobby expired");
      }
      this.room = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    for (const { conn } of this.liveSockets()) {
      if (conn.seat === null && now - conn.openedAt >= JOIN_TIMEOUT_MS) {
        this.close(conn.connId, CLOSE_CODES.joinTimeout, "Join timed out");
      }
    }
    for (const seat of SEATS) {
      const record = room.seats[seat];
      if (record?.releaseAt != null && record.releaseAt <= now) this.releaseSeat(seat);
    }
    this.save();
    this.broadcastRoom();
    await this.armAlarm();
  }

  private async init(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
    const { code, ...rest } = body ?? {};
    const settings = parseCreateRoom(rest);
    if (!isLobbyCode(code) || !settings) {
      return jsonError(400, "bad_request", "Expected { code, court, target }.");
    }
    if (this.room) return jsonError(409, "conflict", "Room already exists.");
    const now = Date.now();
    this.room = {
      version: 1,
      code,
      ...settings,
      createdAt: now,
      lastActivityAt: now,
      seats: [null, null],
      phase: "lobby",
      pausedFor: null,
      winner: null,
      wins: [0, 0],
      match: null,
      frame: 0,
    };
    this.save();
    await this.armAlarm();
    return Response.json(
      { code, expiresAt: now + ROOM_IDLE_TTL_MS },
      { status: 201, headers: noStore },
    );
  }

  private async upgrade(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonError(426, "upgrade_required", "Expected a WebSocket upgrade.");
    }
    if (!this.room) return jsonError(404, "not_found", "Room not found.");
    this.pruneGone();
    const now = Date.now();
    // Never refuse: a player coming back must get in. Make room by closing sockets that never
    // joined, oldest first.
    const live = this.liveSockets();
    const unjoined = live
      .filter(({ conn }) => conn.seat === null)
      .sort((a, b) => a.conn.openedAt - b.conn.openedAt);
    let extra = live.length + 1 - (SEATS.length + MAX_SPECTATORS + SPARE_SOCKETS);
    for (const { conn } of unjoined) {
      if (extra <= 0) break;
      this.close(conn.connId, CLOSE_CODES.joinTimeout, "Join timed out");
      extra -= 1;
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const connId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [connId]);
    server.serializeAttachment({ connId, seat: null, openedAt: now } satisfies Attachment);
    this.room.lastActivityAt = now;
    this.save();
    await this.armAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handle(conn: Attachment, msg: ClientMessage, now: number): Promise<void> {
    const room = this.room!;
    if (msg.t === "join") {
      if (conn.seat !== null) return this.sendTo(conn.connId, error("Already joined."));
      return this.join(conn, msg, now);
    }
    if (conn.seat === null) return this.sendTo(conn.connId, error("Join the room first."));
    if (msg.t === "ping") return this.sendTo(conn.connId, { t: "pong", c: msg.c });
    if (msg.t === "leave") {
      this.close(conn.connId, CLOSE_CODES.normal, "Left the room");
      if (conn.seat !== "spectator") this.releaseSeat(conn.seat);
      this.save();
      this.broadcastRoom();
      return this.armAlarm();
    }
    if (conn.seat === "spectator") return this.sendTo(conn.connId, error("Spectators can't play."));
    const seat = conn.seat;
    const record = room.seats[seat];
    if (record?.connId !== conn.connId) return;

    switch (msg.t) {
      case "input":
        return this.input(seat, msg.f, msg.i, now);
      case "pick": {
        if (room.phase !== "lobby" && room.phase !== "over") return;
        if (room.seats[otherSeat(seat)]?.character === msg.character) {
          return this.sendTo(conn.connId, error("Your opponent is playing that one."));
        }
        record.character = msg.character;
        break;
      }
      case "ready":
        if (room.phase === "lobby" || room.phase === "over") {
          record.ready = true;
          const [a, b] = room.seats;
          if (a?.ready && b?.ready && a.connId && b.connId) this.startMatch();
        } else if (room.phase === "paused" && room.pausedFor === "idle") {
          this.beginCountdown();
        }
        break;
    }
    this.save();
    this.broadcastRoom();
  }

  private async join(
    conn: Attachment,
    msg: Extract<ClientMessage, { t: "join" }>,
    now: number,
  ): Promise<void> {
    const room = this.room!;
    const reclaimed =
      msg.token === undefined ? undefined : SEATS.find((s) => room.seats[s]?.token === msg.token);
    const seat = reclaimed ?? SEATS.find((s) => room.seats[s] === null);

    if (seat === undefined) {
      if (this.spectatorCount() >= MAX_SPECTATORS) {
        this.sendTo(conn.connId, error("This room is full."));
        this.close(conn.connId, CLOSE_CODES.lobbyFull, "Lobby full");
        return;
      }
      this.setSeat(conn.connId, "spectator");
      this.sendTo(conn.connId, { t: "joined", seat: null, token: null });
      this.broadcastRoom();
      this.sendSnapTo(conn.connId);
      return;
    }

    const previous = room.seats[seat];
    if (previous?.connId) {
      this.setSeat(previous.connId, null);
      this.close(previous.connId, CLOSE_CODES.seatTakenOver, "Seat taken over");
    }
    // Two players never look the same: someone who picks their opponent's colour gets another.
    const theirs = room.seats[otherSeat(seat)]?.character;
    const character =
      msg.character !== theirs
        ? msg.character
        : (CHARACTERS.find((entry) => entry.id !== theirs)?.id ?? msg.character);
    const token = crypto.randomUUID();
    room.seats[seat] = {
      name: msg.name,
      character: previous && reclaimed !== undefined ? previous.character : character,
      token,
      connId: conn.connId,
      releaseAt: null,
      ready: previous && reclaimed !== undefined ? previous.ready : false,
    };
    this.setSeat(conn.connId, seat);
    this.sendTo(conn.connId, { t: "joined", seat, token });
    room.lastActivityAt = now;
    if (room.phase === "paused" && room.pausedFor === "disconnect") this.resumeIfBothHere();
    this.save();
    this.broadcastRoom();
    this.sendSnapTo(conn.connId);
    await this.armAlarm();
  }

  private input(seat: Seat, frame: number, bits: number, now: number) {
    const room = this.room!;
    if (room.phase !== "countdown" && room.phase !== "playing") return;
    if (frame > room.frame + MAX_INPUT_LEAD) return;
    const early = frame - room.frame;
    this.slack[seat] = Math.min(this.slack[seat] ?? early, early);
    const at = Math.max(frame, room.frame);
    const queue = this.pending[seat];
    queue.push({ f: at, i: bits });
    if (queue.length > 1 && queue.at(-2)!.f > at) queue.sort((a, b) => a.f - b.f);
    this.lastInputAt = now;
    const text = JSON.stringify({ t: "in", s: seat, f: at, i: bits } satisfies ServerMessage);
    for (const { ws, conn } of this.liveSockets()) {
      if (conn.seat !== null && conn.seat !== seat) this.send(ws, text);
    }
  }

  /** A new match between the two seated players, after the countdown. */
  private startMatch() {
    const room = this.room!;
    const [a, b] = room.seats;
    room.match = createMatch({
      characters: [characterById(a!.character), characterById(b!.character)],
      target: room.target,
      court: room.court,
      seed: crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1,
    });
    room.frame = 0;
    room.winner = null;
    for (const seat of room.seats) if (seat) seat.ready = false;
    this.inputs = [0, 0];
    this.pending = [[], []];
    this.beginCountdown();
  }

  private beginCountdown() {
    const room = this.room!;
    this.stopClock();
    room.phase = "countdown";
    room.pausedFor = null;
    this.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    this.countdown = setTimeout(() => this.run(), COUNTDOWN_MS);
    this.broadcastSnap();
  }

  private run() {
    const room = this.room;
    this.countdown = null;
    if (!room?.match || room.phase !== "countdown") return;
    room.phase = "playing";
    this.epoch += 1;
    this.clock = { start: Date.now(), frame: room.frame };
    this.lastInputAt = Date.now();
    this.ticker = setInterval(() => this.tick(), 1000 / SNAPSHOT_HZ);
    this.save();
    this.broadcastRoom();
    this.broadcastSnap();
  }

  /** Steps the match up to the present, then sends a snapshot. */
  private tick() {
    const room = this.room;
    if (!room?.match || room.phase !== "playing") return this.stopClock();
    const now = Date.now();
    let due = this.clock.frame + Math.floor((now - this.clock.start) / (STEP * 1000));
    if (due - room.frame > MAX_CATCH_UP) {
      // The object stalled: carry on from here rather than fast-forwarding through it.
      due = room.frame + MAX_CATCH_UP;
      this.epoch += 1;
      this.clock = { start: now, frame: due };
    }
    let rallyOver = false;
    let winner: Seat | null = null;
    while (room.frame < due && winner === null) {
      for (const seat of SEATS) {
        const queue = this.pending[seat];
        while (queue.length > 0 && queue[0]!.f <= room.frame) this.inputs[seat] = queue.shift()!.i;
      }
      const events = step(room.match, [decodeInput(this.inputs[0]), decodeInput(this.inputs[1])]);
      room.frame += 1;
      for (const event of events) {
        if (event.type === "rally-over") rallyOver = true;
        if (event.type === "win") winner = event.winner;
      }
    }
    this.broadcastSnap();
    if (winner !== null) {
      this.stopClock();
      room.phase = "over";
      room.winner = winner;
      room.wins[winner] += 1;
      this.save();
      this.broadcastRoom();
    } else if (now - this.lastInputAt > MATCH_IDLE_MS) {
      this.pause("idle");
      this.broadcastRoom();
    } else if (rallyOver) {
      this.save();
    }
  }

  private pause(reason: "disconnect" | "idle") {
    const room = this.room!;
    this.stopClock();
    room.phase = "paused";
    room.pausedFor = reason;
    this.save();
  }

  private resumeIfBothHere() {
    const [a, b] = this.room!.seats;
    if (a?.connId && b?.connId) this.beginCountdown();
  }

  private stopClock() {
    if (this.ticker) clearInterval(this.ticker);
    if (this.countdown) clearTimeout(this.countdown);
    this.ticker = null;
    this.countdown = null;
  }

  /** Gives up a seat: whoever is left is back in the lobby, waiting for a new opponent. */
  private releaseSeat(seat: Seat) {
    const room = this.room!;
    this.stopClock();
    room.seats[seat] = null;
    room.phase = "lobby";
    room.pausedFor = null;
    room.winner = null;
    room.wins = [0, 0];
    room.match = null;
    room.frame = 0;
    const other = room.seats[otherSeat(seat)];
    if (other) other.ready = false;
  }

  /**
   * After a restart (a deploy, or eviction) the timers are gone: a match that was running waits
   * for both players, who reconnect on their own. Seats whose socket didn't survive start their
   * grace period.
   */
  private restore(room: RoomRecord) {
    const live = new Set(this.liveSockets().map(({ conn }) => conn.connId));
    const now = Date.now();
    for (const seat of room.seats) {
      if (seat?.connId && !live.has(seat.connId)) {
        seat.connId = null;
        seat.releaseAt = now + ROOM_GRACE_MS;
      }
    }
    if (room.phase === "countdown" || room.phase === "playing") {
      room.phase = "paused";
      room.pausedFor = "disconnect";
      this.resumeIfBothHere();
    }
    this.save();
  }

  private async socketGone(ws: WebSocket): Promise<void> {
    const conn = this.connection(ws);
    if (!conn) return;
    this.gone.add(conn.connId);
    this.rates.delete(conn.connId);
    await this.disconnected(conn);
  }

  /** Closes a misbehaving socket; a seated player gets the usual grace period. */
  private async drop(conn: Attachment, code: number, reason: string): Promise<void> {
    this.close(conn.connId, code, reason);
    await this.disconnected(conn);
  }

  /** A seated player's socket went away: hold the seat, and pause a running match. */
  private async disconnected(conn: Attachment): Promise<void> {
    const room = this.room;
    if (!room || conn.seat === null) return;
    if (conn.seat !== "spectator") {
      const record = room.seats[conn.seat];
      if (record?.connId !== conn.connId) return;
      record.connId = null;
      record.releaseAt = Date.now() + ROOM_GRACE_MS;
      if (room.phase === "countdown" || room.phase === "playing") this.pause("disconnect");
      this.save();
      await this.armAlarm();
    }
    this.broadcastRoom();
  }

  private view(): RoomView {
    const room = this.room!;
    const player = (seat: SeatRecord | null) =>
      seat && {
        name: seat.name,
        character: seat.character,
        connected: seat.connId !== null,
        releaseAt: seat.releaseAt,
        ready: seat.ready,
      };
    return {
      code: room.code,
      court: room.court,
      target: room.target,
      players: [player(room.seats[0]), player(room.seats[1])],
      spectators: this.spectatorCount(),
      phase: room.phase,
      startsIn: room.phase === "countdown" ? Math.max(0, this.countdownEndsAt - Date.now()) : null,
      pausedFor: room.pausedFor,
      winner: room.winner,
      wins: [...room.wins],
    };
  }

  private broadcastRoom() {
    if (!this.room) return;
    const text = JSON.stringify({ t: "room", room: this.view() } satisfies ServerMessage);
    for (const { ws, conn } of this.liveSockets()) if (conn.seat !== null) this.send(ws, text);
  }

  private snapText(slack: number | null): string | null {
    const room = this.room;
    if (!room?.match) return null;
    const match = JSON.stringify(room.match);
    const inputs = JSON.stringify(this.inputs);
    return `{"t":"snap","f":${room.frame},"e":${this.epoch},"m":${match},"i":${inputs},"slack":${slack}}`;
  }

  private broadcastSnap() {
    const room = this.room;
    if (!room?.match) return;
    const match = JSON.stringify(room.match);
    const head = `{"t":"snap","f":${room.frame},"e":${this.epoch},"m":${match},"i":${JSON.stringify(this.inputs)},"slack":`;
    for (const { ws, conn } of this.liveSockets()) {
      if (conn.seat === null) continue;
      const slack = conn.seat === "spectator" ? null : this.slack[conn.seat];
      this.send(ws, `${head}${slack}}`);
    }
    this.slack = [null, null];
  }

  private sendSnapTo(connId: string) {
    const text = this.snapText(null);
    if (text) this.send(this.socket(connId), text);
  }

  private save() {
    if (this.room) this.ctx.storage.kv.put(ROOM_KEY, this.room);
  }

  /** The room's next alarm: idle expiry, a seat's release or an unjoined socket's timeout. */
  private async armAlarm(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const times = [room.lastActivityAt + ROOM_IDLE_TTL_MS];
    for (const seat of room.seats) if (seat?.releaseAt != null) times.push(seat.releaseAt);
    for (const { conn } of this.liveSockets()) {
      if (conn.seat === null) times.push(conn.openedAt + JOIN_TIMEOUT_MS);
    }
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  private connection(ws: WebSocket): Attachment | null {
    try {
      return (ws.deserializeAttachment() as Attachment | null) ?? null;
    } catch {
      return null;
    }
  }

  private socket(connId: string): WebSocket | undefined {
    return this.gone.has(connId) ? undefined : this.ctx.getWebSockets(connId)[0];
  }

  private liveSockets(): LiveSocket[] {
    const live: LiveSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const conn = this.connection(ws);
      if (conn && !this.gone.has(conn.connId)) live.push({ ws, conn });
    }
    return live;
  }

  private pruneGone(): void {
    const listed = new Set(this.ctx.getWebSockets().flatMap((ws) => this.ctx.getTags(ws)));
    for (const connId of this.gone) if (!listed.has(connId)) this.gone.delete(connId);
  }

  private spectatorCount(): number {
    return this.liveSockets().filter(({ conn }) => conn.seat === "spectator").length;
  }

  private setSeat(connId: string, seat: Attachment["seat"]): void {
    const ws = this.ctx.getWebSockets(connId)[0];
    if (!ws) return;
    try {
      const openedAt = this.connection(ws)?.openedAt ?? 0;
      ws.serializeAttachment({ connId, seat, openedAt } satisfies Attachment);
    } catch {
      this.gone.add(connId);
    }
  }

  private sendTo(connId: string, msg: ServerMessage): void {
    this.send(this.socket(connId), JSON.stringify(msg));
  }

  private send(ws: WebSocket | undefined, text: string): void {
    try {
      ws?.send(text);
    } catch {
      // Closing socket; its close event will be handled separately.
    }
  }

  private close(connId: string, code: number, reason: string): void {
    const ws = this.socket(connId);
    this.setSeat(connId, null);
    this.gone.add(connId);
    this.rates.delete(connId);
    try {
      ws?.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private overRate(connId: string, now: number): boolean {
    const rate = this.rates.get(connId);
    if (!rate || now - rate.windowStart >= 1000) {
      this.rates.set(connId, { windowStart: now, count: 1 });
      return false;
    }
    rate.count += 1;
    return rate.count > MAX_ROOM_MESSAGES_PER_SECOND;
  }
}

const otherSeat = (seat: Seat): Seat => (seat === 0 ? 1 : 0);

const error = (message: string): ServerMessage => ({ t: "error", message });
