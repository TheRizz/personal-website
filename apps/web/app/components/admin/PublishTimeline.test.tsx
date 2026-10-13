import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublishState, Stage } from "~/lib/admin/publish";
import { PublishTimeline, hasTimeline } from "./PublishTimeline";

const RUN = "https://github.com/TheRizz/personal-website/actions/runs/42";

const at = (stage: Stage, patch: Partial<PublishState> = {}): PublishState => ({
  stage,
  action: "publish",
  pr: 7,
  prUrl: "https://github.com/TheRizz/personal-website/pull/7",
  branch: "blog/hello-1700000000",
  runUrl: null,
  mergeSha: null,
  slug: "hello",
  mergedOtherVersion: false,
  ...patch,
});

/** Each step's text (tags stripped) and whether it is the current one. */
function steps(state: PublishState) {
  const html = renderToStaticMarkup(<PublishTimeline state={state} />);
  return [...html.matchAll(/<li([^>]*)>(.*?)<\/li>/g)].map(([, attributes, inner]) => ({
    current: attributes!.includes('aria-current="step"'),
    text: inner!.replace(/<[^>]+>/g, ""),
    html: inner!,
  }));
}

describe("PublishTimeline", () => {
  it("is an ordered list named Publish progress with six steps", () => {
    const html = renderToStaticMarkup(<PublishTimeline state={at("opened")} />);
    expect(html).toMatch(/^<ol aria-label="Publish progress"/);
    expect(steps(at("opened")).map((step) => step.text)).toEqual([
      "PR #7 opened",
      "CI running (about 2 min)",
      "Waiting for your review",
      "Merged",
      "Deploying (about 1 min)",
      "Live",
    ]);
  });

  it.each([
    ["opened", 0],
    ["ci_running", 1],
    ["ci_failed", 1],
    ["review", 2],
    ["merged", 3],
    ["deploying", 4],
    ["deploy_failed", 4],
    ["live", 5],
  ] as const)("marks the current step at %s and the ones before it done", (stage, current) => {
    const list = steps(at(stage));
    expect(list.findIndex((step) => step.current)).toBe(current);
    expect(list.filter((step) => step.current)).toHaveLength(1);
    list.forEach((step, i) => expect(step.text.includes("(done)")).toBe(i < current));
  });

  it("links the PR from the first step on", () => {
    for (const stage of ["opened", "review", "live"] as const) {
      expect(steps(at(stage))[0]!.html).toContain(
        '<a href="https://github.com/TheRizz/personal-website/pull/7" class="link font-semibold">PR #7</a>',
      );
    }
  });

  it("names a CI failure and links its run", () => {
    const ci = steps(at("ci_failed", { runUrl: RUN }))[1]!;
    expect(ci.text).toBe("CI failed View the run");
    expect(ci.html).toContain(`href="${RUN}"`);
  });

  it("links the deploy run while deploying, and names a failed deploy", () => {
    expect(steps(at("deploying", { runUrl: RUN }))[4]!.text).toBe(
      "Deploying (about 1 min) View the run",
    );
    expect(steps(at("deploying"))[4]!.text).toBe("Deploying (about 1 min)");
    const failed = steps(at("deploy_failed", { runUrl: RUN }))[4]!;
    expect(failed.text).toBe("Deploy failed View the run");
  });

  it("links the live post, or says an unpublished one is gone", () => {
    const live = steps(at("live"))[5]!;
    expect(live.text).toBe("Live View the post");
    expect(live.html).toContain('href="/blog/hello"');
    expect(steps(at("live", { action: "unpublish" }))[5]!.text).toBe("Live Removed from the site");
  });

  it("shows nothing for a draft without a pull request", () => {
    for (const stage of ["draft", "closed"] as const) {
      expect(hasTimeline(stage)).toBe(false);
      expect(renderToStaticMarkup(<PublishTimeline state={at(stage)} />)).toBe("");
    }
  });
});
