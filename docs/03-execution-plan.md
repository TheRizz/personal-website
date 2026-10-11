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

### Step 1.1: Monorepo scaffold
- [ ] `pnpm` workspace with `apps/web`, `packages/game-core` and `packages/content-schema` (§4.1).
- [ ] Root tooling: TypeScript 5 in strict mode, ESLint (flat config), Prettier, `.editorconfig`, `.nvmrc` (Node 22), `.gitignore`.
- [ ] Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `e2e`, `format`.
- [ ] Vitest workspace config.

**Done when:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test` passes on a clean clone.

### Step 1.2: React Router v7 app on a Worker
- [ ] Scaffold React Router v7 in framework mode with the `@cloudflare/vite-plugin`.
- [ ] `wrangler.jsonc`: Worker `site`, static assets, `run_worker_first: ["/api/*"]`, and a `GAME_LOBBY` Durable Object binding with a SQLite migration (empty class for now).
- [ ] Worker entry with `/api/health` returning `{ok, version}`, where version is the git SHA injected at build time.
- [ ] A placeholder `/` route ("Coming soon").

**Done when:** `pnpm dev` serves `/` and `/api/health` locally, and `pnpm build` produces static assets plus the Worker bundle.

### Step 1.3: CI workflow (`ci.yml`)
- [ ] Runs on `pull_request`: install with a pnpm cache, then lint, typecheck, test and build.
- [ ] Pin actions to SHAs, use minimal `permissions`, and use `concurrency` to cancel superseded runs.
- [ ] Preview job: `wrangler versions upload --preview-alias pr-<n>`, then post the preview URL as a PR comment that gets updated on each push.
- [ ] Add Dependabot config for npm and github-actions.

**Done when:** a test PR shows a green `ci` check and a working preview URL.

### Step 1.4: Deploy workflow (`deploy.yml`) and custom domain
- [ ] Runs on `push` to `main` in the `production` environment with `concurrency: deploy-production`.
- [ ] Steps: build, then `wrangler deploy`, then the smoke test (curl `/` and `/api/health` and check the version matches the SHA).
- [ ] On smoke-test failure: `wrangler rollback`, then fail the job.
- [ ] Separate `rollback.yml` (`workflow_dispatch`).
- [ ] Custom domain route in `wrangler.jsonc` and a `www` redirect (hosting guide §2.5).

**Done when:** merging to `main` updates `https://<domain>/api/health` to the new SHA within about 3 minutes, and a deliberately failing smoke test triggers a rollback (tested once, then reverted).

### Step 1.5: Uptime monitor ⇄
- [ ] `uptime.yml` runs on cron `*/30 * * * *`. It curls `/` and `/api/health` with retries and opens or updates a GitHub issue labelled `outage` on failure, and closes it when the site recovers.

**Done when:** a manual `workflow_dispatch` run passes.

---

## Phase 2: Site shell and design system

### Step 2.1: Layout and navigation
- [ ] App shell with header nav (Home, Resume, Blog, Snippets, Photos, Games), a search button, footer and social links.
- [ ] Responsive at 360 px, 768 px and 1280 px, with a mobile menu.
- [ ] Styling: Tailwind CSS v4 with CSS-variable design tokens (colour, spacing, type scale).
- [ ] Error boundary and a 404 route.
- [ ] Stretch goal: dark mode that follows `prefers-color-scheme`, with a toggle.

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

**Done when:** a unit test loads the index and finds documents by a title typo, by tag and by type filter.

### Step 6.3: Search UI
- [ ] `/search` page with the state in the query string, plus a global `Ctrl+K` / `/` command palette (Radix Dialog or cmdk).
- [ ] The index loads lazily the first time search is opened. Results are grouped by type and the matched terms are highlighted. Up and down arrows move through results and Enter opens one.
- [ ] Fallback to substring matching if the index fails to load.

**Done when:** a Playwright test covers opening with `Ctrl+K` → typing with a typo → filtering by type → opening a result, and the first result appears in under 50 ms after the index has loaded.

---

## Phase 7: Game engine (server)

### Step 7.1: `game-core` package
- [ ] The `GameDefinition<S, M>` interface (§4.5), `Seat` and `GameError` types, and zod protocol schemas for `ClientMsg` and `ServerMsg`.
- [ ] `tictactoe` implementation: board of 9, X goes first, win lines, draw detection, `validateMove` that rejects occupied cells, out-of-range cells, the wrong seat and moves after the game has ended.
- [ ] Exhaustive tests: all 8 win lines, a draw, and a property test (fast-check) that random legal play always ends within 9 moves.

**Done when:** 100% branch coverage on `tictactoe`.

### Step 7.2: Lobby HTTP API
- [ ] `POST /api/lobbies` (code generation, collision retry, rate limit), `GET /api/lobbies/:code`, `GET /api/lobbies/:code/ws` (forwards the upgrade to the DO) (§4.5).
- [ ] Rate limiting through the Workers Rate Limiting binding (or a WAF rule) at 10 per minute per IP.
- [ ] JSON error format and `Cache-Control: no-store`.

**Done when:** integration tests with `@cloudflare/vitest-pool-workers` cover create → get → 404 for an unknown code → 429 after the limit.

### Step 7.3: `GameLobby` Durable Object
- [ ] Uses the WebSocket Hibernation API (`acceptWebSocket`, `webSocketMessage`, `webSocketClose`) and `serializeAttachment` for seat and token.
- [ ] Seat assignment, reconnect tokens (`crypto.randomUUID`), a 2-minute grace period on disconnect, spectators (max 10 sockets), and rematch.
- [ ] State is saved to DO storage after every change. Full snapshots are broadcast.
- [ ] Message validation, a 4 KB size cap, a limit of 10 messages per second per socket, and close code 1008 for bad clients.
- [ ] `setWebSocketAutoResponse` handles ping/pong. `alarm()` removes the lobby after 30 minutes without activity.

**Done when:** worker integration tests cover a full game between two sockets, an out-of-turn move, an invalid message, a reconnect with a token, a third socket becoming a spectator, a rematch, and alarm cleanup.

---

## Phase 8: Game UI

### Step 8.1: Lobby screens
- [ ] `/games`: list of games. `/games/tictactoe`: "Create game" and "Join with code" (input upper-cases and filters to the allowed alphabet).
- [ ] After creating a lobby: show the code in large text, a "Copy invite link" button (`/games/tictactoe/:code`), and a "Waiting for opponent…" state.
- [ ] Display-name prompt, remembered in `localStorage` inside try/catch.

**Done when:** creating a lobby and opening the invite link in a second browser puts both players on the game screen.

### Step 8.2: Game client hook and board
- [ ] `useGameSocket(code)` hook: connect, `join` with a stored token (`sessionStorage` per code), reconnect with backoff, and expose `state`, `seat`, `send` and `connectionStatus`.
- [ ] `TicTacToeBoard`: accessible grid of buttons with ARIA labels, highlighted win line, turn indicator, score, rematch button and connection badge.
- [ ] Optimistic move using `game-core.validateMove` on the client, then reconcile with the server snapshot.

**Done when:** a Playwright test with two browser contexts covers create → join → X wins → rematch → O moves first → draw. A refresh mid-game keeps the same seat.

### Step 8.3: Game polish ⇄
- [ ] Error toasts mapped from server error codes, a friendly "Lobby not found/expired" page, a "Opponent disconnected — waiting 2:00" countdown, and simple sound effects (muted by default).

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
- [ ] Work through the whole go-live checklist (hosting guide §5).
- [ ] Turn on HSTS. Submit the sitemap to Google Search Console and Bing Webmaster Tools (both free).
- [ ] Replace the seed content with real posts, snippets, photos and resume.

**Done when:** every checklist box is ticked.

---

## Milestone summary

| Milestone | Phases | What you can show |
|-----------|--------|-------------------|
| M1: Live skeleton | 0–1 | Custom domain serving "Coming soon", with CI/CD, previews and rollback |
| M2: Portfolio MVP | 2–4 | Resume, blog and snippets live and prerendered for SEO |
| M3: Media and discovery | 5–6 | Photo gallery, tag pages and site-wide search |
| M4: Games | 7–8 | 1v1 tic-tac-toe with lobby codes, playable across devices |
| M5: Launch | 9 | Quality gates, monitoring, the complete go-live checklist |

## Definition of done (applies to every step)

- [ ] Lint, typecheck and tests pass in CI, and new logic has tests.
- [ ] The preview URL has been checked by hand for UI changes.
- [ ] No secrets in code. New env vars are documented.
- [ ] Docs are updated if behaviour or operations changed.
- [ ] Accessibility checked with keyboard only, with no new axe violations.
