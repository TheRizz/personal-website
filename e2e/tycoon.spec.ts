import { expect, test, type Page } from "@playwright/test";
import { RULES_VERSION } from "@site/tycoon-core";

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

const records = (page: Page) => page.getByTestId("tycoon").locator("p.text-3xl");

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
  const errors = watchErrors(page, [/Failed to load resource/]);
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

  // Back: the retry is refused as out of date, and the tab quietly picks up a new session.
  const resynced = page.waitForResponse((r) => r.url().endsWith("/api/tycoon/session"));
  await setVisibility("visible");
  expect((await resynced).status()).toBe(200);
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
