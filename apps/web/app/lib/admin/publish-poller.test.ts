import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishState, Stage } from "../publish/state";
import { createPublishPoller } from "./publish-poller";

const state = (stage: Stage): PublishState => ({
  stage,
  action: "publish",
  pr: 7,
  prUrl: "https://github.com/TheRizz/personal-website/pull/7",
  branch: "blog/hello-1700000000",
  runUrl: null,
  mergeSha: null,
  slug: "hello",
  mergedOtherVersion: false,
});

/** A poller over scripted answers, with visibility the test controls. */
function setup(answers: (Stage | Error)[] = []) {
  let visible = true;
  let onVisibility: (() => void) | null = null;
  const states: Stage[] = [];
  const errors: unknown[] = [];
  const fetchState = vi.fn(async () => {
    const next = answers.shift() ?? "review";
    if (next instanceof Error) throw next;
    return state(next);
  });
  const unsubscribe = vi.fn(() => {
    onVisibility = null;
  });
  const poller = createPublishPoller({
    fetchState,
    isVisible: () => visible,
    onVisibilityChange: (callback) => {
      onVisibility = callback;
      return unsubscribe;
    },
    onState: (s) => states.push(s.stage),
    onError: (error) => errors.push(error),
  });
  const setVisible = (next: boolean) => {
    visible = next;
    onVisibility?.();
  };
  return { poller, fetchState, states, errors, setVisible, unsubscribe };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createPublishPoller", () => {
  it("does nothing until started", async () => {
    const { fetchState } = setup();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchState).not.toHaveBeenCalled();
  });

  it("checks every 10 s after start", async () => {
    const { poller, fetchState, states } = setup(["opened", "ci_running", "review"]);
    poller.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual(["opened", "ci_running", "review"]);
    poller.stop();
  });

  it.each(["live", "closed", "draft"] as const)("stops polling at %s", async (terminal) => {
    const { poller, fetchState, states } = setup(["merged", "deploying", terminal]);
    poller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states).toEqual(["merged", "deploying", terminal]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchState).toHaveBeenCalledTimes(3);
  });

  it("keeps polling through failed and failing stages that can still change", async () => {
    const { poller, states } = setup(["ci_failed", "ci_failed", "deploy_failed", "deploying"]);
    poller.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(states).toEqual(["ci_failed", "ci_failed", "deploy_failed", "deploying"]);
    poller.stop();
  });

  it("pauses while the page is hidden and catches up when it is back", async () => {
    const { poller, fetchState, setVisible } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchState).toHaveBeenCalledTimes(1);
    setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchState).toHaveBeenCalledTimes(1);
    // More than 10 s since the last check: check at once.
    setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchState).toHaveBeenCalledTimes(2);
    // Hidden and back within the interval: wait for the rest of it.
    await vi.advanceTimersByTimeAsync(4_000);
    setVisible(false);
    setVisible(true);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(fetchState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchState).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it("doesn't poll when started on a hidden page until it is shown", async () => {
    const { poller, fetchState, setVisible } = setup();
    setVisible(false);
    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchState).not.toHaveBeenCalled();
    setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchState).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("checkNow checks at once and restarts the interval", async () => {
    const { poller, fetchState, states } = setup(["opened", "ci_running", "review"]);
    poller.start();
    await vi.advanceTimersByTimeAsync(6_000);
    await poller.checkNow();
    expect(states).toEqual(["opened"]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual(["opened", "ci_running"]);
    poller.stop();
  });

  it("checkNow shares a check that is already under way", async () => {
    let resolve!: (value: PublishState) => void;
    const { poller, fetchState } = setup();
    fetchState.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const first = poller.checkNow();
    const second = poller.checkNow();
    expect(fetchState).toHaveBeenCalledTimes(1);
    resolve(state("review"));
    await Promise.all([first, second]);
    expect(fetchState).toHaveBeenCalledTimes(1);
  });

  it("checkNow works without start, and on a terminal stage", async () => {
    const { poller, fetchState, states } = setup(["live", "live"]);
    await poller.checkNow();
    await poller.checkNow();
    expect(states).toEqual(["live", "live"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchState).toHaveBeenCalledTimes(2);
  });

  it("reports errors and keeps the schedule", async () => {
    const failure = new Error("offline");
    const { poller, states, errors } = setup([failure, "review"]);
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors).toEqual([failure]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual(["review"]);
    poller.stop();
  });

  it("start after a terminal stage polls again", async () => {
    const { poller, states } = setup(["closed", "opened"]);
    poller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states).toEqual(["closed"]);
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual(["closed", "opened"]);
    poller.stop();
  });

  it("stop unsubscribes and drops an answer still on its way", async () => {
    let resolve!: (value: PublishState) => void;
    const { poller, fetchState, states, unsubscribe, setVisible } = setup();
    fetchState.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    poller.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    resolve(state("live"));
    await vi.advanceTimersByTimeAsync(60_000);
    setVisible(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).toEqual([]);
    expect(fetchState).toHaveBeenCalledTimes(1);
  });

  it("can be started again after stop (React runs effects twice in development)", async () => {
    const { poller, fetchState, unsubscribe } = setup();
    poller.start();
    poller.stop();
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchState).toHaveBeenCalledTimes(1);
    poller.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
