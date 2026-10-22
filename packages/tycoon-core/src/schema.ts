import { z } from "zod";
import { GENERATORS, UPGRADES_BY_ID } from "./data";
import { RULES_VERSION, type GameState } from "./rules";
import type { SaveLog } from "./replay";

// Shapes that cross the network or come out of storage. Everything the server receives is
// parsed here before it reaches the rules.

/** A save covers at most this many actions; the client saves early when it gets close. */
export const MAX_LOG_ACTIONS = 4_000;
/** And at most this many bytes of JSON. */
export const MAX_SAVE_BYTES = 128 * 1024;
/** Autosave interval (docs/04-pipeline-tycoon.md §2.3). */
export const AUTOSAVE_MS = 5 * 60 * 1000;

const time = z.number().finite().min(0).max(1e12);

export const actionSchema = z.discriminatedUnion("a", [
  z.object({ t: time, a: z.literal("click"), n: z.number().int().min(1).max(100_000) }),
  z.object({
    t: time,
    a: z.literal("buy"),
    g: z
      .number()
      .int()
      .min(0)
      .max(GENERATORS.length - 1),
    n: z.number().int().min(1).max(100),
  }),
  z.object({ t: time, a: z.literal("up"), id: z.string().max(64) }),
  z.object({ t: time, a: z.literal("gold"), i: z.number().int().min(0).max(1_000_000) }),
  z.object({ t: time, a: z.literal("migrate") }),
]);

export const saveLogSchema: z.ZodType<SaveLog> = z.object({
  elapsed: time,
  actions: z.array(actionSchema).max(MAX_LOG_ACTIONS),
});

/** POST /api/tycoon/session body. */
export const sessionRequestSchema = z.object({ v: z.number().int() });

/** PUT /api/tycoon/save body. */
export const saveRequestSchema = z.object({
  v: z.number().int(),
  session: z.string().min(1).max(64),
  /** The save counter the client last saw; detects lost or duplicated requests. */
  seq: z.number().int().min(0),
  log: saveLogSchema,
});
export type SaveRequest = z.infer<typeof saveRequestSchema>;

const count = z.number().int().min(0);
const amount = z.number().finite().min(0);

/** A stored state. Unknown upgrade ids are dropped rather than failing the whole save. */
export const gameStateSchema: z.ZodType<GameState> = z.object({
  v: z.number().int(),
  records: amount,
  runRecords: amount,
  lifetimeRecords: amount,
  playMs: amount,
  runMs: amount,
  clicks: count,
  owned: z.array(count).length(GENERATORS.length),
  upgrades: z.array(z.string()).transform((ids) => ids.filter((id) => UPGRADES_BY_ID.has(id))),
  ap: count,
  migrations: count,
  achievements: z.array(z.string()),
  goldenCaught: count,
  bestRate: amount,
  overclockUntil: amount,
  ended: z.boolean(),
  golden: z.object({ seed: count, start: amount, next: count }),
});

/**
 * Brings a stored state up to the current RULES_VERSION. There is only version 1 so far; later
 * versions add a step here for each bump.
 */
export function upgradeState(state: GameState): GameState {
  return { ...state, v: RULES_VERSION };
}
