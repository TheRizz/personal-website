import { describe, expect, it } from "vitest";
import { generateLobbyCode, isLobbyCode, normalizeLobbyCode } from "./code";
import { LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH } from "./constants";

/** A RandomBytes stub that serves `bytes` in order, in chunks of whatever size is asked for. */
function fromBytes(bytes: number[]) {
  let i = 0;
  const requested: number[] = [];
  const randomBytes = (n: number) => {
    requested.push(n);
    const chunk = bytes.slice(i, i + n);
    i += n;
    return Uint8Array.from(chunk);
  };
  return { randomBytes, requested };
}

describe("generateLobbyCode", () => {
  it("produces valid codes with the default crypto source", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateLobbyCode();
      expect(code).toHaveLength(LOBBY_CODE_LENGTH);
      expect(isLobbyCode(code)).toBe(true);
      for (const char of code) expect(LOBBY_CODE_ALPHABET).toContain(char);
    }
  });

  it("maps bytes onto the alphabet", () => {
    const { randomBytes } = fromBytes([0, 1, 30, 31, 32, 247]);
    // 31 % 31 = 0 -> A, 32 % 31 = 1 -> B, 247 % 31 = 30 -> 9
    expect(generateLobbyCode(randomBytes)).toBe("AB9AB9");
  });

  it("skips bytes >= 248 to avoid modulo bias", () => {
    const { randomBytes } = fromBytes([248, 0, 255, 1, 250, 2, 3, 4, 5]);
    expect(generateLobbyCode(randomBytes)).toBe("ABCDEF");
  });

  it("asks for more bytes when a whole batch is rejected", () => {
    const { randomBytes, requested } = fromBytes([...Array(12).fill(255), 0, 0, 0, 0, 0, 0]);
    expect(generateLobbyCode(randomBytes)).toBe("AAAAAA");
    expect(requested.length).toBe(2);
  });
});

describe("normalizeLobbyCode", () => {
  it.each([
    ["k7qxm2", "K7QXM2"],
    [" k7q xm2 ", "K7QXM2"],
    ["k7q-xm2", "K7QXM2"],
    // 0, O, 1, I and L are not in the alphabet.
    ["O0I1L", ""],
    ["aboc0d1e", "ABCDE"],
    ["ABCDEFGH", "ABCDEF"],
    ["", ""],
    ["ж€😀", ""],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeLobbyCode(input)).toBe(expected);
  });
});

describe("isLobbyCode", () => {
  it.each(["ABCDEF", "K7QXM2", "234567", "ZZZZZZ"])("accepts %j", (code) => {
    expect(isLobbyCode(code)).toBe(true);
  });

  it.each([
    ["lowercase", "abcdef"],
    ["too short", "ABCDE"],
    ["too long", "ABCDEFG"],
    ["ambiguous O", "ABCDEO"],
    ["ambiguous 0", "ABCDE0"],
    ["ambiguous 1", "ABCDE1"],
    ["ambiguous I", "ABCDEI"],
    ["ambiguous L", "ABCDEL"],
    ["spaces", "ABC DE"],
    ["trailing newline", "ABCDEF\n"],
    ["not a string", 123456],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(isLobbyCode(value)).toBe(false);
  });
});
