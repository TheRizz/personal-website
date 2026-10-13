import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./drafts";
import type { PublishState, Stage } from "../publish/state";
import {
  cancelPublish,
  describePublishError,
  fileDates,
  getPublishState,
  importPost,
  isOpenStage,
  listPosts,
  metaOf,
  publishButton,
  publishDraft,
  stageText,
  unpublishPost,
  type DraftMeta,
} from "./publish";

const ID = "5b0f2c58-0d7e-4a39-9a51-6a1c1f6f4b11";
let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchFn = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchFn);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The path, method, headers and body of the one request made. */
function sent() {
  expect(fetchFn).toHaveBeenCalledOnce();
  const [path, init = {}] = fetchFn.mock.calls[0]!;
  return {
    path,
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: init.body,
  };
}

describe("publishing calls", () => {
  it.each([
    ["publishDraft", () => publishDraft(ID, { baseRev: 3, date: "2026-10-13" }), "publish"],
    ["cancelPublish", () => cancelPublish(ID), "cancel"],
  ])("%s POSTs to the draft's route", async (_name, run, action) => {
    await run();
    const { path, method, headers } = sent();
    expect(path).toBe(`/api/admin/drafts/${ID}/${action}`);
    expect(method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Admin")).toBe("1");
  });

  it("sends the publish body as JSON", async () => {
    await publishDraft(ID, { baseRev: 3, date: "2026-10-13", slug: "hello-world" });
    expect(sent().body).toBe('{"baseRev":3,"date":"2026-10-13","slug":"hello-world"}');
  });

  it("sends an empty JSON object on the POSTs that take no fields", async () => {
    for (const run of [
      () => cancelPublish(ID),
      () => importPost("hello"),
      () => unpublishPost("hello"),
    ]) {
      fetchFn.mockClear();
      await run();
      const { method, headers, body } = sent();
      expect(method).toBe("POST");
      expect(body).toBe("{}");
      expect(headers.get("Content-Type")).toBe("application/json");
    }
  });

  it("GETs the status and the posts list", async () => {
    await getPublishState(ID);
    expect(sent()).toMatchObject({ path: `/api/admin/drafts/${ID}/status`, method: "GET" });
    expect(sent().body).toBeUndefined();
    fetchFn.mockClear();
    await listPosts();
    expect(sent()).toMatchObject({ path: "/api/admin/posts", method: "GET" });
  });

  it("imports, refreshes and unpublishes by slug", async () => {
    await importPost("hello-world");
    expect(sent()).toMatchObject({ path: "/api/admin/posts/hello-world/import", body: "{}" });
    fetchFn.mockClear();
    await importPost("hello-world", { baseRev: 9 });
    expect(sent()).toMatchObject({
      path: "/api/admin/posts/hello-world/import",
      body: '{"refresh":true,"baseRev":9}',
    });
    fetchFn.mockClear();
    await unpublishPost("hello-world");
    expect(sent()).toMatchObject({ path: "/api/admin/posts/hello-world/unpublish", body: "{}" });
  });

  it("encodes the id and slug as one path segment", async () => {
    await getPublishState("a/b?c");
    expect(sent().path).toBe("/api/admin/drafts/a%2Fb%3Fc/status");
  });

  it("returns the answer's JSON", async () => {
    const answer = { id: ID, created: true };
    fetchFn.mockResolvedValueOnce(Response.json(answer, { status: 201 }));
    await expect(importPost("hello")).resolves.toEqual(answer);
  });

  it("throws ApiError with the error body's other fields as details", async () => {
    fetchFn.mockResolvedValueOnce(
      Response.json(
        { error: { code: "stale_draft", message: "Reload." }, rev: 12 },
        { status: 409 },
      ),
    );
    const error = await publishDraft(ID, { baseRev: 3, date: "2026-10-13" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "stale_draft", message: "Reload." });
    expect((error as ApiError).details).toEqual({ rev: 12 });
  });

  it("keeps array and null details as they were sent", async () => {
    fetchFn.mockResolvedValueOnce(
      Response.json(
        { error: { code: "invalid_post", message: "Invalid." }, errors: ["Add a title."] },
        { status: 422 },
      ),
    );
    const invalid = (await listPosts().catch((e) => e)) as ApiError;
    expect(invalid.details).toEqual({ errors: ["Add a title."] });
    fetchFn.mockResolvedValueOnce(
      Response.json({ error: { code: "changed_on_github" }, sha: null }, { status: 409 }),
    );
    const changed = (await listPosts().catch((e) => e)) as ApiError;
    expect(changed.details).toEqual({ sha: null });
  });

  it("gives a non-JSON refusal a generic code and empty details", async () => {
    fetchFn.mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }));
    const error = (await listPosts().catch((e) => e)) as ApiError;
    expect(error).toMatchObject({ status: 502, code: "error", details: {} });
  });
});

describe("fileDates", () => {
  const today = "2026-10-13";

  it("keeps a post's date on main and sets updated to today", () => {
    expect(
      fileDates(
        { kind: "edit", sourcePath: "content/blog/2026-10-11-hello.md", postDate: "2026-10-10" },
        today,
      ),
    ).toEqual({ date: "2026-10-10", updated: today });
    expect(
      fileDates(
        { kind: "edit", sourcePath: "content/blog/2026-10-11-hello.md", postDate: null },
        today,
      ),
    ).toEqual({ date: "2026-10-11", updated: today });
  });

  it("dates a new post by its file name once it has one, else today, with no updated", () => {
    expect(
      fileDates(
        { kind: "new", sourcePath: "content/blog/2026-10-12-hello.md", postDate: null },
        today,
      ),
    ).toEqual({ date: "2026-10-12" });
    expect(fileDates({ kind: "new", sourcePath: null, postDate: null }, today)).toEqual({
      date: today,
    });
  });
});

describe("describePublishError", () => {
  const refusal = (code: string, details: Record<string, unknown> = {}, status = 422) =>
    describePublishError(new ApiError(status, code, "Server message.", details));

  it("names where an address is taken", () => {
    expect(refusal("slug_taken", { where: "main" }).text).toBe(
      "That address is already used on the site. Choose another.",
    );
    expect(refusal("slug_taken", { where: "pull_request", pr: 4 }).text).toBe(
      "That address is already used by an open PR. Choose another.",
    );
    expect(refusal("slug_taken", { where: "draft" }).text).toBe(
      "That address is already used by another draft. Choose another.",
    );
  });

  it("lists every invalid_post line", () => {
    expect(refusal("invalid_post", { errors: ["Add a title.", "line 3: bad figure", 4] })).toEqual({
      text: "Fix these before publishing:",
      lines: ["Add a title.", "line 3: bad figure"],
    });
  });

  it("explains unsupported posts by problem", () => {
    expect(refusal("unsupported_post", { problem: "draft" }).text).toBe(
      "This file is marked draft on GitHub, so the editor can't publish it.",
    );
    expect(refusal("unsupported_post", { problem: "custom_slug" }).text).toBe(
      "This file sets its own slug, which the editor can't keep.",
    );
    expect(refusal("unsupported_post", { problem: "bad_path" }).text).toBe(
      "This file isn't one the editor can handle.",
    );
  });

  it("tells a missing file from a changed one", () => {
    expect(refusal("changed_on_github", { sha: null }, 409).text).toBe(
      "This post isn't on GitHub's main branch any more.",
    );
    expect(refusal("changed_on_github", { sha: "a".repeat(40) }, 409).text).toBe(
      "This post changed on GitHub since you loaded it.",
    );
  });

  it("links the draft that holds an address", () => {
    expect(refusal("slug_in_use", { draftId: ID }, 409)).toEqual({
      text: "Another draft uses this address.",
      draftId: ID,
    });
  });

  it("covers the GitHub and configuration failures", () => {
    expect(refusal("github_error", {}, 502).text).toBe(
      "GitHub didn't answer as expected. Try again in a minute.",
    );
    for (const code of ["github_unavailable", "misconfigured"]) {
      expect(refusal(code, {}, 503).text).toBe("Publishing isn't available right now.");
    }
    expect(refusal("owner_email").text).toBe(
      "This post contains your private e-mail address. Remove it and publish again.",
    );
  });

  it("falls back to the server's message, and to a connection hint for network errors", () => {
    expect(refusal("bad_request", {}, 400).text).toBe("Server message.");
    expect(describePublishError(new TypeError("Failed to fetch")).text).toMatch(/connection/);
  });
});

describe("publishButton", () => {
  const meta = (patch: Partial<DraftMeta> = {}): DraftMeta => ({
    kind: "new",
    slug: null,
    status: "draft",
    sourcePath: null,
    postDate: null,
    prAction: null,
    ...patch,
  });
  const at = (stage: Stage, action: PublishState["action"] = "publish"): PublishState => ({
    stage,
    action,
    pr: 7,
    prUrl: "https://github.com/TheRizz/personal-website/pull/7",
    branch: "blog/hello-1700000000",
    runUrl: null,
    mergeSha: null,
    slug: "hello",
    mergedOtherVersion: false,
  });

  it("says Publish for a new post and Publish changes for one on main", () => {
    expect(publishButton(meta(), null)).toEqual({ label: "Publish", blockedBy: null });
    expect(publishButton(meta({ kind: "edit" }), null).label).toBe("Publish changes");
    expect(publishButton(meta(), at("draft")).label).toBe("Publish");
    expect(publishButton(meta(), at("closed")).label).toBe("Publish");
  });

  it.each(["opened", "ci_running", "ci_failed", "review"] as const)(
    "says Republish while a publish PR is %s",
    (stage) => {
      expect(publishButton(meta(), at(stage))).toEqual({ label: "Republish", blockedBy: null });
    },
  );

  it.each(["merged", "deploying", "deploy_failed", "live"] as const)(
    "opens a new PR once a publish PR is %s",
    (stage) => {
      expect(publishButton(meta({ status: "publishing", prAction: "publish" }), at(stage))).toEqual(
        { label: "Publish changes", blockedBy: null },
      );
    },
  );

  it("is blocked while an unpublish PR is open, and a new post once it is merged", () => {
    const tracking = meta({ kind: "edit", status: "publishing", prAction: "unpublish" });
    expect(publishButton(tracking, at("review", "unpublish"))).toEqual({
      label: "Publish changes",
      blockedBy: "An unpublish PR is open.",
    });
    expect(publishButton(tracking, at("deploying", "unpublish"))).toEqual({
      label: "Publish",
      blockedBy: null,
    });
  });

  it("goes by the draft's fields until the status arrives", () => {
    expect(publishButton(meta({ status: "publishing", prAction: "publish" }), null).label).toBe(
      "Republish",
    );
    expect(
      publishButton(meta({ kind: "edit", status: "publishing", prAction: "unpublish" }), null)
        .blockedBy,
    ).toBe("An unpublish PR is open.");
    expect(publishButton(meta({ kind: "edit", status: "failed" }), null).label).toBe(
      "Publish changes",
    );
  });

  it("knows which stages have an open PR", () => {
    const stages: Stage[] = ["draft", "opened", "ci_running", "ci_failed", "review", "merged"];
    expect(stages.filter(isOpenStage)).toEqual(["opened", "ci_running", "ci_failed", "review"]);
  });
});

describe("stageText", () => {
  const at = (stage: Stage, action: PublishState["action"] = "publish") =>
    stageText({
      stage,
      action,
      pr: null,
      prUrl: null,
      branch: null,
      runUrl: null,
      mergeSha: null,
      slug: null,
      mergedOtherVersion: false,
    });

  it("uses the contract's words for the draft, closed and deploy_failed stages", () => {
    expect(at("draft", null)).toBe("No open pull request.");
    expect(at("closed")).toBe("The PR was closed without merging. This draft is a draft again.");
    expect(at("deploy_failed")).toBe(
      "The deploy failed. Re-run it from the run page if it is the newest deploy; if a later " +
        "deploy has run, press Check now.",
    );
  });

  it("never repeats a timeline step label", () => {
    const labels = ["opened", "ci running", "ci failed", "waiting for your review", "merged"];
    const stages: Stage[] = ["opened", "ci_running", "ci_failed", "review", "merged", "deploying"];
    for (const stage of stages) {
      for (const action of ["publish", "unpublish"] as const) {
        const text = at(stage, action).toLowerCase();
        for (const label of [...labels, "deploying", "live"]) expect(text).not.toContain(label);
      }
    }
  });

  it("tells a published post from a removed one", () => {
    expect(at("live")).toBe("The post is on the site.");
    expect(at("live", "unpublish")).toMatch(/off the site/);
  });
});

describe("metaOf", () => {
  it("keeps only the publishing fields", () => {
    const draft = {
      kind: "edit" as const,
      slug: "hello",
      status: "published",
      sourcePath: "content/blog/2026-10-11-hello.md",
      postDate: "2026-10-11",
      prAction: "publish" as const,
      title: "Hello",
      bodyMd: "Secret words",
    };
    expect(metaOf(draft)).toEqual({
      kind: "edit",
      slug: "hello",
      status: "published",
      sourcePath: "content/blog/2026-10-11-hello.md",
      postDate: "2026-10-11",
      prAction: "publish",
    });
  });
});
