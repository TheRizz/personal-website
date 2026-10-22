import { OFFLINE_CAP_MS, RULES_VERSION, type Action, type GameState } from "@site/tycoon-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1 } from "./d1-fake";
import { SAVE_SLACK_MS, handleTycoon, type TycoonEnv } from "./tycoon-api";

// The Pipeline Tycoon API against a real SQLite database with the shipped migrations. The rules
// themselves are tested in packages/tycoon-core; these cover auth, sessions, time and storage.

const SITE = "https://ry-mart.com";
const HOUR = 3_600_000;
let env: TycoonEnv;
let sqlite: Awaited<ReturnType<typeof createD1>>["sqlite"];
let limiterAllows: boolean;

beforeEach(async () => {
  const d1 = await createD1("tycoon");
  sqlite = d1.sqlite;
  limiterAllows = true;
  env = {
    TYCOON_DB: d1.db,
    TYCOON_PLAYER_LIMITER: {
      limit: async () => ({ success: limiterAllows }),
    } as unknown as RateLimit,
  };
});

async function call(method: string, path: string, now: number, body?: unknown, auth?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const response = await handleTycoon(
    new Request(`${SITE}/api/tycoon/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    now,
  );
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

async function newPlayer(now = 0) {
  const { status, json } = await call("POST", "players", now);
  expect(status).toBe(201);
  return `${json.player}.${json.token}` as string;
}

async function session(auth: string, now: number) {
  const { status, json } = await call("POST", "session", now, { v: RULES_VERSION }, auth);
  expect(status).toBe(200);
  return json as {
    state: GameState;
    session: string;
    seq: number;
    offline: { ms: number; earned: number };
  };
}

const save = (
  auth: string,
  now: number,
  s: { session: string; seq: number },
  elapsed: number,
  actions: Action[],
) =>
  call(
    "PUT",
    "save",
    now,
    { v: RULES_VERSION, session: s.session, seq: s.seq, log: { elapsed, actions } },
    auth,
  );

describe("players", () => {
  it("creates an anonymous player and stores only a hash of the token", async () => {
    const auth = await newPlayer();
    const [id, token] = auth.split(".");
    const row = sqlite.prepare("SELECT * FROM players WHERE id = ?").all(id)[0]!;
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("is rate-limited", async () => {
    limiterAllows = false;
    expect((await call("POST", "players", 0)).status).toBe(429);
  });

  it("rejects wrong tokens and unknown players", async () => {
    const auth = await newPlayer();
    const [id] = auth.split(".");
    const forged = `${id}.${"A".repeat(43)}`;
    expect((await call("POST", "session", 0, { v: RULES_VERSION }, forged)).status).toBe(401);
    expect((await call("POST", "session", 0, { v: RULES_VERSION })).status).toBe(401);
  });
});

describe("sessions", () => {
  it("credits offline time by the server's clock, capped at 8 hours", async () => {
    const auth = await newPlayer(0);
    let s = await session(auth, 0);
    // Earn a cron job (10 clicks a second for a minute ≈ 600 records, buy 1 intern + 1 cron).
    const clicks: Action[] = Array.from({ length: 60 }, (_, i) => ({
      t: (i + 1) * 1000,
      a: "click",
      n: 10,
    }));
    const saved = await save(auth, 61_000, s, 61_000, [
      ...clicks,
      { t: 60_500, a: "buy", g: 1, n: 1 },
    ]);
    expect(saved.status).toBe(200);
    expect(saved.json.state.owned[1]).toBe(1);

    s = await session(auth, 61_000 + 3 * OFFLINE_CAP_MS);
    expect(s.offline.ms).toBe(OFFLINE_CAP_MS);
    // One cron job (1 record/s) for 8 hours, plus a few percent from achievements.
    expect(s.offline.earned).toBeGreaterThanOrEqual(OFFLINE_CAP_MS / 1000);
    expect(s.offline.earned).toBeLessThan((OFFLINE_CAP_MS / 1000) * 1.1);
  });

  it("refuses an outdated client", async () => {
    const auth = await newPlayer();
    expect((await call("POST", "session", 0, { v: RULES_VERSION - 1 }, auth)).status).toBe(426);
  });

  it("supersedes the previous session (newest device wins)", async () => {
    const auth = await newPlayer();
    const first = await session(auth, 0);
    await session(auth, 1_000);
    const stale = await save(auth, 2_000, first, 1_000, []);
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("session_replaced");
  });
});

describe("saves", () => {
  it("credits no more time than really passed, whatever the client claims", async () => {
    const auth = await newPlayer();
    const s = await session(auth, 0);
    // Claims a day of play 10 s after the session started.
    const result = await save(auth, 10_000, s, 24 * HOUR, [{ t: 0, a: "click", n: 1 }]);
    expect(result.status).toBe(200);
    expect(result.json.creditedMs).toBe(10_000 + SAVE_SLACK_MS);
  });

  it("drops what the server's replay can't afford", async () => {
    const auth = await newPlayer();
    const s = await session(auth, 0);
    const result = await save(auth, 5_000, s, 5_000, [{ t: 4_000, a: "buy", g: 9, n: 1 }]);
    expect(result.json.dropped).toBe(1);
    expect(result.json.state.owned[9]).toBe(0);
  });

  it("counts saves, so a replayed or out-of-order request is refused", async () => {
    const auth = await newPlayer();
    const s = await session(auth, 0);
    const first = await save(auth, 1_000, s, 1_000, []);
    expect(first.json.seq).toBe(1);
    const again = await save(auth, 2_000, s, 1_000, []);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("out_of_sync");
    expect((await save(auth, 2_000, { ...s, seq: 1 }, 1_000, [])).status).toBe(200);
  });

  it("rejects malformed and oversized bodies", async () => {
    const auth = await newPlayer();
    const s = await session(auth, 0);
    expect(
      (await call("PUT", "save", 0, { v: RULES_VERSION, session: s.session, seq: 0 }, auth)).status,
    ).toBe(400);
    const huge = Array.from({ length: 5_000 }, (_, i) => ({ t: i, a: "click", n: 1 })) as Action[];
    expect((await save(auth, 1_000, s, 5_000, huge)).status).toBe(413);
  });

  it("only answers its own routes and methods", async () => {
    expect((await call("GET", "save", 0)).status).toBe(405);
    expect((await call("GET", "nope", 0)).status).toBe(404);
  });
});
