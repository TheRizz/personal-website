import {
  devices,
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { BASE_URL, uniqueIp } from "./helpers";

/** Chrome's own network logs, not app errors. */
const NETWORK_LOG = /^(Failed to load resource|WebSocket connection to .* failed)/;

interface Person {
  page: Page;
  errors: string[];
  /** Snapshots this page received: frame and the left player's x. */
  snaps: { f: number; x0: number; x1: number }[];
  close(): Promise<void>;
}

/** One person: their own context (storage) and client IP, with errors and snapshots recorded. */
async function person(
  browser: Browser,
  name: string,
  options: BrowserContextOptions = {},
): Promise<Person> {
  const context = await browser.newContext({
    ...options,
    baseURL: BASE_URL,
    extraHTTPHeaders: { "CF-Connecting-IP": uniqueIp() },
  });
  // Already has a name, like someone who played before.
  await context.addInitScript((saved) => window.localStorage.setItem("games.name", saved), name);
  const page = await context.newPage();
  const errors: string[] = [];
  const snaps: Person["snaps"] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !NETWORK_LOG.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string" || !payload.startsWith('{"t":"snap"')) return;
      const snap = JSON.parse(payload) as { f: number; m: { players: { x: number }[] } };
      snaps.push({ f: snap.f, x0: snap.m.players[0]!.x, x1: snap.m.players[1]!.x });
    });
  });
  return { page, errors, snaps, close: () => context.close() };
}

/** Ryan creates an online game from the setup screen; returns the room's URL. */
async function create(ryan: Person): Promise<string> {
  const { page } = ryan;
  await page.goto("/games/volley");
  await page.getByText("Online", { exact: true }).click();
  await page.getByRole("button", { name: "Create online game" }).click();
  await expect(page).toHaveURL(/\/games\/volley\/[A-Z2-9]{6}$/);
  await expect(page.getByRole("button", { name: "Copy invite link" })).toBeVisible();
  return page.url();
}

test("two people play online: ready up, move, see each other, leave", async ({ browser }) => {
  test.setTimeout(60_000);
  const ryan = await person(browser, "Ryan");
  const sam = await person(browser, "Sam");
  const url = await create(ryan);

  await sam.page.goto(url);
  const players = sam.page.getByRole("region", { name: "Players" });
  await expect(players.getByText("Ryan")).toBeVisible();
  await expect(players.getByText("Sam (you)")).toBeVisible();
  // The invite panel goes once the second seat is taken.
  await expect(ryan.page.getByRole("button", { name: "Copy invite link" })).toBeHidden();

  await ryan.page.getByRole("button", { name: "Ready" }).click();
  await expect(
    sam.page.getByRole("region", { name: "Players" }).getByText("Ready", { exact: true }),
  ).toBeVisible();
  await sam.page.getByRole("button", { name: "Ready" }).click();

  for (const { page } of [ryan, sam]) {
    await expect(
      page.getByTestId("volley-match").getByRole("img", { name: "Volleyball court" }),
    ).toBeVisible();
  }
  // Past the countdown, the room runs the match and sends snapshots.
  await expect.poll(() => sam.snaps.at(-1)?.f ?? 0, { timeout: 8_000 }).toBeGreaterThan(60);

  // Ryan runs right: Sam's page sees him move.
  const before = sam.snaps.at(-1)!.x0;
  await ryan.page.keyboard.down("ArrowRight");
  await expect.poll(() => sam.snaps.at(-1)!.x0 - before, { timeout: 3_000 }).toBeGreaterThan(80);
  await ryan.page.keyboard.up("ArrowRight");
  // Sam runs right, towards his own baseline, and Ryan's page sees it.
  const samBefore = ryan.snaps.at(-1)!.x1;
  await sam.page.keyboard.down("ArrowRight");
  await expect
    .poll(() => ryan.snaps.at(-1)!.x1 - samBefore, { timeout: 3_000 })
    .toBeGreaterThan(60);
  await sam.page.keyboard.up("ArrowRight");

  // Sam leaves: Ryan is back in the room, waiting for someone new.
  await sam.page.getByRole("button", { name: "Leave game" }).click();
  await expect(sam.page).toHaveURL(/\/games\/volley$/);
  await expect(ryan.page.getByRole("button", { name: "Copy invite link" })).toBeVisible();
  await expect(ryan.page.getByTestId("volley-match")).toBeHidden();

  expect([...ryan.errors, ...sam.errors]).toEqual([]);
  await ryan.close();
  await sam.close();
});

test("a guest without a name is asked for one", async ({ browser }) => {
  const ryan = await person(browser, "Ryan");
  const url = await create(ryan);
  const context = await browser.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "CF-Connecting-IP": uniqueIp() },
  });
  const page = await context.newPage();
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "You've been invited to play Power Volley" }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Ana");
  await page.getByRole("button", { name: "Join game" }).click();
  await expect(ryan.page.getByRole("region", { name: "Players" }).getByText("Ana")).toBeVisible();
  await context.close();
  await ryan.close();
});

test("an unknown room says so", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("games.name", "Ryan"));
  await page.goto("/games/volley/ZZZZZZ");
  await expect(page.getByRole("heading", { name: /expired|not found/i })).toBeVisible();
});

test("on an iPhone held sideways, the online match has touch buttons and fits", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { defaultBrowserType: _, viewport, ...iPhone } = devices["iPhone 13 landscape"];
  const ryan = await person(browser, "Ryan", { ...iPhone, viewport });
  const sam = await person(browser, "Sam");
  const url = await create(ryan);
  await sam.page.goto(url);
  await sam.page.getByRole("button", { name: "Ready" }).click();
  await ryan.page.getByRole("button", { name: "Ready" }).click();

  const match = ryan.page.getByTestId("volley-match");
  await expect(match.getByRole("group", { name: "Player move" })).toBeVisible();
  await expect(match.getByRole("button", { name: "Player jump" })).toBeVisible();
  const court = await match.getByRole("img", { name: "Volleyball court" }).boundingBox();
  expect(court!.width).toBeLessThanOrEqual(viewport.width);
  expect(court!.y + court!.height).toBeLessThanOrEqual(viewport.height);
  await ryan.page.screenshot({ path: test.info().outputPath("iphone-landscape.png") });
  expect([...ryan.errors, ...sam.errors]).toEqual([]);
  await ryan.close();
  await sam.close();
});
