import { CLOSE_CODES } from "@site/game-core";
import { reconnectDelay } from "../client-state";
import { STEP, step, type GameEvent, type Match } from "./engine";
import {
  SEATS,
  decodeInput,
  parseServerMessage,
  type ClientMessage,
  type RoomView,
  type Seat,
} from "./net";

// The page's side of online play. The room sends a snapshot of the match 30 times a second, but
// by the time one arrives it is already a little old, and a button pressed now reaches the room a
// little later still. So the page shows the match a round trip ahead of the latest snapshot: it
// steps a copy of the snapshot forward with its own buttons (known exactly) and the opponent's
// (as last heard), and stamps each button change with the frame it was shown at, so the room
// applies it at that same frame. When the opponent did something else in the meantime, the next
// snapshot corrects the picture and the page eases the difference out over a few frames.

const STEP_MS = STEP * 1000;
/** Snapshot arrival times kept to find the least delayed one. */
const OFFSET_WINDOW_MS = 3_000;
const RTT_WINDOW_MS = 10_000;
/** Assumed round trip before the first pong. */
const DEFAULT_RTT_MS = 120;
/** Never guess further than this past the latest snapshot (2 s): the connection has stalled. */
export const MAX_PREDICTION = 240;
/** Further than this from where it should be, the page's clock jumps instead of easing. */
const CLOCK_SNAP_FRAMES = 24;

const pruneBefore = (list: { at: number }[], at: number) => {
  while (list.length > 1 && list[0]!.at < at) list.shift();
};

/** Keeps the page's match clock a round trip (plus a margin) ahead of the room's. */
export class FrameClock {
  private epoch = -1;
  /** Arrival time minus frame time of recent snapshots; the smallest was the least delayed. */
  private offsets: { at: number; value: number }[] = [];
  private rtts: { at: number; value: number }[] = [];
  /** Extra lead in ms: grown when inputs reach the room late, shrunk while they're early. */
  margin = 20;
  private frame = 0;
  private last = 0;
  private synced = false;

  onSnapshot(epoch: number, frame: number, now: number, slack: number | null) {
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.offsets = [];
      this.synced = false;
    }
    this.offsets.push({ at: now, value: now - frame * STEP_MS });
    pruneBefore(this.offsets, now - OFFSET_WINDOW_MS);
    if (slack !== null) {
      if (slack < 1) this.margin = Math.min(200, this.margin + 6);
      else if (slack > 6) this.margin = Math.max(10, this.margin - 1);
    }
  }

  onPong(rtt: number, now: number) {
    this.rtts.push({ at: now, value: rtt });
    pruneBefore(this.rtts, now - RTT_WINDOW_MS);
  }

  rtt(): number {
    return this.rtts.length > 0
      ? Math.min(...this.rtts.map((entry) => entry.value))
      : DEFAULT_RTT_MS;
  }

  /** Where the page's clock should be at `now`, or null before the first snapshot. */
  target(now: number): number | null {
    if (this.offsets.length === 0) return null;
    const base = Math.min(...this.offsets.map((entry) => entry.value));
    return (now - base + this.rtt() + this.margin) / STEP_MS;
  }

  /** The frame to show at `now`: real time, nudged toward the target, never before `floor`. */
  advance(now: number, floor: number): number {
    const target = this.target(now);
    if (target === null) return floor;
    if (!this.synced || Math.abs(target - this.frame) > CLOCK_SNAP_FRAMES) {
      this.frame = target;
      this.synced = true;
    } else {
      this.frame += (now - this.last) / STEP_MS;
      this.frame += (target - this.frame) * 0.1;
    }
    this.last = now;
    this.frame = Math.max(this.frame, floor);
    return Math.floor(this.frame);
  }
}

export interface Snapshot {
  frame: number;
  match: Match;
  inputs: [number, number];
}

type Change = { f: number; i: number };

/** The latest change at or before frame `k`, else `fallback`. */
function bitsAt(changes: Change[], k: number, fallback: number): number {
  let bits = fallback;
  for (const change of changes) {
    if (change.f > k) break;
    bits = change.i;
  }
  return bits;
}

/** Steps the latest snapshot forward to the frame the page shows. */
export class Predictor {
  snapshot: Snapshot | null = null;
  /** This page's own button changes, oldest first. */
  private own: Change[] = [];
  /** The other seat's changes the room passed on, oldest first. */
  private theirs: Change[] = [];

  constructor(readonly seat: Seat | null) {}

  setSnapshot(snapshot: Snapshot) {
    // A new match starts again from frame 0.
    if (this.snapshot && snapshot.frame < this.snapshot.frame) {
      this.own = [];
      this.theirs = [];
    }
    this.snapshot = snapshot;
    // The snapshot already holds everything up to its frame; keep the last own change before it,
    // which is still what this page holds.
    const firstLive = this.own.findIndex((change) => change.f > snapshot.frame);
    const keepFrom = firstLive === -1 ? this.own.length - 1 : firstLive - 1;
    this.own = this.own.slice(Math.max(0, keepFrom));
    this.theirs = this.theirs.filter((change) => change.f > snapshot.frame);
  }

  /** The buttons this page holds right now. */
  ownBits(): number {
    return this.own.at(-1)?.i ?? (this.seat === null ? 0 : (this.snapshot?.inputs[this.seat] ?? 0));
  }

  /** Records this page's buttons from `frame` on. Returns false if nothing changed. */
  press(frame: number, bits: number): Change | null {
    if (this.seat === null || bits === this.ownBits()) return null;
    const change = { f: Math.max(frame, this.own.at(-1)?.f ?? 0), i: bits };
    this.own.push(change);
    return change;
  }

  /** The other seat's buttons from `frame` on, passed on by the room. */
  heard(seat: Seat, frame: number, bits: number) {
    if (seat === this.seat) return;
    if (this.snapshot && frame <= this.snapshot.frame) return;
    this.theirs.push({ f: frame, i: bits });
    if (this.theirs.length > 1 && this.theirs.at(-2)!.f > frame) {
      this.theirs.sort((a, b) => a.f - b.f);
    }
  }

  /**
   * The match at `frame`: the snapshot stepped forward with the buttons known so far (the other
   * player is assumed to keep holding what they last held). `onEvent` hears every step's events.
   */
  predict(frame: number, onEvent?: (event: GameEvent, frame: number) => void): Match | null {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    const match = structuredClone(snapshot.match);
    const to = Math.min(frame, snapshot.frame + MAX_PREDICTION);
    for (let k = snapshot.frame; k < to; k++) {
      const inputs = SEATS.map((seat) =>
        decodeInput(bitsAt(seat === this.seat ? this.own : this.theirs, k, snapshot.inputs[seat])),
      );
      const events = step(match, inputs);
      if (onEvent) for (const event of events) onEvent(event, k);
    }
    return match;
  }
}

export type ConnectionStatus =
  | "connecting"
  | "open"
  /** Lost the connection; trying again. */
  | "reconnecting"
  /** Gave up reconnecting; the player can try again. */
  | "offline"
  /** Another tab took this seat. */
  | "replaced"
  | "expired"
  | "full"
  | "left";

export interface RoomState {
  status: ConnectionStatus;
  /** Null until joined, and for spectators. */
  seat: Seat | null;
  joined: boolean;
  room: RoomView | null;
  /** When the countdown ends, in performance.now() time. */
  startsAt: number | null;
  error: string | null;
}

export interface RoomDeps {
  openSocket(): WebSocket;
  loadToken(): string | null;
  saveToken(token: string | null): void;
  now(): number;
}

const PING_MS = 1_000;
/** How long the room may keep showing other buttons than this page holds before they're resent. */
const RESEND_MS = 600;
/** Keep-alive for the plain "ping" the runtime answers, outside a match. */
const KEEPALIVE_MS = 30_000;

/**
 * One room connection: joins, reconnects with backoff, measures the round trip during a match and
 * feeds snapshots to the clock and predictor. React reads `getState` through
 * useSyncExternalStore; the match loop reads `predictor` and `clock` directly every frame.
 */
export class RoomConnection {
  private state: RoomState = {
    status: "connecting",
    seat: null,
    joined: false,
    room: null,
    startsAt: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pinger: ReturnType<typeof setInterval> | undefined;
  private attempt = 0;
  private running = false;
  predictor = new Predictor(null);
  clock = new FrameClock();
  /** Bumped when a snapshot arrives, so the match loop can tell. */
  snapshots = 0;
  private sentAt = 0;

  constructor(
    private readonly join: { name: string; character: string },
    private readonly deps: RoomDeps,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  start = () => {
    if (this.running) return;
    this.running = true;
    this.connect();
  };

  stop = () => {
    this.running = false;
    this.teardown();
  };

  /** Tries again after giving up. */
  retry = () => {
    if (!this.running) return;
    this.teardown();
    this.attempt = 0;
    this.update({ status: "connecting" });
    this.connect();
  };

  send = (msg: ClientMessage): boolean => {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  };

  /**
   * Records and sends this page's buttons from `frame` on, if they changed. If the room still
   * shows other buttons a while later (a new match, a message lost in a reconnect), they are sent
   * again.
   */
  press(frame: number, bits: number) {
    const now = this.deps.now();
    const change = this.predictor.press(frame, bits);
    const { seat } = this.predictor;
    const stale =
      seat !== null &&
      this.predictor.snapshot !== null &&
      this.predictor.snapshot.inputs[seat] !== bits &&
      now - this.sentAt > RESEND_MS;
    if (!change && !stale) return;
    if (this.send({ t: "input", f: change?.f ?? frame, i: bits })) this.sentAt = now;
  }

  pick = (character: string) => this.send({ t: "pick", character });
  ready = () => this.send({ t: "ready" });

  /** Gives up the seat for good. */
  leave = () => {
    this.send({ t: "leave" });
    this.deps.saveToken(null);
    this.running = false;
    this.teardown();
    this.update({ status: "left" });
  };

  private update(change: Partial<RoomState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  private teardown() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    clearInterval(this.pinger);
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
    let socket: WebSocket;
    try {
      socket = this.deps.openSocket();
    } catch {
      this.closed(1006);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      const token = this.deps.loadToken();
      this.send({ t: "join", ...this.join, ...(token ? { token } : {}) });
      let sinceKeepalive = 0;
      this.pinger = setInterval(() => {
        const phase = this.state.room?.phase;
        sinceKeepalive += PING_MS;
        if (phase === "countdown" || phase === "playing" || phase === "paused") {
          this.send({ t: "ping", c: this.deps.now() });
        } else if (sinceKeepalive >= KEEPALIVE_MS && socket.readyState === WebSocket.OPEN) {
          sinceKeepalive = 0;
          socket.send("ping");
        }
      }, PING_MS);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      this.receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      clearInterval(this.pinger);
      this.socket = null;
      this.closed(event.code);
    };
  }

  private receive(text: string) {
    const msg = parseServerMessage(text);
    if (!msg) return;
    const now = this.deps.now();
    switch (msg.t) {
      case "joined":
        this.deps.saveToken(msg.token);
        this.attempt = 0;
        this.predictor = new Predictor(msg.seat);
        this.clock = new FrameClock();
        this.update({ status: "open", seat: msg.seat, joined: true, error: null });
        break;
      case "room":
        this.update({
          room: msg.room,
          startsAt: msg.room.startsIn === null ? null : now + msg.room.startsIn,
        });
        break;
      case "snap":
        this.predictor.setSnapshot({ frame: msg.f, match: msg.m, inputs: msg.i });
        if (this.state.room?.phase === "playing")
          this.clock.onSnapshot(msg.e, msg.f, now, msg.slack);
        this.snapshots += 1;
        break;
      case "in":
        this.predictor.heard(msg.s, msg.f, msg.i);
        break;
      case "pong":
        this.clock.onPong(now - msg.c, now);
        break;
      case "error":
        this.update({ error: msg.message });
        break;
    }
  }

  private closed(code: number) {
    if (!this.running) return;
    if (code === CLOSE_CODES.seatTakenOver) {
      this.deps.saveToken(null);
      return this.update({ status: "replaced" });
    }
    if (code === CLOSE_CODES.lobbyExpired) return this.update({ status: "expired" });
    if (code === CLOSE_CODES.lobbyFull) return this.update({ status: "full" });
    this.attempt += 1;
    const delay = reconnectDelay(this.attempt);
    if (delay === null) return this.update({ status: "offline" });
    this.update({ status: "reconnecting" });
    this.timers.push(setTimeout(() => this.running && this.connect(), delay));
  }
}
