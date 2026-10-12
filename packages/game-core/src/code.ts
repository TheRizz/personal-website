import { LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH } from "./constants";

/** Returns `n` cryptographically random bytes. */
export type RandomBytes = (n: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// The largest multiple of the alphabet size that fits in a byte (8 * 31 = 248). Bytes at or above it
// are discarded so every character is equally likely (no modulo bias).
const REJECT_FROM = 256 - (256 % LOBBY_CODE_ALPHABET.length);

/** A fresh random lobby code, e.g. "K7QXM2". Randomness is injectable for tests. */
export function generateLobbyCode(randomBytes: RandomBytes = defaultRandomBytes): string {
  let code = "";
  while (code.length < LOBBY_CODE_LENGTH) {
    for (const byte of randomBytes(LOBBY_CODE_LENGTH * 2)) {
      if (byte >= REJECT_FROM) continue;
      code += LOBBY_CODE_ALPHABET[byte % LOBBY_CODE_ALPHABET.length];
      if (code.length === LOBBY_CODE_LENGTH) break;
    }
  }
  return code;
}

/** Cleans up user input as they type: uppercase, drop characters outside the alphabet, cap length. */
export function normalizeLobbyCode(input: string): string {
  return Array.from(input.toUpperCase())
    .filter((char) => LOBBY_CODE_ALPHABET.includes(char))
    .join("")
    .slice(0, LOBBY_CODE_LENGTH);
}

const LOBBY_CODE_RE = new RegExp(`^[${LOBBY_CODE_ALPHABET}]{${LOBBY_CODE_LENGTH}}$`);

/** True for exactly LOBBY_CODE_LENGTH alphabet characters (already normalised). */
export function isLobbyCode(value: unknown): value is string {
  return typeof value === "string" && LOBBY_CODE_RE.test(value);
}
