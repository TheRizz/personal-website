# ADR-0005: In-browser authoring: private drafts in D1, published as Markdown through a pull request

**Status:** Accepted · **Date:** 2026-10-12 (amended the same day: the owner merges each publish PR by hand) · **Deciders:** Ryan Martinez

## Context

The owner wants to draft and publish blog posts from the browser, including a
phone, with header sizes, bold, italics and image sections that break up the
text. Only the owner may see this (ADR-0004). Today a post is a Markdown file
in `content/blog/` that the build prerenders (ADR-0002), and the only way to
publish is `git push`.

Constraints:
- **The repo is public.** Anything pushed to any branch is world-readable at once and stays in git history. Drafts can't live in git, not even on a branch or as `draft: true`.
- **Free tier.** The Worker gets 10 ms of CPU per request. Rendering Markdown with Shiki takes 158 ms to start and 27 ms for a first render, so the Worker can't render posts.
- **Prerendering stays.** Blog pages, RSS, the sitemap and the search index are built at deploy time for SEO and to cost nothing to serve.

## Options considered

### A. Git stays the source of truth. Drafts in D1, published by a GitHub App pull request
- Drafts, revisions and an image ledger live in a D1 database. Images go to the R2 `photos` bucket.
- **Publish** makes one commit with the Git Data API on a `blog/<slug>-<time>` branch and opens a PR that describes the post and its changes. CI validates the post, the owner reviews and merges the PR, and the existing `deploy.yml` ships it. About 3.5–4 minutes from click to live when the PR is merged as soon as CI passes (CI about 2m15s, deploy about 1 min, both measured).
- **Keeps** ADR-0002: git history, PR checks, prerendered SEO, rollback by revert.
- **Cons:** two stores (D1 and git) with a hand-off that can fail midway. A GitHub credential lives in the Worker. The post text is public on the PR from the click until about a minute after the merge. Every publish waits for the owner to merge it.

### B. D1 is the source of truth, and every publish triggers a snapshot deploy
- Posts live in D1. Publishing dispatches `deploy.yml`, which snapshots D1 into the build. A new post's URL works in seconds through a client-rendered fallback page. Everything else is static again in about 1–1.5 minutes. Slug renames get real redirects. Only an Actions-only token lives in the Worker.
- **Cons:** overturns ADR-0002 for posts. Content and code deploys become coupled, so a bad post blocks code deploys and `wrangler rollback` can bring back an unpublished post. PR CI can no longer build real posts. It needs a snapshot step, an import, a backup job and a D1 fallthrough on `/blog/*`. About 2–3 days more work, and the most to maintain.

### C. Decap CMS at `/admin` on our own Worker backend
- Decap's `proxy` backend lets the Worker store drafts in D1, so no draft or token reaches git or the browser. You get a ready-made post list, frontmatter form, review board and raw-Markdown tab.
- **Cons:** the image section is a form-based shortcode with a plain-text caption and can't be moved except by cut and paste. No server autosave, and two tabs are last-write-wins. The bundle is 1.37 MB gzipped and the UI is desktop-first. Its legacy serializer changed 3 of 30 test cases (literal `1. ` became a list, literal `<b>` was dropped). The proxy protocol is an internal contract, and Decap assumes publish is a synchronous merge. Total effort is close to option A, with less control.

### D. A stock git-backed CMS (Decap, Sveltia or TinaCMS with the GitHub backend)
- Every save goes to `cms/*` branches and PRs, or straight to `main`, in a public repo. `refs/pull/N/head` keeps a "deleted" draft fetchable forever, and the browser holds a token that can write to all of the owner's repos. Rejected.

### Editor (same for A and B)
- **TipTap 3 with our own Markdown bridge (chosen).** In tests, a remark-based bridge (about 150 lines) round-tripped headings, bold, italic, links, lists, quotes, code fences and figures byte for byte through a real TipTap editor, and escaped 14 of 14 typed samples that look like syntax. About 191 KB gzipped, on admin routes only.
- `@tiptap/markdown` turned `\#` and typed `1. ` into headings and lists, collapsed 4-backtick fences and double-escaped `&copy;`. Lexical's Markdown isn't CommonMark and nested quotes. MDXEditor throws on `x <3 y`. BlockNote is MPL with a GPL add-on. Milkdown is the fallback if our bridge becomes costly.

### Draft storage (A)
- **D1 (chosen):** SQL, migrations, a revision check for autosave, 7 days of Time Travel, 100k writes a day free.
- KV allows 1,000 writes a day and is eventually consistent, so autosave would break. A SQLite Durable Object has the same limits as D1 and its own 30-day point-in-time recovery, but no `wrangler` migrations or export commands and no dashboard or CLI restore, so all of that would be code we write. JSON objects in R2 can't be queried.

## Decision

Choose **Option A** with the TipTap editor. Both reviews preferred it: it keeps
ADR-0002's guarantees, has the smallest long-term surface for one person, and
its main costs (about 4 minutes to publish, two stores) are stated and tested.

- **Markdown stays the only stored format,** in D1 and in git. Editor JSON exists only in memory.
- **Image sections** are a leaf directive on their own line, `::figure[caption]{src alt size w h}`, rendered at build time into `<figure>` with a responsive `<img>` (design doc §4.9.4). Only the leaf form of the directive syntax is turned on, because the full form turns prose like `16:9` and `10:30am` into empty `<div>`s.
- **One renderer.** A new `packages/content-markdown` is shared by the build, the admin preview (which runs in the browser) and the editor bridge.
- **Images** are resized and stripped of EXIF in the browser, checked by magic bytes in the Worker, and stored in R2 under random keys.
- **The owner merges.** The Worker opens the PR and never merges it or turns on auto-merge. The PR is the review step, so it carries everything needed to review it on GitHub, from a phone too:
  - **Title:** `Publish: <title>`, `Update: <title>` or `Unpublish: <title>`.
  - **Overview:** the post URL, summary, tags, reading time, and the created and updated dates.
  - **Images:** each figure shown inline from `photos.ry-mart.com`, with its alt text and caption.
  - **What changed:** for an edit, the frontmatter fields that changed (old → new) and a section-level summary of the body (each section added, removed or edited, by heading, with the word-count change). A new post lists its sections; an unpublish says the file is deleted.
  - **Review checklist:** reads well, alt text and captions right, summary and tags right, nothing private, `ci` green, then **Squash and merge**.

  Republishing while the PR is open updates the body and adds a comment saying what changed since the last commit.
- **Dates.** `date` is set at the first publish and never changes. Republishing a published post sets `updated` to the publish day, and the post page shows "Published <date> · Updated <date>" when they differ.
- **Ship in two halves.** First the private editor with a "Download .md" button, so posts can be published through the normal PR flow. The GitHub App publish flow comes after.

## Consequences

- This amends ADR-0002's "Upgrade path": the in-browser editor replaces the git-backed CMS idea, and the storage model for published posts doesn't change. Hand-written `content/blog/*.md` files keep working.
- New resources: a D1 database `blog`, a private R2 bucket `blog-backups` for nightly draft exports, a GitHub App with Contents and Pull requests write on this repo only, and one daily cron. All are $0.
- The `main` ruleset has to match hosting guide §2.4 (a required `ci` check, Restrict updates off, and 0 approvals, which the owner sets, because GitHub doesn't let them approve their own PRs). Allow auto-merge stays off. The owner's PRs, publish PRs included, then merge by hand without the admin bypass once `ci` passes.
- The App is never a ruleset bypass actor. A second ruleset limits it to `blog/**` branches, and `ci.yml` fails any PR whose bot commits touch files outside `content/blog/`. The Worker never merges, but the App's permissions still allow merging any PR whose `ci` is green, so `deploy.yml` refuses to deploy a bot merge that touches code (design doc §4.9.7).
- Publishing makes the text public on a GitHub PR before it is live (about 4 minutes when merged promptly; the owner accepted this, posts aren't sensitive), and it stays in history even if CI fails or the PR is closed. The publish dialog says so.
- Slugs are locked after the first publish, so a copied link keeps working; there is no redirect mechanism yet.
- The first save of an old hand-written post through the editor normalises its Markdown (`-` bullets, `*` emphasis), which gives a one-time noisy diff.
- `::figure` lines show as literal text in GitHub's file view.

## Revisit when

- Merging every publish PR by hand becomes a chore. Turn on auto-merge for publish PRs (squash, after `ci`), which needs **Allow auto-merge** in the repo settings.
- Waiting about 4 minutes to publish becomes painful. Options: make the App a bypass actor and push straight to `main` (about 1 minute, no CI first), or move to Option B.
- The repo becomes private. A stock git CMS (Sveltia) becomes viable, since draft branches would no longer be public.
- The bridge needs nodes it doesn't support (tables, footnotes). Add a mapper and golden tests, or switch to Milkdown.
