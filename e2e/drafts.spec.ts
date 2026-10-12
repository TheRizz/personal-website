import { expect, test } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken } from "./access";

// The drafts API on local D1 (design doc §4.9.5, Step 10.4), through the real owner gate.

/** The headers the admin fetch wrapper and the browser add to a same-origin write. */
async function ownerHeaders(baseURL: string | undefined) {
  return {
    [ASSERTION_HEADER]: await signAccessToken(),
    Origin: new URL(baseURL!).origin,
    "Sec-Fetch-Site": "same-origin",
    "X-Admin": "1",
    "X-Requested-With": "XMLHttpRequest",
  };
}

test("the owner creates, saves and reloads a draft", async ({ request, baseURL }) => {
  const headers = await ownerHeaders(baseURL);
  const created = await request.post("/api/admin/drafts", {
    headers,
    data: { title: "E2E draft" },
  });
  expect(created.status()).toBe(201);
  const { id, rev } = (await created.json()) as { id: string; rev: number };
  expect(rev).toBe(1);

  try {
    const bodyMd = "## Heading\n\nSome **bold** and *italic* text.\n";
    const saved = await request.put(`/api/admin/drafts/${id}`, {
      headers,
      data: { baseRev: 1, title: "E2E draft, saved", tags: ["E2E Tests"], bodyMd },
    });
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toEqual({ rev: 2 });

    const stale = await request.put(`/api/admin/drafts/${id}`, {
      headers,
      data: { baseRev: 1, bodyMd: "from a stale tab" },
    });
    expect(stale.status()).toBe(409);

    const loaded = await request.get(`/api/admin/drafts/${id}`, { headers });
    expect(loaded.status()).toBe(200);
    expect(loaded.headers()["cache-control"]).toBe("no-store, private");
    expect(await loaded.json()).toMatchObject({
      id,
      title: "E2E draft, saved",
      tags: ["e2e-tests"],
      bodyMd,
      rev: 2,
    });

    const list = await request.get("/api/admin/drafts", { headers });
    const { drafts } = (await list.json()) as { drafts: { id: string }[] };
    expect(drafts.map((draft) => draft.id)).toContain(id);
  } finally {
    const discarded = await request.delete(`/api/admin/drafts/${id}`, { headers });
    expect(discarded.status()).toBe(204);
  }
});

test("the drafts API is 404 without a token", async ({ request }) => {
  const response = await request.get("/api/admin/drafts");
  expect(response.status()).toBe(404);
});
