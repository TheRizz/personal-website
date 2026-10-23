import { OFFLINE_CAP_MS, advance, apply, cloneState, type Action, type GameState } from "./rules";

/** Autoclickers get at most this many clicks a second (with a burst of the same size). */
export const MAX_CLICKS_PER_SECOND = 20;

/**
 * What a client uploads: everything it did since its last accepted save, in order. `t` on each
 * action and `elapsed` are ms since that save, on the client's own monotonic clock.
 */
export interface SaveLog {
  elapsed: number;
  actions: Action[];
}

export interface Dropped {
  /** Index into `log.actions`. */
  index: number;
  reason: string;
  /** For a click entry: how many of its clicks were lost. */
  clicks?: number;
}

/** What a save undid, grouped for telling the player: e.g. 12 clicks for "click_rate". */
export interface Undone {
  a: Action["a"];
  reason: string;
  /** Actions, or clicks for "click". */
  count: number;
}

/** Groups `dropped` (from replaying `log`) into what the player lost. */
export function summariseDropped(log: SaveLog, dropped: Dropped[]): Undone[] {
  const groups = new Map<string, Undone>();
  for (const d of dropped) {
    const action = log.actions[d.index];
    if (!action) continue;
    const key = `${action.a}/${d.reason}`;
    const group = groups.get(key) ?? { a: action.a, reason: d.reason, count: 0 };
    group.count += action.a === "click" ? (d.clicks ?? action.n) : 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export interface ReplayResult {
  state: GameState;
  /** Play time actually credited (ms). */
  creditedMs: number;
  dropped: Dropped[];
}

/**
 * Re-runs a log from `start` (ADR-0006). At most `maxCreditMs` of play time is credited: if the
 * client claims more, its action times are scaled down to fit. Gaps between actions are capped at
 * OFFLINE_CAP_MS. Actions the replayed state can't perform are dropped, never fatal. `start` is
 * not modified.
 */
export function replay(start: GameState, log: SaveLog, maxCreditMs = Infinity): ReplayResult {
  const state = cloneState(start);
  const elapsed = Math.max(0, log.elapsed);
  const creditedMs = Math.min(elapsed, Math.max(0, maxCreditMs));
  const scale = elapsed > 0 ? creditedMs / elapsed : 0;
  const dropped: Dropped[] = [];

  let cursor = 0;
  let clientT = 0;
  let clickTokens = MAX_CLICKS_PER_SECOND;
  const pass = (ms: number) => {
    if (ms <= 0) return;
    advance(state, Math.min(ms, OFFLINE_CAP_MS));
    clickTokens = Math.min(
      MAX_CLICKS_PER_SECOND,
      clickTokens + (ms * MAX_CLICKS_PER_SECOND) / 1000,
    );
  };

  log.actions.forEach((action, index) => {
    // Times never run backwards or past the log's end.
    clientT = Math.min(elapsed, Math.max(clientT, action.t));
    const at = clientT * scale;
    pass(at - cursor);
    cursor = Math.max(cursor, at);

    if (action.a === "click") {
      const allowed = Math.min(action.n, Math.floor(clickTokens));
      if (allowed < 1) {
        dropped.push({ index, reason: "click_rate", clicks: action.n });
        return;
      }
      const outcome = apply(state, { ...action, n: allowed });
      if (!outcome.ok) dropped.push({ index, reason: outcome.reason, clicks: action.n });
      else {
        clickTokens -= allowed;
        if (allowed < action.n) {
          dropped.push({ index, reason: "click_rate", clicks: action.n - allowed });
        }
      }
      return;
    }
    const outcome = apply(state, action);
    if (!outcome.ok) dropped.push({ index, reason: outcome.reason });
  });
  pass(creditedMs - cursor);

  return { state, creditedMs, dropped };
}

/** Offline earnings when a session starts: up to OFFLINE_CAP_MS since the last save. */
export function applyOffline(
  start: GameState,
  awayMs: number,
): { state: GameState; creditedMs: number; earned: number } {
  const state = cloneState(start);
  const creditedMs = Math.min(Math.max(0, awayMs), OFFLINE_CAP_MS);
  const before = state.lifetimeRecords;
  advance(state, creditedMs);
  return { state, creditedMs, earned: state.lifetimeRecords - before };
}
