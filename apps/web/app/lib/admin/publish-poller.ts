import { isTerminal, type PublishState } from "../publish/state";

// Polls a draft's publishing status (design doc §4.9.7): every 10 s while the stage can still
// change and the page is visible, plus "Check now". Plain TypeScript with the page's visibility
// passed in, so it is tested with fake timers and never touches `document` itself.

export interface PublishPollerOptions {
  fetchState: () => Promise<PublishState>;
  isVisible: () => boolean;
  /** Subscribes to visibility changes; returns the unsubscribe function. */
  onVisibilityChange: (callback: () => void) => () => void;
  intervalMs?: number;
  onState: (state: PublishState) => void;
  /** A failed check. The schedule carries on. */
  onError: (error: unknown) => void;
}

export interface PublishPoller {
  /** Polls every interval from now on, until a terminal stage or `stop`. */
  start(): void;
  /** Checks at once (sharing a check already under way), then carries on with the schedule. */
  checkNow(): Promise<void>;
  /** Stops polling and ignores any answer still on its way. */
  stop(): void;
}

/** A poller for one draft's status. Nothing runs until `start` or `checkNow`. */
export function createPublishPoller(options: PublishPollerOptions): PublishPoller {
  const intervalMs = options.intervalMs ?? 10_000;
  let running = false;
  // The last answer was a terminal stage, so nothing more happens without the owner.
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let lastCheckAt = 0;
  let unsubscribe: (() => void) | null = null;
  // Bumped by `stop`, so an answer to an earlier run is dropped.
  let generation = 0;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    if (!running || settled || !options.isVisible()) return;
    timer = setTimeout(() => void check(), delayMs);
  };

  function check(): Promise<void> {
    if (inFlight) return inFlight;
    clearTimer();
    const run = generation;
    lastCheckAt = Date.now();
    const request = new Promise<PublishState>((resolve) => resolve(options.fetchState()))
      .then((state) => {
        if (run !== generation) return;
        settled = isTerminal(state.stage);
        options.onState(state);
      })
      .catch((error: unknown) => {
        if (run === generation) options.onError(error);
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
        if (run === generation) schedule(intervalMs);
      });
    inFlight = request;
    return request;
  }

  const onVisibilityChange = () => {
    if (!running) return;
    // Back on the page: check when the interval since the last check is up, at once if it is.
    if (options.isVisible()) {
      if (!inFlight) schedule(Math.max(0, lastCheckAt + intervalMs - Date.now()));
    } else {
      clearTimer();
    }
  };

  return {
    start() {
      settled = false;
      lastCheckAt = Date.now();
      if (!running) {
        running = true;
        unsubscribe = options.onVisibilityChange(onVisibilityChange);
      }
      if (!inFlight) schedule(intervalMs);
    },
    checkNow() {
      return check();
    },
    stop() {
      running = false;
      generation += 1;
      inFlight = null;
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
