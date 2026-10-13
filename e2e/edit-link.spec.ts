import { expect, test } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken } from "./access";
import { cspTest } from "./csp";
import { cleanUpDrafts, discardDraft } from "./github";
import { BASE_URL } from "./helpers";

// The Edit link on public posts (design doc §4.9.1, Step 10.9): only a browser with the owner
// hint asks /api/admin/me (with HEAD), and only the owner gets the link. The post is the stub's
// `hello-world`, the one in content/blog.

const POST = "/blog/hello-world";
const OWNER_HINT = { name: "owner_hint", value: "1", url: BASE_URL };

/** The owner: every request carries the test token, as Access would add it. */
const ownerTest = cspTest({
  headers: async () => ({ [ASSERTION_HEADER]: await signAccessToken() }),
  consoleErrors: true,
});
/** A visitor with a stale hint and no Access session. */
const visitorTest = cspTest({ headers: () => ({}), consoleErrors: true });

test("a visitor without the hint makes no admin request", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.goto(POST, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Hello, world" })).toBeVisible();
  expect(urls.length).toBeGreaterThan(1);
  expect(urls.filter((url) => url.includes("/api/admin"))).toEqual([]);
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
});

test("the prerendered post has no admin markup", async ({ request }) => {
  const response = await request.get(POST);
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("Hello, world");
  expect(html).not.toContain("/admin/posts/");
  expect(html).not.toContain("/api/admin");
});

ownerTest("the owner gets Edit, which opens the post's draft", async ({ page }) => {
  await cleanUpDrafts();
  await page.context().addCookies([OWNER_HINT]);
  const probe = page.waitForRequest((request) => request.url().endsWith("/api/admin/me"));
  await page.goto(POST);
  // HEAD, so the owner's e-mail never reaches the public page.
  expect((await probe).method()).toBe("HEAD");
  const edit = page.getByRole("link", { name: "Edit", exact: true });
  await expect(edit).toHaveAttribute("href", "/admin/posts/hello-world");

  await edit.click();
  await expect(page).toHaveURL(/\/admin\/drafts\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const id = page.url().split("/").at(-1)!;
  try {
    await expect(page.getByLabel("Title")).toHaveValue("Hello, world");
  } finally {
    await discardDraft(id);
  }
});

visitorTest("with the hint but no token there is no Edit link and no error", async ({ page }) => {
  await page.context().addCookies([OWNER_HINT]);
  const probe = page.waitForResponse((response) => response.url().endsWith("/api/admin/me"));
  await page.goto(POST, { waitUntil: "networkidle" });
  // The gate's plain 404; the browser's own "Failed to load resource" line is all it logs.
  expect((await probe).status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Hello, world" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
});
