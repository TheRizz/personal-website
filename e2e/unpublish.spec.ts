import { expect, type Page } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken } from "./access";
import { cspTest } from "./csp";
import { cleanUpDrafts, discardDraft, getDraft, githubStub, publishState } from "./github";

// Unpublishing a post from /admin against the local GitHub stub (design doc §4.9.7, Step 10.10):
// a pull request that deletes the file, which the stub merges as the owner would.

const test = cspTest({
  headers: async () => ({ [ASSERTION_HEADER]: await signAccessToken() }),
  consoleErrors: true,
});

test.beforeEach(async () => {
  await cleanUpDrafts();
});

const currentStep = (page: Page) =>
  page.getByRole("list", { name: "Publish progress" }).locator('[aria-current="step"]');

test("the owner unpublishes a post through an Unpublish: PR", async ({ page }) => {
  const path = "content/blog/2026-10-11-hello-world.md";
  let id: string | null = null;
  try {
    await page.goto("/admin");
    const post = page
      .getByRole("list", { name: "Published posts" })
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: "Hello, world" }) });
    await post.getByRole("button", { name: "Unpublish" }).click();
    const dialog = page.getByRole("dialog", { name: "Unpublish this post?" });
    await expect(dialog).toContainText(`Unpublishing opens a pull request that deletes ${path}.`);
    await expect(dialog).toContainText(
      "Its images stay at photos.ry-mart.com; delete them in R2 and purge the cache if they " +
        "must go too.",
    );
    await dialog.getByRole("button", { name: "Open the unpublish PR" }).click();
    await expect(page).toHaveURL(/\/admin\/drafts\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    id = page.url().split("/").at(-1)!;

    const pr = (await publishState(id)).pr!;
    await expect(currentStep(page)).toHaveText(new RegExp(`^PR #${pr} opened\\b`));
    const stub = await githubStub.state();
    expect(stub.pulls).toHaveLength(1);
    const pull = stub.pulls[0]!;
    expect(pull.title).toBe("Unpublish: Hello, world");
    expect(pull.body).toContain(path);
    expect(pull.headRef).toMatch(/^blog\/hello-world-\d+$/);
    // One commit, whose tree no longer has the post.
    expect(pull.commits).toHaveLength(1);
    expect(pull.commits[0]!.paths).not.toContain(path);
    expect(stub.mainPaths).toContain(path);

    const { mergeSha } = await githubStub.merge(pr);
    await githubStub.setVersion(mergeSha);
    await expect(async () => {
      await page.getByRole("button", { name: "Check now" }).click();
      await expect(currentStep(page)).toHaveText(/^Live\b/, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(currentStep(page)).toContainText("Removed from the site");

    const after = await githubStub.state();
    expect(after.mainPaths).not.toContain(path);
    expect(after.violations).toEqual([]);
    // Off main, the draft is a new post again, still holding the address.
    expect(await getDraft(id)).toMatchObject({ kind: "new", status: "draft", slug: "hello-world" });
  } finally {
    if (id) await discardDraft(id);
  }
});
