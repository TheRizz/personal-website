import { describe, expect, it } from "vitest";
import { goldenSpawn, newGame, type GameState } from "@site/tycoon-core";
import { splitKeys } from "./app";
import { listedUpgrades, renderEnding, renderFrame, ENDING_LINES, type View } from "./render";
import { Canvas, detectColorMode } from "./screen";

function view(state: GameState | null, overrides: Partial<View> = {}): View {
  return {
    cols: 100,
    rows: 30,
    time: 1234,
    state,
    status: { kind: "playing" },
    tab: "build",
    buyAmount: 1,
    toast: null,
    saving: false,
    lastSavedAt: null,
    confirmMigrate: false,
    pairing: null,
    serverLabel: "ry-mart.com",
    ...overrides,
  };
}

function playing(): GameState {
  const state = newGame();
  state.records = 1234;
  state.owned[0] = 12;
  state.owned[1] = 3;
  state.golden = { seed: 5, start: 0, next: 0 };
  return state;
}

describe("renderFrame", () => {
  it("fills exactly the terminal, with the core, the owned tiers and the shop", () => {
    const frame = renderFrame(view(playing())).lines();
    expect(frame).toHaveLength(30);
    expect(frame.every((line) => [...line].length === 100)).toBe(true);
    const text = frame.join("\n");
    expect(text).toContain("PROCESS");
    expect(text).toContain("CSV×12");
    expect(text).toContain("CRON×3");
    expect(text).not.toContain("SFTP×");
    expect(text).toContain("1.23K records");
    expect(text).toContain("Intern");
    expect(text).toContain("[space] process");
  });

  it("shows the golden packet only while it's on screen", () => {
    const state = playing();
    const spawn = goldenSpawn(state.golden, 0);
    expect(renderFrame(view(state)).lines().join("")).not.toContain("◆");
    state.playMs = spawn.at + 1000;
    expect(renderFrame(view(state)).lines().join("")).toContain("◆");
  });

  it("lists upgrades with their keys, and asks before migrating", () => {
    const state = playing();
    const upgrades = renderFrame(view(state, { tab: "upgrades" }))
      .lines()
      .join("\n");
    expect(listedUpgrades(state)[0]).toBeDefined();
    expect(upgrades).toContain(listedUpgrades(state)[0]!.name);
    state.runRecords = 5e9;
    const migrate = renderFrame(view(state, { tab: "migrate", confirmMigrate: true }))
      .lines()
      .join("\n");
    expect(migrate).toContain("Press [m] again");
  });

  it("asks for a bigger terminal rather than drawing a broken one", () => {
    const frame = renderFrame(view(playing(), { cols: 60, rows: 20 })).lines();
    expect(frame[0]).toContain("at least 80×24");
  });

  it("explains why the game stopped", () => {
    const text = renderFrame(
      view(playing(), { status: { kind: "stopped", failure: { kind: "session_replaced" } } }),
    )
      .lines()
      .join("\n");
    expect(text).toContain("playing on another device");
  });

  it("plays the ending line by line, then offers the request you can't accept", () => {
    expect(renderEnding(100, 30, 1).lines().join("\n")).not.toContain("UNKNOWN");
    const done = renderEnding(100, 30, ENDING_LINES.length).lines().join("\n");
    expect(done).toContain("ORIGIN: UNKNOWN");
    expect(done).toContain("[ACCEPT] (unavailable)");
  });
});

describe("terminal", () => {
  it("picks a colour depth and respects NO_COLOR", () => {
    expect(detectColorMode({ NO_COLOR: "1", COLORTERM: "truecolor" }, true, null)).toBe("none");
    expect(detectColorMode({ COLORTERM: "truecolor" }, true, null)).toBe("truecolor");
    expect(detectColorMode({ TERM: "xterm-256color" }, true, null)).toBe("256");
    expect(detectColorMode({ COLORTERM: "truecolor" }, false, null)).toBe("none");
    expect(detectColorMode({}, true, false)).toBe("none");
  });

  it("writes no escapes in no-colour mode", () => {
    const canvas = new Canvas(4, 1);
    canvas.text(0, 0, "ab", { fg: "#ff0000", bold: true });
    expect(canvas.toAnsi("none")).toBe("ab  ");
    expect(canvas.toAnsi("truecolor")).toContain("\x1b[1;38;2;255;0;0m");
  });

  it("splits raw input into keys, keeping escape sequences whole", () => {
    expect(splitKeys("  1\x1b[Zq")).toEqual([" ", " ", "1", "\x1b[Z", "q"]);
  });
});
