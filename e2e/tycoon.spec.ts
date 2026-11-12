import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { RULES_VERSION, goldenSpawn, type GameState } from "@site/tycoon-core";

// Pipeline Tycoon end to end: the page talks to the real Worker and local D1 (ADR-0006).

/** Fails the test on any uncaught error or console error, except the ones listed. */
function watchErrors(page: Page, allowed: RegExp[] = []) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !allowed.some((pattern) => pattern.test(message.text()))) {
      errors.push(`console: ${message.text()}`);
    }
  });
  return errors;
}

const records = (page: Page) => page.getByTestId("records");

async function play(page: Page) {
  await page.goto("/games/pipeline-tycoon");
  const scene = page.getByRole("button", { name: /^Factory/ });
  await expect(scene.locator("canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: /Intern/ })).toBeVisible();
  return scene;
}

test("the games page links to Pipeline Tycoon", async ({ page }) => {
  await page.goto("/games");
  await page.getByRole("link", { name: /Pipeline Tycoon/ }).click();
  await expect(page).toHaveURL(/\/games\/pipeline-tycoon$/);
  await expect(page.getByRole("heading", { name: "Pipeline Tycoon", level: 1 })).toBeVisible();
});

test("clicks and purchases are saved to the server and survive a reload", async ({ page }) => {
  // A reload can cut off React Router's background fetch of route manifest patches, which logs
  // this harmless error (see admin-shell.spec.ts).
  const errors = watchErrors(page, [/Failed to fetch manifest patches/]);
  const scene = await play(page);

  await scene.focus();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(60);
  }
  await page.getByRole("button", { name: /Intern/ }).click();
  await expect(page.getByRole("button", { name: /Intern/ })).toContainText("1");

  await page.getByRole("tab", { name: "Stats" }).click();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
  await page.getByRole("button", { name: "Save now" }).click();
  expect((await saved).status()).toBe(200);

  await page.waitForLoadState("networkidle");
  await page.reload();
  await play(page);
  await expect(page.getByRole("button", { name: /Intern/ })).toContainText(/Intern\s*1/);
  await expect(records(page)).not.toHaveText("0");
  expect(errors).toEqual([]);
});

test("a second tab takes over and the first is told to stop", async ({ page, context }) => {
  const errors = watchErrors(page, [/409/]);
  await play(page);
  const second = await context.newPage();
  await play(second);

  await page.getByRole("tab", { name: "Stats" }).click();
  await page.getByRole("button", { name: "Save now" }).click();
  const halted = page.getByRole("dialog");
  await expect(halted).toContainText("playing on another tab or device");

  // "Continue here" takes the session back.
  await halted.getByRole("button", { name: "Continue here" }).click();
  await expect(halted).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("linking devices", () => {
  test("a code from the web links a CLI to the same game", async ({ page, request }) => {
    const errors = watchErrors(page, [/409/]);
    await play(page);
    await page.getByRole("tab", { name: "Stats" }).click();
    await page.getByRole("button", { name: "Show a link code" }).click();
    const command = await page.locator("code", { hasText: "pipeline-tycoon link" }).textContent();
    const code = command!.trim().split(" ").at(-1)!;
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);

    // What `pipeline-tycoon link <CODE>` does, then starts a session.
    const claim = await request.post("/api/tycoon/pair/claim", { data: { code, client: "cli" } });
    expect(claim.status()).toBe(201);
    const { player, token } = await claim.json();
    const session = await request.post("/api/tycoon/session", {
      headers: { Authorization: `Bearer ${player}.${token}` },
      data: { v: RULES_VERSION },
    });
    const started = await session.json();
    expect(started.state.achievements).toContain("works-on-my-machine");

    // The CLI took over, so the browser is told on its next save.
    await page.getByRole("button", { name: "Save now" }).click();
    await expect(page.getByRole("dialog")).toContainText("playing on another tab or device");
    expect(errors).toEqual([]);
  });

  test("the web can join a game started in the CLI", async ({ page, request }) => {
    const errors = watchErrors(page);
    // A CLI player with some progress.
    const created = await (await request.post("/api/tycoon/players")).json();
    const cli = `Bearer ${created.player}.${created.token}`;
    const started = await (
      await request.post("/api/tycoon/session", {
        headers: { Authorization: cli },
        data: { v: RULES_VERSION },
      })
    ).json();
    const clicks = Array.from({ length: 10 }, (_, i) => ({ t: (i + 1) * 1000, a: "click", n: 5 }));
    await request.put("/api/tycoon/save", {
      headers: { Authorization: cli },
      data: {
        v: RULES_VERSION,
        session: started.session,
        seq: 0,
        log: { elapsed: 10_000, actions: clicks },
      },
    });
    const { code } = await (
      await request.post("/api/tycoon/pair", { headers: { Authorization: cli } })
    ).json();

    await play(page);
    await page.getByRole("tab", { name: "Stats" }).click();
    await page.getByRole("button", { name: "Have a code from another device?" }).click();
    await page.getByLabel("Code").fill(`${code.slice(0, 3)} ${code.slice(3)}`);
    await page.getByRole("button", { name: "Join" }).click();
    await page.getByRole("button", { name: "Switch" }).click();
    // The CLI's 50 clicks are now this browser's.
    const clickCount = page
      .locator("dt", { hasText: /^Clicks$/ })
      .locator("xpath=following-sibling::dd[1]");
    await expect(clickCount).toHaveText("50");
    expect(errors).toEqual([]);
  });
});

test("coming back to a tab whose save was cut off carries on without halting", async ({
  page,
  context,
}) => {
  const errors = watchErrors(page, [/Failed to load resource/, /409/]);
  const scene = await play(page);
  await scene.focus();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(60);
  }

  // Leaving the tab sends a save; like iOS Safari suspending the page, it reaches the server but
  // the page never sees the reply.
  let landed = false;
  await page.route("**/api/tycoon/save", async (route) => {
    await route.fetch();
    landed = true;
    await route.abort("failed");
  });
  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      Object.defineProperty(document, "hidden", { configurable: true, value: value === "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  await setVisibility("hidden");
  await expect.poll(() => landed).toBe(true);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await page.waitForTimeout(500);
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await page.unroute("**/api/tycoon/save");

  // Back: the retry is refused as already saved, and the tab carries on from that save.
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
  await setVisibility("visible");
  expect((await refused).status()).toBe(409);
  await expect(page.getByText("fell out of sync")).toHaveCount(0);
  await expect(page.getByText("Pipeline halted")).toHaveCount(0);

  // And it keeps saving normally.
  await page.getByRole("tab", { name: "Stats" }).click();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
  await page.getByRole("button", { name: "Save now" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText("Pipeline halted")).toHaveCount(0);
  await expect(records(page)).not.toHaveText("0");
  expect(errors).toEqual([]);
});

test("a phone that slept with the tab open gets the time credited as time away", async ({
  page,
}) => {
  const errors = watchErrors(page);
  // iOS stops performance.now() while the phone sleeps; Date.now() keeps real time. Fake that:
  // the wall clock jumps an hour, the page's own clock doesn't.
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + ((window as { slept?: number }).slept ?? 0);
  });
  await play(page);
  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      Object.defineProperty(document, "hidden", { configurable: true, value: value === "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);

  const saved = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
  await setVisibility("hidden");
  expect((await saved).status()).toBe(200);

  // The local Worker's clock doesn't jump, so stand in for its answer to the new session.
  let sessions = 0;
  await page.route("**/api/tycoon/session", async (route) => {
    sessions += 1;
    const response = await route.fetch();
    const body = (await response.json()) as { offline: { ms: number; earned: number } };
    body.offline = { ms: 3_600_000, earned: 1234 };
    await route.fulfill({ response, json: body });
  });
  await page.evaluate(() => ((window as { slept?: number }).slept = 3_600_000));
  await setVisibility("visible");
  const away = page.getByRole("dialog").filter({ hasText: "While you were away" });
  await expect(away).toContainText("1h");
  expect(sessions).toBe(1);
  await away.getByRole("button", { name: "Back to work" }).click();
  await expect(page.getByText("Pipeline halted")).toHaveCount(0);

  // Saving carries on in the new session.
  await page.getByRole("tab", { name: "Stats" }).click();
  const next = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
  await page.getByRole("button", { name: "Save now" }).click();
  expect((await next).status()).toBe(200);
  expect(errors).toEqual([]);
});

test("a save whose reply is lost mid-play keeps everything played since", async ({ page }) => {
  const errors = watchErrors(page, [
    /Failed to load resource/,
    /409/,
    /Failed to fetch manifest patches/,
  ]);
  const scene = await play(page);
  await scene.focus();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(60);
  }

  // A save reaches the server, but its reply never comes back (a flaky phone connection).
  let landed = false;
  await page.route("**/api/tycoon/save", async (route) => {
    await route.fetch();
    landed = true;
    await route.abort("failed");
  });
  await page.getByRole("tab", { name: "Stats" }).click();
  await page.getByRole("button", { name: "Save now" }).click();
  await expect.poll(() => landed).toBe(true);
  await page.unroute("**/api/tycoon/save");

  // More play after it: a purchase the server hasn't seen.
  await page.getByRole("tab", { name: "Build" }).click();
  await page.getByRole("button", { name: /Intern/ }).click();
  await expect(page.getByRole("button", { name: /Intern/ })).toContainText(/Intern\s*1/);

  // The retry is refused as already saved; the tab keeps the purchase and saves it right after.
  const followUp = page.waitForResponse(
    (r) => r.url().endsWith("/api/tycoon/save") && r.status() === 200,
  );
  await page.getByRole("tab", { name: "Stats" }).click();
  await page.getByRole("button", { name: "Save now" }).click();
  await followUp;
  await expect(page.getByText("Pipeline halted")).toHaveCount(0);

  await page.waitForLoadState("networkidle");
  await page.reload();
  await play(page);
  await expect(page.getByRole("button", { name: /Intern/ })).toContainText(/Intern\s*1/);
  expect(errors).toEqual([]);
});

test("play a killed tab never saved comes back on the next visit", async ({ page }) => {
  const scene = await play(page);
  await scene.focus();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(60);
  }
  await page.getByRole("button", { name: /Intern/ }).click();
  await expect(page.getByRole("button", { name: /Intern/ })).toContainText(/Intern\s*1/);
  // The tab keeps its unsaved play within a couple of seconds.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("games.tycoon.unsaved")))
    .toContain('"a":"buy"');

  // The tab dies before its save gets anywhere (iOS closing it under memory pressure).
  await page.evaluate(() => {
    const send = window.fetch.bind(window);
    window.fetch = (input, init) =>
      String(input).includes("/api/tycoon/save") ? new Promise(() => {}) : send(input, init);
  });
  const errors = watchErrors(page, [/Failed to fetch manifest patches/]);
  const session = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/session"));
  await page.reload();
  const started = await session;
  expect(started.request().postDataJSON().unsaved.log.actions.length).toBeGreaterThan(1);
  expect((await started.json()).recovered.moves).toBeGreaterThan(1);
  // The notice shows as soon as the game starts, before the scene has finished loading.
  await expect(
    page.getByText(/^Picked up \d+ moves you made before the page closed\.$/),
  ).toBeVisible();
  await play(page);
  await expect(page.getByRole("button", { name: /Intern/ })).toContainText(/Intern\s*1/);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("games.tycoon.unsaved")))
    .toBeNull();

  // It is on the server now, not just kept in this browser.
  await page.waitForLoadState("networkidle");
  await page.reload();
  await play(page);
  await expect(page.getByRole("button", { name: /Intern/ })).toContainText(/Intern\s*1/);
  await expect(page.getByText(/^Picked up/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a named player who saves shows on the leaderboard with their lifetime Records", async ({
  request,
}) => {
  const created = await (await request.post("/api/tycoon/players")).json();
  const auth = { Authorization: `Bearer ${created.player}.${created.token}` };
  const started = await (
    await request.post("/api/tycoon/session", { headers: auth, data: { v: RULES_VERSION } })
  ).json();
  const saved = await request.put("/api/tycoon/save", {
    headers: auth,
    data: {
      v: RULES_VERSION,
      session: started.session,
      seq: 0,
      log: { elapsed: 3000, actions: [1, 2, 3].map((s) => ({ t: s * 1000, a: "click", n: 10 })) },
    },
  });
  expect(saved.status()).toBe(200);
  const { state } = await saved.json();

  // A unique name, since the local database outlives a single test run.
  const name = `e2e_${Date.now().toString(36)}`;
  expect(
    (await request.put("/api/tycoon/name", { headers: auth, data: { name: "f_u_c_k" } })).status(),
  ).toBe(400);
  const named = await request.put("/api/tycoon/name", { headers: auth, data: { name } });
  expect(named.status()).toBe(200);
  expect(await named.json()).toMatchObject({ name, hidden: false, records: state.lifetimeRecords });

  const board = await request.get("/api/tycoon/leaderboard");
  expect(board.status()).toBe(200);
  const { entries } = await board.json();
  expect(entries).toContainEqual({
    rank: expect.any(Number),
    name,
    records: state.lifetimeRecords,
  });

  expect((await request.delete("/api/tycoon/name", { headers: auth })).status()).toBe(204);
  const after = await (await request.get("/api/tycoon/leaderboard")).json();
  expect(after.entries.map((e: { name: string }) => e.name)).not.toContain(name);
});

test("Max buys every intern the bank allows and the shop shows what's next", async ({ page }) => {
  const errors = watchErrors(page);
  const scene = await play(page);
  await scene.focus();
  // 20 clicks a second at most; 2.5 s of clicking is ~50 records, enough for three interns.
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(55);
  }
  const intern = page.getByRole("button", { name: /Intern/ });
  await page
    .getByRole("group", { name: "Buy amount" })
    .getByRole("button", { name: "Max" })
    .click();
  await expect(intern).toContainText(/\d+ for \d+/);
  await intern.click();
  const owned = Number(await intern.getByLabel(/owned$/).textContent());
  expect(owned).toBeGreaterThanOrEqual(2);
  await expect(intern).toContainText(`${owned}/10 unlocks ×2`);
  // Production has started, so the next intern says how long it is away.
  await expect(intern).toContainText(/in \d+(s|m)/);
  await expect(intern).toContainText(/\/s · 100 %/);

  await page.getByRole("tab", { name: "Stats" }).click();
  await expect(page.getByText(/^\d+\/100$/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the new achievements count progress, save it and keep it after a reload", async ({
  page,
}) => {
  const errors = watchErrors(page, [/Failed to fetch manifest patches/]);
  const scene = await play(page);
  await scene.focus();
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(55);
  }
  // Interns only: "Unpaid workforce" counts them while nothing else is owned.
  await page
    .getByRole("group", { name: "Buy amount" })
    .getByRole("button", { name: "Max" })
    .click();
  const intern = page.getByRole("button", { name: /Intern/ });
  await intern.click();
  const owned = Number(await intern.getByLabel(/owned$/).textContent());
  expect(owned).toBeGreaterThanOrEqual(2);

  await page.getByRole("tab", { name: "Stats" }).click();
  const unpaid = page.getByRole("listitem").filter({ hasText: "Own 25 interns and nothing else." });
  await expect(unpaid).toContainText(`${owned}/25`);
  await expect(page.getByRole("heading", { name: /^Achievements \d+\/38$/ })).toBeVisible();

  // The server replays the clicks under the same rules and keeps the new counters.
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
  await page.getByRole("button", { name: "Save now" }).click();
  const reply = await saved;
  expect(reply.status()).toBe(200);
  const { state } = (await reply.json()) as { state: GameState };
  expect(state.v).toBe(RULES_VERSION);
  expect(state.runClicks).toBeGreaterThanOrEqual(40);
  expect(state.lastClickMs).toBeGreaterThan(0);
  expect(state.goldenStreak).toBe(0);

  await page.waitForLoadState("networkidle");
  await page.reload();
  await play(page);
  await page.getByRole("tab", { name: "Stats" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Own 25 interns and nothing else." }),
  ).toContainText(`${owned}/25`);
  expect(errors).toEqual([]);
});

/**
 * Gives this browser's player Architecture Points straight in the local D1 the preview serves
 * (earning them takes a 45-minute run). The page must reload afterwards to start from it.
 */
async function grantAp(page: Page, ap: number) {
  const credential = await page.evaluate(() => localStorage.getItem("games.tycoon.player"));
  const id = credential?.split(".")[0] ?? "";
  expect(id).toMatch(/^[\w-]+$/);
  execFileSync(
    "pnpm",
    [
      "--filter",
      "web",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "tycoon",
      "--local",
      "--command",
      `UPDATE players SET state = json_set(state, '$.ap', ${ap}) WHERE id = '${id}'`,
    ],
    { stdio: "pipe" },
  );
}

test("AP raise the offline cap, the server keeps it and it shows after a reload", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = watchErrors(page, [/Failed to fetch manifest patches/]);
  await play(page);
  await page.getByRole("tab", { name: "Migrate" }).click();
  await expect(page.getByTestId("offline-cap")).toHaveText("8 hours");
  await expect(page.getByRole("button", { name: "12 hours needs 10 AP" })).toBeDisabled();

  await page.waitForLoadState("networkidle");
  await grantAp(page, 25);
  await page.reload();
  await play(page);
  await page.getByRole("tab", { name: "Migrate" }).click();
  await page.getByRole("button", { name: "Raise to 12 hours for 10 AP…" }).click();
  await expect(
    page.getByText(/^Permanent bonus goes from \+2,5\d\d % to \+1,5\d\d %\.$/),
  ).toBeVisible();
  // Spending saves at once; the server replays the raise against the AP it has stored.
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
  await page.getByRole("button", { name: "Spend 10 AP" }).click();
  const reply = await saved;
  expect(reply.status()).toBe(200);
  const body = (await reply.json()) as { state: GameState; dropped: number };
  expect(body.state.v).toBe(RULES_VERSION);
  expect(body.state.offlineLevel).toBe(1);
  expect(body.state.ap).toBe(15);
  expect(body.dropped).toBe(0);
  await expect(page.getByTestId("offline-cap")).toHaveText("12 hours");
  await expect(page.getByRole("button", { name: "24 hours needs 100 AP" })).toBeDisabled();

  await page.waitForLoadState("networkidle");
  await page.reload();
  await play(page);
  await page.getByRole("tab", { name: "Migrate" }).click();
  await expect(page.getByTestId("offline-cap")).toHaveText("12 hours");
  await expect(page.getByRole("tabpanel").getByText("15 AP", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Stats" }).click();
  await expect(
    page.locator("dt", { hasText: /^Offline cap$/ }).locator("xpath=following-sibling::dd[1]"),
  ).toHaveText("12 hours");
  expect(errors).toEqual([]);
});

test("a tab running an old build offers to save and reload", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, version: "a-newer-build" } }),
  );
  await play(page);
  await expect(page.getByText("A new version of Pipeline Tycoon is out.")).toBeVisible();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
  await page.getByRole("button", { name: "Save and reload" }).click();
  await saved;
  await page.waitForLoadState("load");
  await expect(page.getByRole("button", { name: /^Factory/ })).toBeVisible();
});

test("settings change how numbers are written and are remembered", async ({ page, context }) => {
  const errors = watchErrors(page, [/Failed to fetch manifest patches/]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await play(page);
  await page.getByRole("tab", { name: "Migrate" }).click();
  await expect(page.getByText(/^Next point at [\d.]+[KMB] records/)).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await sheet.getByText("Long").click();
  await expect(
    page.getByText(/^Next point at [\d.]+ (thousand|million|billion) records/),
  ).toBeVisible();
  await sheet.getByRole("switch", { name: "Reduce motion" }).click();
  await expect(sheet.getByRole("switch", { name: "Reduce motion" })).toBeChecked();

  // The save code is the same one-time link code the Stats tab shows, copied in one tap.
  await sheet.getByRole("button", { name: "Copy my save code" }).click();
  const code = (await sheet.getByTestId("save-code").textContent())!.replace(" ", "");
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  await expect(sheet).toContainText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.waitForLoadState("networkidle");
  await page.reload();
  await play(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(sheet.getByRole("radio", { name: /Long/ })).toBeChecked();
  await expect(sheet.getByRole("switch", { name: "Reduce motion" })).toBeChecked();
  expect(errors).toEqual([]);
});

test("on a laptop a tip shows near the top of the scene, above the fold", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scene = await play(page);
  const toast = scene.getByRole("status");
  await expect(toast).toHaveText("Tap the core");
  const box = (await toast.boundingBox())!;
  const sceneBox = (await scene.boundingBox())!;
  expect(box.y + box.height).toBeLessThan(900);
  expect(box.y - sceneBox.y).toBeLessThan(100);
});

test("keys play the game and ? lists them", async ({ page }) => {
  const errors = watchErrors(page);
  const scene = await play(page);
  const keys = page.getByRole("dialog", { name: "Keyboard keys" });

  // The help line under the game points at the list.
  await page.getByRole("button", { name: "press ? for all keys" }).click();
  await expect(keys).toBeVisible();
  await expect(keys).toContainText("Catch the golden packet");
  await page.keyboard.press("Escape");
  await expect(keys).toBeHidden();

  // Space on the factory, then 1 builds an intern without touching the shop.
  await scene.focus();
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(55);
  }
  const intern = page.getByRole("button", { name: /Intern/ });
  await page.keyboard.press("1");
  await expect(intern.getByLabel(/owned$/)).toHaveText("1");

  // x walks through the buy amounts; the arrows walk through the shop tabs.
  const amounts = page.getByRole("group", { name: "Buy amount" });
  await page.keyboard.press("x");
  await expect(amounts.getByRole("button", { name: "×10", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(scene.getByRole("status")).toHaveText("Builds buy 10 at a time");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Upgrades/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Stats" })).toHaveAttribute("aria-selected", "true");

  // g with no golden packet about says so; ? from anywhere opens the list.
  await page.keyboard.press("g");
  await expect(scene.getByRole("status")).toHaveText("No golden packet right now");
  await page.keyboard.press("?");
  await expect(keys).toBeVisible();
  await page.screenshot({ path: "test-results/tycoon-keys-laptop.png" });
  // Keys do nothing while the list is open.
  await page.keyboard.press("ArrowRight");
  await keys.getByRole("button", { name: "Close keyboard keys" }).click();
  await expect(page.getByRole("tab", { name: "Stats" })).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("the game can be installed: manifest and icons are served", async ({ page, request }) => {
  await page.goto("/games/pipeline-tycoon");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/games/pipeline-tycoon/manifest.webmanifest");
  const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );

  const response = await request.get(href!);
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as {
    start_url: string;
    scope: string;
    display: string;
    icons: { src: string; sizes: string; type: string }[];
  };
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
  // Every icon (and the iPhone one) is there, is the type it says, and a PNG is the size it says.
  for (const icon of [
    ...manifest.icons,
    { src: touchIcon!, sizes: "180x180", type: "image/png" },
  ]) {
    const file = await request.get(icon.src);
    expect(file.ok(), icon.src).toBe(true);
    expect(file.headers()["content-type"], icon.src).toContain(icon.type);
    if (icon.type !== "image/png") continue;
    const png = await file.body();
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("after one scroll the counter, scene and two shop rows fit on the screen", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    const scene = await play(page);
    const game = scene.locator("xpath=../..");
    // Instant: the site scrolls smoothly, and a slow CI runner would measure mid-scroll.
    await game.evaluate((el) =>
      window.scrollBy({ top: el.getBoundingClientRect().top - 8, behavior: "instant" }),
    );
    const inView = async (name: string, box: { y: number; height: number } | null) => {
      expect(box, name).not.toBeNull();
      expect(box!.y, `${name} top`).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, `${name} bottom`).toBeLessThanOrEqual(844);
    };
    // The counter sits on the scene's top edge.
    const counter = (await records(page).boundingBox())!;
    const sceneBox = (await scene.boundingBox())!;
    expect(counter.y).toBeGreaterThanOrEqual(sceneBox.y);
    expect(counter.y + counter.height).toBeLessThan(sceneBox.y + 64);
    await inView("scene", sceneBox);
    await inView("shop tabs", await page.getByRole("tablist", { name: "Shop" }).boundingBox());
    const rows = page.getByRole("tabpanel").getByRole("listitem");
    await inView("first shop row", await rows.nth(0).boundingBox());
    await inView("second shop row", await rows.nth(1).boundingBox());
    await page.screenshot({ path: "test-results/tycoon-one-screen-phone.png" });
    expect(errors).toEqual([]);
  });

  test("a new game shows each first-time tip once and a reload shows none", async ({ page }) => {
    const errors = watchErrors(page, [/Failed to fetch manifest patches/]);
    const scene = await play(page);
    const toast = scene.getByRole("status");
    await expect(toast).toHaveText("Tap the core");
    await page.screenshot({ path: "test-results/tycoon-hint-phone.png" });

    // A tip goes as soon as it has been followed, rather than covering the scene for 5 s.
    await scene.focus();
    await page.keyboard.press("Space");
    await expect(toast.filter({ hasText: "Tap the core" })).toHaveCount(0, { timeout: 1_500 });

    // 15 records buy the first intern.
    for (let i = 0; i < 19; i++) {
      await page.keyboard.press("Space");
      await page.waitForTimeout(60);
    }
    await expect(toast).toHaveText("Buy an intern, it works while you don't", { timeout: 8_000 });
    await page.getByRole("button", { name: /Intern/ }).tap();
    await expect(toast.filter({ hasText: "Buy an intern" })).toHaveCount(0, { timeout: 1_500 });

    await page.getByRole("tab", { name: "Stats" }).tap();
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/save"));
    await page.getByRole("button", { name: "Save now" }).tap();
    await saved;
    await page.waitForLoadState("networkidle");
    await page.reload();
    await play(page);
    await page.waitForTimeout(1_000);
    await expect(scene.getByRole("status")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a lost touch elsewhere on the page doesn't stop the core taking taps", async ({
    page,
    context,
  }) => {
    const errors = watchErrors(page);
    const scene = await play(page);
    const box = (await scene.locator("canvas").boundingBox())!;
    const core = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchEnd", points: { x: number; y: number }[] = []) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map((point, id) => ({ ...point, id })),
      });

    // A finger lands on a button that leaves the page before it lifts, as on iOS when the
    // Migrate button changes under it: the end of that touch never reaches the window. Before
    // the fix the scene's only touch pointer stayed taken and the core ignored every tap.
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "gone";
      button.style.cssText = "position:fixed;left:0;bottom:0;width:80px;height:40px";
      document.body.append(button);
    });
    const gone = (await page.locator("#gone").boundingBox())!;
    await touch("touchStart", [{ x: gone.x + 10, y: gone.y + 10 }]);
    await page.evaluate(() => document.getElementById("gone")!.remove());
    await touch("touchEnd");

    const count = async () => Number(await records(page).textContent());
    for (let i = 0; i < 5; i++) {
      await page.touchscreen.tap(core.x, core.y);
      await page.waitForTimeout(80);
    }
    await expect.poll(count).toBeGreaterThanOrEqual(5);

    // Two thumbs on the core at once both count.
    const before = await count();
    await touch("touchStart", [
      { x: core.x - 10, y: core.y },
      { x: core.x + 10, y: core.y },
    ]);
    await touch("touchEnd");
    await expect.poll(count).toBeGreaterThanOrEqual(before + 2);
    expect(errors).toEqual([]);
  });

  test("a golden packet is announced when it arrives and the notice goes with it", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    // Golden packets come one to three minutes in. Shift this tab's copy of the schedule so the
    // first is already half way across when the page opens (the server keeps its own copy, so
    // this test only looks and never catches).
    await page.route("**/api/tycoon/session", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { state: GameState };
      const { golden, playMs } = body.state;
      const first = goldenSpawn({ seed: golden.seed, start: 0 }, 0);
      golden.start = playMs - first.at - first.visibleMs / 2;
      await route.fulfill({ response, json: body });
    });
    await play(page);
    const note = page.getByTestId("golden-note");
    await expect(note).toHaveText(/^Golden packet in the factory: tap it within \d+ seconds\.$/);
    await page.screenshot({ path: "test-results/tycoon-golden-phone.png" });
    // It flies off after its 12 seconds and the notice clears.
    await expect(note).toHaveText("", { timeout: 10_000 });
    expect(errors).toEqual([]);
  });

  test("the help line says how to put the game on the home screen", async ({ page }) => {
    await play(page);
    await expect(page.getByTestId("install-hint")).toBeVisible();
    await page.getByTestId("install-hint").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/tycoon-install-hint-phone.png" });
    // Opened from the home screen it is already installed, so the tip goes. Chromium can't
    // emulate display-mode, so look for the rule that hides it there.
    const hidden = await page.getByTestId("install-hint").evaluate((hint) => {
      // Tailwind puts the rule inside a cascade layer, so walk every grouping rule.
      const walk = (rules: CSSRuleList, standalone: boolean): boolean =>
        Array.from(rules).some((rule) => {
          if (rule instanceof CSSStyleRule && standalone && hint.matches(rule.selectorText)) {
            return rule.style.display === "none";
          }
          if (!(rule instanceof CSSGroupingRule)) return false;
          const media =
            rule instanceof CSSMediaRule && /display-mode:\s*standalone/.test(rule.conditionText);
          return walk(rule.cssRules, standalone || media);
        });
      return Array.from(document.styleSheets).some((sheet) => walk(sheet.cssRules, false));
    });
    expect(hidden).toBe(true);
  });

  test("sound moves into the settings sheet", async ({ page }) => {
    const errors = watchErrors(page);
    await play(page);
    await expect(page.getByRole("button", { name: "Turn sound on" })).toBeHidden();
    await page.getByRole("button", { name: "Settings" }).tap();
    const sheet = page.getByRole("dialog", { name: "Settings" });
    const sound = sheet.getByRole("switch", { name: "Sound" });
    await expect(sound).not.toBeChecked();
    await sound.tap();
    await expect(sound).toBeChecked();
    // The sheet sits on the bottom edge of the screen.
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(844);
    await page.screenshot({ path: "test-results/tycoon-settings-phone.png" });
    await sheet.getByRole("button", { name: "Close settings" }).tap();
    await expect(sheet).toBeHidden();
    expect(errors).toEqual([]);
  });
});
