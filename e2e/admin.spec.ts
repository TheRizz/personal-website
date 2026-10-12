import { expect, test, type APIResponse } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken, testIdentity } from "./access";

// The owner gate (design doc §4.9.1), with the localhost-only test identity standing in for
// Cloudflare Access.

function expectAdminHeaders(response: APIResponse) {
  const headers = response.headers();
  expect(headers["cache-control"]).toBe("no-store, private");
  expect(headers["x-robots-tag"]).toBe("noindex");
  expect(headers["x-frame-options"]).toBe("DENY");
}

test("GET /api/admin/me is 404 without a token", async ({ request }) => {
  const response = await request.get("/api/admin/me");
  expect(response.status()).toBe(404);
  expectAdminHeaders(response);
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("GET /api/admin/me returns the owner's e-mail with a token", async ({ request }) => {
  const response = await request.get("/api/admin/me", {
    headers: { [ASSERTION_HEADER]: await signAccessToken() },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ email: testIdentity().email });
  expectAdminHeaders(response);
  expect(response.headers()["set-cookie"]).toMatch(/^owner_hint=1; Path=\/;/);
});

test("the Access cookie alone is not accepted", async ({ request }) => {
  const response = await request.get("/api/admin/me", {
    headers: { Cookie: `CF_Authorization=${await signAccessToken()}` },
  });
  expect(response.status()).toBe(404);
});

test("other spellings of admin paths are 404 even with a token", async ({ request }) => {
  const headers = { [ASSERTION_HEADER]: await signAccessToken() };
  for (const path of [
    "/API/ADMIN/me",
    "/%61pi/admin/me",
    "/api/ADMIN/me",
    "/ADMIN/",
    "/admin.data",
  ]) {
    const response = await request.get(path, { headers });
    expect(response.status(), path).toBe(404);
    expectAdminHeaders(response);
    expect(await response.text(), path).not.toContain(testIdentity().email);
  }
});

test("a cross-site write is 404 even with a token", async ({ request, baseURL }) => {
  // No bodies: locally, a POST whose body the Worker never reads can break the next request on
  // the same Miniflare connection ("fetch failed", a 500). Production is unaffected.
  const headers = {
    [ASSERTION_HEADER]: await signAccessToken(),
    "Content-Type": "application/json",
    "X-Admin": "1",
  };
  const crossSite = await request.post("/api/admin/me", {
    headers: { ...headers, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  });
  expect(crossSite.status()).toBe(404);
  // The same write from the site itself passes the gate and reaches the route (GET only).
  const sameOrigin = await request.post("/api/admin/me", {
    headers: { ...headers, Origin: baseURL!, "Sec-Fetch-Site": "same-origin" },
  });
  expect(sameOrigin.status()).toBe(405);
});

test("robots.txt keeps crawlers out of /admin", async ({ request }) => {
  expect(await (await request.get("/robots.txt")).text()).toContain("Disallow: /admin\n");
});
