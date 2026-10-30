import { describe, expect, it, vi } from "vitest";
import {
  TycoonApiError,
  TycoonController,
  TycoonClient,
  type SaveAck,
  type SessionStart,
  type Transport,
} from "./client";
import { applyOffline, replay, type SaveLog } from "./replay";
import { cloneState, newGame, type GameState } from "./rules";
import { AUTOSAVE_MS } from "./schema";

/**
 * A server in memory: replays each log like the Worker does, with a clock the test moves, and
 * credits offline time since the last save when a session starts.
 */
function fakeServer(start: GameState = newGame(), clock: () => number = () => 0) {
  let state = cloneState(start);
  let seq = 0;
  const logs: SaveLog[] = [];
  let failNext: TycoonApiError | null = null;
  let loseNextReply = false;
  let reportSaved = true;
  let savedAt = clock();
  let sessions = 0;
  let hold: Promise<void> | null = null;
  const transport: Transport = {
    async startSession(): Promise<SessionStart> {
      sessions += 1;
      const offline = applyOffline(state, clock() - savedAt);
      state = offline.state;
      savedAt = clock();
      return {
        state: cloneState(state),
        session: `s${sessions}`,
        seq,
        offline: { ms: offline.creditedMs, earned: offline.earned },
      };
    },
    async uploadSave(_session, clientSeq, log): Promise<SaveAck> {
      if (hold) await hold;
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      // Like the Worker: a save that isn't on top of the last one is refused.
      if (clientSeq !== seq) {
        throw new TycoonApiError(
          reportSaved
            ? {
                kind: "out_of_sync",
                saved: { seq, state: cloneState(state), ageMs: clock() - savedAt },
              }
            : { kind: "out_of_sync" },
        );
      }
      logs.push(log);
      const result = replay(state, log);
      state = result.state;
      seq += 1;
      savedAt = clock();
      if (loseNextReply) {
        // Saved, but the page never hears back (a phone suspended it mid-request).
        loseNextReply = false;
        throw new TycoonApiError({ kind: "network", detail: "Load failed" });
      }
      return { state: cloneState(state), seq, dropped: result.dropped.length, creditedMs: 0 };
    },
  };
  return {
    transport,
    logs,
    get state() {
      return state;
    },
    get sessions() {
      return sessions;
    },
    loseNextReply() {
      loseNextReply = true;
    },
    /** Like a Worker from before out_of_sync said where the save stands. */
    withoutSavedPoint() {
      reportSaved = false;
    },
    failWith(error: TycoonApiError) {
      failNext = error;
    },
    holdSaves() {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

/** `now` is the page's monotonic clock, `wall` the real time (the server's clock too). */
function setup(start?: GameState) {
  let now = 0;
  let wall = 1_000_000;
  const server = fakeServer(start, () => wall);
  const controller = new TycoonController(
    server.transport,
    () => now,
    () => wall,
  );
  return {
    server,
    controller,
    advance(ms: number) {
      now += ms;
      wall += ms;
      controller.tick();
    },
    /** The phone sleeps with the tab open: real time passes, the page's clock stands still. */
    sleep(ms: number) {
      wall += ms;
    },
  };
}

/** A game that earns something every second. */
function producing(): GameState {
  const state = newGame();
  state.owned[0] = 10;
  return state;
}

describe("TycoonController", () => {
  it("plays locally and the server ends up with the same state", async () => {
    const { server, controller, advance } = setup();
    await controller.start();
    for (let i = 0; i < 30; i++) {
      advance(100);
      controller.click();
    }
    expect(controller.buy(0, 1).ok).toBe(true);
    advance(10_000);
    await controller.save();
    expect(server.state.owned[0]).toBe(1);
    expect(server.state.clicks).toBe(30);
    expect(controller.local!.records).toBeCloseTo(server.state.records, 6);
  });

  it("merges clicks within a second into one log entry and caps them at 20 a second", async () => {
    const { server, controller, advance } = setup();
    await controller.start();
    advance(1);
    let accepted = 0;
    for (let i = 0; i < 50; i++) if (controller.click().ok) accepted++;
    expect(accepted).toBe(20);
    await controller.save();
    expect(server.logs[0]!.actions).toEqual([{ t: 1, a: "click", n: 20 }]);
  });

  it("never logs a burst of clicks the server would cut short", async () => {
    const { server, controller, advance } = setup();
    await controller.start();
    const dropped: number[] = [];
    controller.onEvent((e) => e.type === "dropped" && dropped.push(e.count));
    // Mashing at 40 a second: the client allows the 20 burst plus what refills meanwhile.
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      advance(25);
      if (controller.click().ok) accepted++;
    }
    expect(accepted).toBeGreaterThan(20);
    await controller.save();
    expect(dropped).toEqual([]);
    expect(server.state.clicks).toBe(accepted);
    expect(server.logs[0]!.actions.every((a) => a.a !== "click" || a.n <= 20)).toBe(true);
  });

  it("saves on its own every 5 minutes", async () => {
    const { server, controller, advance } = setup();
    await controller.start();
    advance(AUTOSAVE_MS - 1);
    expect(server.logs).toHaveLength(0);
    advance(1);
    await controller.save(); // waits for the autosave in flight
    expect(server.logs.length).toBeGreaterThanOrEqual(1);
  });

  it("runs a save asked for mid-flight right after, so a migration is never left unsaved", async () => {
    const start = newGame();
    start.runRecords = 2e9;
    const { server, controller, advance } = setup(start);
    await controller.start();
    const release = server.holdSaves();
    const first = controller.save();
    advance(1_000);
    expect(controller.migrate().ok).toBe(true);
    release();
    await first;
    await controller.save();
    expect(server.state.migrations).toBe(1);
  });

  it("keeps the log through a network failure and sends it again", async () => {
    const { server, controller, advance } = setup();
    await controller.start();
    advance(500);
    controller.click();
    server.failWith(new TycoonApiError({ kind: "network", detail: "offline" }));
    await controller.save();
    expect(controller.status.kind).toBe("playing");
    advance(500);
    controller.click();
    await controller.save();
    expect(server.state.clicks).toBe(2);
    expect(server.logs).toHaveLength(1);
  });

  it("keeps minutes of play when a save landed but its reply was lost", async () => {
    const { server, controller, advance } = setup();
    await controller.start();
    advance(500);
    controller.click();
    // An autosave lands, but the reply never arrives (a flaky phone connection).
    server.loseNextReply();
    await controller.save();
    expect(server.state.clicks).toBe(1);
    // Five more minutes of play before the retry goes out.
    for (let i = 0; i < 300; i++) {
      advance(1_000);
      controller.click();
    }
    const records = controller.local!.records;
    await controller.save();
    // The server refused the retry as already saved; the tab kept everything since and sent it.
    await vi.waitFor(() => expect(server.state.clicks).toBe(301));
    expect(controller.status.kind).toBe("playing");
    expect(server.sessions).toBe(1);
    expect(controller.local!.clicks).toBe(301);
    expect(controller.local!.records).toBeGreaterThanOrEqual(records * 0.99);
  });

  it("resyncs quietly when a save landed unheard and the server can't say more", async () => {
    const { server, controller, advance } = setup();
    server.withoutSavedPoint();
    await controller.start();
    advance(500);
    controller.click();
    // The tab is hidden: the save goes out, the phone suspends the page before the reply.
    server.loseNextReply();
    await controller.save(true);
    expect(server.state.clicks).toBe(1);
    // Back on the tab: the retry runs straight away, finds the save already landed, and the tab
    // carries on from the server's state in a new session instead of halting.
    controller.resume();
    await vi.waitFor(() => expect(server.sessions).toBe(2));
    await vi.waitFor(() => expect(controller.saving).toBe(false));
    expect(controller.status.kind).toBe("playing");
    expect(controller.local?.clicks).toBe(1);
    advance(500);
    controller.click();
    await controller.save();
    expect(controller.status.kind).toBe("playing");
    expect(server.state.clicks).toBe(2);
  });

  it("retries a cut-off save as soon as the page is back, if it is still in flight then", async () => {
    const { server, controller, advance } = setup();
    await controller.start();
    advance(500);
    controller.click();
    const release = server.holdSaves();
    server.failWith(new TycoonApiError({ kind: "network", detail: "Load failed" }));
    const hidden = controller.save(true);
    controller.resume();
    release();
    await hidden;
    // Without resume() this would wait RETRY_MS; now the next frame sends it.
    advance(16);
    await vi.waitFor(() => expect(server.logs).toHaveLength(1));
    expect(server.state.clicks).toBe(1);
  });

  it("credits the time a phone slept with the tab open as time away", async () => {
    const { server, controller, advance, sleep } = setup(producing());
    await controller.start();
    advance(1_000);
    controller.click();
    // Hidden: the save on the way out lands. Then the phone sleeps for an hour.
    await controller.save(true);
    sleep(3_600_000);
    const before = controller.local!.lifetimeRecords;
    advance(16);
    controller.resume();
    await vi.waitFor(() => expect(server.sessions).toBe(2));
    await vi.waitFor(() => expect(controller.offline?.ms).toBe(3_600_016));
    expect(controller.status.kind).toBe("playing");
    expect(controller.local!.clicks).toBe(1);
    expect(controller.local!.lifetimeRecords).toBeGreaterThan(
      before + controller.offline!.earned / 2,
    );
    // Play carries on in the new session.
    advance(500);
    controller.click();
    await controller.save();
    expect(server.state.clicks).toBe(2);
  });

  it("catches up after the save on the way out answers, if it is still in flight", async () => {
    const { server, controller, advance, sleep } = setup(producing());
    await controller.start();
    advance(1_000);
    const release = server.holdSaves();
    const hidden = controller.save(true);
    sleep(3_600_000);
    advance(16);
    controller.resume();
    expect(server.sessions).toBe(1);
    release();
    await hidden;
    // (This fake server only takes the held save in now, so it has no away time to credit.)
    await vi.waitFor(() => expect(server.sessions).toBe(2));
    await vi.waitFor(() => expect(controller.saving).toBe(false));
    expect(controller.status.kind).toBe("playing");
    expect(server.logs).toHaveLength(1);
  });

  it("does not start over when that would drop unsaved play", async () => {
    const { server, controller, advance, sleep } = setup(producing());
    await controller.start();
    advance(1_000);
    controller.click();
    sleep(3_600_000);
    advance(16);
    controller.resume();
    await controller.save();
    expect(server.sessions).toBe(1);
    expect(server.state.clicks).toBe(1);
    expect(controller.offline).toBeNull();
  });

  it("leaves a tab alone when both clocks ran (a desktop's hidden tab)", async () => {
    const { server, controller, advance } = setup(producing());
    await controller.start();
    await controller.save(true);
    advance(3_600_000);
    controller.resume();
    await controller.save();
    expect(server.sessions).toBe(1);
    expect(controller.offline).toBeNull();
  });

  it("stops when another device takes over", async () => {
    const { server, controller } = setup();
    await controller.start();
    server.failWith(new TycoonApiError({ kind: "session_replaced" }));
    await controller.save();
    expect(controller.status).toEqual({ kind: "stopped", failure: { kind: "session_replaced" } });
    expect(controller.click().ok).toBe(false);
  });
});

describe("TycoonClient", () => {
  function client(responses: Response[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    let stored: string | null = null;
    const c = new TycoonClient({
      baseUrl: "https://example.test",
      kind: "cli",
      store: { load: () => stored, save: (v) => (stored = v) },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return responses.shift()!;
      },
    });
    return { c, calls, stored: () => stored };
  }

  it("creates a player on first use and sends its credential afterwards", async () => {
    const { c, calls, stored } = client([
      Response.json({ player: "p", token: "t" }, { status: 201 }),
      Response.json({ state: newGame(), session: "s", seq: 0, offline: { ms: 0, earned: 0 } }),
    ]);
    await c.startSession();
    expect(stored()).toBe("p.t");
    expect(calls[0]!.url).toBe("https://example.test/api/tycoon/players");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer p.t");
  });

  it("claims a pairing code as a CLI and switches to that player", async () => {
    const { c, calls, stored } = client([
      Response.json({ player: "q", token: "u" }, { status: 201 }),
    ]);
    await c.claimPairingCode("abc234");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ code: "abc234", client: "cli" });
    expect(stored()).toBe("q.u");
  });

  it("turns error codes into failures", async () => {
    const { c } = client([
      Response.json({ error: { code: "invalid_code", message: "" } }, { status: 404 }),
    ]);
    await expect(c.claimPairingCode("NOPE00")).rejects.toMatchObject({
      failure: { kind: "invalid_code" },
    });
  });
});
