import { expect, test, type Page } from "@playwright/test";

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
  const errors = watchErrors(page);
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

  // React Router fetches route manifest patches for links shortly after they appear; leaving while
  // one is in flight logs it as a failure (see admin-shell.spec.ts).
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
