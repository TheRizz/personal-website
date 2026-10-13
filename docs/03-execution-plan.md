# Execution Plan

Each step below is sized for **one pull request**. Each one lists its inputs,
the tasks and its acceptance criteria. Do the steps in order. Steps marked ⇄
can run in parallel with the step before them. Design details are in
[`01-system-design.md`](./01-system-design.md) (cited as §x.y), and
account and purchase steps are in [`02-hosting-and-costs.md`](./02-hosting-and-costs.md).

**Rule:** the deploy pipeline goes live in Phase 1, so every later step ships to
production on merge. Unfinished features stay behind a route that isn't linked
from the nav yet.

---

## Phase 0: Decisions and accounts (no code)

### Step 0.1: Answer the open questions
- [ ] Choose the domain name and TLD (§8 Q1).
- [ ] Decide public or private repo, resume privacy, spectators, and analytics (§8 Q2–5).
- [ ] Accept or change ADR-0001, 0002 and 0003, and set their status to *Accepted*.

**Done when:** the ADRs are marked Accepted and the answers are recorded in §8 of the design doc.

### Step 0.2: Buy and set up accounts
- [ ] Do steps 2.1–2.4 of the hosting guide: Cloudflare account, domain, R2 bucket, API token, GitHub environment and branch protection.

**Done when:** every ✅ check in hosting guide §2.1–2.4 passes.

---

## Phase 1: Skeleton and deploy pipeline (walking skeleton)

> **Built 2026-10-11.** Deviations from the plan: React Router stays on v7 (v8 is out, but
> Cloudflare's starter still uses 7). Node 24 instead of 22. `packages/game-core` is
> created in Phase 7. `GameLobby` is a plain class, not `extends DurableObject`, because
> React Router prerenders by loading the Worker module in Node, which can't import
> `cloudflare:workers`. The visual design is modelled on godobject.dev. The PR preview
> job (Step 1.3) and the uptime monitor (Step 1.5) are not built yet. On phones the nav is
> a compact row of links rather than a menu button; five links fit at 360 px.

### Step 1.1: Monorepo scaffold
- [x] `pnpm` workspace with `apps/web`, `packages/game-core` and `packages/content-schema` (§4.1).
- [x] Root tooling: TypeScript 5 in strict mode, ESLint (flat config), Prettier, `.editorconfig`, `.nvmrc` (Node 22), `.gitignore`.
- [x] Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `format`. (`e2e` arrives with Playwright.)
- [x] Vitest workspace config.

**Done when:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test` passes on a clean clone.

### Step 1.2: React Router v7 app on a Worker
- [x] Scaffold React Router v7 in framework mode with the `@cloudflare/vite-plugin`.
- [x] `wrangler.jsonc`: Worker `site`, static assets, `run_worker_first: ["/api/*"]`, and a `GAME_LOBBY` Durable Object binding with a SQLite migration (empty class for now).
- [x] Worker entry with `/api/health` returning `{ok, version}`, where version is the git SHA injected at build time.
- [x] A placeholder `/` route ("Coming soon"). Built as the real home page instead: intro plus the post timeline.

**Done when:** `pnpm dev` serves `/` and `/api/health` locally, and `pnpm build` produces static assets plus the Worker bundle.

### Step 1.3: CI workflow (`ci.yml`)
- [x] Runs on `pull_request`: install with a pnpm cache, then lint, typecheck, test and build.
- [x] Pin actions to SHAs, use minimal `permissions`, and use `concurrency` to cancel superseded runs.
- [ ] Preview job: `wrangler versions upload --preview-alias pr-<n>`, then post the preview URL as a PR comment that gets updated on each push.
  - Version URLs aren't generated for a Worker that has a Durable Object, so this job can't work as written. The alternative is `wrangler preview` (Previews), whose bindings must never point at the production `blog` D1 database (Phase 10).
- [x] Add Dependabot config for npm and github-actions.

**Done when:** a test PR shows a green `ci` check and a working preview URL.

### Step 1.4: Deploy workflow (`deploy.yml`) and custom domain
- [x] Runs on `push` to `main` in the `main` environment with `concurrency: deploy-production`.
- [x] Steps: build, then `wrangler deploy`, then the smoke test (curl `/` and `/api/health` and check the version matches the SHA).
- [x] On smoke-test failure: `wrangler rollback`, then fail the job.
- [x] Separate `rollback.yml` (`workflow_dispatch`).
- [x] Custom domain route in `wrangler.jsonc` and a `www` redirect (hosting guide §2.5).

**Done when:** merging to `main` updates `https://<domain>/api/health` to the new SHA within about 3 minutes, and a deliberately failing smoke test triggers a rollback (tested once, then reverted).

### Step 1.5: Uptime monitor ⇄
- [ ] `uptime.yml` runs on cron `*/30 * * * *`. It curls `/` and `/api/health` with retries and opens or updates a GitHub issue labelled `outage` on failure, and closes it when the site recovers.

**Done when:** a manual `workflow_dispatch` run passes.

---

## Phase 2: Site shell and design system

### Step 2.1: Layout and navigation
- [x] App shell with header nav (Home, Resume, Blog, Snippets, Photos, Games), a search button, footer and social links.
- [x] Responsive at 360 px, 768 px and 1280 px, with a mobile menu.
- [x] Styling: Tailwind CSS v4 with CSS-variable design tokens (colour, spacing, type scale).
- [x] Error boundary and a 404 route.
- [x] Stretch goal: dark mode that follows `prefers-color-scheme`, with a toggle.

**Done when:** every nav link resolves (to a placeholder if needed), there are no layout shifts, and axe-core shows 0 serious violations.

### Step 2.2: Shared UI primitives
- [ ] `Card`, `TagChip`, `TagList`, `DateLabel`, `CodeBlock` (with a copy button), `Pagination`, `EmptyState`, `Skeleton`, `Toast`.
- [ ] A Vitest + Testing Library test for each component's behaviour.

**Done when:** the components are used by at least one page and their tests pass.

### Step 2.3: SEO and head management ⇄
- [ ] Per-route `meta` exports: title, description, canonical URL, Open Graph and Twitter tags.
- [ ] `robots.txt` and the security headers `_headers` file (§4.8).

**Done when:** the headers check passes and the OG preview renders correctly (check with a link-preview debugger).

---

## Phase 3: Content pipeline

### Step 3.1: Content schemas
- [ ] Zod schemas in `packages/content-schema` for post, snippet, photo, resume (JSON Resume) and taxonomy (§4.2).
- [ ] Unit tests for valid and invalid samples of each.

**Done when:** the tests cover required fields, date formats, unknown categories and tag normalisation.

### Step 3.2: `build-content` script
- [ ] Read `content/**`, parse frontmatter, validate, and render Markdown with remark/rehype, Shiki and rehype-sanitize. Compute reading time and slugs.
- [ ] Normalise tags (lowercase, kebab-case, apply aliases from `taxonomy.yaml`) and build `tags.json`.
- [ ] Write the generated JSON files to `apps/web/app/generated/` (git-ignored).
- [ ] Fail with a file:line message on schema errors, duplicate slugs or unknown categories.
- [ ] Hook it into `pnpm dev` (watch mode) and `pnpm build`.
- [ ] Seed content: 2 posts, 3 snippets, the resume and the taxonomy.

**Done when:** editing a Markdown file hot-reloads in dev, and a deliberately invalid frontmatter field fails CI with a clear message.

### Step 3.3: Sitemap and RSS ⇄
- [ ] Generate `sitemap.xml` (all prerendered routes) and `rss.xml` (latest 20 posts) during the content build.
- [ ] Write both into the build's output directory (`apps/web/app/generated/`, or `--out`) and serve them from there, never straight into `apps/web/public/`: the draft privacy test (Step 10.11) reads only what the build writes under `--out`.

**Done when:** both files pass validators and are linked from `robots.txt` and the `<head>`.

---

## Phase 4: Resume, blog and snippets

### Step 4.1: Resume page and PDF
- [ ] `/resume` renders `resume.json` with sections for work, education, skills and projects, plus a print stylesheet.
- [ ] `scripts/resume-pdf.ts` uses Playwright to print `/resume` to `public/resume.pdf` in CI.
- [ ] A "Download PDF" button.

**Done when:** the page is prerendered and the PDF is created on every deploy and matches the page.

### Step 4.2: Blog list, category and post pages
- [ ] `/blog` with paginated cards and tag filter chips in the query string.
- [ ] `/blog/category/:category`.
- [ ] `/blog/:slug` with a table of contents, highlighted code, tags linking to `/tags/:tag`, and prev/next links.
- [ ] Prerender every post and category route. Drafts are left out of production builds.

**Done when:** page source contains the post HTML, and a Playwright test covers list → filter → open post → tag link.

### Step 4.3: Snippets pages ⇄
- [ ] `/snippets` with filters by language and tag, and `/snippets/:slug` with a copy button and description.

**Done when:** the copy button puts the exact code on the clipboard (e2e-tested), and the language filter works.

---

## Phase 5: Photos

### Step 5.1: Photo upload script
- [ ] `scripts/photos-upload.ts`: takes a folder plus `--album` and `--tags`. Uses `sharp` to strip EXIF GPS data, make WebP variants at 480, 1024 and 2048 px, and compute the dominant colour. Uploads to R2 through the S3-compatible API with immutable cache headers. Adds entries to `photos.yaml`.
- [ ] Idempotent: re-running skips ids that are already uploaded.
- [ ] Credentials come from a local `.env` (R2 access key) and are never committed.

**Done when:** uploading 5 test photos creates 15 objects in R2 and 5 manifest entries, and a second run uploads nothing.

### Step 5.2: Gallery UI
- [ ] `/photos` masonry grid using `srcset` and `sizes`, lazy loading and a placeholder colour.
- [ ] `/photos/album/:album`.
- [ ] Accessible lightbox: keyboard arrows, Esc to close, focus trap and a caption.

**Done when:** no layout shift on load (CLS < 0.05), keyboard navigation works, and Lighthouse image audits pass.

---

## Phase 6: Tags and search

### Step 6.1: Tag pages
- [ ] `/tags` shows a tag cloud or list with counts. `/tags/:tag` lists posts, snippets and photos grouped by type.

**Done when:** every tag shown anywhere links to a tag page that exists (checked by a build-time link checker).

### Step 6.2: Search index build
- [ ] Extend `build-content` to make a unified document list and a serialized MiniSearch index with the boosts, fuzzy and prefix settings from §4.4.
- [ ] Content-hashed file name. CI fails if the gzipped index is over 300 KB.
- [ ] Write the index into the build's output directory (`--out`), like every other build output, so the draft privacy test (Step 10.11) reads it.

**Done when:** a unit test loads the index and finds documents by a title typo, by tag and by type filter.

### Step 6.3: Search UI
- [ ] `/search` page with the state in the query string, plus a global `Ctrl+K` / `/` command palette (Radix Dialog or cmdk).
- [ ] The index loads lazily the first time search is opened. Results are grouped by type and the matched terms are highlighted. Up and down arrows move through results and Enter opens one.
- [ ] Fallback to substring matching if the index fails to load.

**Done when:** a Playwright test covers opening with `Ctrl+K` → typing with a typo → filtering by type → opening a result, and the first result appears in under 50 ms after the index has loaded.

---

## Phase 7: Game engine (server)

> **Built 2026-10-12.** Deviations from the plan: `@cloudflare/vitest-pool-workers` needs
> vitest 4 and the repo uses vitest 5, so the Worker and the Durable Object are unit-tested in
> Node with fakes. Playwright tests against `vite preview` (workerd) cover the real runtime,
> including hibernation, so the "Done when" checks for Steps 7.2 and 7.3 are met that way. The
> lobby rules are a pure state machine in `game-core`, and the DO only stores the record and runs
> its effects. The DO stays a plain class, so the Worker calls it with `stub.fetch()` rather than
> RPC. The protocol says `role` instead of `seat`, gives spectators a `null` token and adds the
> errors `NOT_JOINED`, `NOT_A_PLAYER` and `STALE_STATE`. `init` takes the first seat and
> `validateMove` returns a result object. The plan's 10-socket cap (refusing a full lobby with
> 409) is replaced by a cap of 8 spectators at join (close 4002) and a 10-second join timeout
> (close 4003), so a dropped player can always get back in. Spectators don't bump `seq`.
> Releasing a seat resets the match. `POST /api/lobbies` also requires a JSON content type (415),
> and WebSocket upgrades from another origin get 403. Design doc §4.5 has the details.

### Step 7.1: `game-core` package
- [x] The `GameDefinition<S, M>` interface (§4.5), `Seat` and `GameError` types, and zod protocol schemas for `ClientMsg` and `ServerMsg`.
- [x] `tictactoe` implementation: board of 9, X goes first, win lines, draw detection, `validateMove` that rejects occupied cells, out-of-range cells, the wrong seat and moves after the game has ended.
- [x] Exhaustive tests: all 8 win lines, a draw, and a property test (fast-check) that random legal play always ends within 9 moves.

**Done when:** 100% branch coverage on `tictactoe`.

### Step 7.2: Lobby HTTP API
- [x] `POST /api/lobbies` (code generation, collision retry, rate limit), `GET /api/lobbies/:code`, `GET /api/lobbies/:code/ws` (forwards the upgrade to the DO) (§4.5).
- [x] Rate limiting through the Workers Rate Limiting binding (or a WAF rule) at 10 per minute per IP.
- [x] JSON error format and `Cache-Control: no-store`.

**Done when:** integration tests with `@cloudflare/vitest-pool-workers` cover create → get → 404 for an unknown code → 429 after the limit.

### Step 7.3: `GameLobby` Durable Object
- [x] Uses the WebSocket Hibernation API (`acceptWebSocket`, `webSocketMessage`, `webSocketClose`) and `serializeAttachment` for seat and token.
- [x] Seat assignment, reconnect tokens (`crypto.randomUUID`), a 2-minute grace period on disconnect, spectators (max 8, checked at join), and rematch.
- [x] State is saved to DO storage after every change. Full snapshots are broadcast.
- [x] Message validation, a 4 KB size cap, a limit of 10 messages per second per socket, and close code 1008 for bad clients.
- [x] `setWebSocketAutoResponse` handles ping/pong. `alarm()` removes the lobby after 30 minutes without activity.

**Done when:** worker integration tests cover a full game between two sockets, an out-of-turn move, an invalid message, a reconnect with a token, a third socket becoming a spectator, a rematch, and alarm cleanup.

---

## Phase 8: Game UI

> **Built 2026-10-12.** Deviations from the plan: sound effects are not built, so that box in
> Step 8.3 stays unticked. The disconnect notice counts down the time left on the held seat
> ("Alice disconnected — seat held for 1:42") rather than a fixed "waiting 2:00".
> `/games/tictactoe/:code` isn't prerendered: the Worker renders it on demand, a malformed code
> gets the 404 page and a lowercase code redirects to the uppercase one. The join box also accepts
> a pasted invite link. When the spectator cap is reached the page says "This game is full" and
> offers Try again. When another tab takes the seat (close 4000), the old tab offers "Watch here".
> The two-player Playwright tests use separate browser contexts against `vite preview`, and CI
> runs them after the build. The owner played tic-tac-toe on ry-mart.com and confirmed it works
> correctly on 2026-10-12.

### Step 8.1: Lobby screens
- [x] `/games`: list of games. `/games/tictactoe`: "Create game" and "Join with code" (input upper-cases and filters to the allowed alphabet).
- [x] After creating a lobby: show the code in large text, a "Copy invite link" button (`/games/tictactoe/:code`), and a "Waiting for opponent…" state.
- [x] Display-name prompt, remembered in `localStorage` inside try/catch.

**Done when:** creating a lobby and opening the invite link in a second browser puts both players on the game screen.

### Step 8.2: Game client hook and board
- [x] `useGameSocket(code)` hook: connect, `join` with a stored token (`sessionStorage` per code), reconnect with backoff, and expose `state`, `seat`, `send` and `connectionStatus`.
- [x] `TicTacToeBoard`: accessible grid of buttons with ARIA labels, highlighted win line, turn indicator, score, rematch button and connection badge.
- [x] Optimistic move using `game-core.validateMove` on the client, then reconcile with the server snapshot.

**Done when:** a Playwright test with two browser contexts covers create → join → X wins → rematch → O moves first → draw. A refresh mid-game keeps the same seat.

### Step 8.3: Game polish ⇄
- [x] Error toasts mapped from server error codes, a friendly "Lobby not found/expired" page and a "Opponent disconnected — waiting 2:00" countdown.
- [ ] Simple sound effects (muted by default). Not built.

**Done when:** each error path in the Step 8.2 test suite shows the correct user-facing message.

---

## Phase 9: Hardening and launch

### Step 9.1: Quality gates
- [ ] Lighthouse CI in `ci.yml` with a budget of ≥ 90 in every category on `/` and one post.
- [ ] axe-core e2e checks on every top-level route.
- [ ] Internal link checker over the prerendered output.
- [ ] Bundle-size budget: initial JS under 150 KB gzipped. The game and search code are split into separate chunks.

**Done when:** CI enforces all four checks.

### Step 9.2: Production smoke test, expanded
- [ ] `deploy.yml` smoke test also opens a WebSocket to a fresh lobby, sends `join`, and expects `joined` back.

**Done when:** a broken DO deploy is caught and rolled back automatically.

### Step 9.3: Docs and runbook
- [ ] Update `README.md` with a quickstart, a content-authoring guide, and links to the runbook in hosting guide §6.
- [ ] `CONTRIBUTING.md`-style notes for future you: branch naming, how previews work, how to add a game.

**Done when:** a fresh clone can run the site by following the README only.

### Step 9.4: Launch
- [ ] Work through the go-live checklist (hosting guide §5), except the Authoring block, which Step 10.11 covers.
- [ ] HSTS: the site already sends `Strict-Transport-Security: max-age=31536000` (Step 10.1). Decide on `includeSubDomains` and `preload`, and submit to the preload list only once every subdomain serves HTTPS. Submit the sitemap to Google Search Console and Bing Webmaster Tools (both free).
- [ ] Replace the seed content with real posts, snippets, photos and resume.

**Done when:** every checklist box outside the Authoring block is ticked.

---

## Phase 10: Owner-only authoring

The owner drafts posts in a browser editor that only they can reach, with header
sizes, bold, italics and image sections, and publishes them as Markdown through
a pull request. Design: §4.9, [ADR-0004](./adr/0004-owner-only-admin-access.md)
and [ADR-0005](./adr/0005-in-browser-authoring.md). Setup clicks: hosting guide
§2.7–2.10.

**Rule for this phase:** the owner gate and the site-wide CSP (Step 10.1) ship
before any admin page or endpoint exists. Every later step adds its routes to the route-auth table
test from Step 10.1, so nothing admin is ever reachable without a valid owner
token. Steps 10.0–10.6 give a working private editor; posts are published by
committing the downloaded `.md` through a normal PR. Steps 10.7–10.11 add
one-click publishing.

> **Built 2026-10-12 (Steps 10.1–10.3, code only).** The production Done-whens stay open until
> Step 10.0 is finished: the Access vars in `wrangler.jsonc` are empty until the owner sends the
> team domain and AUD tag, so admin fails closed in production. Deviations from the plan:
> prerendered pages get their CSP from a `_headers` file generated in `buildEnd`, one rule per
> page listing that page's inline scripts by sha256 hash; Worker-rendered pages get a per-request
> nonce. The policy also allows Cloudflare Web Analytics (`static.cloudflareinsights.com`,
> `cloudflareinsights.com`), and `zod` runs `jitless` because its JIT trips the CSP.
> `_headers` is capped at 100 rules, one per prerendered page, so the build warns above 80 and
> fails at about 92 posts; the fallback is in design doc §4.8. HSTS (`max-age=31536000`) is
> sent from this step, so Step 9.4 only decides on `includeSubDomains` and `preload`. Admin
> paths get their own stricter CSP instead of the site-wide one (§4.9.8). Gate refusals are a
> bare 404 (plain text for pages), not the site's HTML 404 (§4.9.1). E2E needs `pnpm e2e:keys`
> before `pnpm build`. The post page shows "<date> • Updated <date>", which ships here with
> Step 10.2 rather than with Step 10.9. Wide and full figures are sized in `cqw` of the root,
> not `vw`, so a classic scrollbar doesn't push them off centre.

### Step 10.0: Owner setup, part 1 (no code)
- [x] Answer §8 Q6–14 and set ADR-0004 and ADR-0005 to *Accepted* (2026-10-12). ADR-0005 is amended: the owner merges every publish PR by hand.
- [x] A card on file and the R2 billing alert (§2.8 step 5).
- [x] The GitHub default branch is `main` (§2.4 step 1).
- [x] Hosting guide §2.7: turn on Zero Trust Free and create the "Site admin" Access app (paths `admin` and `api/admin`, the Cloudflare login, owner-only policy, 24-hour sessions, SameSite Lax, HttpOnly, Binding cookie, empty CORS).
- [ ] Hosting guide §2.8: create the D1 database `blog` (done 2026-10-12) and the private bucket `blog-backups`. Finish §2.2 (`photos` and `photos.ry-mart.com`) if it isn't done. Add the `nosniff` Transform Rule.
- [ ] Hosting guide §2.9: `wrangler secret put OWNER_EMAIL` (done 2026-10-12). Add Account · D1 · Edit to the CI token (§2.3). Create the backup-only D1 token and the R2 key scoped to `blog-backups`.
- [ ] Confirm the `main` environment only deploys from `main` (§2.4 check).
- [x] Send back the team domain, the AUD tag and the D1 `database_id` (none is secret), so a follow-up commit fills them in (Access vars in Step 10.1, the `DB` binding in Step 10.4). The team domain (`tight-boat-6333`) and AUD tag arrived on 2026-10-12 and are in `wrangler.jsonc`, and the D1 id arrived the same day and is in the `DB` binding.

**Done when:** every ✅ check in hosting guide §2.7–2.9 passes, `curl -sI https://ry-mart.com/admin` returns `302` to `<team>.cloudflareaccess.com`, and the team domain, AUD tag and D1 id have been sent back.

### Step 10.1: Owner gate in the Worker
- [x] Site-wide CSP and security headers from §4.8 (`img-src` includes `photos.ry-mart.com`), so they are live before any owner session can exist. Check the game WebSocket still works.
- [x] `pnpm add jose` (exact version) in `apps/web`. `worker/admin-auth.ts`: `verifyAccessJwt` as a pure function (with `maxTokenAge`), and `requireOwner` with admin detection, a 404 for any non-canonical spelling, host check, header-only token (no cookie fallback), CSRF rules, no-store and noindex headers (§4.9.1).
- [x] Call it first in `worker/index.ts`, before `/api/*` dispatch and the React Router handler. Mount an admin router behind it.
- [x] `GET /api/admin/me` (sets `owner_hint`). Requests to the API are refused with 404 everywhere else under `/api/admin`.
- [x] `wrangler.jsonc`: Access vars, `run_worker_first` adds `/admin` and `/admin/*`, `workers_dev: false`, `preview_urls: false`. No `secrets.required` block (it would hide the e2e key); `deploy.yml` checks `wrangler secret list` for `OWNER_EMAIL` instead. `robots.txt` adds `Disallow: /admin`.
- [x] `deploy.yml`: `CLOUDFLARE_API_TOKEN` only on the Wrangler steps, not the job.
- [x] Test identity: `pnpm e2e:keys` runs before `pnpm build` in CI and in the local `pnpm e2e` server command. It writes `ACCESS_TEST_JWKS` (public key only) to `.dev.vars` and the private key to the gitignored `e2e/.auth/`. Global setup signs tokens and fails fast if the build doesn't accept them. The Worker honours the key on localhost only and fails closed if it sees it on any other host. CI grep guard on `wrangler.jsonc`.
- [x] Never log tokens, draft bodies or image keys.

**Done when:** Vitest covers valid, wrong audience, wrong issuer, too old, expired, HS256, wrong e-mail, wrong host, missing Origin, cross-site `Sec-Fetch-Site`, a valid `CF_Authorization` cookie with no header (404), and `/ADMIN`, `/%61dmin` and `/admin.data`. A table-driven test expects 404 without a token on every admin route, and a check fails if any admin route or the root route exports a server `loader` or `action`. E2E gets 404 anonymously and `200 {email}` with the test token on `/api/admin/me`, and 404 **with** the test token on `/API/ADMIN/me`, `/%61pi/admin/me` and `/ADMIN/`. After deploy, the runbook checks pass: anonymous gets the Access redirect, the logged-in browser sees its e-mail, a cross-site POST is refused, securityheaders.com shows the CSP and the games still work.

### Step 10.2: Shared Markdown package and figures in the build ⇄
- [x] `packages/content-markdown`: `remarkLeafDirective` (leaf only), `remarkFigure` (validation, variant widths from `w`, `srcset`, `sizes`, size classes), `sanitizeSchema`, `renderMarkdown(md, {highlighter})`, `markdownToDoc` / `docToMarkdown`, `SHIKI_LANGS` (§4.9.4).
- [x] Switch `scripts/build-content.ts` to it. Figure CSS for column, wide and full.
- [x] `build-content --check-images` in CI: HEAD each figure URL, only when files under `content/blog/` change, and only for posts that have figures, so unrelated PRs never depend on `photos.ry-mart.com`.

**Done when:** every existing post renders byte-identical HTML to before. Golden tests pass: round trip is idempotent, rendered HTML is the same after a round trip, typed syntax stays escaped, `16:9` and `10:30am` are untouched, a bad `src`, missing `alt`, missing `w`/`h` or unknown `size` fails the build with file and line. A test post with a wide figure renders `figure`, `img[srcset]` and `figcaption`.

### Step 10.3: Admin shell
- [x] `/admin` layout route: client data only, CSP with a per-request nonce, `frame-ancestors 'none'`, a "Sign out" link that also clears `owner_hint`, and an empty draft list. Never in the prerender list.
- [x] The `fetch` wrapper for `/api/admin/*`: adds `X-Requested-With: XMLHttpRequest` (Access answers 401, not a redirect) and `X-Admin: 1` (the gate needs it on writes), and shows "Session expired" on 401.

**Done when:** e2e signs in with the test token and sees the empty draft list. A test write through the wrapper passes the gate, and the same write without the wrapper gets 404. The prerendered post HTML is unchanged. axe shows no new violations.

### Step 10.4: Drafts API on D1
- [x] Migration `0001` (`drafts`, `draft_revisions`, `images`, §4.9.5) and the `DB` binding.
- [x] Endpoints: list, create, get, autosave `PUT` with `baseRev` (409 on a stale rev), discard, revisions, restore. Validate with `postFrontmatter.partial()` and a 512 KB body cap. Bound parameters only, and every batch statement guarded.
- [x] Revisions: every `publish` revision kept, others capped at 50, a `conflict` snapshot before an overwrite.
- [x] `deploy.yml` runs `wrangler d1 migrations apply blog --remote` before `wrangler deploy`. Migrations are expand-only, because `wrangler rollback` doesn't roll back D1. E2E applies them `--local`.
- [x] `backup.yml`: nightly `wrangler d1 export`, uploaded into `blog-backups` with the S3 API, in the `main` environment, with the backup-only credentials (hosting guide §2.9), printing no content.

**Done when:** unit tests cover a successful save, a stale save (409, row unchanged), the revision cap and the conflict snapshot. E2E creates, saves and reloads a draft. The production migration applies from the deploy job. The first nightly backup object appears in `blog-backups`, and the run log has no draft text.

> **Built (Step 10.4).** A save asks for a snapshot with `revision: "interval" | "manual" |
> "conflict"`; the editor's Overwrite re-sends with the rev from the 409 and `"conflict"`, which
> keeps the overwritten version in the same batch as the UPDATE. The other snapshots and the
> pruning run only after the UPDATE succeeded, so a stale save never writes a revision. Restore
> takes `{baseRev}` and is a 409 when stale. Discard is refused while a publish is open. Unit tests
> run the real migrations on Node's built-in SQLite (`worker/d1-fake.ts`). `backup.yml` skips with
> a warning until the backup credentials from §2.9 exist. `deploy.yml` now fails if `OWNER_EMAIL`
> is missing.

### Step 10.5: Editor
- [x] TipTap, lazy-loaded in `/admin/drafts/:id`. Toolbar: H2, H3, H4, bold, italic, code, link, lists, quote, code block, rule. Raw Markdown tab. Markdown paste.
- [x] Metadata panel checked live against `postFrontmatter` (summary counter, tags normalised). No cover picker (§7); an imported `cover` is kept as it is.
- [x] Autosave (2 s debounce, 10 s max wait), conflict banner, `BroadcastChannel`, `localStorage` crash copy, stop after 3 errors, revisions drawer with restore.
- [x] Preview with `renderMarkdown` and Shiki loaded on first use, styled with the public `.prose` CSS.
- [x] "Download .md" and "Copy as Markdown" that produce the exact `content/blog/YYYY-MM-DD-slug.md` file, and mark the draft's images `published = 1`.
- [x] Bundle check: no public route chunk contains `@tiptap` or the bridge.

**Done when:** e2e types a title, an H2, bold and italic text, reloads, and sees the same content, and the stored `body_md` equals the expected Markdown. Two browser contexts show the 409 banner, and Overwrite keeps the other version as a revision. The downloaded file, committed by hand, builds and deploys. It works with the keyboard only and has been tried on a real phone (iOS Safari and Android Chrome).

> **Built (Step 10.5).** `/admin` lists drafts and has **New post**. The editor lives in
> `DraftEditor.client.tsx`: the `.client` suffix keeps TipTap out of the server build (bundling
> it there breaks React Router's server manifest), and `pnpm check:bundle` in CI fails if any
> public page statically loads ProseMirror or the bridge. The preview uses fine-grained Shiki
> (the `SHIKI_LANGS`, both themes, the JavaScript regex engine). `content-schema` turns off Zod's
> JIT, which the CSP reports as `script-src eval`. Marking images `published = 1` on download
> shipped with Step 10.6. Left for the owner: the keyboard-only
> pass and a try on a real phone.

### Step 10.6: Image sections
- [x] `PHOTOS` R2 binding. `POST /api/admin/images` and `PUT /api/admin/images/:id/:width` with magic-byte sniffing that must match the row's `ext`, the metadata refusal (Exif, XMP, PNG `eXIf`, WebP `EXIF`/`XMP `, GIF XMP), the 10 MB cap and immutable metadata. GIFs are stored as `blog/<id>.gif` (§4.9.6).
- [x] Browser: `createImageBitmap`, canvas resize, WebP with a `blob.type` check, `@jsquash/webp` or JPEG fallback, GIF (sniffed from its bytes) as is, upload progress.
- [x] Figure node view: preview, required alt, size picker, Move up / Move down (`Alt+Shift+Up/Down`), Remove, inline caption.
- [x] Orphan marking on save, deletes on discard (unpublished images only), and the daily cron clean-up.

**Done when:** unit tests accept JPEG, PNG, WebP and GIF and refuse with 415 SVG, HTML, a renamed file, a type that differs from the row, and a raw phone JPEG that carries GPS. Re-encoded output has no `Exif` segment, and a GIF lands at a key with no width suffix. E2E inserts an image, moves it above a paragraph, the Markdown shows the `::figure` line in its new place, and the preview renders `figure` and `figcaption`. Discarding a draft after **Download .md** leaves its images in R2. The cron test deletes only stale `pending` rows and unpublished orphans. A JPEG uploaded from a phone in production shows up at `photos.ry-mart.com` with the immutable header and no GPS data.

> **Built 2026-10-13 (Step 10.6).** Deviations from the plan: `@jsquash/webp` is deferred, so
> Safari uploads JPEG, with ImageIO's own EXIF and Photoshop blocks stripped in the browser (the
> Worker would refuse them). The Worker refuses more metadata than listed: JPEG `APP13` (IPTC),
> PNG `Raw profile type` text, and every GIF application extension except looping, ICC and
> ImageMagick's gamma. `POST /api/admin/images/published` marks a draft's figures published on
> Download .md and Copy as Markdown. Besides stale `pending` rows and old orphans, the cron also
> deletes uploads never inserted (after 7 days) and rows whose draft was discarded (after a day),
> but never one a draft or revision body mentions. The editor refuses any change that turns a
> figure into a heading, code block or list, since its caption is a textblock. Left for the
> owner: the `photos` bucket and `photos.ry-mart.com` must exist before this deploys (the
> `PHOTOS` binding names it), plus the phone upload check in production.

### Step 10.7: Owner setup, part 2: repo settings and GitHub App (no code)
- [ ] Hosting guide §2.10: fix the `main` ruleset to match §2.4 (0 approvals, which the owner sets, required `ci`, Restrict updates off). Turn on Automatically delete head branches and leave Allow auto-merge off. From now on your own PRs merge by hand without the admin bypass once `ci` passes.
- [ ] Add the "bot scope" ruleset: restrict creations and updates on every branch except `main` and `blog/**`, with the Admin role, Dependabot and the Claude GitHub App as bypass actors.
- [ ] Create the GitHub App (Contents RW, Pull requests RW, Actions R, Checks R, no Workflows, no webhook), install it on this repo only, pipe the key through the PKCS#8 conversion into the Worker secret (the `.pem` stays outside the repo) and set the three `GITHUB_APP_*` Worker secrets. Never add the App as a bypass actor.

**Done when:** every ✅ check in §2.10 up to check 10 passes. A throwaway PR can't be merged while `ci` runs and merges by hand once it passes, with no approval and no bypass. A local `test/x` push and a Claude Code `claude/test` push both still work.

### Step 10.8: CI guard for bot PRs (must merge before 10.9)
- [x] First step of the `ci` job, on `pull_request` only, inline in the YAML and before checkout and `pnpm install`: read the PR's files and commits from the API and fail when the PR author is the App's bot, or any commit has the bot as committer, and a changed file is outside `content/blog/`. No repo script runs.
- [x] First step of `deploy.yml`, before checkout: fail when `github.actor`, or the author or merger of the PR behind the commit, is the bot and the compare API's file list for `<before>...<sha>` touches anything outside `content/blog/`.
- [x] `scripts/app-token.ts` (`pnpm app-token --key <path>`): signs the App JWT with `jose` from the downloaded key and prints an installation token, for the §2.10 checks.

**Done when:** with an App token from `pnpm app-token`: it can create `blog/test` and is refused on `test`. A test PR that touches `README.md` fails `ci` and can't be merged, and one that only adds `content/blog/x.md` passes. Merging a green PR that edits `.github/workflows/` is refused. Merging a green owner PR that touches `README.md` with the App token makes the deploy fail at the guard (then revert it). §2.10 check 11 passes and the `.pem` is deleted.

> **Built 2026-10-13 (Step 10.8, code only).** The bot login is the repository variable
> `PUBLISH_BOT` (hosting guide §2.10 step 4), not a value in the YAML, so it needs no code
> change. While it is unset both guards pass, since there is no App; `deploy.yml` then fails if
> the Worker has `GITHUB_APP_PRIVATE_KEY`, so the guards can't be off once the App exists. The
> deploy guard also checks the merge commit's author and committer, and compares a manual run
> with the commit's parent. `scripts/app-token.ts` signs with `node:crypto` (no `jose` at the
> root), takes `--client-id` and finds the installation itself. The guard scripts were run
> against canned API answers for the owner's PRs, a posts-only App PR, App PRs touching
> `README.md` or renaming code into `content/blog/`, an App commit in an owner PR, and App and
> owner merges; the Done-when checks need the App and are left for the owner.

### Step 10.9: Publish from the editor
- [x] `worker/github.ts`: App JWT (`jose`, RS256, `iat` now − 60 s, `exp` + 9 min), installation token cached per isolate, `User-Agent`, typed calls for refs, trees, commits, pulls, GraphQL. `GITHUB_API_BASE` override on localhost only, for the e2e stub.
- [x] Frontmatter writer (`JSON.stringify` per value), slug generator, path allowlist, uniqueness check against `main` and open `blog/*` PRs, and the check that every figure key is `ready`.
- [x] `POST …/publish`: one commit (author from the plain var `GIT_AUTHOR`, the owner's no-reply address), branch and PR. The Worker never merges and never turns on auto-merge; the owner merges (§4.9.7). Publishing again while the PR is open adds a commit to the same branch, refreshes the body and comments with what changed.
- [x] PR title and body (§4.9.7): `Publish:`, `Update:` or `Unpublish: <title>`; an overview (URL, summary, tags, reading time, created and updated dates); the figures inline from `photos.ry-mart.com` with their alt text; "What changed" (frontmatter old → new and a section-level body summary for an update); a short review checklist.
- [x] Dates: republishing a published post sets `updated` to the publish day and never changes `date`. The display half shipped with Step 10.2: `blog.$slug` already shows "<date> • Updated <date>", the second part only when they differ.
- [x] Confirm dialog with the exposure and timing warning.
- [x] `GET /api/admin/posts` (one GraphQL tree query, cached by tree SHA) and Edit-from-`main` import with the `base_sha` check.
- [x] On `blog.$slug`, a client-only probe behind `owner_hint` that shows "Edit" linking to `/admin/posts/<slug>` with a full page load. It ships here because that route needs the import above.

**Done when:** Vitest with fetch fakes covers the happy path, slug collision, `base_sha` 409, token expiry, no request to a merge or auto-merge endpoint, no request body containing `OWNER_EMAIL`, and the PR title and body for a new post, an update and an unpublish. The frontmatter round-trips through `gray-matter` and `postFrontmatter`, and a republish changes `updated` but not `date`. E2E: a visitor without the cookie makes zero `/api/admin` requests (Playwright request log), the prerendered post has no admin markup, Edit appears with the cookie and test token and opens the imported draft, and without the token there is no Edit link and no uncaught exception or app-logged error (the browser's own failed-request message for `/api/admin/me` is filtered). A real test post published from production opens a PR with the overview, the owner merges it, and the post is live at `/blog/<slug>` within about 2 minutes of the merge.

> **Built 2026-10-13 (Step 10.9, code only).** The production Done-whens wait for Step 10.7 (the
> App and its secrets). Deviations from the plan: migration `0002_publish.sql` adds three columns
> to `drafts` (`pr_action`, `pr_blob_sha`, `post_date`; it only adds, since `wrangler rollback`
> doesn't roll back D1). Four fixed GraphQL queries do the list and status reads (the
> `content/blog` tree probe, the posts list, the open-PR scan and the PR status); every other
> call is REST. The client has no raw call and refuses any query with `mutation`. The committer
> is the App's bot, looked up with `GET /app` and `GET /users/<slug>[bot]`. The installation
> token is minted for `personal-website` only with exactly the four permissions publishing uses,
> and the grant is checked. `OWNER_EMAIL` is checked in every outgoing text before the first
> write, after NFKC and after undoing character references, percent-encoding, zero-width
> characters and backslash escapes (twice, for double encodings), and again in every request URL
> and body at send time. Old values that contain it are printed as "(contains a private
> address)", so an edit that removes a leak can publish. `GIT_AUTHOR` must be a no-reply address
> other than the owner's. A new endpoint, `POST /api/admin/posts/:slug/import`, imports a post
> from `main` (`{}`) or loads the GitHub version after a `changed_on_github` 409
> (`{refresh: true, baseRev}`), keeping the old text as a `conflict` revision. Posts with
> `draft: true`, a frontmatter `slug` that differs from the file name, or a file that is binary,
> too large or doesn't parse are listed but not editable. The posts list is cached by the
> `content/blog` tree OID behind a probe query. Frontmatter on `main` is parsed with
> `js-yaml@3.15.2`, gray-matter's own version. The public Edit link probes `/api/admin/me` with
> `HEAD`, so the owner's e-mail never reaches a public page. Publish, unpublish and cancel run
> under `ctx.waitUntil`, and a first publish or an unpublish that fails after creating its branch
> closes the PR and deletes the branch. Publishing refuses to run when the e2e test key is set
> without the local GitHub stub. `pnpm e2e:keys` now also writes the stub's `GITHUB_API_BASE` and
> a throwaway test App, private key included, to `.dev.vars`.

### Step 10.10: Publish status, cancel and unpublish
- [x] `GET …/status` (one GraphQL PR query, the deploy run for the merge SHA, `/api/health`) and the timeline in the editor: PR opened → CI running → waiting for your review → merged → deploying → Live, with links. A PR closed without a merge puts the draft back to Draft.
- [x] CI failed: "Fix and republish" or "Cancel" (closes the PR, deletes the branch). Deploy failed: link to the run.
- [x] Unpublish (a `sha: null` tree entry through the same PR flow). Images get `published = 1` when Live.

**Done when:** e2e against the GitHub stub walks every stage (the stub plays the owner's merge), including a CI failure and a PR closed on GitHub. In production, a deliberately broken post shows "CI failed" with a working link, Cancel closes the PR and deletes the branch, and the test post from Step 10.9 is unpublished through an `Unpublish:` PR the owner merges, and returns 404.

> **Built 2026-10-13 (Step 10.10, code only).** Deviations from the plan: production reads the
> live version in-process from the Worker's own `__APP_VERSION__` instead of fetching
> `/api/health`; with the local stub it reads `GET <stub>/__e2e/health`. A merge is Live when
> that version is the merge SHA, or a later commit that contains it (`compare` says `ahead` or
> `identical`), or when the `deploy.yml` run for the merge SHA succeeded. A cancelled deploy run
> (superseded in the concurrency group) shows "deploying", not "deploy failed". Images get
> `published = 1` at the first poll that sees the merge, in the same D1 batch, from the merged
> file's text (every `publish` revision when the text isn't available), not at Live. The `ci`
> result comes from GitHub Actions' check suite (App id 15368) on the PR head, which needs only
> Checks read; verify that filter at the 10.9 production check. Status acts only on a PR whose
> head branch, head repo and base match D1, and a missing repository is 503 with no D1 write. A
> PR closed on GitHub also has its branch deleted, so it can't be reopened and merged behind
> D1's back. Unpublish works for any post file on `main`, including ones the editor can't edit,
> and leaves the post's images in R2 (hosting guide §6).

### Step 10.11: Hardening
- [x] Draft privacy fixture test: a seeded draft's text and image keys never appear in `posts.json`, RSS, the sitemap, the search index or a PR body.
- [ ] Runbook drills (hosting guide §6): revoke Access sessions, restore a draft from a revision, from Time Travel and from a `blog-backups` export, rotate the App key, emergency takedown with a WAF rule.

**Done when:** the authoring checks in the go-live checklist (hosting guide §5) pass on production, each drill has been done once, and the Lighthouse and axe budgets still pass.

> **Built 2026-10-13 (Step 10.11, code only).** `worker/draft-privacy.test.ts` seeds a private draft
> (a marker in every field and in a figure's caption and alt, two image rows, a manual and a
> conflict revision) and an unpublished edit of a post on `main`. It then takes another draft
> through the admin router from a revision with a section that is removed before publishing, a
> publish that fails once after its branch is pushed (so the clean-up runs), a republish, CI and the
> fake's merge to Live. The private markers, image ids and every draft id must be missing from every
> GitHub request (URL, headers and body; PR title, body and comments included) and from the PRs and
> commits the fake keeps; from every file the content build writes from the merged `main` plus a
> `draft: true` post, and what the build prints; and from everything logged during the flow (each
> argument inspected in full, so an error's cause or a Request's URL can't hide), where the
> published post's text and image and the owner's address are refused too. The `draft: true` post's
> slug, tag, text and image are single-word markers, so a sitemap that listed it or a search index
> that split its words would show one. The build check reads the whole output directory, so the RSS
> feed, the sitemap and the search index are covered once Steps 3.3 and 6.2 add them, as long as
> they write there (now on those steps' checklists). For that `scripts/build-content.ts` takes
> `--content` and `--out`, and it now refuses unknown flags. Each check was seen to fail against a
> planted leak: a build that keeps drafts in `posts.json`, a sitemap, a tag list or a search index,
> a feed file with every title, a republish comment diffed against an older revision, another
> draft's title in a PR body, a request header carrying the request URL, a logged draft body, a
> `console.dir` of the draft's row and a branch name logged during clean-up. The runbook drills and
> the go-live authoring checks are the owner's, on production, after Step 10.7.

---

## Milestone summary

| Milestone | Phases | What you can show |
|-----------|--------|-------------------|
| M1: Live skeleton | 0–1 | Custom domain serving "Coming soon", with CI/CD, previews and rollback |
| M2: Portfolio MVP | 2–4 | Resume, blog and snippets live and prerendered for SEO |
| M3: Media and discovery | 5–6 | Photo gallery, tag pages and site-wide search |
| M4: Games | 7–8 | 1v1 tic-tac-toe with lobby codes, playable across devices |
| M5: Launch | 9 | Quality gates, monitoring, the complete go-live checklist |
| M6: Private drafts | 10.0–10.6 | Owner-only editor with header sizes, bold, italics and image sections. Posts are published by committing the downloaded `.md`. |
| M7: Publish from the browser | 10.7–10.11 | One click from draft to a PR with an overview of the changes. The owner merges it and the post is live about a minute later, with progress, cancel and unpublish. |

## Definition of done (applies to every step)

- [ ] Lint, typecheck and tests pass in CI, and new logic has tests.
- [ ] The preview URL has been checked by hand for UI changes.
- [ ] No secrets in code. New env vars are documented.
- [ ] Docs are updated if behaviour or operations changed.
- [ ] Accessibility checked with keyboard only, with no new axe violations.
