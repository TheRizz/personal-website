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
        dropped.push({ index, reason: "click_rate" });
        return;
      }
      const outcome = apply(state, { ...action, n: allowed });
      if (!outcome.ok) dropped.push({ index, reason: outcome.reason });
      else {
        clickTokens -= allowed;
        if (allowed < action.n) dropped.push({ index, reason: "click_rate" });
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
