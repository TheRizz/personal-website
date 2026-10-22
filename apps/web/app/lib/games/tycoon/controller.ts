import {
  AUTOSAVE_MS,
  MAX_CLICKS_PER_SECOND,
  advance,
  apply,
  cloneState,
  replay,
  type Action,
  type GameState,
  type GoldenKind,
  type Outcome,
} from "@site/tycoon-core";
import { TycoonApiError, startSession, uploadSave, type ApiFailure } from "./api";

// The client side of ADR-0006. The game runs here, every frame, on `local`; every action is also
// written to a log. Saves upload the log; the server replays it onto its own state and sends that
// back, and `local` is rebuilt from the server's state plus whatever happened while the save was
// in flight. So the client never holds progress the server didn't confirm for long.

/** Save early when the log gets this long, so a keepalive save on unload fits in 64 KB. */
const FLUSH_AT_ACTIONS = 1_500;
/** Clicks within this window go into one log entry. */
const CLICK_MERGE_MS = 1_000;
/** "While you were away" shows only after at least this long. */
const OFFLINE_NOTICE_MS = 60_000;
/** After a failed save, try again this much later. */
const RETRY_MS = 30_000;

export type GameEvent =
  | { type: "click"; earned: number; count: number }
  | { type: "buy"; tier: number; count: number }
  | { type: "upgrade"; id: string }
  | { type: "golden"; kind: GoldenKind; earned?: number }
  | { type: "achievement"; ids: string[] }
  | { type: "migrate" }
  | { type: "ending" }
  | { type: "dropped"; count: number };

export type Status =
  { kind: "loading" } | { kind: "playing" } | { kind: "stopped"; failure: ApiFailure };

/** An action before it gets its time. */
type Untimed = Action extends infer A ? (A extends Action ? Omit<A, "t"> : never) : never;

interface Pending {
  /** performance.now() when this log began (the last accepted save). */
  start: number;
  actions: Action[];
}

export class TycoonController {
  /** What the player sees: server state plus everything since. */
  local: GameState | null = null;
  status: Status = { kind: "loading" };
  offline: { ms: number; earned: number } | null = null;
  saving = false;
  lastSavedAt: number | null = null;

  private session = "";
  private seq = 0;
  private pending: Pending = { start: 0, actions: [] };
  private inflight: { start: number; elapsed: number; actions: Action[] } | null = null;
  private lastTick = 0;
  private clickTokens = MAX_CLICKS_PER_SECOND;
  private nextSaveAt = 0;
  private version = 0;
  private startAttempt = 0;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(event: GameEvent) => void>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Starts (or restarts) a session with the server. */
  async start(): Promise<void> {
    const attempt = ++this.startAttempt;
    this.status = { kind: "loading" };
    this.changed();
    try {
      const started = await startSession();
      // A later start() superseded this one (and its session) while it was in flight.
      if (attempt !== this.startAttempt) return;
      const now = this.now();
      this.session = started.session;
      this.seq = started.seq;
      this.local = started.state;
      this.pending = { start: now, actions: [] };
      this.inflight = null;
      this.lastTick = now;
      this.clickTokens = MAX_CLICKS_PER_SECOND;
      this.nextSaveAt = now + AUTOSAVE_MS;
      // A reload a few seconds later isn't "away"; only say so after a minute.
      this.offline =
        started.offline.earned > 0 && started.offline.ms >= OFFLINE_NOTICE_MS
          ? started.offline
          : null;
      this.status = { kind: "playing" };
    } catch (error) {
      if (attempt !== this.startAttempt) return;
      this.stop(error);
    }
    this.changed();
  }

  // ---- subscriptions (React reads `version` through useSyncExternalStore) ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  onEvent(listener: (event: GameEvent) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Tells React to re-render. Called from tick at a throttled rate and after every action. */
  changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private emit(event: GameEvent) {
    for (const listener of this.eventListeners) listener(event);
  }

  get playing() {
    return this.status.kind === "playing" && this.local !== null;
  }

  // ---- the loop ----

  /** Lets time pass up to now. Call every frame. */
  tick() {
    if (!this.playing || !this.local) return;
    const now = this.now();
    const ms = now - this.lastTick;
    if (ms <= 0) return;
    this.lastTick = now;
    const before = this.local.achievements.length;
    advance(this.local, ms);
    this.clickTokens = Math.min(
      MAX_CLICKS_PER_SECOND,
      this.clickTokens + (ms * MAX_CLICKS_PER_SECOND) / 1000,
    );
    this.announceAchievements(before);
    if (now >= this.nextSaveAt) void this.save();
  }

  private announceAchievements(before: number) {
    if (this.local && this.local.achievements.length > before) {
      this.emit({ type: "achievement", ids: this.local.achievements.slice(before) });
    }
  }

  /** Applies an action now and logs it. */
  private act(action: Untimed): Outcome {
    if (!this.playing || !this.local) return { ok: false, reason: "not_playing" };
    this.tick();
    const t = this.now() - this.pending.start;
    const logged = { ...action, t } as Action;
    const before = this.local.achievements.length;
    const outcome = apply(this.local, logged);
    if (!outcome.ok) return outcome;
    this.pending.actions.push(logged);
    this.announceAchievements(before);
    if (this.pending.actions.length >= FLUSH_AT_ACTIONS) void this.save();
    this.changed();
    return outcome;
  }

  click(): Outcome {
    if (!this.playing || !this.local) return { ok: false, reason: "not_playing" };
    this.tick();
    // The same budget the server allows (replay.ts), so the two never disagree.
    if (this.clickTokens < 1) return { ok: false, reason: "click_rate" };
    this.clickTokens -= 1;
    const now = this.now();
    const last = this.pending.actions.at(-1);
    const before = this.local.achievements.length;
    const outcome = apply(this.local, { t: 0, a: "click", n: 1 });
    if (!outcome.ok) return outcome;
    if (last?.a === "click" && now - this.pending.start - last.t < CLICK_MERGE_MS) last.n += 1;
    else this.pending.actions.push({ t: now - this.pending.start, a: "click", n: 1 });
    this.announceAchievements(before);
    this.emit({ type: "click", earned: outcome.earned ?? 0, count: 1 });
    this.changed();
    return outcome;
  }

  buy(tier: number, count: number): Outcome {
    const outcome = this.act({ a: "buy", g: tier, n: count });
    if (outcome.ok) this.emit({ type: "buy", tier, count });
    return outcome;
  }

  upgrade(id: string): Outcome {
    const wasEnded = this.local?.ended ?? false;
    const outcome = this.act({ a: "up", id });
    if (!outcome.ok) return outcome;
    this.emit({ type: "upgrade", id });
    if (!wasEnded && this.local?.ended) {
      this.emit({ type: "ending" });
      void this.save();
    }
    return outcome;
  }

  catchGolden(index: number): Outcome {
    const outcome = this.act({ a: "gold", i: index });
    if (outcome.ok && outcome.golden)
      this.emit({ type: "golden", kind: outcome.golden, earned: outcome.earned });
    return outcome;
  }

  migrate(): Outcome {
    const outcome = this.act({ a: "migrate" });
    if (outcome.ok) {
      this.emit({ type: "migrate" });
      void this.save();
    }
    return outcome;
  }

  // ---- saving ----

  /** Uploads the log. With `unloading`, uses a keepalive request and doesn't wait for the answer. */
  async save(unloading = false): Promise<void> {
    if (!this.playing || this.inflight) return;
    this.tick();
    const now = this.now();
    const sent = {
      start: this.pending.start,
      elapsed: now - this.pending.start,
      actions: this.pending.actions,
    };
    this.inflight = sent;
    this.pending = { start: now, actions: [] };
    this.clickTokens = MAX_CLICKS_PER_SECOND;
    this.nextSaveAt = now + AUTOSAVE_MS;
    this.saving = true;
    this.changed();
    try {
      const ack = await uploadSave(
        this.session,
        this.seq,
        { elapsed: sent.elapsed, actions: sent.actions },
        unloading,
      );
      this.seq = ack.seq;
      this.lastSavedAt = Date.now();
      if (ack.dropped > 0) this.emit({ type: "dropped", count: ack.dropped });
      // Rebuild: the server's state at the cut, plus what happened since.
      const cutoff = this.now();
      this.tick();
      const rebuilt = replay(ack.state, {
        elapsed: cutoff - this.pending.start,
        actions: this.pending.actions,
      });
      this.local = rebuilt.state;
      this.lastTick = cutoff;
    } catch (error) {
      if (error instanceof TycoonApiError && error.failure.kind === "network") {
        // Put the log back in front of what came since, and try again later.
        const shift = this.pending.start - sent.start;
        this.pending = {
          start: sent.start,
          actions: [
            ...sent.actions,
            ...this.pending.actions.map((a) => ({ ...a, t: a.t + shift })),
          ],
        };
        this.nextSaveAt = this.now() + RETRY_MS;
      } else {
        this.stop(error);
      }
    } finally {
      this.inflight = null;
      this.saving = false;
      this.changed();
    }
  }

  private stop(error: unknown) {
    const failure: ApiFailure =
      error instanceof TycoonApiError ? error.failure : { kind: "network", detail: String(error) };
    this.status = { kind: "stopped", failure };
  }

  dismissOffline() {
    this.offline = null;
    this.changed();
  }

  /** A copy of the current state, for code that wants to look without touching. */
  snapshot(): GameState | null {
    return this.local ? cloneState(this.local) : null;
  }
}
