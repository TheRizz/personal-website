import { serverMsgSchema, type ClientMsg } from "@site/game-core";
import type { LobbyLookup } from "./api";
import {
  classifyClose,
  clientReducer,
  initialClientState,
  PING_INTERVAL_MS,
  planMove,
  reconnectDelay,
  STABLE_CONNECTION_MS,
  type ClientAction,
  type ClientState,
} from "./client-state";

// Declared through a method signature so the DOM's handler types (with `this` and specific event
// classes) are assignable to it.
type Handler<E> = { handle(event: E): void }["handle"] | null;

/** The subset of the browser WebSocket the client uses (so tests can pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown>;
  onmessage: Handler<{ data: unknown }>;
  onclose: Handler<{ code: number }>;
  onerror: Handler<unknown>;
}

const OPEN = 1;

export interface GameClientDeps {
  /** Opens a socket to the lobby (resolving the URL lazily, so construction is SSR-safe). */
  openSocket(): SocketLike;
  /** GET /api/lobbies/:code, re-checked before every automatic reconnect. */
  lookupLobby(): Promise<LobbyLookup>;
  loadToken(): string | null;
  saveToken(token: string | null): void;
}

/**
 * One lobby connection: owns the socket, ping and reconnect timers, and the token, and feeds
 * events through the pure clientReducer. Exposes a useSyncExternalStore-style store.
 * start()/stop() may be called repeatedly (React StrictMode runs effects twice).
 */
export class GameClient {
  private state: ClientState = initialClientState;
  private listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by stop() and reconnect() so late callbacks from an older run are ignored. */
  private run = 0;
  private running = false;

  constructor(
    private readonly name: string,
    private readonly deps: GameClientDeps,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.state;

  start = () => {
    if (this.running) return;
    this.running = true;
    this.run += 1;
    this.dispatch({ type: "reconnect" });
    this.connect();
  };

  stop = () => {
    this.running = false;
    this.run += 1;
    this.teardown();
  };

  /** Sends a message if the socket is open. Returns whether it was sent. */
  send = (msg: ClientMsg): boolean => {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  };

  /** Plays a cell optimistically. Returns false (and sends nothing) if the move is not legal. */
  play = (cell: number): boolean => {
    const plan = planMove(this.state, cell);
    if (!plan.ok || !this.send(plan.msg)) return false;
    this.dispatch({ type: "moveSent", pending: plan.pending });
    return true;
  };

  rematch = () => this.send({ t: "rematch" });

  /** Gives up the seat (or stops watching): sends `leave`, forgets the token and disconnects. */
  leave = () => {
    this.send({ t: "leave" });
    this.deps.saveToken(null);
    this.run += 1;
    this.running = false;
    this.teardown();
    this.dispatch({ type: "left" });
  };

  /**
   * Manual reconnect: checks the lobby, then connects afresh. After "replaced" the token is gone,
   * so this tab comes back as a spectator (or takes a seat that has since been freed).
   */
  reconnect = () => {
    if (!this.running) return;
    this.run += 1;
    this.teardown();
    this.dispatch({ type: "reconnect" });
    void this.checkThenConnect(this.run);
  };

  private dispatch(action: ClientAction) {
    const next = clientReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private teardown() {
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000, "Client closed");
    } catch {
      // Already closed.
    }
  }

  private connect() {
    let socket: SocketLike;
    try {
      socket = this.deps.openSocket();
    } catch {
      this.handleClose(1006);
      return;
    }
    this.socket = socket;
    const token = this.deps.loadToken();

    socket.onopen = () => {
      socket.send(
        JSON.stringify(
          token ? { t: "join", name: this.name, token } : { t: "join", name: this.name },
        ),
      );
      this.pingTimer = setInterval(() => {
        if (socket.readyState === OPEN) socket.send("ping");
      }, PING_INTERVAL_MS);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = serverMsgSchema.safeParse(data);
      if (!parsed.success) return;
      const msg = parsed.data;
      // Spectators get a null token: any stored token no longer matches a seat.
      if (msg.t === "joined") {
        this.deps.saveToken(msg.token);
        clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(
          () => this.dispatch({ type: "stable" }),
          STABLE_CONNECTION_MS,
        );
      }
      this.dispatch({ type: "message", msg });
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      clearInterval(this.pingTimer);
      clearTimeout(this.stableTimer);
      this.socket = null;
      // The tab that took the seat over got a fresh token; this tab's copy no longer works.
      if (classifyClose(event.code) === "replaced") this.deps.saveToken(null);
      this.handleClose(event.code);
    };
  }

  private handleClose(code: number) {
    this.dispatch({ type: "closed", code });
    if (this.state.connection !== "reconnecting") return;
    const run = this.run;
    const delay = reconnectDelay(this.state.attempt) ?? 0;
    this.retryTimer = setTimeout(() => void this.checkThenConnect(run), delay);
  }

  /** Re-checks the lobby so an expired or unknown code shows "not found" instead of looping. */
  private async checkThenConnect(run: number) {
    const lookup = await this.deps.lookupLobby();
    if (run !== this.run) return;
    if (lookup.kind === "notFound") {
      this.dispatch({ type: "notFound" });
      return;
    }
    // Still tries when it looks full: the estimate is approximate and spectators come and go.
    if (lookup.kind === "found") this.dispatch({ type: "lobbyChecked", full: lookup.full });
    this.connect();
  }
}
