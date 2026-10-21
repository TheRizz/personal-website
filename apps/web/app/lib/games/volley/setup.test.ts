import { describe, expect, it } from "vitest";
import { DEFAULT_SETUP, charactersFor, controllers, parseSetup, sideNames } from "./setup";

describe("parseSetup", () => {
  it("falls back to the default for missing or unknown values", () => {
    expect(parseSetup(null)).toEqual(DEFAULT_SETUP);
    expect(parseSetup({ format: "3v3", mode: "coop", target: 99, p1: "nobody" })).toEqual(
      DEFAULT_SETUP,
    );
  });

  it("keeps a mode only if the format has it", () => {
    expect(parseSetup({ format: "2v2", mode: "versus" }).mode).toBe("versus");
    expect(parseSetup({ format: "1v1", mode: "versus" }).mode).toBe("cpu");
  });
});

describe("players", () => {
  it("puts the people at the front in 2v2 and fills the rest with computers", () => {
    expect(controllers({ ...DEFAULT_SETUP, format: "1v1", mode: "local" })).toEqual(["p1", "p2"]);
    expect(controllers({ ...DEFAULT_SETUP, format: "2v2", mode: "cpu" })).toEqual([
      "cpu",
      "p1",
      "cpu",
      "cpu",
    ]);
    expect(controllers({ ...DEFAULT_SETUP, format: "2v2", mode: "versus" })).toEqual([
      "cpu",
      "p1",
      "cpu",
      "p2",
    ]);
  });

  it("gives the computers characters nobody picked", () => {
    const setup = { ...DEFAULT_SETUP, format: "2v2" as const, mode: "cpu" as const, p1: "zip" };
    const ids = charactersFor(setup).map((character) => character.id);
    expect(ids[1]).toBe("zip");
    expect(new Set(ids).size).toBe(4);
  });

  it("names 1v1 sides after the characters, or P1 and P2 when both picked the same", () => {
    const setup = { ...DEFAULT_SETUP, mode: "local" as const, p1: "kiki", p2: "kiki" };
    expect(sideNames(setup, charactersFor(setup))).toEqual(["P1", "P2"]);
    const other = { ...setup, p2: "rio" };
    expect(sideNames(other, charactersFor(other))).toEqual(["Kiki", "Rio"]);
  });
});
