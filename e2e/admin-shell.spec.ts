import { existsSync, readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken, testIdentity } from "./access";
import { cspTest, inlineScripts, sha256 } from "./csp";

// The admin shell (design doc §4.9.2, Step 10.3), signed in with the localhost-only test identity
// standing in for Cloudflare Access.

/** A page signed in as the owner: every request carries the test token, as Access would add it. */
const test = cspTest({
  headers: async () => ({ [ASSERTION_HEADER]: await signAccessToken() }),
  consoleErrors: true,
});

test("without a token /admin is a bare plain-text 404", async ({ request }) => {
  for (const path of ["/admin", "/admin/", "/admin/drafts/example"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(response.headers()["content-type"], path).toMatch(/^text\/plain/);
    expect(await response.text(), path).toBe("Not found");
    expect(response.headers()["set-cookie"], path).toBeUndefined();
  }
});

test("the owner signs in and sees the empty draft list", async ({ page }) => {
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Drafts · Admin · ry-mart");
  await expect(page.getByRole("heading", { level: 1, name: "Drafts" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "No drafts yet" })).toBeVisible();
  await expect(page.getByText(`Signed in as ${testIdentity().email}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign out" })).toHaveAttribute(
    "href",
    "/cdn-cgi/access/logout",
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  // GET /api/admin/me (through the wrapper) set the hint for public pages.
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === "owner_hint")?.value).toBe("1");
});

test("the admin page has one strict CSP with a fresh nonce", async ({ page }) => {
  const response = await page.goto("/admin");
  const headers = await response!.headersArray();
  const policies = headers.filter(({ name }) => name.toLowerCase() === "content-security-policy");
  expect(policies).toHaveLength(1);
  const policy = policies[0]!.value;
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("connect-src 'self';");
  expect(policy).toContain("img-src 'self' https://photos.ry-mart.com blob: data:");
  expect(policy).toContain("frame-ancestors 'none'");
  const all = response!.headers();
  expect(all["x-robots-tag"]).toBe("noindex");
  expect(all["x-frame-options"]).toBe("DENY");
  expect(all["cache-control"]).toBe("no-store, private");

  const sources = policy
    .split(";")
    .find((directive) => directive.trim().startsWith("script-src"))!
    .trim()
    .split(/\s+/);
  const nonces = sources.filter((source) => source.startsWith("'nonce-"));
  expect(nonces).toHaveLength(1);
  expect(sources).not.toContain("'unsafe-inline'");
  const nonce = nonces[0]!.slice("'nonce-".length, -1);
  // Every inline script carries the nonce, except the theme script, which is allowed by hash.
  const html = await response!.text();
  const scripts = inlineScripts(html);
  expect(scripts.length).toBeGreaterThan(0);
  for (const { attributes, text } of scripts) {
    if (!attributes.includes(`nonce="${nonce}"`)) expect(sources).toContain(sha256(text));
  }
  const again = await page.request.get("/admin");
  expect(again.headers()["content-security-policy"]).not.toContain(`'nonce-${nonce}'`);
});

test("a write with the wrapper's headers passes the gate; without them, 404", async ({ page }) => {
  // The shell's own request goes through the wrapper (app/lib/admin/api.ts), which Vitest also
  // runs against the real gate (worker/admin.test.ts). Here the browser adds Origin and
  // Sec-Fetch-Site itself.
  const shellRequest = page.waitForRequest("**/api/admin/me");
  await page.goto("/admin");
  const sent = await (await shellRequest).allHeaders();
  const wrapperHeaders = {
    "X-Requested-With": sent["x-requested-with"]!,
    "X-Admin": sent["x-admin"]!,
  };
  expect(wrapperHeaders).toEqual({ "X-Requested-With": "XMLHttpRequest", "X-Admin": "1" });

  const [wrapped, plain] = await page.evaluate(async (extra) => {
    // No body: the route never reads it, and locally an unread body can break the next request.
    const write = (headers: Record<string, string>) =>
      fetch("/api/admin/me", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
      }).then(async (response) => ({ status: response.status, body: await response.json() }));
    return [await write(extra), await write({})];
  }, wrapperHeaders);
  // Past the gate, /api/admin/me itself answers: it only allows GET.
  expect(wrapped).toEqual({
    status: 405,
    body: { error: { code: "method_not_allowed", message: "Use GET." } },
  });
  // The gate refuses a write without X-Admin, as it refuses everything: a plain 404.
  expect(plain).toEqual({
    status: 404,
    body: { error: { code: "not_found", message: "No such API route." } },
  });
});

test("an expired session shows a sign-in prompt", async ({ page }) => {
  // What Access answers for an expired session when the request carries X-Requested-With.
  await page.route("**/api/admin/me", async (route) => {
    expect(route.request().headers()["x-requested-with"]).toBe("XMLHttpRequest");
    await route.fulfill({ status: 401, body: "" });
  });
  await page.goto("/admin");
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("Session expired, sign in again.");
  await expect(alert.getByRole("link", { name: "sign in again" })).toHaveAttribute(
    "href",
    "/admin",
  );
});

test("Sign out clears the owner hint and goes to the Access logout", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByText(/^Signed in as /)).toBeVisible();
  expect((await page.context().cookies()).map((cookie) => cookie.name)).toContain("owner_hint");
  // Locally there is no Access, so the logout path is just a missing page.
  await page.route("**/cdn-cgi/access/logout", (route) => route.fulfill({ body: "Signed out" }));
  await page.getByRole("link", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
  expect((await page.context().cookies()).map((cookie) => cookie.name)).not.toContain("owner_hint");
});

test("Sign out is reachable with the keyboard", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByText(/^Signed in as /)).toBeVisible();
  const signOut = page.getByRole("link", { name: "Sign out" });
  for (let presses = 0; presses < 20; presses++) {
    await page.keyboard.press("Tab");
    if (await signOut.evaluate((link) => link === document.activeElement)) break;
  }
  await expect(signOut).toBeFocused();
});

test("admin is never prerendered and public pages carry no admin markup", async ({ request }) => {
  const client = new URL("../apps/web/build/client/", import.meta.url);
  expect(existsSync(new URL("admin.html", client))).toBe(false);
  expect(existsSync(new URL("admin/", client))).toBe(false);
  expect(readFileSync(new URL("_headers", client), "utf8")).not.toMatch(/^\/admin/m);
  const posts = JSON.parse(
    readFileSync(new URL("../apps/web/app/generated/posts.json", import.meta.url), "utf8"),
  ) as { slug: string }[];
  for (const path of ["/", "/blog", `/blog/${posts[0]!.slug}`]) {
    const html = await (await request.get(path)).text();
    expect(html, path).not.toMatch(/Sign out|cdn-cgi\/access|owner_hint|\/api\/admin/);
  }
});
