import { describe, expect, it } from "vitest";
import { WORDS_PER_MINUTE, readingMinutes } from "./index";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("readingMinutes", () => {
  it("is at least one minute", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes("\nHello.\n")).toBe(1);
  });

  it("rounds words over 220 a minute", () => {
    expect(WORDS_PER_MINUTE).toBe(220);
    // split(/\s+/) counts the empty strings around a leading and a trailing newline, as before.
    expect(readingMinutes(`\n${words(327)}\n`)).toBe(1);
    expect(readingMinutes(`\n${words(328)}\n`)).toBe(2);
    expect(readingMinutes(words(2200))).toBe(10);
  });
});
