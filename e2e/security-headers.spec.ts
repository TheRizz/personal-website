import { createHash } from "node:crypto";
import { test as base, expect, type APIResponse, type Page } from "@playwright/test";
import { createLobby, uniqueIp } from "./helpers";

// The site-wide CSP and security headers (design doc §4.8). Prerendered pages get theirs from the
// generated `_headers` file (script hashes); pages the Worker renders get a per-request nonce.

declare global {
  interface Window {
    cspViolations?: string[];
  }
}

const TOP_LEVEL_ROUTES = ["/", "/blog", "/resume", "/snippets", "/photos", "/search", "/games"];

/**
 * A page that records every CSP violation (console message or `securitypolicyviolation` event)
 * and every uncaught error; the test fails if there are any.
 */
const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { "CF-Connecting-IP": uniqueIp() },
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (message) => {
      if (/Content.Security.Policy/i.test(message.text())) problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        (window.cspViolations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await use(page);
    problems.push(...(await page.evaluate(() => window.cspViolations ?? [])));
    await context.close();
    expect(problems).toEqual([]);
  },
});

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** The single CSP header's script-src sources (two CSP headers would both be enforced). */
async function scriptSources(response: APIResponse | null): Promise<string[]> {
  expect(response).not.toBeNull();
  const headers = await response!.headersArray();
  const policies = headers.filter(({ name }) => name.toLowerCase() === "content-security-policy");
  expect(policies).toHaveLength(1);
  const policy = policies[0]!.value;
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("img-src 'self' https://photos.ry-mart.com data:");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response!.headers()[name], name).toBe(value);
  }
  const scriptSrc = policy.split(";").find((d) => d.trim().startsWith("script-src"));
  return scriptSrc!.trim().split(/\s+/).slice(1);
}

/** The text of every inline (non-src) script in an HTML document. */
function inlineScripts(html: string): { attributes: string; text: string }[] {
  return [...html.matchAll(/<script\b(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi)].map(
    ([, attributes = "", text = ""]) => ({ attributes, text }),
  );
}

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

test("every top-level route and a blog post load with no CSP violations", async ({ page }) => {
  for (const path of TOP_LEVEL_ROUTES) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
  }
  await page.goto("/blog");
  const post = await page.locator('main a[href^="/blog/"]').first().getAttribute("href");
  expect(post).toBeTruthy();
  await page.goto(post!);
  await expect(page.locator("main article, main h1").first()).toBeVisible();
  // A client-side navigation and a Worker-rendered 404.
  await page.getByRole("link", { name: "Games" }).first().click();
  await expect(page).toHaveURL(/\/games$/);
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("a game created from the prerendered lobby page connects its WebSocket", async ({ page }) => {
  await page.goto("/games/tictactoe");
  await page.getByLabel("Your name").fill("Csp");
  await page.getByRole("button", { name: "Create game" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});

test("a live game rendered by the Worker connects its WebSocket", async ({ page, request }) => {
  const { code } = await createLobby(request);
  await page.goto(`/games/tictactoe/${code}`);
  await page.getByLabel("Your name").fill("Csp");
  await page.getByRole("button", { name: "Join game" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});

test("a prerendered page allows exactly its own inline scripts by hash", async ({ page }) => {
  await page.goto("/blog");
  const post = await page.locator('main a[href^="/blog/"]').first().getAttribute("href");
  for (const path of ["/", post!]) {
    const response = await page.request.get(path);
    const sources = await scriptSources(response);
    const scripts = inlineScripts(await response.text());
    expect(scripts.length).toBeGreaterThan(0);
    for (const { text } of scripts) expect(sources).toContain(sha256(text));
    expect(sources.some((s) => s.startsWith("'nonce-"))).toBe(false);
    expect(sources).not.toContain("'unsafe-inline'");
    // Served as a static asset, not rendered by the Worker.
    expect(response.headers()["cf-cache-status"]).toBeDefined();
  }
});

test("a Worker-rendered page allows only its own nonce", async ({ request }) => {
  const { code } = await createLobby(request);
  const first = await request.get(`/games/tictactoe/${code}`);
  const sources = await scriptSources(first);
  const nonces = sources.filter((s) => s.startsWith("'nonce-"));
  expect(nonces).toHaveLength(1);
  const nonce = nonces[0]!.slice("'nonce-".length, -1);
  expect(sources).not.toContain("'unsafe-inline'");
  for (const { attributes, text } of inlineScripts(await first.text())) {
    // Every inline script carries the nonce, except the theme script, which is allowed by hash.
    if (!attributes.includes(`nonce="${nonce}"`)) expect(sources).toContain(sha256(text));
  }
  // A fresh nonce for every response.
  const second = await request.get(`/games/tictactoe/${code}`);
  expect((await scriptSources(second)).filter((s) => s.startsWith("'nonce-"))).not.toEqual(nonces);
});

test("API responses carry the security headers too", async ({ request }) => {
  const response = await request.get("/api/health");
  await scriptSources(response);
});
