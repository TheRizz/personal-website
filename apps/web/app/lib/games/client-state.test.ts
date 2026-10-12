import { describe, expect, it } from "vitest";
import { tictactoe, type PublicState, type ServerMsg } from "@site/game-core";
import {
  classifyClose,
  clientReducer,
  errorText,
  formatCountdown,
  initialClientState,
  MAX_RECONNECT_ATTEMPTS,
  planMove,
  reconnectDelay,
  RECONNECT_DELAYS_MS,
  viewState,
  type ClientAction,
  type ClientState,
} from "./client-state";

const player = (name: string) => ({ name, connected: true, releaseAt: null });

function publicState(overrides: Partial<PublicState> = {}): PublicState {
  const board = overrides.board ?? tictactoe.init("X");
  return {
    code: "ABC234",
    game: "tictactoe",
    phase: "playing",
    players: { X: player("Ada"), O: player("Bo") },
    spectators: 0,
    board,
    result: tictactoe.status(board),
    round: 1,
    firstSeat: "X",
    score: { X: 0, O: 0, draws: 0 },
    rematch: { X: false, O: false },
    ...overrides,
  };
}

const reduce = (state: ClientState, ...actions: ClientAction[]) =>
  actions.reduce(clientReducer, state);
const msg = (m: ServerMsg): ClientAction => ({ type: "message", msg: m });

/** Joined as `role` with a playing board at seq 3. */
function joinedAs(role: "X" | "O" | "spectator", state = publicState()): ClientState {
  return reduce(
    initialClientState,
    msg({ t: "joined", role, token: null }),
    msg({ t: "state", state, seq: 3 }),
  );
}

describe("clientReducer", () => {
  it("starts connecting and becomes open once joined", () => {
    expect(initialClientState.connection).toBe("connecting");
    const state = joinedAs("X");
    expect(state.connection).toBe("open");
    expect(state.role).toBe("X");
    expect(state.server?.seq).toBe(3);
  });

  it("never mutates the input state", () => {
    const before = joinedAs("X");
    const frozen = Object.freeze({ ...before });
    expect(() => clientReducer(frozen, { type: "closed", code: 1006 })).not.toThrow();
    expect(frozen.connection).toBe("open");
  });

  it("shows server errors with friendly text and a fresh id each time", () => {
    const once = reduce(joinedAs("X"), msg({ t: "error", code: "GAME_OVER", message: "x" }));
    const twice = reduce(once, msg({ t: "error", code: "GAME_OVER", message: "x" }));
    expect(once.lastError).toMatchObject({ code: "GAME_OVER", text: errorText("GAME_OVER") });
    expect(twice.lastError?.id).toBe((once.lastError?.id ?? 0) + 1);
  });

  it("resets the attempt counter only once the connection is stable", () => {
    const retrying = reduce(
      joinedAs("X"),
      { type: "closed", code: 1006 },
      { type: "closed", code: 1006 },
    );
    expect(retrying).toMatchObject({ connection: "reconnecting", attempt: 2 });
    const back = reduce(retrying, msg({ t: "joined", role: "X", token: null }));
    expect(back).toMatchObject({ connection: "open", attempt: 2 });
    expect(clientReducer(back, { type: "closed", code: 1006 }).attempt).toBe(3);
    expect(clientReducer(back, { type: "stable" }).attempt).toBe(0);
  });

  it("keeps the role and board while reconnecting", () => {
    const state = reduce(joinedAs("O"), { type: "closed", code: 1001 });
    expect(state.role).toBe("O");
    expect(state.server).not.toBeNull();
  });
});

describe("close codes", () => {
  it("classifies the lobby's close codes", () => {
    expect(classifyClose(4000)).toBe("replaced");
    expect(classifyClose(4001)).toBe("expired");
    expect(classifyClose(1008)).toBe("policy");
    // 4002 (lobby full) is retried: spectators come and go.
    for (const code of [1000, 1001, 1006, 1011, 1012, 4002]) {
      expect(classifyClose(code)).toBe("retry");
    }
  });

  it("remembers a full lobby until it joins, sees room or reconnects manually", () => {
    const full = msg({ t: "error", code: "LOBBY_FULL", message: "Full." });
    const refused = clientReducer(initialClientState, full);
    expect(refused).toMatchObject({ lobbyFull: true, lastError: { code: "LOBBY_FULL" } });
    // Kept through closes, so the final failed state can say why.
    expect(clientReducer(refused, { type: "closed", code: 4002 }).lobbyFull).toBe(true);
    expect(clientReducer(refused, { type: "lobbyChecked", full: false }).lobbyFull).toBe(false);
    expect(clientReducer(refused, { type: "reconnect" }).lobbyFull).toBe(false);
    const joined = msg({ t: "joined", role: "spectator", token: null });
    expect(clientReducer(refused, joined).lobbyFull).toBe(false);

    const looked = clientReducer(initialClientState, { type: "lobbyChecked", full: true });
    expect(looked).toMatchObject({ lobbyFull: true, lastError: { code: "LOBBY_FULL" } });
    const fine = clientReducer(initialClientState, { type: "lobbyChecked", full: false });
    expect(fine).toBe(initialClientState);
  });

  it("4000 means another tab took the seat: no auto-reconnect", () => {
    expect(clientReducer(joinedAs("X"), { type: "closed", code: 4000 })).toMatchObject({
      connection: "replaced",
      attempt: 0,
    });
  });

  it("4001 means the lobby expired", () => {
    expect(clientReducer(joinedAs("X"), { type: "closed", code: 4001 }).connection).toBe("expired");
  });

  it("1008 fails straight away with an error instead of looping", () => {
    const state = clientReducer(joinedAs("X"), { type: "closed", code: 1008 });
    expect(state.connection).toBe("failed");
    expect(state.lastError?.code).toBe("CONNECTION_CLOSED");
  });

  it("gives up after the last backoff step", () => {
    let state = joinedAs("X");
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      state = clientReducer(state, { type: "closed", code: 1006 });
      expect(state).toMatchObject({ connection: "reconnecting", attempt });
    }
    state = clientReducer(state, { type: "closed", code: 1006 });
    expect(state).toMatchObject({ connection: "failed", attempt: 0 });
    expect(clientReducer(state, { type: "reconnect" })).toMatchObject({
      connection: "connecting",
      attempt: 0,
    });
  });
});

describe("reconnectDelay", () => {
  it("backs off 0.5, 1, 2, 4, 8 seconds then stops", () => {
    expect(RECONNECT_DELAYS_MS).toEqual([500, 1000, 2000, 4000, 8000]);
    expect([1, 2, 3, 4, 5].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(reconnectDelay(6)).toBeNull();
    expect(reconnectDelay(0)).toBeNull();
  });
});

describe("optimistic moves", () => {
  it("plans a legal move against the latest seq", () => {
    const plan = planMove(joinedAs("X"), 4);
    expect(plan).toEqual({
      ok: true,
      pending: { cell: 4, seat: "X", baseSeq: 3 },
      msg: { t: "move", move: { cell: 4 }, seq: 3 },
    });
  });

  it("rejects moves locally using the game rules", () => {
    expect(planMove(joinedAs("O"), 0)).toEqual({ ok: false, code: "NOT_YOUR_TURN" });
    expect(planMove(joinedAs("spectator"), 0)).toEqual({ ok: false, code: "NOT_A_PLAYER" });
    const taken = publicState({ board: { board: ["O", ...Array(8).fill(null)], turn: "X" } });
    expect(planMove(joinedAs("X", taken), 0)).toEqual({ ok: false, code: "INVALID_MOVE" });
    expect(planMove(joinedAs("X"), 9)).toEqual({ ok: false, code: "INVALID_MOVE" });
    expect(planMove(joinedAs("X", publicState({ phase: "waiting" })), 0)).toMatchObject({
      ok: false,
    });
    expect(planMove(joinedAs("X", publicState({ phase: "finished" })), 0)).toEqual({
      ok: false,
      code: "GAME_OVER",
    });
    expect(planMove(initialClientState, 0)).toEqual({ ok: false, code: "NOT_JOINED" });
  });

  it("allows only one move in flight", () => {
    const plan = planMove(joinedAs("X"), 4);
    if (!plan.ok) throw new Error("expected a legal move");
    const sent = clientReducer(joinedAs("X"), { type: "moveSent", pending: plan.pending });
    expect(planMove(sent, 5)).toEqual({ ok: false, code: "NOT_YOUR_TURN" });
  });

  it("renders the move immediately", () => {
    const sent = clientReducer(joinedAs("X"), {
      type: "moveSent",
      pending: { cell: 4, seat: "X", baseSeq: 3 },
    });
    const view = viewState(sent);
    expect(view?.board.board[4]).toBe("X");
    expect(view?.board.turn).toBe("O");
    expect(view?.result).toEqual({ kind: "playing", turn: "O" });
  });

  it("shows an optimistic win", () => {
    const board = { board: ["X", "X", null, "O", "O", null, null, null, null], turn: "X" } as const;
    const sent = clientReducer(
      joinedAs("X", publicState({ board: { ...board, board: [...board.board] } })),
      {
        type: "moveSent",
        pending: { cell: 2, seat: "X", baseSeq: 3 },
      },
    );
    expect(viewState(sent)?.result).toEqual({ kind: "won", winner: "X", line: [0, 1, 2] });
  });

  it("the next snapshot replaces local state", () => {
    const sent = clientReducer(joinedAs("X"), {
      type: "moveSent",
      pending: { cell: 4, seat: "X", baseSeq: 3 },
    });
    const confirmed = tictactoe.applyMove(tictactoe.init("X"), "X", { cell: 4 });
    const next = clientReducer(
      sent,
      msg({ t: "state", state: publicState({ board: confirmed }), seq: 4 }),
    );
    expect(next.pending).toBeNull();
    expect(viewState(next)?.board).toEqual(confirmed);
  });

  it("keeps the pending move across a same-seq snapshot (spectator count change)", () => {
    const sent = clientReducer(joinedAs("X"), {
      type: "moveSent",
      pending: { cell: 4, seat: "X", baseSeq: 3 },
    });
    const next = clientReducer(
      sent,
      msg({ t: "state", state: publicState({ spectators: 1 }), seq: 3 }),
    );
    expect(next.pending).not.toBeNull();
    expect(viewState(next)?.board.board[4]).toBe("X");
    expect(viewState(next)?.spectators).toBe(1);
  });

  it("reverts on an error and reports it", () => {
    const sent = clientReducer(joinedAs("X"), {
      type: "moveSent",
      pending: { cell: 4, seat: "X", baseSeq: 3 },
    });
    const next = clientReducer(sent, msg({ t: "error", code: "STALE_STATE", message: "stale" }));
    expect(next.pending).toBeNull();
    expect(viewState(next)?.board.board[4]).toBeNull();
    expect(next.lastError?.text).toBe(errorText("STALE_STATE"));
  });

  it("drops the pending move when the connection closes", () => {
    const sent = clientReducer(joinedAs("X"), {
      type: "moveSent",
      pending: { cell: 4, seat: "X", baseSeq: 3 },
    });
    expect(clientReducer(sent, { type: "closed", code: 1006 }).pending).toBeNull();
  });
});

describe("errorText", () => {
  it("has friendly text for every server error code", () => {
    const codes = [
      "NOT_YOUR_TURN",
      "INVALID_MOVE",
      "GAME_OVER",
      "LOBBY_FULL",
      "BAD_MESSAGE",
      "NOT_JOINED",
      "NOT_A_PLAYER",
      "STALE_STATE",
      "CONNECTION_CLOSED",
    ] as const;
    for (const code of codes) {
      expect(errorText(code)).toMatch(/^[A-Z].+\.$/);
      expect(errorText(code)).not.toContain("_");
    }
  });
});

describe("formatCountdown", () => {
  it("formats minutes and seconds, rounding up and clamping at zero", () => {
    expect(formatCountdown(120_000)).toBe("2:00");
    expect(formatCountdown(102_000)).toBe("1:42");
    expect(formatCountdown(101_001)).toBe("1:42");
    expect(formatCountdown(9_000)).toBe("0:09");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});
