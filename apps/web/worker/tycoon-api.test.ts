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

  it("credits up to 12 hours once the player spends AP on a higher cap", async () => {
    const auth = await newPlayer(0);
    await session(auth, 0);
    const [id] = auth.split(".");
    // A player with 10 AP and a cron job (migrations take far longer than a test).
    const stored = JSON.parse(
      (sqlite.prepare("SELECT state FROM players WHERE id = ?").all(id)[0] as { state: string })
        .state,
    ) as GameState;
    stored.ap = 10;
    stored.owned[1] = 1;
    sqlite.prepare("UPDATE players SET state = ? WHERE id = ?").run(JSON.stringify(stored), id);

    let s = await session(auth, 0);
    const saved = await save(auth, 1_000, s, 1_000, [{ t: 500, a: "offline" }]);
    expect(saved.status).toBe(200);
    expect(saved.json.state.offlineLevel).toBe(1);
    expect(saved.json.state.ap).toBe(0);

    s = await session(auth, 1_000 + 3 * OFFLINE_CAP_MS);
    expect(s.offline.ms).toBe(12 * HOUR);
    expect(s.state.offlineLevel).toBe(1);
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

describe("leaderboard", () => {
  /** A player who has tapped `clicks` times in one second (the rules cap how many count). */
  async function playerWith(clicks: number, now = 0) {
    const auth = await newPlayer(now);
    const s = await session(auth, now);
    if (clicks > 0) {
      const { status } = await save(auth, now + 1000, s, 1000, [{ t: 500, a: "click", n: clicks }]);
      expect(status).toBe(200);
    }
    return auth;
  }
  const setName = (auth: string, name: unknown, now = 2000) =>
    call("PUT", "name", now, { name }, auth);

  it("keeps a copy of lifetime Records with every save", async () => {
    const auth = await playerWith(30);
    const id = auth.split(".")[0];
    const [row] = sqlite
      .prepare("SELECT lifetime_records, state FROM players WHERE id = ?")
      .all(id) as { lifetime_records: number; state: string }[];
    expect(row!.lifetime_records).toBe(JSON.parse(row!.state).lifetimeRecords);
    expect(row!.lifetime_records).toBeGreaterThan(0);
  });

  it("is empty until someone picks a name, and shows only named players", async () => {
    await playerWith(10);
    let board = await call("GET", "leaderboard", 1000);
    expect(board.status).toBe(200);
    expect(board.json.entries).toEqual([]);

    const named = await playerWith(20);
    expect((await setName(named, "data_wizard")).status).toBe(200);
    board = await call("GET", "leaderboard", 3000);
    expect(board.json.entries).toEqual([
      { rank: 1, name: "data_wizard", records: expect.any(Number) },
    ]);
  });

  it("ranks by lifetime Records, ties share a rank, and caps at 50", async () => {
    const low = await playerWith(5);
    const high = await playerWith(50);
    const tie = await playerWith(5);
    await setName(low, "low_one");
    await setName(high, "high_one");
    await setName(tie, "tie_one");
    const { json } = await call("GET", "leaderboard", 3000);
    expect(json.entries.map((e: { name: string; rank: number }) => [e.rank, e.name])).toEqual([
      [1, "high_one"],
      [2, "low_one"],
      [2, "tie_one"],
    ]);
    const mine = await call("GET", "name", 3000, undefined, tie);
    expect(mine.json).toMatchObject({ name: "tie_one", hidden: false, rank: 2 });

    for (let i = 0; i < 50; i++) {
      const auth = await newPlayer();
      await setName(auth, `filler_${i}`);
    }
    const capped = await call("GET", "leaderboard", 4000);
    expect(capped.json.entries).toHaveLength(50);
    expect(capped.json.entries[0].name).toBe("high_one");
  });

  it("checks names: length, characters, profanity, taken ignoring case", async () => {
    const a = await playerWith(1);
    const b = await playerWith(1);
    expect((await setName(a, "ab")).json).toMatchObject({
      error: { code: "invalid_name" },
      problem: "length",
    });
    expect((await setName(a, "no spaces")).json.problem).toBe("characters");
    expect((await setName(a, "Sh1t_happens")).json.problem).toBe("blocked");
    expect((await setName(a, 42)).status).toBe(400);
    expect((await setName(a, "Pipeline_Pro")).status).toBe(200);
    const taken = await setName(b, "pipeline_pro");
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe("name_taken");
    // Changing your own name's case is fine.
    expect((await setName(a, "PIPELINE_PRO")).json.name).toBe("PIPELINE_PRO");
  });

  it("renaming keeps one entry; leaving takes the player off the board", async () => {
    const auth = await playerWith(3);
    await setName(auth, "first_name");
    await setName(auth, "second_name");
    let { json } = await call("GET", "leaderboard", 3000);
    expect(json.entries.map((e: { name: string }) => e.name)).toEqual(["second_name"]);

    expect((await call("DELETE", "name", 3000, undefined, auth)).status).toBe(204);
    ({ json } = await call("GET", "leaderboard", 3000));
    expect(json.entries).toEqual([]);
    const mine = await call("GET", "name", 3000, undefined, auth);
    expect(mine.json).toMatchObject({ name: null, rank: null });
  });

  it("a hidden player stays hidden when renaming or leaving and rejoining", async () => {
    const auth = await playerWith(3);
    await setName(auth, "rude_name");
    sqlite.exec("UPDATE leaderboard_names SET hidden = 1");
    await setName(auth, "nice_name");
    await call("DELETE", "name", 3000, undefined, auth);
    await setName(auth, "nicer_name");
    const { json } = await call("GET", "leaderboard", 3000);
    expect(json.entries).toEqual([]);
    const mine = await call("GET", "name", 3000, undefined, auth);
    expect(mine.json).toMatchObject({ name: "nicer_name", hidden: true, rank: null });
  });

  it("needs a player for names, and is cacheable for a few minutes", async () => {
    expect((await call("GET", "name", 0)).status).toBe(401);
    expect((await call("PUT", "name", 0, { name: "anyone" })).status).toBe(401);
    const response = await handleTycoon(new Request(`${SITE}/api/tycoon/leaderboard`), env, 0);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect((await call("POST", "leaderboard", 0)).status).toBe(405);
  });

  it("limits name changes per IP", async () => {
    const auth = await playerWith(1);
    limiterAllows = false;
    expect((await setName(auth, "too_fast")).status).toBe(429);
  });
});
