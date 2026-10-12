import {
  CLOSE_CODES,
  MAX_MESSAGES_PER_SECOND,
  MAX_SOCKETS_PER_LOBBY,
  SEATS,
  closeConnection,
  createLobby,
  handleAlarm,
  handleClose,
  handleText,
  isGameId,
  isLobbyCode,
  lobbyExpiresAt,
  lobbySummary,
  nextAlarmAt,
  stateMessage,
  touch,
  type Connection,
  type LobbyRecord,
  type LobbyResult,
  type Role,
} from "@site/game-core";

// Workerd-only globals (WebSocketPair, WebSocketRequestResponsePair) are referenced only inside
// methods: React Router's prerender imports this module in Node, where they don't exist.

const LOBBY_KEY = "lobby";
const noStore = { "Cache-Control": "no-store" };

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: noStore });
}

/**
 * One instance per game lobby: a thin transport around game-core's pure lobby state machine.
 * Persists the LobbyRecord in sync KV storage and keeps every per-socket fact in hibernatable
 * WebSocket attachments, so nothing but the message rate counters lives only in memory.
 */
export class GameLobby implements DurableObject {
  private lobby: LobbyRecord | null;
  /** Sockets this instance has closed or seen close; excluded from broadcasts and counts. */
  private readonly gone = new Set<string>();
  /** Per-socket fixed one-second windows. Reset by hibernation, which is fine. */
  private readonly rates = new Map<string, { windowStart: number; count: number }>();

  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {
    this.lobby = ctx.storage.kv.get<LobbyRecord>(LOBBY_KEY) ?? null;
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/init" && request.method === "POST") return this.init(request);
    if (pathname === "/info" && request.method === "GET") {
      if (!this.lobby) return jsonError(404, "not_found", "Lobby not found.");
      return Response.json(lobbySummary(this.lobby, this.spectatorCount()), { headers: noStore });
    }
    if (pathname === "/ws" && request.method === "GET") return this.upgrade(request);
    return jsonError(404, "not_found", "No such lobby route.");
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The runtime still delivers frames from a socket after the server closed it. `gone` is lost
    // on eviction, but readyState survives hibernation, so such a socket can't rejoin afterwards.
    if (ws.readyState !== WebSocket.OPEN) return;
    const conn = this.connection(ws);
    if (!this.lobby || !conn || this.gone.has(conn.connId)) return;
    const ctx = { now: Date.now(), spectators: this.spectatorCount() };
    let result: LobbyResult;
    if (typeof message !== "string") {
      const reason = "Binary frames are not supported.";
      result = closeConnection(this.lobby, conn, CLOSE_CODES.policyViolation, reason, ctx);
    } else if (this.overRate(conn.connId, ctx.now)) {
      const reason = "Too many messages";
      result = closeConnection(this.lobby, conn, CLOSE_CODES.policyViolation, reason, ctx);
    } else {
      result = handleText(this.lobby, conn, message, ctx);
    }
    await this.apply(result);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  async alarm(): Promise<void> {
    if (!this.lobby) return;
    await this.apply(handleAlarm(this.lobby, { now: Date.now() }));
  }

  private async init(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => null);
    const { code, game } = (body ?? {}) as { code?: unknown; game?: unknown };
    if (!isLobbyCode(code) || !isGameId(game)) {
      return jsonError(400, "bad_request", "Expected { code, game }.");
    }
    if (this.lobby) return jsonError(409, "conflict", "Lobby already exists.");
    this.lobby = createLobby({ code, game, now: Date.now() });
    this.ctx.storage.kv.put(LOBBY_KEY, this.lobby);
    await this.ctx.storage.setAlarm(nextAlarmAt(this.lobby));
    const created = { code, game, expiresAt: lobbyExpiresAt(this.lobby) };
    return Response.json(created, { status: 201, headers: noStore });
  }

  private async upgrade(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonError(426, "upgrade_required", "Expected a WebSocket upgrade.");
    }
    if (!this.lobby) return jsonError(404, "not_found", "Lobby not found.");
    this.pruneGone();
    // Spectators are capped on join (game-core), so a full lobby still has a spare socket per seat:
    // a player reclaiming a held seat must never be refused here.
    if (this.liveSockets().length >= MAX_SOCKETS_PER_LOBBY + SEATS.length) {
      return jsonError(409, "LOBBY_FULL", "This lobby is full.");
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const connId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [connId]);
    server.serializeAttachment({ connId, role: null } satisfies Connection);
    this.lobby = touch(this.lobby, Date.now());
    this.ctx.storage.kv.put(LOBBY_KEY, this.lobby);
    await this.ctx.storage.setAlarm(nextAlarmAt(this.lobby));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async socketGone(ws: WebSocket): Promise<void> {
    const conn = this.connection(ws);
    if (!conn) return;
    this.gone.add(conn.connId);
    this.rates.delete(conn.connId);
    if (this.lobby) await this.apply(handleClose(this.lobby, conn, { now: Date.now() }));
  }

  /** Persists the new record, runs the effects in order, then re-arms the alarm. */
  private async apply(result: LobbyResult): Promise<void> {
    if (result.lobby !== this.lobby) {
      this.lobby = result.lobby;
      this.ctx.storage.kv.put(LOBBY_KEY, result.lobby);
    }
    const lobby = result.lobby;
    for (const effect of result.effects) {
      switch (effect.type) {
        case "send":
          this.send(this.socket(effect.connId), JSON.stringify(effect.msg));
          break;
        case "setRole":
          this.setRole(effect.connId, effect.role);
          break;
        case "close":
          this.close(effect.connId, effect.code, effect.reason);
          break;
        case "broadcastState": {
          const text = JSON.stringify(stateMessage(lobby, this.spectatorCount()));
          for (const { ws, conn } of this.liveSockets()) {
            if (conn.role !== null) this.send(ws, text);
          }
          break;
        }
        case "expire":
          for (const { conn } of this.liveSockets()) {
            this.close(conn.connId, CLOSE_CODES.lobbyExpired, "Lobby expired");
          }
          this.lobby = null;
          await this.ctx.storage.deleteAll(); // also clears the pending alarm
          return;
      }
    }
    await this.ctx.storage.setAlarm(nextAlarmAt(lobby));
  }

  private connection(ws: WebSocket): Connection | null {
    try {
      return (ws.deserializeAttachment() as Connection | null) ?? null;
    } catch {
      return null;
    }
  }

  private socket(connId: string): WebSocket | undefined {
    return this.gone.has(connId) ? undefined : this.ctx.getWebSockets(connId)[0];
  }

  /** Accepted sockets that are open and not closed by us, with their attachments. */
  private liveSockets(): { ws: WebSocket; conn: Connection }[] {
    const live: { ws: WebSocket; conn: Connection }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const conn = this.connection(ws);
      if (conn && !this.gone.has(conn.connId)) live.push({ ws, conn });
    }
    return live;
  }

  /** Forgets closed sockets the runtime no longer lists, so `gone` stays small. */
  private pruneGone(): void {
    const listed = new Set(this.ctx.getWebSockets().flatMap((ws) => this.ctx.getTags(ws)));
    for (const connId of this.gone) if (!listed.has(connId)) this.gone.delete(connId);
  }

  private spectatorCount(): number {
    return this.liveSockets().filter(({ conn }) => conn.role === "spectator").length;
  }

  private setRole(connId: string, role: Role | null): void {
    const ws = this.ctx.getWebSockets(connId)[0];
    try {
      ws?.serializeAttachment({ connId, role } satisfies Connection);
    } catch {
      // The socket is already closing; it is excluded via `gone` instead.
      this.gone.add(connId);
    }
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
    this.gone.add(connId);
    this.rates.delete(connId);
    try {
      ws?.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** Counts a frame against the socket's one-second window; true once it is over the limit. */
  private overRate(connId: string, now: number): boolean {
    const rate = this.rates.get(connId);
    if (!rate || now - rate.windowStart >= 1000) {
      this.rates.set(connId, { windowStart: now, count: 1 });
      return false;
    }
    rate.count += 1;
    return rate.count > MAX_MESSAGES_PER_SECOND;
  }
}
