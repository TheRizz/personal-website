import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken, testIdentity } from "./access";
import { cspTest } from "./csp";
import {
  cleanUpDrafts,
  createDraft,
  discardDraft,
  getDraft,
  githubStub,
  importPost,
  listDrafts,
  mentions,
  ownerFetch,
  publishDraft,
  publishState,
} from "./github";

// Publishing from the editor against the local GitHub stub (design doc §4.9.7, Steps 10.9 and
// 10.10). The stub plays GitHub Actions and the owner: CI results, Squash and merge, closing a
// PR on GitHub, the deploy runs and the version the site serves.

const test = cspTest({
  headers: async () => ({ [ASSERTION_HEADER]: await signAccessToken() }),
  consoleErrors: true,
});

test.beforeEach(async () => {
  await cleanUpDrafts();
});

const REPO_URL = "https://github.com/TheRizz/personal-website";
const REPO_PATH = "/repos/TheRizz/personal-website";
/** GIT_AUTHOR in wrangler.jsonc. */
const AUTHOR = { name: "TheRizz", email: "19941577+TheRizz@users.noreply.github.com" };
/** The stub's App is `e2e-publisher` with bot user id 4242. */
const COMMITTER = {
  name: "e2e-publisher[bot]",
  email: "4242+e2e-publisher[bot]@users.noreply.github.com",
};

const timeline = (page: Page) => page.getByRole("list", { name: "Publish progress" });
const currentStep = (page: Page) => timeline(page).locator('[aria-current="step"]');
const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: /^Saved$/ }));
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The timeline's current step starts with `label` (hints and links follow it). */
async function expectStep(page: Page, label: string, timeout?: number) {
  await expect(currentStep(page)).toHaveText(new RegExp(`^${escapeRegExp(label)}\\b`), { timeout });
}

/**
 * Presses Check now until `label` is the current step. A poll already under way when the stub
 * changed answers Check now with the old stage, so one press isn't always enough.
 */
async function checkUntil(page: Page, label: string) {
  await expect(async () => {
    await page.getByRole("button", { name: "Check now" }).click();
    await expectStep(page, label, 2_000);
  }).toPass({ timeout: 20_000 });
}

/** The toolbar button, then Publish now in the confirm dialog. */
async function publishFromEditor(page: Page, button: string) {
  await page.getByRole("button", { name: button, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Publish this post?" });
  await expect(dialog).toContainText(
    "Publishing makes this text public on a GitHub pull request now. It goes live about a " +
      "minute after you merge that PR, and it stays in git history even if you cancel.",
  );
  await dialog.getByRole("button", { name: "Publish now" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test("a new post walks every stage to Live, and GitHub sees only that post", async ({ page }) => {
  const stamp = Date.now();
  const title = `E2E publish ${stamp}`;
  const slug = `e2e-publish-${stamp}`;
  const id = await createDraft({
    title,
    summary: "A post the e2e tests publish.",
    tags: ["E2E Tests"],
    bodyMd: "Some words first.\n\n## Why\n\nBecause the stub plays GitHub.\n",
  });
  // Another draft, whose text and image key must never reach GitHub.
  const phrase = `unpublished phrase ${randomUUID()}`;
  const imageKey = `blog/${randomUUID()}.webp`;
  const other = await createDraft({
    title: `E2E private ${stamp}`,
    summary: "Never published.",
    bodyMd: `${phrase}\n\n::figure[]{src="${imageKey}" alt="Private" w=800 h=600}\n`,
  });

  try {
    await page.goto(`/admin/drafts/${id}`);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Publish this post?" });
    await expect(dialog).toContainText("public on a GitHub pull request now");
    await expect(dialog.getByLabel("Address")).toHaveValue(slug);
    await expect(dialog).toContainText(`https://ry-mart.com/blog/${slug}`);
    await dialog.getByRole("button", { name: "Publish now" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const pr = (await publishState(id)).pr!;
    expect(pr).toBeGreaterThan(0);
    await expectStep(page, `PR #${pr} opened`);
    const prLink = timeline(page).getByRole("link", { name: `PR #${pr}` });
    await expect(prLink).toHaveAttribute("href", `${REPO_URL}/pull/${pr}`);

    await githubStub.checks(pr, "queued");
    await checkUntil(page, "CI running");
    await githubStub.checks(pr, "in_progress");
    await checkUntil(page, "CI running");
    await githubStub.checks(pr, "completed", "success");
    await checkUntil(page, "Waiting for your review");
    await expect(prLink).toHaveAttribute("href", `${REPO_URL}/pull/${pr}`);

    const { mergeSha } = await githubStub.merge(pr);
    await checkUntil(page, "Merged");
    const { runUrl } = await githubStub.deploy(mergeSha, "in_progress");
    await checkUntil(page, "Deploying");
    await expect(currentStep(page).getByRole("link", { name: "View the run" })).toHaveAttribute(
      "href",
      runUrl,
    );
    await githubStub.setVersion(mergeSha);
    await checkUntil(page, "Live");
    await expect(currentStep(page).getByRole("link", { name: "View the post" })).toHaveAttribute(
      "href",
      `/blog/${slug}`,
    );
    expect((await getDraft(id)).status).toBe("published");

    // One commit on a blog/<slug>-<time> branch, by GIT_AUTHOR, committed by the App's bot.
    const stub = await githubStub.state();
    expect(stub.violations).toEqual([]);
    expect(stub.pulls).toHaveLength(1);
    const pull = stub.pulls[0]!;
    expect(pull.number).toBe(pr);
    expect(pull.headRef).toMatch(new RegExp(`^blog/${slug}-\\d+$`));
    expect(pull.title).toBe(`Publish: ${title}`);
    expect(pull.commits).toHaveLength(1);
    expect(pull.commits[0]).toMatchObject({
      message: `Publish: ${title}`,
      author: AUTHOR,
      committer: COMMITTER,
    });
    for (const part of [
      "## Overview",
      `https://ry-mart.com/blog/${slug}`,
      "## What changed",
      "## Review checklist",
    ]) {
      expect(pull.body).toContain(part);
    }
    expect(stub.mainPaths.filter((path) => path.endsWith(`-${slug}.md`))).toHaveLength(1);

    // Nothing private reached GitHub: not the owner's address, no draft id, nothing of the
    // other draft.
    const drafts = (await listDrafts()).map((draft) => draft.id);
    expect(drafts).toEqual(expect.arrayContaining([id, other]));
    const requests = await githubStub.requests();
    expect(mentions(requests, [testIdentity().email, ...drafts, phrase, imageKey])).toEqual([]);
  } finally {
    await discardDraft(id);
    await discardDraft(other);
  }
});

test("the owner's e-mail typed in the editor is refused before any GitHub write", async ({
  page,
}) => {
  const email = testIdentity().email;
  const id = await createDraft({
    title: `E2E address ${Date.now()}`,
    summary: "A post that mentions the owner's address.",
    bodyMd: "Some text.\n",
  });
  try {
    await page.goto(`/admin/drafts/${id}`);
    await page.getByRole("textbox", { name: "Post body" }).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(` Write to ${email} for a copy.`);
    await saved(page).toBeVisible({ timeout: 15_000 });
    // The editor stores the address escaped (owner\@…); it is still the address.
    expect((await getDraft(id)).bodyMd.replace(/\\/g, "")).toContain(email);

    const before = (await githubStub.requests()).length;
    await publishFromEditor(page, "Publish");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "This post contains your private e-mail address. Remove it" }),
    ).toBeVisible();
    const writes = (await githubStub.requests())
      .slice(before)
      .filter((request) => request.method !== "GET" && request.path.startsWith("/repos/"));
    expect(writes).toEqual([]);
    expect((await githubStub.state()).pulls).toEqual([]);
    expect((await publishState(id)).stage).toBe("draft");
  } finally {
    await discardDraft(id);
  }
});

test("a CI failure is fixed and republished to the same PR, then the PR is cancelled", async ({
  page,
}) => {
  const id = await createDraft({
    title: `E2E fix ${Date.now()}`,
    summary: "A post whose first CI run fails.",
    bodyMd: "The first version.\n",
  });
  try {
    await page.goto(`/admin/drafts/${id}`);
    await publishFromEditor(page, "Publish");
    const pr = (await publishState(id)).pr!;
    await expectStep(page, `PR #${pr} opened`);
    const first = (await githubStub.state()).pulls[0]!;

    const { runUrl } = await githubStub.checks(pr, "completed", "failure");
    await checkUntil(page, "CI failed");
    await expect(currentStep(page).getByRole("link", { name: "View the run" })).toHaveAttribute(
      "href",
      new RegExp(`^${escapeRegExp(runUrl)}/`),
    );

    await page.getByRole("button", { name: "Fix and republish" }).click();
    await expect(page.getByRole("textbox", { name: "Post body" })).toBeFocused();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Fixed after CI.");
    await saved(page).toBeVisible({ timeout: 15_000 });
    await publishFromEditor(page, "Republish");
    await expect(page.getByText(`Pushed your changes to PR #${pr}.`)).toBeVisible();
    await expectStep(page, `PR #${pr} opened`);

    // A second commit on the same branch (a fast-forward), no second PR, a refreshed body and
    // one comment.
    const { pulls, refs } = await githubStub.state();
    expect(pulls).toHaveLength(1);
    const pull = pulls[0]!;
    expect(pull.headRef).toBe(first.headRef);
    expect(pull.commits).toHaveLength(2);
    expect(pull.commits[1]!.parents).toEqual([first.headSha]);
    expect(refs[pull.headRef]).toBe(pull.headSha);
    expect(pull.body).not.toBe(first.body);
    expect(pull.comments).toHaveLength(1);
    expect(pull.comments[0]).toMatch(/^### What changed since the previous publish\n/);
    const requests = await githubStub.requests();
    const sent = (method: string, path: RegExp) =>
      requests.filter((request) => request.method === method && path.test(request.path));
    expect(sent("POST", new RegExp(`^${REPO_PATH}/pulls$`))).toHaveLength(1);
    expect(sent("PATCH", new RegExp(`^${REPO_PATH}/git/refs/heads/`))).toHaveLength(1);

    // Discarding is refused while the PR is open, and autosave carries on.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Cancel the open publish before discarding" }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/admin/drafts/${id}$`));
    await page.getByRole("textbox", { name: "Post body" }).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Still saving.");
    await saved(page).toBeVisible({ timeout: 15_000 });
    expect((await getDraft(id)).bodyMd).toContain("Still saving.");

    await page.getByRole("button", { name: "Cancel publish" }).click();
    const cancel = page.getByRole("dialog", { name: "Close the pull request?" });
    await cancel.getByRole("button", { name: "Close the PR" }).click();
    await expect(cancel).toBeHidden({ timeout: 15_000 });
    await expect(
      page.getByRole("status").filter({ hasText: /^No open pull request\.$/ }),
    ).toBeVisible();
    // The Cancel publish button went with the PR, so focus moves to Check now.
    await expect(page.getByRole("button", { name: "Check now" })).toBeFocused();
    const after = await githubStub.state();
    expect(after.pulls[0]).toMatchObject({ number: pr, state: "closed", merged: false });
    expect(after.refs[pull.headRef]).toBeUndefined();
    expect(after.violations).toEqual([]);
    expect((await publishState(id)).stage).toBe("draft");
  } finally {
    await discardDraft(id);
  }
});

test("a PR closed on GitHub puts the draft back to Draft", async ({ page }) => {
  const id = await createDraft({
    title: `E2E closed ${Date.now()}`,
    summary: "A post whose PR the owner closes on GitHub.",
    bodyMd: "Closed without merging.\n",
  });
  try {
    const pr = (await publishDraft(id)).pr!;
    const branch = (await githubStub.state()).pulls[0]!.headRef;
    await page.goto(`/admin/drafts/${id}`);
    await expectStep(page, `PR #${pr} opened`);

    await githubStub.close(pr);
    const closed = page.getByRole("status").filter({
      hasText: "The PR was closed without merging. This draft is a draft again.",
    });
    await expect(async () => {
      await page.getByRole("button", { name: "Check now" }).click();
      await expect(closed).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    expect((await publishState(id)).stage).toBe("draft");
    // Status deleted the branch, so the closed PR can't be reopened and merged.
    await expect.poll(async () => (await githubStub.state()).refs[branch]).toBeUndefined();
    expect((await ownerFetch("DELETE", `/api/admin/drafts/${id}`)).status).toBe(204);
  } finally {
    await discardDraft(id);
  }
});

test("a post changed on GitHub since its import offers the GitHub version", async ({ page }) => {
  const path = "content/blog/2026-10-11-hello-world.md";
  const original = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const sentence = `Edited on GitHub at ${Date.now()}.`;
  const id = await importPost("hello-world");
  try {
    await githubStub.setMainFile(
      path,
      original.replace(
        "This is the first post on the site.",
        `This is the first post. ${sentence}`,
      ),
    );
    await page.goto(`/admin/drafts/${id}`);
    await publishFromEditor(page, "Publish changes");
    const banner = page
      .getByRole("alert")
      .filter({ hasText: "This post changed on GitHub since you loaded it." });
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Load the GitHub version" }).click();
    await expect(page.getByRole("textbox", { name: "Post body" })).toContainText(sentence);
    await expect(banner).toBeHidden();
    await page.getByRole("button", { name: "Revisions" }).click();
    const revisions = page.getByRole("dialog", { name: "Revisions" });
    await expect(revisions.getByText(/^Replaced · /)).toBeVisible();
    await revisions.getByRole("button", { name: "Close" }).click();

    const stub = await githubStub.state();
    expect(stub.pulls).toEqual([]);
    expect(stub.violations).toEqual([]);
  } finally {
    await discardDraft(id);
  }
});

test("the status API walks every stage, through a failed and a cancelled deploy", async () => {
  const stamp = Date.now();
  const id = await createDraft({
    title: `E2E walk ${stamp}`,
    summary: "A post whose status walks every stage.",
    bodyMd: "Every stage, through the API.\n",
  });
  const later = await createDraft({
    title: `E2E later ${stamp}`,
    summary: "A post merged after the first.",
    bodyMd: "Merged second.\n",
  });
  try {
    const opened = await publishDraft(id);
    expect(opened).toMatchObject({
      stage: "opened",
      action: "publish",
      republished: false,
      slug: `e2e-walk-${stamp}`,
    });
    const pr = opened.pr!;
    const stage = async () => (await publishState(id)).stage;
    expect(await stage()).toBe("opened");
    await githubStub.checks(pr, "queued");
    expect(await stage()).toBe("ci_running");
    await githubStub.checks(pr, "in_progress");
    expect(await stage()).toBe("ci_running");
    await githubStub.checks(pr, "completed", "success");
    expect(await stage()).toBe("review");

    const { mergeSha } = await githubStub.merge(pr);
    expect(await publishState(id)).toMatchObject({ stage: "merged", mergeSha });
    const queued = await githubStub.deploy(mergeSha, "queued");
    expect(await publishState(id)).toMatchObject({ stage: "deploying", runUrl: queued.runUrl });
    const failed = await githubStub.deploy(mergeSha, "completed", "failure");
    expect(await publishState(id)).toMatchObject({ stage: "deploy_failed", runUrl: failed.runUrl });
    expect((await getDraft(id)).status).toBe("failed");
    // A newer deploy cancelled this one: not a failure, a later deploy ships it.
    await githubStub.deploy(mergeSha, "completed", "cancelled");
    expect(await publishState(id)).toMatchObject({ stage: "deploying", runUrl: null });

    // The site goes on to serve a later commit on main, which contains the merge.
    const { mergeSha: laterSha } = await githubStub.merge((await publishDraft(later)).pr!);
    await githubStub.setVersion(laterSha);
    expect(await publishState(id)).toMatchObject({ stage: "live", mergeSha });
    expect((await getDraft(id)).status).toBe("published");
    const requests = await githubStub.requests();
    expect(
      requests.some((request) =>
        request.path.startsWith(`${REPO_PATH}/compare/${mergeSha}...${laterSha}`),
      ),
    ).toBe(true);
    expect((await githubStub.state()).violations).toEqual([]);
  } finally {
    await discardDraft(id);
    await discardDraft(later);
  }
});
