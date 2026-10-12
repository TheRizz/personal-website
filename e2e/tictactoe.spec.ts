import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";
import { MAX_SOCKETS_PER_LOBBY, generateLobbyCode } from "../packages/game-core/src/index";
import { BASE_URL, LobbyClient, createLobby, sleep, uniqueIp } from "./helpers";

/** One simulated person: their own browser context (storage, cookies) and client IP. */
interface Player {
  context: BrowserContext;
  page: Page;
}

/** Chrome's own network logs (an expected 404, a refused WebSocket handshake), not app errors. */
const NETWORK_LOG = /^(Failed to load resource|WebSocket connection to .* failed)/;

/**
 * `open()` gives each person a fresh context with a unique `CF-Connecting-IP`, so lobby creation
 * never shares a rate-limit window with another test; every context is closed afterwards. The
 * test fails if any page throws or logs a console error (e.g. a hydration mismatch) other than a
 * network log.
 */
const test = base.extend<{ open: (options?: BrowserContextOptions) => Promise<Player> }>({
  open: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    await use(async (options) => {
      const context = await newContext(browser, options);
      contexts.push(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" && !NETWORK_LOG.test(message.text())) {
          errors.push(`console: ${message.text()}`);
        }
      });
      recordMoveFrames(page);
      return { context, page };
    });
    for (const context of contexts) await context.close();
    expect(errors).toEqual([]);
  },
});

function newContext(browser: Browser, options: BrowserContextOptions = {}) {
  return browser.newContext({
    ...options,
    baseURL: BASE_URL,
    extraHTTPHeaders: { "CF-Connecting-IP": uniqueIp() },
  });
}

const LOBBY_URL = /\/games\/tictactoe\/([A-Z2-9]{6})$/;
const SOCKET_URL = /\/api\/lobbies\/[A-Z2-9]{6}\/ws$/;

const board = (page: Page) => page.getByRole("group", { name: "Tic-tac-toe board" });
/** Board cell 0..8 (row-major); its accessible name is e.g. "Row 1, column 2, X". */
const cell = (page: Page, index: number) => board(page).getByRole("button").nth(index);
const playerCard = (page: Page, seat: "X" | "O") =>
  page
    .getByRole("list", { name: "Players" })
    .getByRole("listitem")
    .nth(seat === "X" ? 0 : 1);
const headline = (page: Page, text: string) => page.getByText(text, { exact: true });

function cellName(index: number, value: "X" | "O" | null) {
  return `Row ${Math.floor(index / 3) + 1}, column ${(index % 3) + 1}, ${value ?? "empty"}`;
}

async function fillName(page: Page, name: string) {
  await page.getByLabel("Your name").fill(name);
}

/** Creates a game from /games/tictactoe and returns the lobby code from the URL. */
async function createGame(page: Page, name: string): Promise<string> {
  await page.goto("/games/tictactoe");
  await fillName(page, name);
  await page.getByRole("button", { name: "Create game" }).click();
  await expect(page).toHaveURL(LOBBY_URL);
  const code = LOBBY_URL.exec(new URL(page.url()).pathname)?.[1] ?? "";
  await expect(page.getByRole("button", { name: "Copy invite link" })).toBeVisible();
  return code;
}

/** Opens an invite link in a context without a saved name and joins as `name`. */
async function acceptInvite(page: Page, code: string, name: string) {
  await page.goto(`/games/tictactoe/${code}`);
  await expect(
    page.getByRole("heading", { name: "You've been invited to play tic-tac-toe" }),
  ).toBeVisible();
  await fillName(page, name);
  await page.getByRole("button", { name: "Join game" }).click();
}

/** Asserts a cell's mark on every page (i.e. every client has seen the server's snapshot). */
async function expectCell(pages: Page[], index: number, value: "X" | "O" | null) {
  for (const page of pages)
    await expect(cell(page, index)).toHaveAccessibleName(cellName(index, value));
}

/**
 * Plays `cells` alternately, starting with `first`: each mover waits for "Your move", clicks the
 * cell, and every page must show the mark before the next move.
 */
async function playMoves(
  first: Page,
  second: Page,
  cells: number[],
  marks: ["X" | "O", "X" | "O"],
) {
  for (const [i, index] of cells.entries()) {
    const mover = i % 2 === 0 ? first : second;
    await expect(headline(mover, "Your move")).toBeVisible();
    await cell(mover, index).click();
    await expectCell([first, second], index, marks[i % 2]!);
  }
}

/** Every cell of the board is disabled on `page`. */
async function expectAllCellsDisabled(page: Page) {
  const cells = board(page).getByRole("button");
  await expect(cells).toHaveCount(9);
  for (const c of await cells.all()) await expect(c).toBeDisabled();
}

async function expectScore(page: Page, x: number, o: number) {
  await expect(playerCard(page, "X")).toContainText(new RegExp(`Score:\\s*${x}$`));
  await expect(playerCard(page, "O")).toContainText(new RegExp(`Score:\\s*${o}$`));
}

/** Alice creates a game, Bob joins through the invite link; both see the board. */
async function startGame(open: () => Promise<Player>) {
  const alice = await open();
  const bob = await open();
  const code = await createGame(alice.page, "Alice");
  await acceptInvite(bob.page, code, "Bob");
  for (const page of [alice.page, bob.page]) {
    await expect(board(page)).toBeVisible();
    await expect(playerCard(page, "X")).toContainText("Alice");
    await expect(playerCard(page, "O")).toContainText("Bob");
  }
  return { alice: alice.page, bob: bob.page, code };
}

const sentMoves = new WeakMap<Page, string[]>();

/** Records the `move` frames `page` sends; attached before the page opens any socket. */
function recordMoveFrames(page: Page): void {
  const frames: string[] = [];
  sentMoves.set(page, frames);
  page.on("websocket", (ws) => {
    ws.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && payload.includes('"t":"move"')) frames.push(payload);
    });
  });
}

/** The `move` frames `page` has sent so far. */
const movesSent = (page: Page) => sentMoves.get(page) ?? [];

test.describe("tic-tac-toe in the browser", () => {
  test("two players create, join, win, rematch and draw", async ({ open }) => {
    const alice = await open({ permissions: ["clipboard-read", "clipboard-write"] });
    const bob = await open();

    const code = await createGame(alice.page, "Alice");
    const waiting = alice.page.getByRole("region", { name: "Waiting for an opponent" });
    await expect(waiting.getByText(code, { exact: true })).toBeVisible();
    await expect(waiting).toContainText("Waiting for an opponent…");
    await alice.page.getByRole("button", { name: "Copy invite link" }).click();
    await expect(alice.page.getByRole("button", { name: "Copied" })).toBeVisible();
    const invite = await alice.page.evaluate(() => navigator.clipboard.readText());
    expect(invite).toBe(`${BASE_URL}/games/tictactoe/${code}`);

    await acceptInvite(bob.page, code, "Bob");
    const pages = [alice.page, bob.page];
    for (const page of pages) {
      await expect(playerCard(page, "X")).toContainText("Alice");
      await expect(playerCard(page, "O")).toContainText("Bob");
      await expect(page.getByText("Round 1 • 0 draws")).toBeVisible();
    }
    await expect(playerCard(alice.page, "X")).toContainText("You");
    await expect(playerCard(bob.page, "O")).toContainText("You");
    await expect(headline(alice.page, "Your move")).toBeVisible();
    await expect(headline(bob.page, "Waiting for Alice")).toBeVisible();

    // Round 1: X takes the top row while O plays the middle row.
    await playMoves(alice.page, bob.page, [0, 3, 1, 4, 2], ["X", "O"]);
    await expect(headline(alice.page, "You win")).toBeVisible();
    await expect(headline(bob.page, "You lose")).toBeVisible();
    for (const page of pages) {
      await expectScore(page, 1, 0);
      await expectAllCellsDisabled(page);
    }

    // Both ask for a rematch: round 2, O starts.
    await alice.page.getByRole("button", { name: "Play again" }).click();
    await expect(alice.page.getByText("Waiting for Bob to accept…")).toBeVisible();
    await expect(bob.page.getByText("Alice wants a rematch", { exact: true })).toBeVisible();
    await bob.page.getByRole("button", { name: "Play again" }).click();
    for (const page of pages) {
      await expect(page.getByText("Round 2 • 0 draws")).toBeVisible();
      for (let i = 0; i < 9; i++)
        await expect(cell(page, i)).toHaveAccessibleName(cellName(i, null));
    }
    await expect(headline(bob.page, "Your move")).toBeVisible();
    await expect(headline(alice.page, "Waiting for Bob")).toBeVisible();

    // Round 2 ends in a draw:  O X O / O X X / X O O
    await playMoves(bob.page, alice.page, [0, 1, 2, 4, 3, 5, 7, 6, 8], ["O", "X"]);
    for (const page of pages) {
      await expect(headline(page, "Draw")).toBeVisible();
      await expect(page.getByText("Round 2 • 1 draw", { exact: true })).toBeVisible();
      await expectScore(page, 1, 0);
    }
  });

  test("a refreshed tab reconnects to the same seat", async ({ open }) => {
    const { alice, bob } = await startGame(open);
    await playMoves(alice, bob, [0, 4], ["X", "O"]);

    await bob.reload();
    await expect(board(bob)).toBeVisible();
    await expect(playerCard(bob, "O")).toContainText("You");
    await expect(playerCard(bob, "O")).toContainText("Bob");
    await expectCell([bob], 0, "X");
    await expectCell([bob], 4, "O");
    await expect(headline(bob, "Waiting for Alice")).toBeVisible();

    // Whether or not Alice saw the brief disconnect, it ends with Bob back and online.
    await expect(alice.getByText(/Bob disconnected/)).toHaveCount(0);
    await expect(playerCard(alice, "O")).toContainText("online");
    await playMoves(alice, bob, [1, 8], ["X", "O"]);
    await expect(alice.getByText("Round 1 • 0 draws")).toBeVisible();

    // Closing the tab for good leaves the seat held, with a countdown for the opponent.
    await bob.close();
    await expect(alice.getByText(/^Bob disconnected — seat held for [12]:\d\d$/)).toBeVisible();
    await expect(playerCard(alice, "O")).toContainText("offline");
  });

  test("a third visitor is a spectator and cannot play", async ({ open }) => {
    const { alice, bob, code } = await startGame(open);
    await playMoves(alice, bob, [4], ["X", "O"]);

    const carol = (await open()).page;
    await acceptInvite(carol, code, "Carol");
    await expect(carol.getByText("You're watching.")).toBeVisible();
    await expect(playerCard(carol, "X")).toContainText("Alice");
    await expect(playerCard(carol, "O")).toContainText("Bob");
    await expect(headline(carol, "Bob's move")).toBeVisible();
    await expectCell([carol], 4, "X");
    await expectAllCellsDisabled(carol);
    for (const page of [alice, bob]) await expect(page.getByText("1 watching")).toBeVisible();

    // A forced click on a disabled cell sends nothing; play goes on and Carol follows it.
    await cell(carol, 0).click({ force: true });
    await playMoves(bob, alice, [0], ["O", "X"]);
    await expectCell([carol], 0, "O");
    expect(movesSent(carol)).toEqual([]);
    await expect(headline(carol, "Alice's move")).toBeVisible();
  });

  test("an unknown code shows the not-found panel; a malformed code is a 404 page", async ({
    open,
  }) => {
    const { page } = await open();
    // Valid format, never created. Lowercase links redirect to the canonical uppercase URL.
    const code = generateLobbyCode();
    await page.goto(`/games/tictactoe/${code.toLowerCase()}`);
    await expect(page).toHaveURL(new RegExp(`/games/tictactoe/${code}$`));
    await fillName(page, "Dana");
    await page.getByRole("button", { name: "Join game" }).click();
    await expect(page.getByRole("heading", { name: "Lobby not found or expired" })).toBeVisible();
    await page.getByRole("link", { name: "Start a new game" }).click();
    await expect(page).toHaveURL(/\/games\/tictactoe$/);

    for (const bad of ["ABC", "ABCDE0", "ABCDEFG"]) {
      const response = await page.goto(`/games/tictactoe/${bad}`);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    }
  });

  test("joining with a typed code normalises it", async ({ open }) => {
    const alice = (await open()).page;
    const bob = (await open()).page;
    const code = await createGame(alice, "Alice");

    await bob.goto("/games/tictactoe");
    await fillName(bob, "Bob");
    const input = bob.getByLabel("Enter the 6-character code from your friend.");
    const join = bob.getByRole("button", { name: "Join game" });
    await expect(join).toBeDisabled();
    const typed = `${code.slice(0, 3).toLowerCase()} - ${code.slice(3).toLowerCase()}`;
    await input.pressSequentially(typed);
    await expect(input).toHaveValue(code);
    // A pasted invite link works too.
    await input.fill(`${BASE_URL}/games/tictactoe/${code}?from=chat`);
    await expect(input).toHaveValue(code);
    await join.click();

    await expect(bob).toHaveURL(new RegExp(`/games/tictactoe/${code}$`));
    for (const page of [alice, bob]) {
      await expect(playerCard(page, "X")).toContainText("Alice");
      await expect(playerCard(page, "O")).toContainText("Bob");
    }
    await expect(headline(bob, "Waiting for Alice")).toBeVisible();
  });

  test("only the player to move can play, and only empty cells", async ({ open }) => {
    const { alice, bob } = await startGame(open);

    await expect(headline(alice, "Your move")).toBeVisible();
    await expect(headline(bob, "Waiting for Alice")).toBeVisible();
    await expect(playerCard(alice, "X")).toContainText("to move");
    await expectAllCellsDisabled(bob);
    for (let i = 0; i < 9; i++) await expect(cell(alice, i)).toBeEnabled();

    // Out of turn: Bob's forced click does nothing.
    await cell(bob, 0).click({ force: true });
    await cell(alice, 4).click();
    await expectCell([alice, bob], 4, "X");
    expect(movesSent(bob)).toEqual([]);

    // The turn passes: Bob can play empty cells only, Alice can't play at all.
    await expect(headline(bob, "Your move")).toBeVisible();
    await expect(headline(alice, "Waiting for Bob")).toBeVisible();
    await expect(playerCard(bob, "O")).toContainText("to move");
    await expectAllCellsDisabled(alice);
    await expect(cell(bob, 4)).toBeDisabled();
    for (const i of [0, 1, 2, 3, 5, 6, 7, 8]) await expect(cell(bob, i)).toBeEnabled();

    await cell(bob, 4).click({ force: true });
    await cell(bob, 0).click();
    await expectCell([alice, bob], 0, "O");
    expect(movesSent(bob)).toHaveLength(1);
    expect(JSON.parse(movesSent(bob)[0]!)).toMatchObject({ t: "move", move: { cell: 0 } });
    await expect(headline(alice, "Your move")).toBeVisible();
  });

  test("cells can be played with the keyboard", async ({ open }) => {
    const { alice, bob } = await startGame(open);

    // The cells come right after "Leave game" in the tab order.
    await expect(headline(alice, "Your move")).toBeVisible();
    await alice.getByRole("button", { name: "Leave game" }).focus();
    await alice.keyboard.press("Tab");
    await expect(cell(alice, 0)).toBeFocused();
    await alice.keyboard.press("Tab");
    await expect(cell(alice, 1)).toBeFocused();
    await alice.keyboard.press("Enter");
    await expectCell([alice, bob], 1, "X");
    // Focus stays on the cell after the turn passes.
    await expect(cell(alice, 1)).toBeFocused();

    await expect(headline(bob, "Your move")).toBeVisible();
    await bob.getByRole("button", { name: "Leave game" }).focus();
    await bob.keyboard.press("Tab");
    await expect(cell(bob, 0)).toBeFocused();
    await bob.keyboard.press("ArrowDown");
    await expect(cell(bob, 3)).toBeFocused();
    await bob.keyboard.press(" ");
    await expectCell([alice, bob], 3, "O");
    await expect(headline(alice, "Your move")).toBeVisible();
  });

  test("leaving frees the seat for a spectator and starts a new match", async ({ open }) => {
    const { alice, bob, code } = await startGame(open);
    await playMoves(alice, bob, [0, 3, 1, 4, 2], ["X", "O"]);
    await expectScore(bob, 1, 0);
    const carol = (await open()).page;
    await acceptInvite(carol, code, "Carol");
    await expect(carol.getByText("You're watching.")).toBeVisible();

    await alice.getByRole("button", { name: "Leave game" }).click();
    await expect(alice).toHaveURL(/\/games\/tictactoe$/);
    await expect(bob.getByRole("region", { name: "Waiting for an opponent" })).toBeVisible();
    await carol.getByRole("button", { name: "Take the empty seat" }).click();

    await expect(playerCard(carol, "X")).toContainText("You");
    for (const page of [bob, carol]) {
      await expect(playerCard(page, "X")).toContainText("Carol");
      await expect(playerCard(page, "O")).toContainText("Bob");
      await expect(page.getByText("Round 1 • 0 draws", { exact: true })).toBeVisible();
      await expectScore(page, 0, 0);
    }
    await expect(carol.getByText("You're watching.")).toHaveCount(0);
    await playMoves(carol, bob, [4], ["X", "O"]);
  });

  test("a duplicated tab takes the seat over; the old tab can watch", async ({ open }) => {
    const alice = (await open()).page;
    const bob = await open();
    const code = await createGame(alice, "Alice");
    await acceptInvite(bob.page, code, "Bob");
    await expect(headline(bob.page, "Waiting for Alice")).toBeVisible();

    // Duplicating a tab copies its sessionStorage, including the seat token.
    const tokenKey = `games.token.${code}`;
    const token = await bob.page.evaluate((key) => sessionStorage.getItem(key), tokenKey);
    expect(token).toEqual(expect.any(String));
    const duplicate = await bob.context.newPage();
    await duplicate.addInitScript(
      ([key, value]) => {
        if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
      },
      [tokenKey, token!] as const,
    );
    await duplicate.goto(`/games/tictactoe/${code}`);
    await expect(playerCard(duplicate, "O")).toContainText("You");
    await expect(headline(duplicate, "Waiting for Alice")).toBeVisible();

    await expect(bob.page.getByText("This game is open in another tab.")).toBeVisible();
    await bob.page.getByRole("button", { name: "Watch here" }).click();
    await expect(bob.page.getByText("You're watching.")).toBeVisible();
    await expect(headline(bob.page, "Alice's move")).toBeVisible();
    await expectAllCellsDisabled(bob.page);

    // The duplicate keeps the seat and the game goes on.
    await playMoves(alice, duplicate, [0, 4], ["X", "O"]);
    await expectCell([bob.page], 4, "O");
  });

  test("a full lobby says so, and lets you in once there's room", async ({ open, request }) => {
    const { code } = await createLobby(request);
    const sockets: LobbyClient[] = [];
    try {
      for (let i = 0; i < MAX_SOCKETS_PER_LOBBY; i++) {
        sockets.push((await LobbyClient.join(code, `Guest ${i + 1}`)).client);
      }
      const { page } = await open();
      await acceptInvite(page, code, "Late");
      await expect(page.getByText(/^This game is full: both seats are taken/)).toBeVisible();
      await expect(page.getByText("You're watching.")).toHaveCount(0);

      // A spectator leaves.
      sockets.pop()!.close();
      await expect(async () => {
        await page.getByRole("button", { name: "Try again" }).click();
        await expect(page.getByText("You're watching.")).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
    } finally {
      for (const socket of sockets) socket.close();
    }
  });

  test("an expired lobby says so", async ({ open }) => {
    const { page } = await open();
    const routes: WebSocketRoute[] = [];
    await page.routeWebSocket(SOCKET_URL, (ws) => {
      ws.connectToServer();
      routes.push(ws);
    });
    await createGame(page, "Alice");
    await routes.at(-1)!.close({ code: 4001, reason: "Lobby expired" });
    await expect(page.getByRole("heading", { name: "This game has expired" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start a new game" })).toBeVisible();
  });

  test("a lost connection says so, and Reconnect recovers", async ({ open }) => {
    test.setTimeout(60_000);
    const { page } = await open();
    let offline = false;
    const routes: WebSocketRoute[] = [];
    await page.routeWebSocket(SOCKET_URL, (ws) => {
      if (offline) {
        void ws.close({ code: 1011, reason: "Unavailable" });
        return;
      }
      ws.connectToServer();
      routes.push(ws);
    });
    await createGame(page, "Alice");

    offline = true;
    await routes.at(-1)!.close({ code: 1011, reason: "Unavailable" });
    await expect(page.getByText(/^Reconnecting \(\d of 5\)/)).toBeVisible();
    // The backoff runs out after about 15 s.
    await expect(page.getByText("Connection lost.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Check your connection, then try again.")).toBeVisible();
    await expect(page.getByRole("status").getByText("Offline")).toBeVisible();

    offline = false;
    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect(page.getByRole("status").getByText("Connected")).toBeVisible();
    await expect(page.getByText("Connection lost.")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Waiting for an opponent" })).toBeVisible();
    // Focus doesn't fall back to the page when the Reconnect button goes away.
    await expect(page.getByRole("status").getByText("Connected")).toBeFocused();
  });

  test("a create error is shown under the button", async ({ open }) => {
    const { page } = await open();
    await page.route("**/api/lobbies", (route) =>
      route.fulfill({
        status: 429,
        json: { error: { code: "rate_limited", message: "Too many lobbies." } },
      }),
    );
    await page.goto("/games/tictactoe");
    await fillName(page, "Alice");
    await page.getByRole("button", { name: "Create game" }).click();
    await expect(
      page.getByText("You've created a lot of games — try again in a minute."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/games\/tictactoe$/);
  });

  test("a missing name is shown and focused, even when scrolled away", async ({ open }) => {
    const { page } = await open({ viewport: { width: 360, height: 640 } });
    await page.goto("/games/tictactoe");
    const code = page.getByLabel("Enter the 6-character code from your friend.");
    await code.fill("ABCDEF");
    await code.press("Enter");
    const name = page.getByLabel("Your name");
    await expect(name).toBeFocused();
    await expect(page.getByText("Name is required.")).toBeInViewport();
    await expect(page).toHaveURL(/\/games\/tictactoe$/);

    await fillName(page, "   ");
    await page.getByRole("button", { name: "Create game" }).click();
    await expect(page.getByText("Name is required.")).toBeVisible();
    await expect(name).toBeFocused();
  });

  test("leaving the page while a game is being created stays where you went", async ({ open }) => {
    const { page } = await open();
    let answered!: () => void;
    const slowCreate = new Promise<void>((resolve) => (answered = resolve));
    await page.route("**/api/lobbies", async (route) => {
      await sleep(1_000);
      // The page may have given up on the request by now.
      await route.continue().catch(() => {});
      answered();
    });
    await page.goto("/games/tictactoe");
    await fillName(page, "Alice");
    await page.getByRole("button", { name: "Create game" }).click();
    await page.locator('header a[href="/"]').click();
    await expect(page).toHaveURL(`${BASE_URL}/`);
    await slowCreate;
    await sleep(500);
    await expect(page).toHaveURL(`${BASE_URL}/`);
  });

  test("keyboard focus stays put through a rematch", async ({ open }) => {
    const { alice, bob } = await startGame(open);
    await playMoves(alice, bob, [0, 3, 1, 4, 2], ["X", "O"]);

    await alice.getByRole("button", { name: "Play again" }).focus();
    await alice.keyboard.press("Enter");
    await expect(alice.getByText("Waiting for Bob to accept…")).toBeFocused();

    await bob.getByRole("button", { name: "Play again" }).focus();
    await bob.keyboard.press("Enter");
    for (const page of [alice, bob]) await expect(cell(page, 0)).toBeFocused();
  });

  test("on a phone the board is in view and stays put when the turn passes or the opponent drops", async ({
    open,
  }) => {
    const alice = (await open({ viewport: { width: 360, height: 640 } })).page;
    const bob = (await open()).page;
    const code = await createGame(alice, "Alice");
    await acceptInvite(bob, code, "Christopher Long");
    // Relative to the document, so scrolling the board into view doesn't count.
    const boardTop = () =>
      board(alice).evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));

    await expect(headline(alice, "Your move")).toBeVisible();
    // The whole board is scrolled into view when the game starts.
    await expect(board(alice)).toBeInViewport({ ratio: 0.99 });
    const top = await boardTop();
    await cell(alice, 4).click();
    await expect(headline(alice, "Waiting for Christopher Long")).toBeVisible();
    expect(await boardTop()).toBe(top);

    await bob.close();
    await expect(alice.getByText(/^Christopher Long disconnected — seat held/)).toBeVisible();
    expect(await boardTop()).toBe(top);
  });
});
