import { devices, expect, test, type Page } from "@playwright/test";

/** Fails the test on any uncaught error or console error on the page. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test("the games page links to Power Volley", async ({ page }) => {
  await page.goto("/games");
  await page.getByRole("link", { name: /Power Volley/ }).click();
  await expect(page).toHaveURL(/\/games\/volley$/);
  await expect(page.getByRole("heading", { name: "Power Volley", level: 1 })).toBeVisible();
});

test("a match against the computer plays, pauses and quits", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchErrors(page);
  await page.goto("/games/volley");
  await page.getByText("Easy").click();
  await page.getByRole("button", { name: "Start match" }).click();

  const match = page.getByTestId("volley-match");
  await expect(match.getByRole("img", { name: "Volleyball court" })).toBeVisible();
  // No on-screen buttons on a desktop with a mouse.
  await expect(match.getByRole("button", { name: /jump/ })).toHaveCount(0);

  // Standing still, the computer wins rallies (after the serve comes round to it).
  await expect(page.getByTestId("volley-announcer")).toContainText(/scores!/, {
    timeout: 40_000,
  });

  await page.keyboard.press("Escape");
  const paused = page.getByRole("dialog", { name: "Paused" });
  await expect(paused).toBeVisible();
  await paused.getByRole("button", { name: "Resume" }).click();
  await expect(paused).toBeHidden();

  await page.getByRole("button", { name: "Quit match" }).click();
  await expect(match).toBeHidden();
  await expect(page.getByRole("button", { name: "Start match" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("remembers the last setup", async ({ page }) => {
  await page.goto("/games/volley");
  await page.getByText("2 vs 2").click();
  await page.getByText("2 players, rivals").click();
  await page.getByText("Jungle").click();
  await page.reload();
  await expect(page.getByRole("radio", { name: "2 vs 2" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "2 players, rivals" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Jungle" })).toBeChecked();
});

test.describe("on an iPhone", () => {
  const { defaultBrowserType: _, ...iPhone } = devices["iPhone 13"];
  test.use(iPhone);

  test("shows touch buttons and fits the screen", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/games/volley");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBe(0);

    await page.getByRole("button", { name: "Start match" }).click();
    const match = page.getByTestId("volley-match");
    await expect(match.getByRole("group", { name: "Player move" })).toBeVisible();
    await expect(match.getByRole("button", { name: "Player jump" })).toBeVisible();
    const court = await match.getByRole("img", { name: "Volleyball court" }).boundingBox();
    expect(court!.width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });
});
