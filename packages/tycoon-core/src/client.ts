import { MAX_CLICKS_PER_SECOND, replay, type SaveLog } from "./replay";
import {
  RULES_VERSION,
  advance,
  apply,
  cloneState,
  type Action,
  type GameState,
  type Outcome,
} from "./rules";
import type { GoldenKind } from "./golden";
import { AUTOSAVE_MS } from "./schema";

// The client side of ADR-0006, shared by the web page and the CLI so both sync exactly alike.
//
// TycoonClient talks to /api/tycoon/*. TycoonController runs the game: every frame on `local`,
// every action also written to a log. Saves upload the log; the server replays it onto its own
// state and sends that back, and `local` is rebuilt from the server's state plus whatever happened
// while the save was in flight. So a client never holds unconfirmed progress for long.

export type ApiFailure =
  | { kind: "session_replaced" }
  | { kind: "out_of_sync"; saved?: SavedPoint }
  | { kind: "update_required" }
  | { kind: "unauthorized" }
  | { kind: "rate_limited" }
  | { kind: "invalid_code" }
  | { kind: "network"; detail: string };

export class TycoonApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.kind === "network" ? `network: ${failure.detail}` : failure.kind);
  }
}

/** Where the server's save stands, sent with out_of_sync: its seq, state, and how old that is. */
export interface SavedPoint {
  seq: number;
  state: GameState;
  ageMs: number;
}

export interface SessionStart {
  state: GameState;
  session: string;
  seq: number;
  offline: { ms: number; earned: number };
}

export interface SaveAck {
  state: GameState;
  seq: number;
  dropped: number;
  creditedMs: number;
}

/** Where a client keeps its `<player>.<secret>` credential (localStorage, a config file…). */
export interface CredentialStore {
  load(): string | null;
  save(credential: string | null): void;
}

export interface ClientOptions {
  /** "" for same-origin (the web page), "https://ry-mart.com" for the CLI. */
  baseUrl: string;
  store: CredentialStore;
  /** Which kind of device this is, recorded when it links with a code. */
  kind: "web" | "cli";
  fetch?: typeof fetch;
}

/** A request that hasn't answered in this long counts as a network failure. */
const REQUEST_TIMEOUT_MS = 20_000;

/** The /api/tycoon/* endpoints (apps/web/worker/tycoon-api.ts). */
export class TycoonClient {
  private memory: string | null = null;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
  }

  /** Whether this device has a player yet. */
  hasPlayer(): boolean {
    return this.credential() !== null;
  }

  private credential(): string | null {
    return this.memory ?? this.options.store.load();
  }

  private remember(credential: string | null) {
    this.memory = credential;
    this.options.store.save(credential);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    keepalive = false,
  ): Promise<T> {
    const auth = this.credential();
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}/api/tycoon/${path}`, {
        method,
        // A phone can leave a request hanging after it wakes the page; give up rather than wait.
        // (Older Safari has no AbortSignal.timeout; it just waits as before.)
        ...(typeof AbortSignal.timeout === "function"
          ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
          : {}),
        ...(keepalive ? { keepalive: true } : {}),
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new TycoonApiError({ kind: "network", detail: String(error) });
    }
    if (response.ok) {
      return (response.status === 204 ? undefined : await response.json()) as T;
    }
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string };
      saved?: SavedPoint;
    } | null;
    const code = payload?.error?.code;
    if (code === "out_of_sync") {
      throw new TycoonApiError(
        payload?.saved ? { kind: code, saved: payload.saved } : { kind: code },
      );
    }
    if (code === "session_replaced" || code === "update_required" || code === "invalid_code") {
      throw new TycoonApiError({ kind: code });
    }
    if (response.status === 401) throw new TycoonApiError({ kind: "unauthorized" });
    if (response.status === 429) throw new TycoonApiError({ kind: "rate_limited" });
    throw new TycoonApiError({ kind: "network", detail: `HTTP ${response.status}` });
  }

  private async createPlayer(): Promise<void> {
    const { player, token } = await this.request<{ player: string; token: string }>(
      "POST",
      "players",
    );
    this.remember(`${player}.${token}`);
  }

  /** Starts a session, creating an anonymous player first if this device has none. */
  async startSession(): Promise<SessionStart> {
    if (!this.hasPlayer()) await this.createPlayer();
    try {
      return await this.request<SessionStart>("POST", "session", { v: RULES_VERSION });
    } catch (error) {
      // The stored player no longer exists (or the secret is wrong): start over as a new one.
      if (error instanceof TycoonApiError && error.failure.kind === "unauthorized") {
        this.remember(null);
        await this.createPlayer();
        return this.request<SessionStart>("POST", "session", { v: RULES_VERSION });
      }
      throw error;
    }
  }

  /** Uploads the log since the last save. `keepalive` lets it finish while a page unloads. */
  uploadSave(session: string, seq: number, log: SaveLog, keepalive = false): Promise<SaveAck> {
    return this.request<SaveAck>("PUT", "save", { v: RULES_VERSION, session, seq, log }, keepalive);
  }

  /** A code another device can claim within `expiresInMs` to join this player. */
  createPairingCode(): Promise<{ code: string; expiresInMs: number }> {
    return this.request("POST", "pair");
  }

  /** Joins the player that showed `code`. This device's previous player is forgotten. */
  async claimPairingCode(code: string): Promise<void> {
    const { player, token } = await this.request<{ player: string; token: string }>(
      "POST",
      "pair/claim",
      { code, client: this.options.kind },
    );
    this.remember(`${player}.${token}`);
  }

  /** Unlinks: the server forgets this device's secret, and so does this device. */
  async forgetDevice(): Promise<void> {
    if (this.hasPlayer()) await this.request("DELETE", "device");
    this.remember(null);
  }
}

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
  /** `now()` when this log began (the last accepted save). */
  start: number;
  actions: Action[];
}

/** What the controller needs from a client: just the two sync calls. */
export type Transport = Pick<TycoonClient, "startSession" | "uploadSave">;

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
  private inflight: Promise<void> | null = null;
  private saveQueued = false;
  /**
   * A save failed on the network, so it may or may not have reached the server: how many of
   * `pending.actions` it carried (they stay at the front of the log for the retry).
   */
  private unconfirmed: number | null = null;
  /** The page came back while that save was in flight: if it fails, retry at once. */
  private retryOnFailure = false;
  /** A resync is fetching a fresh session; saves wait for it. */
  private resyncing = false;
  private lastTick = 0;
  private clickTokens = MAX_CLICKS_PER_SECOND;
  private nextSaveAt = 0;
  private version = 0;
  private startAttempt = 0;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(event: GameEvent) => void>();

  /**
   * @param now a monotonic clock in ms (performance.now in browsers and Node)
   * @param wallClock for "saved at" times
   */
  constructor(
    private readonly transport: Transport,
    private readonly now: () => number = () => performance.now(),
    private readonly wallClock: () => number = () => Date.now(),
  ) {}

  /** Starts (or restarts) a session with the server. */
  async start(): Promise<void> {
    const attempt = ++this.startAttempt;
    this.status = { kind: "loading" };
    this.changed();
    try {
      const started = await this.transport.startSession();
      // A later start() superseded this one (and its session) while it was in flight.
      if (attempt !== this.startAttempt) return;
      this.begin(started);
    } catch (error) {
      if (attempt !== this.startAttempt) return;
      this.stop(error);
    }
    this.changed();
  }

  /**
   * Picks up the server's state in a fresh session without stopping play. Used when a save we
   * never heard back from turns out to have landed (out_of_sync), which happens when a phone
   * suspends the page mid-save: the server has everything that save carried, so the tab just
   * takes the server's state and carries on.
   */
  private async resync(): Promise<void> {
    const attempt = ++this.startAttempt;
    this.resyncing = true;
    try {
      const started = await this.transport.startSession();
      if (attempt !== this.startAttempt) return;
      this.begin(started);
    } catch (error) {
      if (attempt !== this.startAttempt) return;
      this.stop(error);
    } finally {
      if (attempt === this.startAttempt) this.resyncing = false;
    }
    this.changed();
  }

  private begin(started: SessionStart) {
    const now = this.now();
    this.session = started.session;
    this.seq = started.seq;
    this.local = started.state;
    this.pending = { start: now, actions: [] };
    this.lastTick = now;
    this.clickTokens = MAX_CLICKS_PER_SECOND;
    this.nextSaveAt = now + AUTOSAVE_MS;
    // A reload a few seconds later isn't "away"; only say so after a minute.
    this.offline =
      started.offline.earned > 0 && started.offline.ms >= OFFLINE_NOTICE_MS
        ? started.offline
        : null;
    this.status = { kind: "playing" };
    this.unconfirmed = null;
    this.retryOnFailure = false;
    this.resyncing = false;
  }

  // ---- subscriptions ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = () => this.version;

  onEvent(listener: (event: GameEvent) => void) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Tells views to redraw. Called after every action; views may also call it on a timer. */
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
    if (outcome.ok && outcome.golden) {
      this.emit({ type: "golden", kind: outcome.golden, earned: outcome.earned });
    }
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

  /**
   * Uploads the log. With `unloading`, uses a keepalive request (the page is going away). A save
   * asked for while one is in flight runs right after it, so it is never lost.
   */
  save(unloading = false): Promise<void> {
    if (!this.playing || this.resyncing) return Promise.resolve();
    if (this.inflight) {
      this.saveQueued = true;
      return this.inflight;
    }
    this.inflight = this.upload(unloading).finally(() => {
      this.inflight = null;
      if (this.saveQueued) {
        this.saveQueued = false;
        void this.save();
      }
    });
    return this.inflight;
  }

  private async upload(unloading: boolean): Promise<void> {
    this.tick();
    const now = this.now();
    const sent = {
      start: this.pending.start,
      elapsed: now - this.pending.start,
      actions: this.pending.actions,
    };
    this.pending = { start: now, actions: [] };
    this.clickTokens = MAX_CLICKS_PER_SECOND;
    this.nextSaveAt = now + AUTOSAVE_MS;
    this.saving = true;
    this.changed();
    try {
      const ack = await this.transport.uploadSave(
        this.session,
        this.seq,
        { elapsed: sent.elapsed, actions: sent.actions },
        unloading,
      );
      this.seq = ack.seq;
      this.unconfirmed = null;
      this.retryOnFailure = false;
      this.lastSavedAt = this.wallClock();
      if (ack.dropped > 0) this.emit({ type: "dropped", count: ack.dropped });
      // Rebuild: the server's state at the cut, plus what happened since.
      const cutoff = this.now();
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
        this.unconfirmed = sent.actions.length;
        this.nextSaveAt = this.retryOnFailure ? this.now() : this.now() + RETRY_MS;
        this.retryOnFailure = false;
        this.saveQueued = false;
      } else if (error instanceof TycoonApiError && error.failure.kind === "out_of_sync") {
        // Only this tab saves with this session, so a save of ours landed without us hearing
        // back: the last one that failed on the network. Treat the server's answer as that
        // save's ack and keep everything played since.
        if (!this.recover(sent, error.failure.saved)) void this.resync();
      } else {
        this.stop(error);
      }
    } finally {
      this.saving = false;
      this.changed();
    }
  }

  /**
   * Picks up from `saved` when it is the save we never heard back from, keeping the actions
   * after it. `sent` is the retry the server refused. False when that can't be done safely.
   */
  private recover(
    sent: { start: number; elapsed: number; actions: Action[] },
    saved?: SavedPoint,
  ): boolean {
    const carried = this.unconfirmed;
    if (!saved || carried === null || saved.seq !== this.seq + 1) return false;
    // The whole log since the last save we heard about, then the part after the lost save.
    const shift = this.pending.start - sent.start;
    const all = [...sent.actions, ...this.pending.actions.map((a) => ({ ...a, t: a.t + shift }))];
    const now = this.now();
    // The server measured its save's age when the retry arrived, just after we sent it.
    const start = Math.max(sent.start, sent.start + sent.elapsed - saved.ageMs);
    const since = all
      .slice(carried)
      .map((a) => ({ ...a, t: Math.max(0, a.t - (start - sent.start)) }));
    this.seq = saved.seq;
    this.unconfirmed = null;
    this.retryOnFailure = false;
    this.pending = { start, actions: since };
    this.local = replay(saved.state, { elapsed: now - start, actions: since }).state;
    this.lastTick = now;
    this.lastSavedAt = this.wallClock();
    // Send what came after straight away, so the server has it too.
    this.nextSaveAt = now;
    return true;
  }

  /**
   * Call when the page is shown again. A save cut off while it was hidden gets retried now,
   * before there is much new play riding on it, rather than in RETRY_MS.
   */
  resume() {
    if (!this.playing) return;
    if (this.inflight) this.retryOnFailure = true;
    else if (this.unconfirmed !== null) void this.save();
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
