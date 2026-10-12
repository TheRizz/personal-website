# Personal Website — System Design

Status: **Proposed** · Owner: Ryan Martinez · Last updated: 2026-10-12

This document started as the planning baseline. The skeleton, site shell, blog
and game are built now, and §4.5 describes the game as built. The phased
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
   │                            │──── POST /init (stub.fetch) ▶│                           │
   │◀──── 201 {code:"K7QX3P"} ──│                              │                           │
   │ WS /api/lobbies/K7QX3P/ws  │──── forward upgrade ────────▶│ seat X, token tA          │
   │◀═════════ {joined, role:X, token} ═══════════════════════│                           │
   │                            │                              │◀══ WS join (code) ════════│
   │◀═════════ {state: playing, turn: X} ═════════════════════│══ {joined, role:O} ══════▶│
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
│     ├─ worker/              # Worker entry, /api/lobbies (api.ts), GameLobby DO
│     ├─ public/              # favicon, robots.txt, resume.pdf (generated)
│     └─ wrangler.jsonc
├─ packages/
│  ├─ game-core/              # pure TS: game rules, protocol schemas, lobby state machine
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
├─ e2e/                       # Playwright: lobby API, protocol, 2-player browser game
├─ playwright.config.ts       # e2e runs against `vite preview` (workerd) on port 4173
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
| `/games/tictactoe` | prerender | Create or join lobby |
| `/games/tictactoe/:code` | server, on demand | Live game (shareable link). A malformed code is a 404, a lowercase code redirects. |
| `/rss.xml`, `/sitemap.xml`, `/robots.txt` | static | |

### 4.4 Search design

- **Indexed document shape:** `{id, type: post|snippet|photo|resume, title, text, tags[], category?, language?, date, url}`
- **Fields and boosts:** title ×3, tags ×2, text ×1. Prefix and fuzzy matching (`fuzzy: 0.2`) are on.
- **Filters:** type, tag and category, applied with MiniSearch `filter`. Tag chips in the UI become filters.
- **Loading:** `search-index.json` is fetched lazily the first time the search UI opens, then cached by the browser. The file name is content-hashed for long-term caching.
- **Size budget:** at about 500 documents with roughly 300 words of text each, the index is around 300–500 KB raw and around 80–120 KB gzipped. Only the first 1,000 characters of a post body are indexed. CI fails if the gzipped index goes over 300 KB, which is the trigger to revisit ADR-0003.
- **Deep-linkable:** search state lives in the query string, so `/search?q=retry&type=snippet` can be shared.

### 4.5 Game service design

This section describes the game as built (Phases 7 and 8). The constants are in
`packages/game-core/src/constants.ts`.

**Lobby codes:** 6 characters from a 31-character alphabet with no ambiguous
characters (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`). That gives 887M combinations.
Codes use rejection sampling, so every character is equally likely. The code
maps to an object with `env.GAME_LOBBY.getByName(code)`. On create, the Worker
sends the object `POST /init`, which returns 409 if the lobby already exists.
In that case the Worker generates a new code (at most 3 attempts, then 503).

**Worker and Durable Object:** `GameLobby` is a plain class that implements
`DurableObject`. It doesn't extend the base class or import `cloudflare:workers`,
because React Router prerenders by importing the Worker module in Node, where
those don't exist. Workerd-only globals such as `WebSocketPair` are only used
inside methods for the same reason. Without the base class there is no RPC, so
the Worker calls the object with `stub.fetch()` on internal routes: `POST /init`,
`GET /info` and `GET /ws`.

The lobby rules live in `game-core` (`src/lobby.ts`) as a pure state machine. It
takes the lobby record and a message and returns the new record plus a list of
effects (send, set a socket's role, close, broadcast, expire). The Durable Object
is a thin transport: it stores the record, runs the effects and sets the alarm.
The rules are unit-tested in Node and don't depend on Cloudflare.

**HTTP API (Worker):**

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `POST` | `/api/lobbies` | `Content-Type: application/json`, `{game: "tictactoe"}` | `201 {code, game, expiresAt}` · `400` bad body · `415` wrong content type · `429` rate limited (`Retry-After: 60`) · `503` no free code after 3 tries |
| `GET` | `/api/lobbies/:code` | – | `200 {code, game, phase: waiting\|playing\|finished, seatsTaken, connectedSeats, spectators}` · `404` |
| `GET` | `/api/lobbies/:code/ws` | `Upgrade: websocket` | `101` · `404` unknown lobby · `403` `Origin` from another site · `426` not an upgrade |
| `GET` | `/api/health` | – | `200 {ok: true, version}` |

Errors are JSON (`{error: {code, message}}`) and every `/api/*` response is
`no-store`. A wrong method on a known path gets `405` with `Allow`. A malformed
code gets `404` before any Durable Object is touched, and only `/init` writes
storage, so lookups never create a lobby. `seatsTaken` includes a seat held for
a disconnected player and `connectedSeats` doesn't, so a player coming back
isn't told the game is full. The upgrade is never refused for a full lobby; the
`join` is (see below).

**WebSocket protocol** (JSON text frames, validated with zod on both ends, 4 KB max per message):

```ts
// client → server
type ClientMsg =
  | { t: "join";    name: string; token?: string }   // token = reconnect to a seat
  | { t: "move";    move: unknown; seq: number }     // seq of the latest state seen
  | { t: "rematch" }
  | { t: "leave" };

// server → client
type ServerMsg =
  | { t: "joined";  role: "X" | "O" | "spectator"; token: string | null } // null for spectators
  | { t: "state";   state: PublicState; seq: number } // full snapshot every time
  | { t: "error";   code: ErrorCode; message: string };

type ErrorCode =
  | "NOT_YOUR_TURN" | "INVALID_MOVE" | "GAME_OVER"   // from validateMove
  | "LOBBY_FULL"                                     // spectator cap reached, then close 4002
  | "BAD_MESSAGE"                                    // second join, rematch before the game ends
  | "NOT_JOINED"                                     // anything before join
  | "NOT_A_PLAYER"                                   // a spectator tried to move
  | "STALE_STATE";                                   // move.seq isn't the current seq
```

`PublicState` holds the code, game, `phase`, both players (name, `connected`, and
`releaseAt` while disconnected), the spectator count, board, result, round, who
started the round, score and rematch flags. It never contains tokens. Errors go
only to the socket that caused them and leave it open, except `LOBBY_FULL`.

The server always sends a **full state snapshot** rather than a diff. Tic-tac-toe
state is under 200 bytes, so this costs nothing and makes reconnecting trivial.
For keepalive, clients send the bare text frame `"ping"` every 30 s and get
`"pong"` back. `setWebSocketAutoResponse` answers it, so keepalives do not wake
the object and are not billed.

**Close codes:**

| Code | Meaning | Client reconnects? |
|------|---------|--------------------|
| `1000` | The player sent `leave`, and the seat was released | No |
| `1008` | A binary, oversized, non-JSON or schema-invalid frame, an unknown message type, or more than 10 messages a second | No |
| `4000` | Another socket joined with this seat's token, for example a duplicated tab. The seat moves to the new socket. | No. The old tab offers "Watch here". |
| `4001` | The lobby was idle for 30 minutes and has been deleted | No |
| `4002` | Lobby full: both seats are taken and 8 spectators are watching | Yes, with backoff |
| `4003` | The socket didn't send `join` within 10 s, or a newer socket needed its slot | Yes, with backoff |

**`game-core` abstraction** (pure functions, unit-tested, shared by browser and DO):

```ts
interface GameDefinition<S, M> {
  id: string;                         // "tictactoe"
  name: string;                       // "Tic-tac-toe"
  players: 2;
  init(firstSeat: Seat): S;           // rematches alternate who starts
  validateMove(s: S, seat: Seat, m: unknown): MoveResult<M>; // parse + legality
  applyMove(s: S, seat: Seat, m: M): S;
  status(s: S): { kind: "playing"; turn: Seat }
              | { kind: "won"; winner: Seat; line?: number[] }
              | { kind: "draw" };
}

type MoveResult<M> =
  | { ok: true; move: M }
  | { ok: false; code: "NOT_YOUR_TURN" | "INVALID_MOVE" | "GAME_OVER"; message: string };
```
To add Connect Four, you write a new `GameDefinition`, add it to `GAMES` in
`game-core`, and write a board component. The Durable Object and the lobby rules
stay as they are. The protocol's `board` schema is tic-tac-toe only for now and
would become a union of the games' states.

**Lobby rules** (in `game-core`; the Durable Object runs the effects):
1. Create: `POST /init` stores `{code, game, createdAt}` with phase `waiting`, round 1 and X first, and sets the alarm.
2. Connect: `ctx.acceptWebSocket(ws, [connId])` (hibernation). Each socket's attachment holds `{connId, role, openedAt}`. Upgrades are never refused, so a player reclaiming a held seat can always get back in. A socket that hasn't sent `join` within 10 seconds is closed (`4003`), and past 2 unjoined sockets the oldest is closed to make room.
3. `join`: a token that matches a seat gives that seat back (reconnect). If another socket still holds the seat, that socket is closed with `4000` first. Without a matching token the player takes the first empty seat, X then O. A seat held for a disconnected player isn't empty. Every seated join gets a fresh token (`crypto.randomUUID`) and the old one stops working. If both seats are taken, the socket becomes a spectator (`token: null`). Spectators are capped at 8 when they join: the ninth gets `LOBBY_FULL` and close `4002`. Seat claims and token reconnects are never refused.
4. When both seats are filled, the game starts.
5. `move`: seated players only. `seq` must equal the current seq, then the server runs `validateMove` and `applyMove`. A finished game updates the score.
6. Both players ask for a rematch after a game ends: the other seat moves first, the board resets, the round goes up by one and the score is kept.
7. Disconnect: the seat is held for 2 minutes so the player can reconnect. The other player sees a countdown from `releaseAt`. `leave` releases the seat at once.
8. Seat release (grace period over, or `leave`): the seat empties and the match resets for whoever is left: phase `waiting`, round 1, X first, score cleared. A new opponent means a new match.
9. `alarm()`: runs at the earliest seat release, join timeout or idle expiry. If there has been no client message or connection for 30 minutes, it closes every socket with `4001` and runs `ctx.storage.deleteAll()`.

The record is saved to SQLite-backed storage (`ctx.storage.kv`) after every change,
so it survives hibernation and eviction. `seq` goes up by one on every change,
and each change is broadcast to every joined socket as a full `state`. A
spectator joining or leaving broadcasts the new count without changing `seq`, so
spectators can't make a player's move fail with `STALE_STATE`.

**Abuse controls:** lobby creation is capped at 10 per minute per client IP by
the Workers Rate Limiting binding `LOBBY_CREATE_LIMITER`, keyed on
`CF-Connecting-IP`. IPv6 addresses are grouped by their /64, so rotating
addresses inside one subscriber's block doesn't reset the limit. The check runs
before the body is read, so malformed requests use up the quota too. If the
binding isn't available, a Cloudflare WAF rate-limit rule on `POST /api/lobbies`
is the fallback. WebSocket upgrades whose `Origin` is another site get 403.
Display names are 1–20 characters, trimmed, must contain a visible character,
and can't contain control or bidi-override characters. React escapes them when
rendered. Each socket can send at most 10 messages per second.

**Testing:** `@cloudflare/vitest-pool-workers` doesn't support vitest 5, so the
Worker and the Durable Object are unit-tested in Node with fakes. Playwright
covers the real runtime against `vite preview` (workerd): the HTTP API, the
protocol (including hibernation) and two players in separate browser contexts.

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
- **Game client:** reconnects with exponential backoff (0.5, 1, 2, 4, 8 s, then gives up with a "Reconnect" button) and replays `join` with the stored token. Close codes `4000`, `4001` and `1008` don't reconnect (§4.5). Server `error` messages show as toasts, and an optimistic move that the server refuses is undone.
- **Worker:** wraps handlers in try/catch, returns JSON errors, and logs structured JSON to Workers Logs.

### 4.8 Security

- Security headers, set with a `_headers` file and the Worker: `Content-Security-Policy` (`default-src 'self'; img-src 'self' https://photos.<domain> data:; connect-src 'self' wss://<domain>; …`), `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Markdown is rendered at build time from trusted content, but `rehype-sanitize` is still applied in case content is ever pasted in from elsewhere.
- The Cloudflare API token used by CI is scoped to the minimum (Workers Scripts:Edit, Workers R2 Storage:Edit, Account Settings:Read) and stored in the `main` GitHub Environment, which only the `main` branch can deploy from (a required reviewer can be added).
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
| One DO per lobby | Strong consistency, simple code | Tied to Cloudflare's runtime | Moving off Cloudflare. `game-core` is portable, so only about 450 lines of transport code (`worker/api.ts` and `worker/game-lobby.ts`) would need rewriting. |
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

1. ~~**Domain name:** which name and which TLD?~~ **Decided:** `ry-mart.com`, registered at Cloudflare. Photos are served from `photos.ry-mart.com`.
2. **Public or private repo?** A public repo gets unlimited Actions minutes. A private one gets 2,000 minutes a month, which is still plenty.
3. **Resume privacy:** show phone and address, or only e-mail and LinkedIn?
4. ~~**Should game lobbies allow spectators?**~~ **Decided:** yes, up to 8 per lobby. The next one is told the lobby is full.
5. **Analytics:** is Cloudflare Web Analytics (cookieless, so no cookie banner) acceptable?
