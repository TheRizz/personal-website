# Personal Website — System Design

Status: **Proposed** · Owner: Ryan Martinez · Last updated: 2026-10-11

This document is the planning baseline. Nothing here is built yet. The phased
build steps are in [`03-execution-plan.md`](./03-execution-plan.md), and the
purchase, setup and operations guide is in
[`02-hosting-and-costs.md`](./02-hosting-and-costs.md).

---

## 1. Requirements

### 1.1 Functional

| ID | Requirement |
|----|-------------|
| F1 | **Resume** page with sections for experience, education, skills and projects, plus a downloadable PDF. |
| F2 | **Blog** posts, each with one **category** and any number of **tags**. Lists can be filtered by category and tag. |
| F3 | **Code snippets**: short, syntax-highlighted, copyable snippets with a language, description and tags. |
| F4 | **Photos**: a gallery with albums, captions, tags, lazy loading and a full-size lightbox. |
| F5 | **Tagging** across all content types. Each tag gets a page listing everything with that tag. |
| F6 | **Site search** across resume, posts, snippets and photo captions, with type and tag filters, fuzzy matching and keyboard access (`/` or `Ctrl+K`). |
| F7 | **Games**: a 1v1 tic-tac-toe game played over WebSockets. One player creates a lobby and gets a short code; the second player joins with that code. The server enforces turns and rules, players can reconnect, and both can ask for a rematch. |
| F8 | The games system can take more 1v1 games later (for example Connect Four) without changing the transport. |
| F9 | Deployment is automated with **GitHub Actions**: PRs get CI checks and a preview, and merging to `main` deploys to production. |

### 1.2 Non-functional

| Concern | Target |
|---------|--------|
| **Cost** | Domain only, about $10–15 per year. Everything else stays on free tiers, and there is a documented $5/month upgrade path if limits are ever reached. |
| **Traffic** | Personal-site scale: about 100–5,000 page views per day and fewer than 50 games running at once. |
| **Latency** | Static pages served from the edge with a first contentful paint under 1.5 s on 4G. Game moves reach the other player in under 150 ms round trip in the same region. |
| **Availability** | Best effort, with no single VM to patch. A failed deploy can be rolled back with one command. |
| **SEO** | Blog, snippet and resume pages ship prerendered HTML with OG and meta tags, a sitemap and an RSS feed. |
| **Security** | No secrets in the browser. Strict security headers. Game messages are validated against a schema. Lobby creation is rate limited. |
| **Maintainability** | One repo, one language (TypeScript) on both client and server, and game rules shared between client and server. |
| **Authoring** | Content is written in Markdown or YAML and published by `git push`, so no admin UI is needed. |

### 1.3 Constraints and assumptions

- The team is one person, comfortable with React and familiar with Python and SQL.
- Content volume is small: fewer than about 1,000 posts and snippets and a few thousand photos.
- There is only one author, so there are no user accounts. Game players are anonymous and pick a display name.
- Comments, likes and newsletters are **out of scope for v1** (see §7).

---

## 2. Key decisions (summary)

| # | Decision | Chosen | Main alternative | Why |
|---|----------|--------|------------------|-----|
| D1 | Hosting platform | **Cloudflare Workers** (static assets plus Durable Objects) | FastAPI on a $5/month VPS | It costs $0 instead of about $60–85 per year, there is no server to patch, and WebSockets are built in. See [ADR-0001](./adr/0001-hosting-platform.md). |
| D2 | Content storage | **Content as code**: Markdown and YAML in the repo, compiled at build time | SQL database plus an admin UI | One author, versioned in git, no database cost, and it can be prerendered for SEO. See [ADR-0002](./adr/0002-content-as-code.md). |
| D3 | Search | **Client-side index** built in CI (MiniSearch) | Server-side SQL FTS (D1 / SQLite FTS5) | Instant results, no backend, and fine below about 5k documents. See [ADR-0003](./adr/0003-client-side-search.md). |
| D4 | Frontend framework | **React 19 + React Router v7 (framework mode, Vite)** with `prerender` | Vite SPA only; Next.js; Astro | Stays in React and prerenders content routes for SEO. Pages are plain static files, so they are free to serve. |
| D5 | Real-time games | **One Durable Object per lobby**, using the WebSocket Hibernation API | Socket.IO on a VPS | Each lobby has one authoritative instance, so no Redis or pub/sub is needed. Idle lobbies cost nothing. |
| D6 | Photos | **Cloudflare R2** bucket. Resized variants are made by a script, and a manifest is kept in the repo. | Git LFS; Cloudinary | 10 GB free and no egress fees. Large binaries stay out of git. |
| D7 | Language | **TypeScript everywhere**, in a pnpm monorepo | Python backend | The game rules package is shared by the browser (optimistic UI) and the server (authority). |

> **Using Python instead:** if a Python API is a hard requirement, ADR-0001
> describes the FastAPI + SQLite/Postgres + Caddy + Docker setup on a small VPS.
> Every other decision (content as code, client-side search, R2 photos, the game
> protocol) stays the same, so only Phases 1 and 7 of the execution plan change.

---

## 3. High-level architecture

```
                         ┌──────────────────────────────────────────────┐
  Browser                │            Cloudflare (free plan)            │
 ┌──────────────┐  HTTPS │  ┌────────────────────────────────────────┐  │
 │ React app    │───────▶│  │ Worker "site"                          │  │
 │ (prerendered │        │  │  • static assets (HTML/JS/CSS/JSON)    │  │
 │  HTML + SPA) │        │  │    served free, never hits the script  │  │
 │              │        │  │  • /api/* → Worker script (run first)  │  │
 │ search-index │        │  │      POST /api/lobbies                 │  │
 │   .json      │        │  │      GET  /api/lobbies/:code           │  │
 │              │  WSS   │  │      GET  /api/lobbies/:code/ws ───┐   │  │
 │ Game client ◀┼───────▶│  │      GET  /api/health              │   │  │
 └──────┬───────┘        │  └────────────────────────────────────┼───┘  │
        │                │                 idFromName(code)      ▼      │
        │                │  ┌────────────────────────────────────────┐  │
        │                │  │ Durable Object "GameLobby" (1/lobby)   │  │
        │                │  │  • 2 seats (X/O) + reconnect tokens    │  │
        │                │  │  • authoritative state in DO SQLite    │  │
        │                │  │  • hibernating WebSockets              │  │
        │                │  │  • alarm → delete after idle TTL       │  │
        │                │  └────────────────────────────────────────┘  │
        │  HTTPS (images)│  ┌────────────────────────────────────────┐  │
        └───────────────▶│  │ R2 bucket "photos" (photos.<domain>)   │  │
                         │  └────────────────────────────────────────┘  │
                         └──────────────────────────────────────────────┘
                                          ▲
           GitHub Actions ────────────────┘  wrangler deploy / versions upload
           (lint · typecheck · test · build content · e2e · deploy · smoke)
```

**Why one Worker:** the static site and the game API share one origin, so no
CORS setup is needed. There is one deploy and one rollback. Static asset requests
are free and unlimited. Only `/api/*` runs the Worker script and counts against
the free tier of 100k requests per day.

### 3.1 Build-time data flow (content)

```
content/**/*.md, *.yaml
        │  scripts/build-content.ts
        │   1. parse frontmatter (gray-matter) → validate (zod) → fail build on error
        │   2. render Markdown → HTML (unified/remark/rehype + Shiki highlighting)
        │   3. emit typed JSON: posts, snippets, photos, resume, tags
        │   4. emit search-index.json (MiniSearch serialized)
        │   5. emit sitemap.xml, rss.xml
        ▼
apps/web/app/generated/*.json  ──▶ React Router loaders ──▶ prerendered HTML
```

### 3.2 Runtime data flow (game)

```
Player A                       Worker                 GameLobby DO (code=K7QX3P)        Player B
   │ POST /api/lobbies          │                              │                           │
   │───────────────────────────▶│ gen code, rate-limit         │                           │
   │                            │──── init(game="tictactoe") ─▶│                           │
   │◀──── 201 {code:"K7QX3P"} ──│                              │                           │
   │ WS /api/lobbies/K7QX3P/ws  │──── forward upgrade ────────▶│ seat X, token tA          │
   │◀═════════ {joined, seat:X, token} ═══════════════════════│                           │
   │                            │                              │◀══ WS join (code) ════════│
   │◀═════════ {state: playing, turn: X} ═════════════════════│══ {joined, seat:O} ══════▶│
   │ {move, cell:4} ═══════════════════════════════════════▶ │ validate via game-core    │
   │◀═════════ {state ...}      ══════════════════════════════│══ {state ...} ═══════════▶│
```

---

## 4. Deep dive

### 4.1 Repository layout (pnpm monorepo)

```
personal-website/
├─ apps/
│  └─ web/                    # React Router v7 app + Worker entry (one deployable)
│     ├─ app/                 # routes, components, styles
│     ├─ worker/              # Worker fetch handler + GameLobby Durable Object
│     ├─ public/              # favicon, robots.txt, resume.pdf (generated)
│     └─ wrangler.jsonc
├─ packages/
│  ├─ game-core/              # pure TS game rules + protocol types (no I/O)
│  └─ content-schema/         # zod schemas shared by build script and app
├─ content/
│  ├─ resume.yaml             # JSON Resume schema, YAML-encoded
│  ├─ blog/2026-10-20-my-first-post.md
│  ├─ snippets/python-retry-decorator.md
│  ├─ photos/photos.yaml      # manifest (R2 keys, captions, tags, dims)
│  └─ taxonomy.yaml           # allowed categories + tag aliases
├─ scripts/
│  ├─ build-content.ts
│  ├─ photos-upload.ts        # resize → upload to R2 → append manifest
│  └─ resume-pdf.ts           # Playwright print-to-PDF of /resume
├─ e2e/                       # Playwright tests (incl. 2-player game)
├─ docs/                      # this design + ADRs + runbooks
└─ .github/workflows/         # ci.yml, deploy.yml, uptime.yml
```

### 4.2 Content data model

All schemas live in `packages/content-schema` (zod), so a bad frontmatter field
fails CI rather than appearing broken in production.

**Blog post** (`content/blog/*.md`)
```yaml
---
title: "Building a WebSocket game on Durable Objects"
slug: websocket-game-durable-objects   # optional; defaults to filename sans date
date: 2026-10-20
updated: 2026-10-22                    # optional
category: engineering                  # must exist in taxonomy.yaml
tags: [cloudflare, websockets, typescript]
summary: "One-paragraph summary used in cards, RSS and meta description."
cover: blog/ws-cover.webp              # optional, R2 key
draft: false
---
Markdown body…
```

**Snippet** (`content/snippets/*.md`)
````yaml
---
title: "Retry decorator with exponential backoff"
language: python
tags: [python, resilience]
description: "Wraps a function and retries on exception with jittered backoff."
date: 2026-10-12
---
```python
def retry(...): ...
```
Optional explanation in Markdown.
````

**Photo manifest entry** (`content/photos/photos.yaml`)
```yaml
- id: 2026-07-yosemite-001
  title: "Half Dome at dusk"
  caption: "Shot from Glacier Point."
  album: yosemite-2026
  tags: [landscape, hiking]
  takenAt: 2026-07-14
  width: 4032
  height: 3024
  placeholder: "#3a4a5c"         # dominant colour for blur-up
  variants: { sm: 480, md: 1024, lg: 2048 }   # keys: photos/<id>-<size>.webp
```

**Resume** (`content/resume.yaml`): the [JSON Resume](https://jsonresume.org/schema)
schema in YAML. Using a standard schema means the data also works with
JSON Resume themes and exporters later.

**Taxonomy** (`content/taxonomy.yaml`): the allowed blog categories (a closed
list) and tag aliases (`js → javascript`), so tags stay consistent. Tags are
otherwise free-form, lowercase and kebab-case.

**Generated artifacts** (git-ignored; built in CI):
`posts.json`, `snippets.json`, `photos.json`, `resume.json`, `tags.json`
(`{tag: {count, items: [{type,id}]}}`), `search-index.json`, `sitemap.xml`,
`rss.xml`.

### 4.3 Routes

| Route | Render | Notes |
|-------|--------|-------|
| `/` | prerender | Intro, latest posts, featured snippets and photos |
| `/resume` | prerender | Also `/resume.pdf` (generated in CI) |
| `/blog`, `/blog/category/:category` | prerender | Paginated and filterable by tag on the client |
| `/blog/:slug` | prerender | Shiki-highlighted code, reading time, tags, prev/next |
| `/snippets`, `/snippets/:slug` | prerender | Copy button, language filter |
| `/photos`, `/photos/album/:album` | prerender | Masonry grid and lightbox. Uses `srcset` from R2 variants. |
| `/tags`, `/tags/:tag` | prerender | Mixed list grouped by content type |
| `/search?q=&type=&tag=` | client | Also a global `Ctrl+K` command palette |
| `/games` | prerender shell | List of available games |
| `/games/tictactoe` | client | Create or join lobby |
| `/games/tictactoe/:code` | client | Live game (shareable link) |
| `/rss.xml`, `/sitemap.xml`, `/robots.txt` | static | |

### 4.4 Search design

- **Indexed document shape:** `{id, type: post|snippet|photo|resume, title, text, tags[], category?, language?, date, url}`
- **Fields and boosts:** title ×3, tags ×2, text ×1. Prefix and fuzzy matching (`fuzzy: 0.2`) are on.
- **Filters:** type, tag and category, applied with MiniSearch `filter`. Tag chips in the UI become filters.
- **Loading:** `search-index.json` is fetched lazily the first time the search UI opens, then cached by the browser. The file name is content-hashed for long-term caching.
- **Size budget:** at about 500 documents with roughly 300 words of text each, the index is around 300–500 KB raw and around 80–120 KB gzipped. Only the first 1,000 characters of a post body are indexed. CI fails if the gzipped index goes over 300 KB, which is the trigger to revisit ADR-0003.
- **Deep-linkable:** search state lives in the query string, so `/search?q=retry&type=snippet` can be shared.

### 4.5 Game service design

**Lobby codes:** 6 characters from a 31-character alphabet with no ambiguous
characters (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`). That gives 887M combinations.
The code maps to an object with `env.GAME_LOBBY.idFromName(code)`. On create,
the Worker calls the object's `init()`, which fails if the lobby already exists.
In that case the Worker generates a new code (at most 3 attempts).

**HTTP API (Worker):**

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `POST` | `/api/lobbies` | `{game: "tictactoe"}` | `201 {code, game, expiresAt}` · `429` when rate limited |
| `GET` | `/api/lobbies/:code` | – | `200 {code, game, status: waiting\|playing\|finished, seatsTaken}` · `404` |
| `GET` | `/api/lobbies/:code/ws` | `Upgrade: websocket` | `101` · `404` unknown lobby · `409` full |
| `GET` | `/api/health` | – | `200 {ok: true, version}` |

**WebSocket protocol** (JSON messages, validated with zod on both ends, 4 KB max per message):

```ts
// client → server
type ClientMsg =
  | { t: "join";    name: string; token?: string }   // token = reconnect
  | { t: "move";    move: unknown; seq: number }     // move shape per game
  | { t: "rematch" }
  | { t: "leave" };

// server → client
type ServerMsg =
  | { t: "joined";  seat: "X" | "O" | "spectator"; token: string }
  | { t: "state";   state: PublicState; seq: number } // full snapshot every time
  | { t: "error";   code: "NOT_YOUR_TURN" | "INVALID_MOVE" | "LOBBY_FULL"
                       | "BAD_MESSAGE" | "GAME_OVER"; message: string };
```

The server always sends a **full state snapshot** rather than a diff. Tic-tac-toe
state is under 200 bytes, so this costs nothing and makes reconnecting trivial.
Ping/pong uses `setWebSocketAutoResponse`, so keepalives do not wake the object
and are not billed.

**`game-core` abstraction** (pure functions, unit-tested, shared by browser and DO):

```ts
interface GameDefinition<S, M> {
  id: string;                         // "tictactoe"
  players: 2;
  init(): S;
  validateMove(s: S, seat: Seat, m: unknown): M | GameError; // parse + legality
  applyMove(s: S, seat: Seat, m: M): S;
  status(s: S): { kind: "playing"; turn: Seat }
              | { kind: "won"; winner: Seat; line?: number[] }
              | { kind: "draw" };
}
```
To add Connect Four, you write a new `GameDefinition` and a board component.
The Durable Object, protocol and lobby UI stay as they are.

**GameLobby Durable Object lifecycle:**
1. `init(game)`: store `{game, createdAt, status: "waiting"}` and set an alarm for `now + 30 min`.
2. WebSocket connect: `ctx.acceptWebSocket(ws)` (hibernation). Attach `{seat, token}` with `ws.serializeAttachment`.
3. `join`: if a valid `token` is sent, give back the same seat (reconnect). Otherwise take the first free seat. A third connection becomes a spectator, capped at 10 total sockets.
4. `move`: run `validateMove`, then `applyMove`, save state to DO SQLite storage (so it survives hibernation), and broadcast `state`.
5. Both players ask for a rematch: swap who goes first, reset the board, increment the round counter, and keep the score.
6. Disconnect: mark the seat `disconnected` and keep it for 2 minutes so the player can reconnect. The other player is told.
7. `alarm()`: if nothing has happened for 30 minutes, close the sockets and run `ctx.storage.deleteAll()`. Otherwise push the alarm back.

**Abuse controls:** lobby creation is capped at 10 per minute per IP (Workers
Rate Limiting binding, or a Cloudflare WAF rate-limit rule as a fallback).
Display names are 1–20 characters, trimmed and HTML-escaped when rendered.
Unknown message types close the socket with code 1008. Each socket can send at
most 10 messages per second.

### 4.6 Caching

| Asset | Cache policy |
|-------|--------------|
| Hashed JS, CSS and JSON (`/assets/*`) | `public, max-age=31536000, immutable` |
| HTML | `public, max-age=0, must-revalidate`. Edge-cached by Workers static assets and invalidated on deploy. |
| R2 photos (`photos.<domain>`) | `public, max-age=31536000, immutable`. Keys include a version or size, so they never change in place. |
| `/api/*` | `no-store` |

### 4.7 Error handling

- **Build:** schema violations, broken internal links, unknown categories or tags without an alias, and duplicate slugs all fail the build and print the file and line.
- **Client:** route-level error boundaries and a 404 page. Search falls back to plain substring matching if the index fails to load.
- **Game client:** reconnects with exponential backoff (0.5, 1, 2, 4, 8 s, then gives up with a "Reconnect" button) and replays `join` with the stored token. Server `error` messages show as toasts and leave the board unchanged.
- **Worker:** wraps handlers in try/catch, returns JSON errors, and logs structured JSON to Workers Logs.

### 4.8 Security

- Security headers, set with a `_headers` file and the Worker: `Content-Security-Policy` (`default-src 'self'; img-src 'self' https://photos.<domain> data:; connect-src 'self' wss://<domain>; …`), `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Markdown is rendered at build time from trusted content, but `rehype-sanitize` is still applied in case content is ever pasted in from elsewhere.
- The Cloudflare API token used by CI is scoped to the minimum (Workers Scripts:Edit, Workers R2 Storage:Edit, Account Settings:Read) and stored in the **production** GitHub Environment with a required reviewer.
- Dependabot and `pnpm audit` run in CI. GitHub secret scanning and push protection are on.

---

## 5. Scale and reliability

**Load estimate (generous):** 5,000 page views per day × about 2 API calls
(search and game pages only) is about 10k Worker requests per day. 50 games per
day × about 30 messages works out to about 75 billed DO requests per day
(incoming messages are billed at 20:1). Both are far below the free-plan
allowance of 100k Worker requests per day and 100k DO requests per day. Static
assets don't count toward that.

**Headroom:** traffic could grow 10× before any limit matters. If it does, the
Workers Paid plan ($5/month) raises every limit by orders of magnitude, and no
code changes are needed.

**Failure modes:**

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Bad deploy | Site or API broken | Post-deploy smoke test fails, then the workflow runs `wrangler rollback` automatically |
| Free-tier daily limit hit | `/api/*` returns 429 until 00:00 UTC. Static site unaffected. | Usage alert e-mail. Upgrade to $5/month. |
| DO evicted mid-game | None | State is saved after every move. Clients reconnect with their token. |
| R2 outage | Images fail | `placeholder` colour plus alt text. The rest of the site is unaffected. |
| Domain expiry | Total outage | Auto-renew on, with a card that won't expire. Calendar reminder 30 days out. |

**Monitoring (all free):** Cloudflare Web Analytics (cookieless) for traffic,
Workers Logs and Observability for errors, an `uptime.yml` GitHub Action cron
every 30 min that hits `/` and `/api/health` and opens an issue on failure,
plus Cloudflare billing and usage notifications.

---

## 6. Trade-off analysis

| Decision | We gain | We give up | Revisit when |
|----------|---------|------------|--------------|
| Cloudflare instead of a Python VPS | $0 hosting, no servers to run, edge latency, WebSockets built in | Python for the backend. Some lock-in through the Durable Objects API. | You need heavy Python-only libraries (ML or data work) on the backend. You could then add a small Python service beside this one. |
| Content as code | Versioning, review in PRs, $0, prerendered SEO | Can't publish from a phone. Non-technical editors can't help. | You want to post from mobile. Add a git-based CMS (Decap or TinaCMS) or D1 plus an admin route behind Cloudflare Access. |
| Client-side search | Results on every keystroke, no backend | Index download size. No search analytics. | The gzipped index goes over 300 KB or there are more than 5k documents. Then move to D1 FTS5 or Pagefind. |
| One DO per lobby | Strong consistency, simple code | Tied to Cloudflare's runtime | Moving off Cloudflare. `game-core` is portable, so only about 200 lines of transport code would need rewriting. |
| R2 with manual upload script | Free, fast, large files kept out of git | You run a script for each batch of photos | Lots of photos. Add a `workflow_dispatch` job or a small upload page. |

---

## 7. Out of scope for v1 (backlog)

- Blog comments (could use Giscus, which is free and backed by GitHub Discussions)
- Newsletter or e-mail subscriptions
- Leaderboards or match history (would use D1, free tier)
- Matchmaking with strangers (a "quick play" queue DO)
- More games (Connect Four, Battleship), which the `GameDefinition` interface supports
- Dark mode toggle (planned as a stretch goal in Phase 2)
- An admin UI for content

---

## 8. Open questions for the owner

1. **Domain name:** which name and which TLD? `.com` costs about $10.46/yr at Cloudflare and `.dev` about $12/yr.
2. **Public or private repo?** A public repo gets unlimited Actions minutes. A private one gets 2,000 minutes a month, which is still plenty.
3. **Resume privacy:** show phone and address, or only e-mail and LinkedIn?
4. **Should game lobbies allow spectators?** The design assumes yes, up to 8.
5. **Analytics:** is Cloudflare Web Analytics (cookieless, so no cookie banner) acceptable?
