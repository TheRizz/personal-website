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
    TYCOON_PAIR_LIMITER: {
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

  it("brings a rules-v2 save up to date and credits the idle achievement from time away", async () => {
    const auth = await newPlayer(0);
    await session(auth, 0);
    const [id] = auth.split(".");
    const row = sqlite.prepare("SELECT state FROM players WHERE id = ?").all(id)[0]! as {
      state: string;
    };
    // What a v2 save looked like: no runClicks, lastClickMs or goldenStreak.
    const {
      runClicks: _r,
      lastClickMs: _l,
      goldenStreak: _g,
      ...v2
    } = JSON.parse(row.state) as GameState;
    sqlite
      .prepare("UPDATE players SET state = ?, rules_version = 2 WHERE id = ?")
      .run(JSON.stringify({ ...v2, v: 2, clicks: 12, playMs: 5_000 }), id);

    const s = await session(auth, HOUR);
    expect(s.state.v).toBe(RULES_VERSION);
    expect(s.state.runClicks).toBe(12);
    expect(s.state.lastClickMs).toBe(5_000);
    expect(s.state.goldenStreak).toBe(0);
    // An hour away is more than ten minutes without a click.
    expect(s.state.achievements).toContain("hands-off");
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

describe("unsaved play from a closed tab", () => {
  const clicks = (count: number, every = 1000): Action[] =>
    Array.from({ length: count }, (_, i) => ({ t: (i + 1) * every, a: "click", n: 10 }));
  const start = (auth: string, now: number, unsaved?: unknown) =>
    call("POST", "session", now, { v: RULES_VERSION, ...(unsaved ? { unsaved } : {}) }, auth);

  it("replays it first, then credits only the rest of the time as offline", async () => {
    const auth = await newPlayer(0);
    const s = await session(auth, 0);
    // A minute of play the tab never saved, then it was killed; back 10 minutes after it began.
    const unsaved = {
      session: s.session,
      seq: s.seq,
      log: { elapsed: 61_000, actions: [...clicks(60), { t: 60_500, a: "buy", g: 1, n: 1 }] },
    };
    const back = await start(auth, 600_000, unsaved);
    expect(back.status).toBe(200);
    expect(back.json.seq).toBe(s.seq + 1);
    expect(back.json.recovered).toEqual({ moves: 601, undone: [] });
    expect(back.json.state.owned[1]).toBe(1);
    expect(back.json.state.clicks).toBe(600);
    // 61 s replayed plus 539 s offline: the 10 minutes counted once.
    expect(back.json.offline.ms).toBe(539_000);
    expect(back.json.state.playMs).toBeCloseTo(600_000, 0);

    // The same play sent again is old news: the session it names has been replaced.
    const again = await start(auth, 601_000, { ...unsaved, seq: back.json.seq });
    expect(again.json.recovered).toBeUndefined();
    expect(again.json.state.clicks).toBe(600);
  });

  it("credits no more time than really passed", async () => {
    const auth = await newPlayer(0);
    const s = await session(auth, 0);
    const back = await start(auth, 10_000, {
      session: s.session,
      seq: s.seq,
      log: { elapsed: 24 * HOUR, actions: clicks(5) },
    });
    // The clicks are squeezed into the 15 s that really passed, so some go over the click rate.
    expect(back.json.recovered.moves).toBeLessThan(50);
    expect(back.json.recovered.undone[0]).toMatchObject({ a: "click", reason: "click_rate" });
    expect(back.json.state.playMs).toBeLessThanOrEqual(10_000 + SAVE_SLACK_MS);
    expect(back.json.offline.ms).toBe(0);
  });

  it("is ignored when a save landed after it was kept", async () => {
    const auth = await newPlayer(0);
    const s = await session(auth, 0);
    // The save sent on the way out reached the server after all.
    expect((await save(auth, 11_000, s, 11_000, clicks(10))).status).toBe(200);
    const back = await start(auth, 20_000, {
      session: s.session,
      seq: s.seq,
      log: { elapsed: 11_000, actions: clicks(10) },
    });
    expect(back.status).toBe(200);
    expect(back.json.recovered).toBeUndefined();
    expect(back.json.seq).toBe(1);
    expect(back.json.state.clicks).toBe(100);
  });

  it("is ignored when another device started a session since", async () => {
    const auth = await newPlayer(0);
    const s = await session(auth, 0);
    await session(auth, 5_000);
    const back = await start(auth, 20_000, {
      session: s.session,
      seq: s.seq,
      log: { elapsed: 11_000, actions: clicks(10) },
    });
    expect(back.json.recovered).toBeUndefined();
    expect(back.json.state.clicks).toBe(0);
  });

  it("drops what the rules can't allow, like any save", async () => {
    const auth = await newPlayer(0);
    const s = await session(auth, 0);
    const back = await start(auth, 20_000, {
      session: s.session,
      seq: s.seq,
      // A cron job with nothing in the bank.
      log: { elapsed: 1_000, actions: [{ t: 500, a: "buy", g: 1, n: 1 }] },
    });
    expect(back.json.recovered).toEqual({
      moves: 0,
      undone: [{ a: "buy", reason: "too_expensive", count: 1 }],
    });
    expect(back.json.state.owned[1]).toBe(0);
  });

  it("refuses a malformed one", async () => {
    const auth = await newPlayer(0);
    await session(auth, 0);
    const bad = await start(auth, 1_000, { session: "x", seq: -1, log: { elapsed: 0 } });
    expect(bad.status).toBe(400);
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
    expect(result.json.undone).toEqual([{ a: "buy", reason: "too_expensive", count: 1 }]);
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
    // Where the save stands, so a client whose reply got lost can carry on from it.
    expect(again.json.saved).toEqual({ seq: 1, state: first.json.state, ageMs: 1_000 });
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

describe("pairing", () => {
  async function pair(auth: string, now = 0) {
    const { status, json } = await call("POST", "pair", now, undefined, auth);
    expect(status).toBe(200);
    return json as { code: string; expiresInMs: number };
  }

  const claim = (code: string, now = 0, client = "cli") =>
    call("POST", "pair/claim", now, { code, client });

  it("links a second device to the same player, which then plays the same save", async () => {
    const web = await newPlayer();
    const { code } = await pair(web);
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);

    // Typed sloppily, as people do.
    const claimed = await claim(` ${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `);
    expect(claimed.status).toBe(201);
    const cli = `${claimed.json.player}.${claimed.json.token}`;
    expect(claimed.json.player).toBe(web.split(".")[0]);

    const s = await session(cli, 1_000);
    expect(s.state.linked).toBe(true);
    expect(s.state.achievements).toContain("works-on-my-machine");
    // Both secrets work; the newest session wins as usual.
    expect((await call("POST", "session", 2_000, { v: RULES_VERSION }, web)).status).toBe(200);
  });

  it("is single use and expires after 10 minutes", async () => {
    const web = await newPlayer();
    const first = await pair(web);
    expect((await claim(first.code)).status).toBe(201);
    expect((await claim(first.code)).status).toBe(404);

    const second = await pair(web, 0);
    expect((await claim(second.code, second.expiresInMs + 1)).status).toBe(404);
  });

  it("keeps one live code per player", async () => {
    const web = await newPlayer();
    const old = await pair(web);
    const fresh = await pair(web);
    expect((await claim(old.code)).status).toBe(404);
    expect((await claim(fresh.code)).status).toBe(201);
  });

  it("is rate-limited and needs a signed-in player to create codes", async () => {
    expect((await call("POST", "pair", 0)).status).toBe(401);
    limiterAllows = false;
    expect((await claim("ABCDEF")).status).toBe(429);
  });

  it("forgets a device's secret when it unlinks", async () => {
    const web = await newPlayer();
    const { code } = await pair(web);
    const claimed = await claim(code);
    const cli = `${claimed.json.player}.${claimed.json.token}`;
    expect((await call("DELETE", "device", 0, undefined, cli)).status).toBe(204);
    expect((await call("POST", "session", 0, { v: RULES_VERSION }, cli)).status).toBe(401);
    expect((await call("POST", "session", 0, { v: RULES_VERSION }, web)).status).toBe(200);
  });
});
