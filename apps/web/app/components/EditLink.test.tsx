import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditLink, probeOwner } from "./EditLink";

let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EditLink", () => {
  it("renders nothing on the server, so prerendered posts have no admin markup", () => {
    vi.stubGlobal("document", { cookie: "owner_hint=1" });
    expect(renderToStaticMarkup(<EditLink slug="hello-world" />)).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("probeOwner", () => {
  it("makes no request without the owner hint", async () => {
    for (const cookie of ["", "theme=dark", "owner_hint=0", "theme=owner_hint=1"]) {
      expect(await probeOwner(cookie)).toBe(false);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends one HEAD to /api/admin/me that doesn't follow redirects", async () => {
    expect(await probeOwner("theme=dark; owner_hint=1")).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("/api/admin/me");
    expect(init).toMatchObject({
      method: "HEAD",
      redirect: "manual",
      credentials: "same-origin",
      cache: "no-store",
    });
    const headers = new Headers(init!.headers);
    expect([...headers]).toEqual([["x-requested-with", "XMLHttpRequest"]]);
  });

  it("says yes only for a 200", async () => {
    // What a redirect to the Access login looks like with `redirect: "manual"`.
    const opaqueRedirect = { status: 0, type: "opaqueredirect" } as Response;
    const answers = [
      new Response(null, { status: 204 }),
      new Response(null, { status: 401 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 503 }),
      Response.error(),
      opaqueRedirect,
    ];
    for (const answer of answers) {
      fetchFn.mockResolvedValueOnce(answer);
      expect(await probeOwner("owner_hint=1"), `${answer.status}`).toBe(false);
    }
  });

  it("swallows a network error or an abort without logging", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchFn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await probeOwner("owner_hint=1")).toBe(false);

    const controller = new AbortController();
    controller.abort();
    fetchFn.mockImplementationOnce(async (_url, init) => {
      init?.signal?.throwIfAborted();
      return new Response(null, { status: 200 });
    });
    expect(await probeOwner("owner_hint=1", controller.signal)).toBe(false);
    expect(fetchFn.mock.calls[1]![1]!.signal).toBe(controller.signal);
    expect(logged).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  });
});
