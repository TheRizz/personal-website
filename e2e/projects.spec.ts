import { expect, type Page } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken } from "./access";
import { cspTest } from "./csp";

// Current projects: the owner adds projects at /admin/projects, and the home page shows the
// priorities first, the rest below, and the backlog folded away. Signed in with the localhost-only
// test identity.

const test = cspTest({
  headers: async () => ({ [ASSERTION_HEADER]: await signAccessToken() }),
  consoleErrors: true,
});

async function addProject(
  page: Page,
  fields: { title: string; place: string; progress?: string; note?: string; summary?: string },
) {
  await page.getByRole("button", { name: "Add project" }).click();
  const form = page.getByRole("region", { name: "New project" });
  await form.getByLabel("Title").fill(fields.title);
  await form.getByLabel("Where it shows").selectOption({ label: fields.place });
  if (fields.progress) await form.getByLabel("Progress %").fill(fields.progress);
  if (fields.note) await form.getByLabel("Status (optional)").fill(fields.note);
  if (fields.summary) await form.getByLabel("Description (optional)").fill(fields.summary);
  await form.getByRole("button", { name: "Add to home page" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole("list", { name: "Your projects" })).toContainText(fields.title);
}

test("the owner lists projects and the home page shows them by priority", async ({ page }) => {
  const run = Date.now();
  const lead = `Lead project ${run}`;
  const side = `Side project ${run}`;
  const idea = `Someday idea ${run}`;

  await page.goto("/admin");
  await page.getByRole("link", { name: "Manage projects" }).click();
  await expect(page).toHaveURL(/\/admin\/projects$/);
  await addProject(page, {
    title: lead,
    place: "Priority 1",
    progress: "40",
    note: "Waiting on playtest",
    summary: "The main thing.",
  });
  await addProject(page, { title: side, place: "In progress, no priority", progress: "10" });
  await addProject(page, { title: idea, place: "Backlog (folded away)", summary: "Maybe." });

  await page.goto("/");
  const section = page.getByRole("region", { name: "What I'm working on" });
  const card = section.getByRole("article", { name: lead });
  await expect(card).toContainText("Priority 1");
  await expect(card).toContainText("Waiting on playtest");
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  await expect(section.getByRole("list", { name: "Other projects" })).toContainText(side);

  // The backlog is folded until tapped.
  await expect(section.getByText(idea)).toBeHidden();
  await section.getByText("Backlog").click();
  await expect(section.getByText(idea)).toBeVisible();

  // Moving the side project to priority 1 takes the slot from the lead.
  await page.goto("/admin/projects");
  /** A saved project's form, opened. */
  const open = async (title: string) => {
    await page.locator("summary").filter({ hasText: title }).click();
    return page.getByRole("region", { name: title });
  };
  const sideForm = await open(side);
  await sideForm.getByLabel("Where it shows").selectOption({ label: "Priority 1" });
  await sideForm.getByRole("button", { name: "Save" }).click();
  await expect(sideForm.getByRole("status")).toHaveText("Saved");
  await expect(page.locator("summary").filter({ hasText: lead })).toContainText("no priority");
  await expect((await open(lead)).getByLabel("Where it shows")).toHaveValue("active");

  // Clean up, so the home page is as other tests expect it.
  page.on("dialog", (dialog) => void dialog.accept());
  for (const title of [lead, side, idea]) {
    const form = page.getByRole("region", { name: title });
    if (!(await form.isVisible())) await open(title);
    await form.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("summary").filter({ hasText: title })).toHaveCount(0);
  }
  await page.goto("/");
  await expect(page.getByText(lead)).toHaveCount(0);
});
