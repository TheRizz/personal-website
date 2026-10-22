import { describe, expect, it } from "vitest";
import {
  TycoonApiError,
  TycoonController,
  TycoonClient,
  type SaveAck,
  type SessionStart,
  type Transport,
} from "./client";
import { replay, type SaveLog } from "./replay";
import { cloneState, newGame, type GameState } from "./rules";
import { AUTOSAVE_MS } from "./schema";

/** A server in memory: replays each log like the Worker does, with a clock the test moves. */
function fakeServer(start: GameState = newGame()) {
  let state = cloneState(start);
  let seq = 0;
  const logs: SaveLog[] = [];
  let failNext: TycoonApiError | null = null;
  let hold: Promise<void> | null = null;
  const transport: Transport = {
    async startSession(): Promise<SessionStart> {
      return { state: cloneState(state), session: "s1", seq, offline: { ms: 0, earned: 0 } };
    },
    async uploadSave(_session, clientSeq, log): Promise<SaveAck> {
      if (hold) await hold;
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      expect(clientSeq).toBe(seq);
      logs.push(log);
      const result = replay(state, log);
      state = result.state;
      seq += 1;
      return { state: cloneState(state), seq, dropped: result.dropped.length, creditedMs: 0 };
    },
  };
  return {
    transport,
    logs,
    get state() {
      return state;
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

function setup(start?: GameState) {
  let now = 0;
  const server = fakeServer(start);
  const controller = new TycoonController(
    server.transport,
    () => now,
    () => 0,
  );
  return {
    server,
    controller,
    advance(ms: number) {
      now += ms;
      controller.tick();
    },
  };
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
