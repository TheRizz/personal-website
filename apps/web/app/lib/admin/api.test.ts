import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session-expired flag lives in the module, so each test gets a fresh copy.
let api: typeof import("./api");
let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  vi.resetModules();
  api = await import("./api");
  fetchFn = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The headers and options of the one request `adminFetch` made. */
function sent(): { headers: Headers; init: RequestInit } {
  expect(fetchFn).toHaveBeenCalledOnce();
  const init = fetchFn.mock.calls[0]![1]!;
  return { headers: new Headers(init.headers), init };
}

describe("adminFetch", () => {
  it("adds the headers the owner gate needs and never follows a redirect", async () => {
    await api.adminFetch("/api/admin/me");
    const { headers, init } = sent();
    expect(fetchFn.mock.calls[0]![0]).toBe("/api/admin/me");
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(headers.get("X-Admin")).toBe("1");
    expect(headers.has("Content-Type")).toBe(false);
    expect(init.redirect).toBe("manual");
  });

  it("sends a string body as JSON and keeps the caller's own headers", async () => {
    await api.adminFetch("/api/admin/drafts", {
      method: "POST",
      headers: { Accept: "application/json", "X-Admin": "0" },
      body: JSON.stringify({ title: "Hello" }),
    });
    const { headers, init } = sent();
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"title":"Hello"}');
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-Admin")).toBe("1");
  });

  it("leaves an explicit Content-Type alone", async () => {
    await api.adminFetch("/api/admin/images/abc/800", {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
    });
    expect(sent().headers.get("Content-Type")).toBe("image/webp");
  });

  it("refuses paths outside /api/admin/", async () => {
    for (const path of ["/api/lobbies", "/api/administrator", "https://evil.example/api/admin/"]) {
      await expect(api.adminFetch(path)).rejects.toThrow("/api/admin/");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("marks the session expired on a 401 and tells subscribers", async () => {
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(api.isSessionExpired()).toBe(false);
    const response = await api.adminFetch("/api/admin/me");
    expect(response.status).toBe(401);
    expect(api.isSessionExpired()).toBe(true);
  });

  it("marks the session expired when Access redirects to its login page", async () => {
    const redirect = new Response(null, { status: 200 });
    Object.defineProperty(redirect, "type", { value: "opaqueredirect" });
    fetchFn.mockResolvedValueOnce(redirect);
    await api.adminFetch("/api/admin/me");
    expect(api.isSessionExpired()).toBe(true);
  });

  it("keeps the session for any other status", async () => {
    for (const status of [200, 404, 409, 500]) {
      fetchFn.mockResolvedValueOnce(new Response(null, { status }));
      await api.adminFetch("/api/admin/me");
    }
    expect(api.isSessionExpired()).toBe(false);
  });
});
