import { describe, expect, it } from "vitest";
import { CHARACTERS } from "./characters";
import { STEP, createMatch, step, type Match } from "./engine";
import { decodeInput } from "./net";
import { FrameClock, MAX_PREDICTION, Predictor } from "./online";

const STEP_MS = STEP * 1000;

function newMatch(): Match {
  return createMatch({
    characters: [CHARACTERS[0], CHARACTERS[1]],
    target: 11,
    court: "jungle",
    seed: 7,
  });
}

/** The room's side: steps a match with each seat's buttons by frame. */
function run(match: Match, frames: number, buttons: (frame: number) => [number, number]) {
  for (let k = 0; k < frames; k++) step(match, buttons(k).map(decodeInput));
  return match;
}

const strip = (match: Match) => JSON.parse(JSON.stringify(match)) as Match;

describe("Predictor", () => {
  it("matches the room exactly when it knows every input", () => {
    // Ryan (seat 0) runs right from frame 10 and jumps at 40; Sam holds left from frame 30.
    const buttons = (k: number): [number, number] => [
      (k >= 10 ? 2 : 0) | (k >= 40 && k < 70 ? 4 : 0),
      k >= 30 ? 1 : 0,
    ];
    const room = newMatch();
    run(room, 20, buttons);

    const predictor = new Predictor(0);
    predictor.press(10, 2);
    predictor.setSnapshot({ frame: 20, match: strip(room), inputs: buttons(19) });
    predictor.press(40, 6);
    predictor.press(70, 2);
    predictor.heard(1, 30, 1);

    const predicted = predictor.predict(200)!;
    run(room, 180, (k) => buttons(k + 20));
    expect(predicted).toEqual(strip(room));
  });

  it("guesses the opponent keeps holding what they held", () => {
    const predictor = new Predictor(0);
    const room = newMatch();
    predictor.setSnapshot({ frame: 0, match: strip(room), inputs: [0, 1] });
    const predicted = predictor.predict(60)!;
    expect(predicted.players[1]!.x).toBeLessThan(room.players[1]!.x);
  });

  it("only sends changes, never stamped before the last one", () => {
    const predictor = new Predictor(1);
    predictor.setSnapshot({ frame: 50, match: newMatch(), inputs: [0, 0] });
    expect(predictor.press(60, 0)).toBeNull();
    expect(predictor.press(60, 4)).toEqual({ f: 60, i: 4 });
    expect(predictor.press(58, 0)).toEqual({ f: 60, i: 0 });
    expect(predictor.ownBits()).toBe(0);
  });

  it("starts afresh when a new match begins", () => {
    const predictor = new Predictor(0);
    predictor.setSnapshot({ frame: 500, match: newMatch(), inputs: [0, 0] });
    predictor.press(510, 2);
    predictor.heard(1, 520, 1);
    predictor.setSnapshot({ frame: 0, match: newMatch(), inputs: [0, 0] });
    expect(predictor.ownBits()).toBe(0);
    const predicted = predictor.predict(30)!;
    expect(predicted.players[0]!.x).toBe(newMatch().players[0]!.x);
    expect(predicted.players[1]!.x).toBe(newMatch().players[1]!.x);
  });

  it("stops guessing a couple of seconds past the last snapshot", () => {
    const predictor = new Predictor(0);
    predictor.setSnapshot({ frame: 0, match: newMatch(), inputs: [0, 0] });
    expect(predictor.predict(10_000)!.time).toBeCloseTo(MAX_PREDICTION * STEP, 6);
  });

  it("is empty before the first snapshot", () => {
    expect(new Predictor(0).predict(10)).toBeNull();
  });
});

describe("FrameClock", () => {
  it("runs a round trip plus a margin ahead of the room", () => {
    const clock = new FrameClock();
    expect(clock.advance(0, 5)).toBe(5);
    clock.onPong(60, 0);
    // Snapshot of frame 120 arrives at t = 1030 ms: the room was at 120 30 ms ago.
    clock.onSnapshot(1, 120, 1030, null);
    const shown = clock.advance(1030, 120);
    expect(shown).toBe(Math.floor(120 + (60 + clock.margin) / STEP_MS));
    // A late snapshot doesn't pull it back: the least delayed one sets the pace.
    clock.onSnapshot(1, 124, 1100, null);
    expect(clock.advance(1100, 124)).toBeGreaterThanOrEqual(shown + 8);
  });

  it("leads further when inputs arrive late, and less when they're early", () => {
    const clock = new FrameClock();
    const start = clock.margin;
    clock.onSnapshot(1, 0, 0, -2);
    expect(clock.margin).toBeGreaterThan(start);
    const grown = clock.margin;
    for (let i = 0; i < 5; i++) clock.onSnapshot(1, 0, 0, 10);
    expect(clock.margin).toBeLessThan(grown);
  });

  it("measures again from scratch when the room's clock restarts", () => {
    const clock = new FrameClock();
    clock.onSnapshot(1, 1000, 10_000, null);
    clock.advance(10_000, 1000);
    clock.onSnapshot(2, 1000, 40_000, null);
    expect(clock.advance(40_000, 1000)).toBeLessThan(1100);
  });
});
