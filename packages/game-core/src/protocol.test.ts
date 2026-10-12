import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, MAX_NAME_LENGTH } from "./constants";
import {
  clientMsgSchema,
  createLobbyRequestSchema,
  displayNameSchema,
  parseClientMessage,
  serverMsgSchema,
  type PublicState,
} from "./protocol";

const TOKEN = "3b241101-e2bb-4255-8caf-4136c566a962";

describe("clientMsgSchema", () => {
  it.each([
    [{ t: "join", name: "Ada" }],
    [{ t: "join", name: "Ada", token: TOKEN }],
    [{ t: "join", name: "x".repeat(MAX_NAME_LENGTH) }],
    [{ t: "join", name: "Zoë 👩‍💻" }],
    [{ t: "join", name: "\u0627\u0644\u064a" }],
    [{ t: "join", name: "Jo\u00adhn\u200b" }],
    [{ t: "join", name: "\u2764\ufe0f" }],
    [{ t: "move", move: { cell: 4 }, seq: 0 }],
    [{ t: "move", move: "anything", seq: 12 }],
    [{ t: "rematch" }],
    [{ t: "leave" }],
  ])("accepts %j", (msg) => {
    expect(clientMsgSchema.safeParse(msg).success).toBe(true);
  });

  it("trims names", () => {
    const parsed = clientMsgSchema.parse({ t: "join", name: "  Ada Lovelace \t" });
    expect(parsed).toEqual({ t: "join", name: "Ada Lovelace" });
  });

  it("checks name length after trimming", () => {
    const name = ` ${"x".repeat(MAX_NAME_LENGTH)} `;
    expect(clientMsgSchema.safeParse({ t: "join", name }).success).toBe(true);
  });

  it.each([
    ["empty name", { t: "join", name: "" }],
    ["blank name", { t: "join", name: "   " }],
    ["long name", { t: "join", name: "x".repeat(MAX_NAME_LENGTH + 1) }],
    ["name with newline", { t: "join", name: "Ada\nBob" }],
    ["name with NUL", { t: "join", name: "Ada\u0000" }],
    ["name with DEL", { t: "join", name: "Ada\u007f" }],
    ["name with C1 control", { t: "join", name: "Ada\u0085" }],
    ["name with bidi override", { t: "join", name: "Ada\u202egnp" }],
    ["name with line separator", { t: "join", name: "Ada\u2028Bob" }],
    ["name with LRM", { t: "join", name: "Ada\u200e" }],
    ["name with RLM", { t: "join", name: "\u200fAda" }],
    ["name with ALM", { t: "join", name: "Ada\u061c" }],
    ["name of only zero-width spaces", { t: "join", name: "\u200b\u200b" }],
    ["name of only a word joiner", { t: "join", name: "\u2060" }],
    ["name of only a soft hyphen", { t: "join", name: "\u00ad" }],
    ["name of only a Hangul filler", { t: "join", name: "\u3164" }],
    ["name of only a halfwidth Hangul filler", { t: "join", name: "\uffa0" }],
    ["name of only a Braille blank", { t: "join", name: "\u2800" }],
    ["name of only a variation selector", { t: "join", name: "\ufe0f" }],
    ["name of only a combining mark", { t: "join", name: "\u034f" }],
    ["name of only a tag character", { t: "join", name: "\u{e0041}" }],
    ["name of only ZWJs and spaces", { t: "join", name: "\u200d \u200d" }],
    ["non-string name", { t: "join", name: 42 }],
    ["missing name", { t: "join" }],
    ["non-uuid token", { t: "join", name: "Ada", token: "not-a-token" }],
    ["null token", { t: "join", name: "Ada", token: null }],
    ["join with extra key", { t: "join", name: "Ada", admin: true }],
    ["negative seq", { t: "move", move: { cell: 0 }, seq: -1 }],
    ["fractional seq", { t: "move", move: { cell: 0 }, seq: 1.5 }],
    ["string seq", { t: "move", move: { cell: 0 }, seq: "1" }],
    ["missing seq", { t: "move", move: { cell: 0 } }],
    ["move with extra key", { t: "move", move: { cell: 0 }, seq: 0, x: 1 }],
    ["rematch with extra key", { t: "rematch", please: true }],
    ["leave with extra key", { t: "leave", now: true }],
    ["unknown type", { t: "chat", text: "hi" }],
  ])("rejects %s", (_name, msg) => {
    expect(clientMsgSchema.safeParse(msg).success).toBe(false);
  });
});

describe("parseClientMessage", () => {
  it("parses a valid message", () => {
    expect(parseClientMessage(JSON.stringify({ t: "join", name: " Ada " }))).toEqual({
      ok: true,
      msg: { t: "join", name: "Ada" },
    });
  });

  it.each([
    ["not JSON", "{t:"],
    ["empty", ""],
    ["bare ping", "ping"],
  ])("reports bad_json for %s", (_name, text) => {
    expect(parseClientMessage(text)).toMatchObject({ ok: false, reason: "bad_json" });
  });

  it.each([
    ["unknown t", { t: "chat" }],
    ["missing t", { name: "Ada" }],
    ["numeric t", { t: 1 }],
    ["array", [{ t: "join", name: "Ada" }]],
    ["null", null],
    ["number", 42],
    ["string", "join"],
  ])("reports unknown_type for %s", (_name, value) => {
    expect(parseClientMessage(JSON.stringify(value))).toMatchObject({
      ok: false,
      reason: "unknown_type",
    });
  });

  it("reports invalid for a known type with bad fields", () => {
    const result = parseClientMessage(JSON.stringify({ t: "join", name: "   " }));
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a name with nothing visible in it, and explains why", () => {
    const name = " \u200b\u3164 ";
    expect(parseClientMessage(JSON.stringify({ t: "join", name }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(displayNameSchema.safeParse(name).error?.issues.map((i) => i.message)).toEqual([
      "Name must contain a visible character.",
    ]);
  });

  it("reports invalid for junk keys", () => {
    expect(parseClientMessage(JSON.stringify({ t: "leave", x: 1 }))).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("accepts a message of exactly MAX_MESSAGE_BYTES", () => {
    const base = JSON.stringify({ t: "move", move: "", seq: 0 });
    const text = JSON.stringify({
      t: "move",
      move: "a".repeat(MAX_MESSAGE_BYTES - base.length),
      seq: 0,
    });
    expect(text.length).toBe(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(text).ok).toBe(true);
  });

  it("rejects ASCII over MAX_MESSAGE_BYTES as too_large", () => {
    const text = JSON.stringify({ t: "move", move: "a".repeat(MAX_MESSAGE_BYTES), seq: 0 });
    expect(parseClientMessage(text)).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("measures size in UTF-8 bytes, not UTF-16 units", () => {
    // "€" is 1 UTF-16 unit but 3 UTF-8 bytes: ~1.4k chars, ~4.2k bytes.
    const text = JSON.stringify({ t: "move", move: "€".repeat(1400), seq: 0 });
    expect(text.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(text)).toMatchObject({ ok: false, reason: "too_large" });
    const fits = JSON.stringify({ t: "move", move: "€".repeat(1300), seq: 0 });
    expect(parseClientMessage(fits).ok).toBe(true);
  });
});

describe("serverMsgSchema", () => {
  const state: PublicState = {
    code: "K7QXM2",
    game: "tictactoe",
    phase: "playing",
    players: {
      X: { name: "Ada", connected: true, releaseAt: null },
      O: { name: "Bob", connected: false, releaseAt: 1_700_000_000_000 },
    },
    spectators: 2,
    board: { board: ["X", null, null, null, "O", null, null, null, null], turn: "X" },
    result: { kind: "playing", turn: "X" },
    round: 1,
    firstSeat: "X",
    score: { X: 0, O: 0, draws: 0 },
    rematch: { X: false, O: false },
  };

  it.each([
    [{ t: "joined", role: "X", token: TOKEN }],
    [{ t: "joined", role: "spectator", token: null }],
    [{ t: "state", state, seq: 3 }],
    [
      {
        t: "state",
        state: { ...state, result: { kind: "won", winner: "O", line: [0, 4, 8] } },
        seq: 3,
      },
    ],
    [{ t: "state", state: { ...state, result: { kind: "draw" } }, seq: 3 }],
    [{ t: "error", code: "STALE_STATE", message: "Try again." }],
  ])("accepts %j", (msg) => {
    expect(serverMsgSchema.safeParse(msg).success).toBe(true);
  });

  it("ignores fields added by a newer server", () => {
    const parsed = serverMsgSchema.parse({ t: "error", code: "BAD_MESSAGE", message: "", v: 2 });
    expect(parsed).toEqual({ t: "error", code: "BAD_MESSAGE", message: "" });
  });

  it.each([
    ["unknown t", { t: "hello" }],
    ["unknown error code", { t: "error", code: "NOPE", message: "" }],
    ["bad role", { t: "joined", role: "Z", token: null }],
    ["short board", { t: "state", state: { ...state, board: { board: [], turn: "X" } }, seq: 0 }],
    ["negative seq", { t: "state", state, seq: -1 }],
    ["unknown game", { t: "state", state: { ...state, game: "chess" }, seq: 0 }],
  ])("rejects %s", (_name, msg) => {
    expect(serverMsgSchema.safeParse(msg).success).toBe(false);
  });
});

describe("createLobbyRequestSchema", () => {
  it("accepts a known game only", () => {
    expect(createLobbyRequestSchema.safeParse({ game: "tictactoe" }).success).toBe(true);
    expect(createLobbyRequestSchema.safeParse({ game: "chess" }).success).toBe(false);
    expect(createLobbyRequestSchema.safeParse({}).success).toBe(false);
    expect(createLobbyRequestSchema.safeParse({ game: "tictactoe", x: 1 }).success).toBe(false);
  });
});
