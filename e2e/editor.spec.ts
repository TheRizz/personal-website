import { expect, type Page } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken } from "./access";
import { cspTest } from "./csp";

// The draft editor (design doc §4.9.3, Step 10.5), signed in with the localhost-only test
// identity standing in for Cloudflare Access.

const test = cspTest({
  headers: async () => ({ [ASSERTION_HEADER]: await signAccessToken() }),
  consoleErrors: true,
});

/** GET /api/admin/... from the page, as the owner. */
async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
    return (await response.json()) as T;
  }, path);
}

async function discard(page: Page, id: string) {
  await page.evaluate(async (url) => {
    await fetch(url, { method: "DELETE", headers: { "X-Admin": "1" } });
  }, `/api/admin/drafts/${id}`);
}

const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: /^Saved$/ }));

test("the owner writes a post, reloads, and gets the same Markdown back", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "New post" }).click();
  await expect(page).toHaveURL(/\/admin\/drafts\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").at(-1)!;

  try {
    await page.getByLabel("Title").fill("E2E editor post");
    const body = page.getByRole("textbox", { name: "Post body" });
    await body.click();
    await page.getByRole("button", { name: "Heading 2" }).click();
    await page.keyboard.type("Section");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Some ");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type("bold");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type(" and ");
    await page.keyboard.press("ControlOrMeta+i");
    await page.keyboard.type("italic");
    await page.keyboard.press("ControlOrMeta+i");
    await page.keyboard.type(" text.");
    await saved(page).toBeVisible({ timeout: 15_000 });

    const preview = page.getByRole("article", { name: "Preview" });
    await expect(preview.getByRole("heading", { level: 2, name: "Section" })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("bold");

    const stored = await apiGet<{ title: string; bodyMd: string }>(page, `/api/admin/drafts/${id}`);
    expect(stored.title).toBe("E2E editor post");
    expect(stored.bodyMd).toBe("## Section\n\nSome **bold** and *italic* text.\n");

    await page.reload();
    await expect(page.getByLabel("Title")).toHaveValue("E2E editor post");
    await expect(body.getByRole("heading", { level: 2, name: "Section" })).toBeVisible();
    await expect(body.locator("em")).toHaveText("italic");

    await page.getByRole("tab", { name: "Raw Markdown" }).click();
    await expect(page.getByLabel("Post body (Markdown)")).toHaveValue(stored.bodyMd);

    // The draft shows up in the list.
    await page.getByRole("link", { name: "← All drafts" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "E2E editor post" })).toBeVisible();
  } finally {
    await discard(page, id);
  }
});

test("a save from a stale tab shows the conflict banner, and Overwrite keeps the other version", async ({
  page,
  browser,
}) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "New post" }).click();
  await expect(page).toHaveURL(/\/admin\/drafts\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").at(-1)!;

  // A second browser on the same draft (its own context, so no BroadcastChannel between them).
  const other = await browser.newContext({
    extraHTTPHeaders: { [ASSERTION_HEADER]: await signAccessToken() },
  });
  try {
    const otherPage = await other.newPage();
    await otherPage.goto(`/admin/drafts/${id}`);
    await otherPage.getByLabel("Title").fill("From the other tab");
    await saved(otherPage).toBeVisible({ timeout: 15_000 });

    await page.getByLabel("Title").fill("From this tab");
    await expect(page.getByText("This draft was saved in another tab")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "keep this one" }).click();
    await saved(page).toBeVisible({ timeout: 15_000 });

    const draft = await apiGet<{ title: string }>(page, `/api/admin/drafts/${id}`);
    expect(draft.title).toBe("From this tab");
    const { revisions } = await apiGet<{ revisions: { reason: string; title: string }[] }>(
      page,
      `/api/admin/drafts/${id}/revisions`,
    );
    expect(revisions).toContainEqual(
      expect.objectContaining({ reason: "conflict", title: "From the other tab" }),
    );
  } finally {
    await other.close();
    await discard(page, id);
  }
});
