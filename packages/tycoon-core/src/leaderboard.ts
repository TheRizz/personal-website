import { z } from "zod";

// The public leaderboard (docs/04-pipeline-tycoon.md, phase 3): players opt in with a name and
// are ranked by lifetime Records. Shared by the Worker (which enforces it), the web page and the
// CLI (which check a name before sending it, so the message comes without a round trip).

/** How many players the board shows. */
export const LEADERBOARD_SIZE = 50;
/** How long a board may be served from cache, in seconds. */
export const LEADERBOARD_CACHE_SECONDS = 300;
export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 16;
const NAME_CHARACTERS = /^[A-Za-z0-9_]+$/;

export type NameProblem = "length" | "characters" | "blocked";

export type NameCheck = { ok: true; name: string } | { ok: false; problem: NameProblem };

/** What to tell a player about a rejected name. */
export const NAME_PROBLEM_MESSAGES: Record<NameProblem, string> = {
  length: `Names are ${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters.`,
  characters: "Use letters, digits and _ only.",
  blocked: "Pick a different name.",
};

// Lowercase, with look-alike digits and symbols read as letters. Kept short on purpose: it
// stops the obvious, and moderation (/admin) handles the rest.
const LOOKALIKES: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
};

/** Blocked anywhere in a name, even inside another word. */
const BLOCKED_ANYWHERE = [
  "fuck",
  "fuk",
  "shit",
  "cunt",
  "nigg",
  "nigr",
  "faggot",
  "fagot",
  "retard",
  "whore",
  "slut",
  "bitch",
  "pussy",
  "penis",
  "vagina",
  "porn",
  "nazi",
  "hitler",
  "kike",
  "chink",
  "wetback",
  "tranny",
  "dyke",
  "twat",
  "wank",
  "jizz",
  "kkk",
];

/** Blocked only as a whole word (between _ or the ends): these hide inside ordinary words. */
const BLOCKED_WORDS = new Set([
  "ass",
  "arse",
  "fag",
  "cum",
  "tit",
  "tits",
  "rape",
  "hoe",
  "homo",
  "anal",
  "dick",
  "cock",
  "spic",
  "rapist",
  "sex",
  "coon",
  "gook",
  "jap",
  "admin",
  "moderator",
]);

function readable(text: string): string {
  return [...text.toLowerCase()].map((c) => LOOKALIKES[c] ?? c).join("");
}

/** Repeated letters squeezed to one: "shiiit" → "shit". */
function squeeze(text: string): string {
  return text.replace(/(.)\1+/g, "$1");
}

function isBlocked(name: string): boolean {
  const plain = readable(name);
  const joined = plain.replace(/_/g, "");
  for (const text of [joined, squeeze(joined)]) {
    if (BLOCKED_ANYWHERE.some((word) => text.includes(word))) return true;
  }
  const words = plain.split(/_+/).filter(Boolean);
  // Also split camel case and digits on the original: "BigAss", "ass69".
  const parts = name
    .split(/_+|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
  return [...words, ...parts, joined].some(
    (word) => BLOCKED_WORDS.has(word) || BLOCKED_WORDS.has(squeeze(word)),
  );
}

/** Checks a leaderboard name; spaces around it are dropped. */
export function checkLeaderboardName(input: string): NameCheck {
  const name = input.trim();
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    return { ok: false, problem: "length" };
  }
  if (!NAME_CHARACTERS.test(name)) return { ok: false, problem: "characters" };
  if (isBlocked(name)) return { ok: false, problem: "blocked" };
  return { ok: true, name };
}

/** PUT /api/tycoon/name body. The name itself is checked with checkLeaderboardName. */
export const nameRequestSchema = z.object({ name: z.string().max(64) });

/** GET /api/tycoon/leaderboard. */
export const leaderboardSchema = z.object({
  entries: z.array(
    z.object({ rank: z.number().int().min(1), name: z.string(), records: z.number() }),
  ),
  /** Server time the board was read, in Unix milliseconds (it may be served from cache). */
  at: z.number(),
});
export type Leaderboard = z.infer<typeof leaderboardSchema>;

/** GET, PUT /api/tycoon/name: this player's place. `rank` is null when off the board. */
export const myNameSchema = z.object({
  name: z.string().nullable(),
  hidden: z.boolean(),
  rank: z.number().int().min(1).nullable(),
  records: z.number(),
});
export type MyName = z.infer<typeof myNameSchema>;
