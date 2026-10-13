import { describe, expect, it } from "vitest";
import { site } from "../../site";
import {
  SITE_ORIGIN,
  branchName,
  dateFromPath,
  isBranch,
  isBranchForSlug,
  isGitSha,
  isIsoDate,
  isPostPath,
  isSlug,
  postPath,
  postUrl,
  pullUrl,
  safeRunUrl,
  slugFromPath,
} from "./post-path";

describe("post paths", () => {
  it("checks slugs", () => {
    expect(isSlug("hello-world")).toBe(true);
    expect(isSlug("a".repeat(80))).toBe(true);
    expect(isSlug("a".repeat(81))).toBe(false);
    for (const bad of ["", "Hello", "a--b", "-a", "a-", "a_b", "a b", 42, null]) {
      expect(isSlug(bad)).toBe(false);
    }
  });

  it("checks dates are real", () => {
    expect(isIsoDate("2026-10-11")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-01", "20261011", "", undefined]) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });

  it("builds and reads post paths", () => {
    const path = postPath("2026-10-11", "hello-world");
    expect(path).toBe("content/blog/2026-10-11-hello-world.md");
    expect(isPostPath(path)).toBe(true);
    expect(slugFromPath(path)).toBe("hello-world");
    expect(dateFromPath(path)).toBe("2026-10-11");
    expect(() => postPath("2026-02-30", "x")).toThrow();
    expect(() => postPath("2026-10-11", "Not a slug")).toThrow();
    expect(() => dateFromPath("content/blog/hello.md")).toThrow();
  });

  it.each([
    "content/blog/hello.md",
    "content/blog/2026-10-11-Hello.md",
    "content/blog/2026-10-11-a.mdx",
    "content/blog/sub/2026-10-11-a.md",
    "content/blog/../2026-10-11-a.md",
    "/content/blog/2026-10-11-a.md",
    "content/blog/2026-10-11-a.md\n",
  ])("refuses %j as a post path", (path) => {
    expect(isPostPath(path)).toBe(false);
  });

  it("names branches", () => {
    expect(branchName("a-b", 1760140800)).toBe("blog/a-b-1760140800");
    expect(isBranch("blog/a-b-1760140800")).toBe(true);
    expect(isBranch("blog/a-b")).toBe(false);
    expect(isBranch("main")).toBe(false);
    expect(() => branchName("A", 1)).toThrow();
    expect(() => branchName("a", 1.5)).toThrow();
    expect(isBranchForSlug("blog/a-123", "a")).toBe(true);
    expect(isBranchForSlug("blog/a-b-123", "a")).toBe(false);
    expect(isBranchForSlug("blog/a-b-123", "a-b")).toBe(true);
    expect(isBranchForSlug("blog/a-extra-1", "a")).toBe(false);
    expect(isBranchForSlug("blog/a-", "a")).toBe(false);
  });

  it("checks git SHAs", () => {
    expect(isGitSha("ce013625030ba8dba906f756967f9e9ca394464a")).toBe(true);
    expect(isGitSha("CE013625030BA8DBA906F756967F9E9CA394464A")).toBe(false);
    expect(isGitSha("ce01362")).toBe(false);
    expect(isGitSha(null)).toBe(false);
  });

  it("links to the post and the PR", () => {
    expect(SITE_ORIGIN).toBe(site.url);
    expect(postUrl("hello-world")).toBe("https://ry-mart.com/blog/hello-world");
    expect(pullUrl(12)).toBe("https://github.com/TheRizz/personal-website/pull/12");
  });
});

describe("safeRunUrl", () => {
  it("keeps this repository's pages on github.com", () => {
    const run = "https://github.com/TheRizz/personal-website/actions/runs/123/job/456";
    expect(safeRunUrl(run)).toBe(run);
    expect(safeRunUrl("https://github.com:443/TheRizz/personal-website/actions/runs/1")).toBe(
      "https://github.com/TheRizz/personal-website/actions/runs/1",
    );
  });

  it.each([
    "https://github.com.evil.com/TheRizz/personal-website/actions/runs/1",
    "https://user@github.com/TheRizz/personal-website/actions/runs/1",
    "https://user:pass@github.com/TheRizz/personal-website/actions/runs/1",
    "https://github.com/someone/else/actions/runs/1",
    "https://github.com/TheRizz/personal-website-fork/actions/runs/1",
    "https://github.com/TheRizz/personal-website/../../evil/x",
    "http://github.com/TheRizz/personal-website/actions/runs/1",
    "https://github.com:8443/TheRizz/personal-website/actions/runs/1",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("drops %j", (url) => {
    expect(safeRunUrl(url)).toBeNull();
  });

  it("drops anything that isn't a string", () => {
    expect(safeRunUrl(null)).toBeNull();
    expect(safeRunUrl({ href: "https://github.com/TheRizz/personal-website/" })).toBeNull();
  });
});
