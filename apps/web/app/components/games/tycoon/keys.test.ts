import { describe, expect, it } from "vitest";
import { goldenSpawn, newGame, type GameState } from "@site/tycoon-core";
import { KEY_HELP, goldenOnScreen, isTypingTarget, keyAction, type KeyPress } from "./keys";

function press(key: string, change: Partial<KeyPress> = {}): KeyPress {
  return { key, ctrlKey: false, metaKey: false, altKey: false, onScene: false, ...change };
}

describe("keyAction", () => {
  it("processes records on space or Enter only with the core focused", () => {
    expect(keyAction(press(" ", { onScene: true }))).toEqual({ type: "click" });
    expect(keyAction(press("Enter", { onScene: true }))).toEqual({ type: "click" });
    // Elsewhere space scrolls the page and Enter presses the focused button, as usual.
    expect(keyAction(press(" "))).toBeNull();
    expect(keyAction(press("Enter"))).toBeNull();
  });

  it("builds tier 1 to 10 with keys 1 to 0, like the CLI", () => {
    expect(keyAction(press("1"))).toEqual({ type: "build", tier: 0 });
    expect(keyAction(press("9"))).toEqual({ type: "build", tier: 8 });
    expect(keyAction(press("0"))).toEqual({ type: "build", tier: 9 });
  });

  it("maps x, the arrows, g and ? whatever the caps lock", () => {
    expect(keyAction(press("x"))).toEqual({ type: "amount" });
    expect(keyAction(press("X"))).toEqual({ type: "amount" });
    expect(keyAction(press("ArrowRight"))).toEqual({ type: "tab", step: 1 });
    expect(keyAction(press("ArrowLeft"))).toEqual({ type: "tab", step: -1 });
    expect(keyAction(press("g"))).toEqual({ type: "golden" });
    expect(keyAction(press("G"))).toEqual({ type: "golden" });
    expect(keyAction(press("?"))).toEqual({ type: "help" });
  });

  it("leaves browser shortcuts and other keys alone", () => {
    expect(keyAction(press("1", { metaKey: true }))).toBeNull();
    expect(keyAction(press("r", { ctrlKey: true }))).toBeNull();
    expect(keyAction(press("g", { altKey: true }))).toBeNull();
    expect(keyAction(press("q"))).toBeNull();
    expect(keyAction(press("Tab"))).toBeNull();
    expect(keyAction(press("ArrowDown"))).toBeNull();
  });
});

describe("isTypingTarget", () => {
  const element = (tagName: string, more: object = {}) =>
    ({ tagName, ...more }) as unknown as EventTarget;

  it("is true for text fields and false for buttons and the page", () => {
    expect(isTypingTarget(element("INPUT", { type: "text" }))).toBe(true);
    expect(isTypingTarget(element("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(element("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(element("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTypingTarget(element("BUTTON"))).toBe(false);
    expect(isTypingTarget(element("BODY"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("goldenOnScreen", () => {
  function at(playMs: number): GameState {
    const state = newGame();
    return { ...state, playMs, golden: { ...state.golden, start: 0, next: 0 } };
  }

  it("finds the packet only while it is on screen", () => {
    const first = goldenSpawn({ seed: newGame().golden.seed, start: 0 }, 0);
    expect(goldenOnScreen(at(first.at - 1))).toBeNull();
    expect(goldenOnScreen(at(first.at))).toBe(0);
    expect(goldenOnScreen(at(first.at + first.visibleMs / 2))).toBe(0);
    expect(goldenOnScreen(at(first.at + first.visibleMs + 1))).toBeNull();
  });
});

describe("KEY_HELP", () => {
  it("lists every key the game answers", () => {
    const keys = KEY_HELP.flatMap((row) => row.keys).join(" ");
    for (const key of ["Space", "1", "0", "X", "←", "→", "G", "?"]) expect(keys).toContain(key);
  });
});
