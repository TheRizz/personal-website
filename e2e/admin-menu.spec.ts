import { expect } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken } from "./access";
import { cspTest } from "./csp";
import { BASE_URL } from "./helpers";

// The header's admin menu: for the signed-in owner only, on every page, with a shortcut to each
// section's drafts. It shares the Edit link's owner probe (see edit-link.spec.ts).

const OWNER_HINT = { name: "owner_hint", value: "1", url: BASE_URL };

const ownerTest = cspTest({
  headers: async () => ({ [ASSERTION_HEADER]: await signAccessToken() }),
  consoleErrors: true,
});
const visitorTest = cspTest({ headers: () => ({}), consoleErrors: true });

ownerTest("the owner opens the admin menu and goes to the blog drafts", async ({ page }) => {
  await page.context().addCookies([OWNER_HINT]);
  const probes: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/admin/me")) probes.push(request.method());
  });
  await page.goto("/blog/hello-world", { waitUntil: "networkidle" });
  // One HEAD, shared with the post's Edit link.
  expect(probes).toEqual(["HEAD"]);

  const button = page.getByRole("button", { name: "Admin" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  const menu = page.getByRole("navigation", { name: "Admin" });
  await expect(menu.getByRole("link", { name: "Blog posts" })).toHaveAttribute("href", "/admin");
  await expect(menu.getByRole("link", { name: "Photos" })).toHaveAttribute("href", "/admin/photos");
  await expect(menu.getByText("Code snippets")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await button.click();
  await menu.getByRole("link", { name: "Blog posts" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Drafts" })).toBeVisible();
});

visitorTest("a visitor never sees the admin menu", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Admin" })).toHaveCount(0);
  await page.context().addCookies([OWNER_HINT]);
  await page.goto("/blog", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Admin" })).toHaveCount(0);
});

visitorTest("the prerendered home page has no admin markup", async ({ request }) => {
  const html = await (await request.get("/")).text();
  expect(html).not.toContain('aria-label="Admin"');
  expect(html).not.toContain("/admin/photos");
});
