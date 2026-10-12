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
| F10 | **Owner-only authoring**: the owner can draft, save and publish blog posts from the browser, including on a phone. Nobody else can use the admin area or see that it is there: no nav link, no admin markup in public pages. Drafts never reach the public repo. |
| F11 | **Rich-text editing**: header sizes (H2–H4), bold, italic, links, lists, quotes, code blocks, and **image sections** that break up the text. Each image section has alt text, an optional caption and a size (column, wide or full width), and can be moved up or down. |
| F12 | **Publishing from the editor**: one click turns a draft into a Markdown post that goes live through the normal CI and deploy, with progress shown in the editor. Published posts can be edited and unpublished the same way. |

### 1.2 Non-functional

| Concern | Target |
|---------|--------|
| **Cost** | Domain only, about $10–15 per year. Everything else stays on free tiers, and there is a documented $5/month upgrade path if limits are ever reached. |
| **Traffic** | Personal-site scale: about 100–5,000 page views per day and fewer than 50 games running at once. |
| **Latency** | Static pages served from the edge with a first contentful paint under 1.5 s on 4G. Game moves reach the other player in under 150 ms round trip in the same region. |
| **Availability** | Best effort, with no single VM to patch. A failed deploy can be rolled back with one command. |
| **SEO** | Blog, snippet and resume pages ship prerendered HTML with OG and meta tags, a sitemap and an RSS feed. |
| **Security** | No secrets in the browser. Strict security headers. Game messages are validated against a schema. Lobby creation is rate limited. Admin routes are gated twice: by Cloudflare Access at the edge and by a JWT check in the Worker. |
| **Privacy** | The repo is public, so draft text, draft image keys, the owner's e-mail and test keys never go into git. A post becomes public only when the owner clicks Publish. |
| **Maintainability** | One repo, one language (TypeScript) on both client and server, and game rules shared between client and server. |
| **Authoring** | Blog posts are written in the owner-only editor (§4.9) or by hand as Markdown. Either way the published post is a Markdown file in git. Other content is still Markdown or YAML published by `git push`. Publishing from the editor opens a PR that the owner merges; the post is live about a minute after the merge. |

### 1.3 Constraints and assumptions

- The team is one person, comfortable with React and familiar with Python and SQL.
- Content volume is small: fewer than about 1,000 posts and snippets and a few thousand photos.
- There is only one author, so there are no user accounts in the app. The owner signs in to the admin area through Cloudflare Access (§4.9.1). Game players are anonymous and pick a display name.
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
| D8 | Owner access | **Cloudflare Access** path app on `/admin` and `/api/admin`, plus a JWT check in the Worker | Sign in with Google in the app; passkeys | $0, no auth code to own beyond a 60-line verifier, and the games' WebSockets keep working. See [ADR-0004](./adr/0004-owner-only-admin-access.md). |
| D9 | Authoring | **TipTap editor in `/admin`**. Drafts in D1. Publish opens a GitHub App PR that describes the post and its changes, and the owner merges it, so git stays the source of truth. | D1 as the source of truth with snapshot deploys; Decap CMS | Keeps ADR-0002 (history, PR checks, prerendering) and keeps drafts out of the public repo. See [ADR-0005](./adr/0005-in-browser-authoring.md). |

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

The owner-only admin (`/admin`, `/api/admin/*`) runs in the same Worker, behind
Cloudflare Access. It adds a D1 database for drafts, an R2 binding for uploads
and calls to the GitHub API on publish. §4.9 has its own diagram.

### 3.1 Build-time data flow (content)

```
content/**/*.md, *.yaml
        │  scripts/build-content.ts
        │   1. parse frontmatter (gray-matter) → validate (zod) → fail build on error
        │   2. render Markdown → HTML (unified/remark/rehype + Shiki highlighting,
        │      from packages/content-markdown once §4.9 lands; adds ::figure)
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
│     │  └─ routes/admin.*    # owner-only editor (client data only, never prerendered)
│     ├─ worker/              # Worker entry, /api/lobbies (api.ts), GameLobby DO
│     │  ├─ admin-auth.ts     # requireOwner: path canonicalisation, host check, Access JWT, CSRF
│     │  ├─ admin/            # /api/admin/* handlers: drafts, images, posts, publish
│     │  └─ github.ts         # GitHub App client (installation token, Git Data API, GraphQL)
│     ├─ migrations/          # D1 migrations for the "blog" database
│     ├─ public/              # favicon, robots.txt, resume.pdf (generated)
│     └─ wrangler.jsonc
├─ packages/
│  ├─ game-core/              # pure TS: game rules, protocol schemas, lobby state machine
│  ├─ content-schema/         # zod schemas shared by build script and app
│  └─ content-markdown/       # one Markdown pipeline for build, preview and editor (§4.9.4)
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
└─ .github/workflows/         # ci.yml, deploy.yml, uptime.yml, backup.yml
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
updated: 2026-10-22                    # optional; the editor sets it on republish
category: engineering                  # must exist in taxonomy.yaml
tags: [cloudflare, websockets, typescript]
summary: "One-paragraph summary used in cards, RSS and meta description."
cover: blog/ws-cover.webp              # optional, R2 key
draft: false
---
Markdown body…
```

The body can contain image sections (`::figure[…]{…}`, §4.9.4). The editor
never writes `slug` or `draft`. A `draft: true` file is still public in the
repo, so private drafts belong in the editor.

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
| `/blog/:slug` | prerender | Shiki-highlighted code, reading time, tags, prev/next. Shows "Published <date> · Updated <date>", the second part only when `updated` differs from `date`. |
| `/snippets`, `/snippets/:slug` | prerender | Copy button, language filter |
| `/photos`, `/photos/album/:album` | prerender | Masonry grid and lightbox. Uses `srcset` from R2 variants. |
| `/tags`, `/tags/:tag` | prerender | Mixed list grouped by content type |
| `/search?q=&type=&tag=` | client | Also a global `Ctrl+K` command palette |
| `/games` | prerender shell | List of available games |
| `/games/tictactoe` | prerender | Create or join lobby |
| `/games/tictactoe/:code` | server, on demand | Live game (shareable link). A malformed code is a 404, a lowercase code redirects. |
| `/admin`, `/admin/drafts/:id`, `/admin/posts/:slug` | client, owner only | Never prerendered. Data comes only from `/api/admin/*`. Anyone else gets the Access login or a 404 (§4.9). |
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
| `4003` | The socket didn't send `join` within 10 s, or it sat unjoined while newer sockets needed room (see Lobby rules, step 2) | Yes, with backoff |

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
2. Connect: `ctx.acceptWebSocket(ws, [connId])` (hibernation). Each socket's attachment holds `{connId, role, openedAt}`. Upgrades are never refused, so a player reclaiming a held seat can always get back in. A socket that hasn't sent `join` within 10 seconds is closed (`4003`). When an upgrade arrives, older unjoined sockets are also closed (`4003`), oldest first, to make room for it. That happens only past the lobby's free places (10 minus joined sockets, plus 2 so both seat holders can reconnect) and only for sockets older than 3 seconds. A younger socket may be a client whose `join` is still on its way, for example when a whole lobby reconnects after a deploy. There is also a hard cap of 12 unjoined sockets of any age, past which the oldest is closed, so sockets that never join can't pile up.
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
| `/admin*`, `/api/admin/*` | `no-store, private`, plus `X-Robots-Tag: noindex` |

### 4.7 Error handling

- **Build:** schema violations, broken internal links, unknown categories or tags without an alias, and duplicate slugs all fail the build and print the file and line.
- **Client:** route-level error boundaries and a 404 page. Search falls back to plain substring matching if the index fails to load.
- **Game client:** reconnects with exponential backoff (about 0.5, 1, 2, 4, 8 s, each ±25% random jitter so clients dropped together don't retry in lockstep, then gives up with a "Reconnect" button) and replays `join` with the stored token. Close codes `4000`, `4001` and `1008` don't reconnect (§4.5). Server `error` messages show as toasts, and an optimistic move that the server refuses is undone.
- **Worker:** wraps handlers in try/catch, returns JSON errors, and logs structured JSON to Workers Logs.

### 4.8 Security

- Security headers, set with a `_headers` file and the Worker: `Content-Security-Policy` (`default-src 'self'; img-src 'self' https://photos.<domain> data:; connect-src 'self' wss://<domain>; …`), `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Markdown is rendered at build time from trusted content, but `rehype-sanitize` is still applied in case content is ever pasted in from elsewhere.
- The Cloudflare API token used by CI is scoped to the minimum (Workers Scripts:Edit, Workers R2 Storage:Edit, Account Settings:Read, and D1:Edit once the authoring migrations exist) and stored in the `main` GitHub Environment, which only the `main` branch can deploy from (a required reviewer can be added). It is set only on the Wrangler steps (migrations, deploy, rollback), never on the job, so `pnpm install` and `pnpm build` run without it. The nightly backup has its own narrower credentials (hosting guide §2.9).
- Dependabot and `pnpm audit` run in CI. GitHub secret scanning and push protection are on.
- The site-wide CSP above isn't shipped yet (there is no `_headers` file). It ships with Step 10.1, before any owner session can exist, because XSS anywhere on `ry-mart.com` could make same-origin admin calls while the owner is signed in. `img-src` must include `https://photos.ry-mart.com`.
- The admin area has its own stricter rules. §4.9.8 lists them.

### 4.9 Authoring (owner only)

The owner writes posts in a browser editor at `/admin`. Drafts live in D1, so
they never touch the public repo. Publishing turns a draft into the same
Markdown file a hand-written post would be, commits it on a branch through a
GitHub App, and lets CI and `deploy.yml` ship it. Git stays the source of truth
for published posts, and blog pages stay prerendered. The decisions are in
[ADR-0004](./adr/0004-owner-only-admin-access.md) (access) and
[ADR-0005](./adr/0005-in-browser-authoring.md) (drafts, editor, publishing).

```
Owner's browser (/admin)              Worker "site", behind Access            GitHub
────────────────────────              ────────────────────────────            ──────
TipTap editor ── autosave ──────────▶ PUT /api/admin/drafts/:id ──▶ D1 "blog"
  │  (Markdown through the bridge)
  ├─ preview: renderMarkdown() runs in the browser, no Worker CPU
  ├─ image: resize, WebP, no EXIF ──▶ PUT /api/admin/images/:id/:w ──▶ R2 "photos"
  └─ Publish ───────────────────────▶ POST …/publish ── App token ──▶ commit on blog/<slug>-<t>
                                                                      → PR → ci → owner merges
                                                                      → deploy.yml → live
     status every 10 s ◀───────────── GET …/status ◀── PR checks, deploy run, /api/health
```

#### 4.9.1 Access control

Two layers. Each one alone should stop an outsider. The Worker serves admin
only on the exact paths Access covers, so every admin request has passed Access
too, and Access's own controls (binding cookie, logout, token revocation) apply
to all of them.

**Layer 1, Cloudflare Access (edge).** Zero Trust Free, one self-hosted app
"Site admin" with two destinations: `ry-mart.com` path `admin` and
`ry-mart.com` path `api/admin`. A path with no wildcard covers itself and its
subpaths. `admin/*` would leave bare `/admin` open, so don't add `/*`. The
policy allows only the owner's e-mail, through the Cloudflare login (which the
owner already reaches with Google). Cookie: SameSite Lax, HttpOnly, Binding
cookie on. CORS settings empty. Never use Worker-level "Protect this Worker":
it answers WebSocket upgrades with 403 and would break the games.

**Layer 2, the Worker gate** (`worker/admin-auth.ts`). It is the first thing
`fetch()` does, before `/api/*` dispatch and before React Router's request
handler, so it also covers requests that fall through to the Worker without
matching `run_worker_first`. The admin router is mounted behind it, so no route
opts in on its own.

1. **Is it admin?** Canonicalise the path to *detect* admin: percent-decode (a decode error is 400), lowercase, collapse `//`, strip a trailing `.data`. Admin means `/admin`, `/admin/…`, `/api/admin` or `/api/admin/…`. React Router 7 matches `/ADMIN`, `/%61dmin` and `/admin.data` to admin routes, and Access's handling of those isn't documented.
2. **Exact path only.** If the raw path isn't already in canonical form (any capital letter, `%`, `//` or `.data`), return 404 before looking at a token. Only the lowercase spellings Access covers are ever served (draft ids, image ids and slugs are lowercase too). No admin route and no route above it (root included) has a server `loader` or `action`, so the client never needs `/admin.data`.
3. **Host.** 404 unless the host is `ry-mart.com`. `workers_dev` and `preview_urls` are set to `false`. Version URLs aren't generated for a Worker with a Durable Object. Previews (`wrangler preview`) can still exist; they don't inherit production secrets or bindings, and the host check covers them.
4. **Token.** Read only the `Cf-Access-Jwt-Assertion` header. On `ry-mart.com` a missing header means Access wasn't in front, so it is a 404 and a log line (never the token). There is no cookie fallback. Verify with `jose`: RS256 only, issuer = team domain, audience = the app's AUD tag, `maxTokenAge` = the session length, keys from `<team>/cdn-cgi/access/certs` (fetched once per isolate, matched by `kid`). Then require `type === "app"` and `email` equal to the `OWNER_EMAIL` secret, ignoring case. Any failure is a 404. A missing `OWNER_EMAIL` fails closed. A failed key fetch is a 503.
5. **Writes** (POST, PUT, PATCH, DELETE). Require `Origin: https://ry-mart.com`, `Sec-Fetch-Site: same-origin` when the header is present, `Content-Type: application/json` (`image/*` on uploads) and `X-Admin: 1`. A cross-site request then needs a preflight, and Access answers the cookie-less `OPTIONS` with 403. Admin routes never send CORS headers.
6. **Every admin response** gets `Cache-Control: no-store, private`, `X-Robots-Tag: noindex`, `X-Frame-Options: DENY` and `frame-ancestors 'none'`. `robots.txt` gets `Disallow: /admin`.

`run_worker_first` becomes `["/api/*", "/admin", "/admin/*"]`, and `/admin` is
never in the prerender list. Admin routes have no server loader or action that
returns data, so even a reachable admin HTML shell holds nothing private.

**The Edit link on public posts.** Prerendered HTML has no admin markup.
`GET /api/admin/me` returns `{email}` and sets a non-HttpOnly
`owner_hint=1` cookie. On a post page, a client-only effect probes
`/api/admin/me` (`redirect: "manual"`, `X-Requested-With: XMLHttpRequest`) only
when that cookie exists, and shows "Edit" only on a 200. A visitor without the
cookie makes no admin request at all. A forged cookie costs one failed probe.
"Sign out" links to `/cdn-cgi/access/logout` and clears the hint.

**Expired sessions.** The admin bundle wraps `fetch` for `/api/admin/*`. It adds
`X-Requested-With: XMLHttpRequest`, so Access answers an expired session with
401 rather than a cross-origin redirect, and `X-Admin: 1`, which the gate
requires on every write. The editor then shows "Session expired,
sign in again" and keeps the unsaved text in `localStorage`.

#### 4.9.2 Admin routes and API

| Route | What it does |
|-------|--------------|
| `/admin` | Drafts and published posts, with status badges, "New post" and "Sign out" |
| `/admin/drafts/:id` | The editor, metadata panel, preview, revisions and publish status |
| `/admin/posts/:slug` | Opens the edit draft for a published post, creating it from `main` if needed (the target of the public Edit link) |

| Method | Path | Request → response |
|--------|------|--------------------|
| `GET` | `/api/admin/me` | → `200 {email}`, sets `owner_hint` |
| `GET`, `POST` | `/api/admin/drafts` | list · create → `201 {id, rev}` |
| `GET`, `PUT`, `DELETE` | `/api/admin/drafts/:id` | load · autosave `{baseRev, …fields}` → `200 {rev}` or `409 {rev, updatedAt}` · discard (deletes its images) |
| `GET`, `POST` | `/api/admin/drafts/:id/revisions`, `…/revisions/:rev/restore` | list · restore (a new rev with reason `restore`) |
| `POST` | `/api/admin/images` | `{draftId, ext, width, height, alt}` → `201 {id, widths}` |
| `PUT` | `/api/admin/images/:id/:width` | raw bytes → `200` · `413` over 10 MB · `415` not JPEG, PNG, WebP or GIF, not the type recorded for `:id`, or carrying metadata |
| `GET` | `/api/admin/posts` | published posts on `main`, with blob SHAs |
| `POST` | `/api/admin/drafts/:id/publish` | → `202 {pr, branch}` · `409` changed on GitHub · `422` validation errors |
| `GET` | `/api/admin/drafts/:id/status` | → `{stage, pr, runUrl?, mergeSha?}` |
| `POST` | `/api/admin/drafts/:id/cancel` | closes the PR and deletes its branch |
| `POST` | `/api/admin/posts/:slug/unpublish` | opens a PR that deletes the file |

Errors use the same JSON shape as the rest of `/api` (§4.5).

#### 4.9.3 Editor

- **Library:** TipTap 3 (`@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extensions`), exact versions pinned. Not `@tiptap/markdown` (it corrupts content) and not the drag-handle extension (it pulls in yjs).
- **Effects:** H2, H3 and H4 (H1 is the title, a separate field; type `## ` or press `Mod-Alt-2/3/4`), bold (`Mod-B`), italic (`Mod-I`), inline code, links, bullet and numbered lists, quotes, code blocks with a language picker, horizontal rules and image sections. Underline is off, because Markdown can't store it.
- **Layout:** a fixed toolbar on every screen size (a bubble menu fights the phone's own selection menu). A metadata panel above the body: title, summary (1–300 characters, with a counter), category and tags, checked live against the shared `postFrontmatter` schema. A **Raw Markdown** tab is the escape hatch when the editor misbehaves.
- **Preview:** side by side on desktop, a tab on phones. It runs the same `renderMarkdown()` as the build, debounced 300 ms, with Shiki loaded on first use (about 135 KB gzipped). It uses the same `.prose` and figure CSS as the public page, so it looks like the live post. Languages missing from the shared list show as plain text in the preview only.
- **Paste:** plain-text Markdown on the clipboard goes through the bridge.
- **"Download .md" and "Copy as Markdown"** give the exact `content/blog/YYYY-MM-DD-slug.md` file. Before the publish steps ship, this is how a post gets published: commit the file through a normal PR. It is also a per-draft backup. Downloading or copying marks the draft's images `published = 1`, because the file may now be live (§4.9.6).
- **No cover upload yet.** Public pages don't render `cover` today. The editor keeps an imported post's `cover` value as it is and has no picker (§7).
- **Bundle:** the editor loads with `React.lazy` inside `/admin` only, with `useEditor({immediatelyRender: false})` because the app server-renders. About 191 KB gzipped, plus Shiki on first preview. A CI check fails if a public route chunk imports `@tiptap` or the bridge.

#### 4.9.4 Document format and image sections

Markdown is the only stored format, in D1 and in git. Editor JSON exists only
in memory. `packages/content-markdown` (browser- and Node-safe, no `fs`) holds
the one pipeline used by `build-content.ts`, the preview and the editor:

- `markdownToDoc` / `docToMarkdown`: a remark bridge (about 150 lines) between Markdown and TipTap JSON. It writes `-` bullets, `*` emphasis, `` ` `` fences and `-` rules.
- `remarkLeafDirective`: only the **leaf** form of the directive syntax. The full `remark-directive` also turns on inline directives, which turn `16:9` and `10:30am` into empty `<div>`s.
- `remarkFigure`, `sanitizeSchema`, `renderMarkdown(md, {highlighter})` and `SHIKI_LANGS`.

**Image section syntax.** One line, with blank lines around it:

```md
::figure[A *caption* with [inline](https://example.com) Markdown]{src="blog/2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e.webp" alt="What the image shows" size="wide" w="2048" h="1365"}
```

| Part | Rule |
|------|------|
| `[…]` | Caption, optional. Inline Markdown only. `]` and `\` are escaped. |
| `src` | Required. The logical key `blog/<uuid>.<ext>`, matching `^blog/[0-9a-f-]{36}\.(webp\|jpg\|png\|gif)$`. Never a URL. |
| `alt` | Required and non-empty. |
| `size` | `column` (default, prose width), `wide` (up to about 1,100 px) or `full` (edge to edge). |
| `w`, `h` | Required. Size of the largest stored variant, for layout without shift. |

**Variants.** The uploader stores `blog/<uuid>-<width>.<ext>` for each of 480
and 1024 that is narrower than `w`, plus one at `w` itself (`w` is at most 2048;
bigger images are scaled down first). The build works out the same list from
`w`, so it needs no database. A GIF is stored once, as `blog/<uuid>.gif`, with
no `srcset`: `POST /api/admin/images` returns `widths: [w]` for it, and the
`PUT` for that width writes the key without a width suffix.

**Rendered HTML** (build and preview):

```html
<figure class="figure figure--wide">
  <img src="https://photos.ry-mart.com/blog/<uuid>-1024.webp"
       srcset="…-480.webp 480w, …-1024.webp 1024w, …-2048.webp 2048w"
       sizes="(min-width: 1100px) 1100px, 100vw"
       width="2048" height="1365" alt="What the image shows" loading="lazy" decoding="async">
  <figcaption>A <em>caption</em> with <a href="https://example.com">inline</a> Markdown</figcaption>
</figure>
```

`sizes` depends on the size class. The build fails with file and line on a
missing `alt`, an unknown `size`, a bad `src`, missing `w`/`h` or an unknown
directive name. The sanitize schema adds only `figure`, `figcaption`, the class
allowlist `figure figure--column figure--wide figure--full`, and `img`
`srcset`, `sizes`, `loading` and `decoding`. Raw HTML is still dropped.

#### 4.9.5 Drafts: storage, autosave and backups

D1 database `blog`, binding `DB`, migrations in `apps/web/migrations`. Times are
Unix milliseconds. Published posts are **not** stored here: D1 only remembers
where a draft was published (`source_path`, `base_sha`, `merge_sha`).

```sql
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,               -- random, made by the server
  kind TEXT NOT NULL CHECK (kind IN ('new','edit')),
  source_path TEXT,                  -- content/blog/<file>.md once published or imported
  base_sha TEXT,                     -- blob SHA of source_path on main when loaded or last published
  slug TEXT UNIQUE,                  -- locked after the first publish
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  category TEXT,
  tags TEXT NOT NULL DEFAULT '[]',   -- JSON array
  cover_key TEXT,                    -- kept from an imported post; no upload UI yet
  body_md TEXT NOT NULL DEFAULT '',  -- Markdown, at most 512 KB
  rev INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','publishing','published','failed','archived')),
  pr_number INTEGER, pr_branch TEXT, head_sha TEXT, merge_sha TEXT,
  publish_error TEXT,                -- HTTP status or run URL only, never content
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER
);
CREATE TABLE draft_revisions (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  title TEXT NOT NULL, body_md TEXT NOT NULL,
  meta TEXT NOT NULL,                -- JSON: summary, category, tags, cover
  reason TEXT NOT NULL CHECK (reason IN ('interval','manual','publish','restore','conflict')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (draft_id, rev)
) WITHOUT ROWID;
CREATE TABLE images (
  id TEXT PRIMARY KEY,               -- crypto.randomUUID(), part of the R2 key
  draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  ext TEXT NOT NULL CHECK (ext IN ('webp','jpg','png','gif')),
  widths TEXT NOT NULL DEFAULT '[]', -- JSON, variants stored so far
  width INTEGER NOT NULL, height INTEGER NOT NULL,   -- largest variant
  bytes INTEGER, alt TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('pending','ready','orphan')),
  published INTEGER NOT NULL DEFAULT 0,              -- once 1, never deleted automatically
  created_at INTEGER NOT NULL, orphaned_at INTEGER
);
CREATE INDEX images_by_draft ON images(draft_id);
CREATE INDEX images_by_state ON images(state, orphaned_at);
```

**Autosave.** 2 s after the last keystroke, at most every 10 s while typing.
`PUT` runs `UPDATE drafts SET …, rev = rev + 1 WHERE id = ? AND rev = ? RETURNING rev`.
No row back means another tab saved first: `409`, and the editor offers
"Reload" or "Overwrite". Overwrite first snapshots the other tab's version
(reason `conflict`), so a conflict never loses work. A `BroadcastChannel` tells
other tabs about the new rev. `localStorage` (in try/catch) keeps the last
unsaved body for crash recovery. Autosave stops after 3 errors in a row and
says so. Bodies are always bound parameters (a statement over 100 KB fails),
and every statement in a D1 batch carries the rev guard, because a batch
doesn't stop when an `UPDATE` matches no rows. Non-stop typing is at most about
1,800 writes an hour, against 100k a day free.

**Revisions.** A snapshot at most every 10 minutes of editing, plus on Save,
Publish, Restore and conflict overwrite. Every `publish` revision is kept
forever. The rest are capped at the newest 50 per draft, pruned in the same batch.

**Backups.** Four layers: `draft_revisions`, D1 Time Travel (7 days on Free),
a nightly `backup.yml` that runs `wrangler d1 export` into the private R2
bucket `blog-backups` (no custom domain, 90-day lifecycle rule; it never prints
content, because Actions logs on a public repo are public), and the per-draft
"Download .md".

#### 4.9.6 Image uploads

1. **Browser** (admin only): `createImageBitmap` applies the EXIF rotation. Canvas resizes to the variant widths (never upscaling) and encodes WebP at quality 0.8. Safari can't encode WebP from a canvas, so when `blob.type` isn't `image/webp` it lazy-loads `@jsquash/webp` or falls back to JPEG at 0.82. Re-encoding keeps only pixels, so EXIF and GPS are gone. GIFs (chosen by sniffing the file's bytes, not by its name or `file.type`) are uploaded as they are. SVG and AVIF are refused. Alt text is required before the image is inserted.
2. `POST /api/admin/images` returns a server-made UUID and the widths to upload, and writes a `pending` row.
3. `PUT /api/admin/images/:id/:width` per variant. The Worker checks the owner and CSRF rules, requires `Content-Length` ≤ 10 MB, reads the bytes and sniffs magic bytes (JPEG `FF D8 FF`, PNG `89 50 4E 47`, GIF `GIF8`, WebP `RIFF…WEBP`). Anything else is 415, whatever the client claimed. The sniffed type must match the `ext` in the `images` row. The Worker also refuses (415) any file that carries metadata: JPEG `APP1` (Exif or XMP), PNG `eXIf` or an XMP `iTXt`, WebP `EXIF` or `XMP ` chunks (or those `VP8X` flags), a GIF XMP application extension. So a client bug can't publish a location; the browser step is not the only control. It then calls `PHOTOS.put("blog/<id>-<width>.<ext>", bytes, {httpMetadata: {contentType: <sniffed>, cacheControl: "public, max-age=31536000, immutable", contentDisposition: "inline"}})` (`blog/<id>.gif` for a GIF) and marks the row `ready` when every width is there.
4. The editor inserts the figure node: a preview, required alt, size picker, **Move up / Move down / Remove** buttons (also `Alt+Shift+Up/Down`, because dragging doesn't work on phones) and an inline caption that takes bold, italic and links.

A Transform Rule on `photos.*` adds `X-Content-Type-Options: nosniff` (R2
metadata can't set it). **Privacy:** draft images are public to anyone who has
the URL, but the keys have 122 random bits and public buckets can't be listed.
**Clean-up:** each save marks images the draft no longer uses as orphans.
Discarding a draft deletes the objects and rows of its images that aren't
`published` (deletes are free). An image becomes `published` when the draft
goes Live, or earlier when its `.md` is downloaded or copied, since that file
may have been committed by hand. A daily cron (`scheduled()`, 1 of 5 free) deletes `pending` rows older
than a day and unpublished orphans older than 7 days. An image that was ever
published is never deleted automatically. A deleted object can stay in the
edge cache for up to a year unless purged by URL.

#### 4.9.7 Publishing, editing and unpublishing

**Checks before anything leaves D1.** The browser renders the post with
`renderMarkdown()` and runs `postFrontmatter`, and blocks Publish on any error.
The Worker runs `postFrontmatter` again, a regex lint of each `::figure` line,
checks that every figure key is a `ready` row in `images`, checks the
target path against `^content/blog/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$`,
and checks the slug against `main` and open `blog/*` PRs. The Worker never runs
unified or Shiki (10 ms CPU). CI is the final check.

**Confirm dialog.** "Publishing makes this text public on a GitHub pull request
now. It goes live about a minute after you merge that PR, and it stays in git
history even if you cancel." The same wording shows for a typo fix on a live
post: it also needs a merge.

**The file.** `content/blog/<YYYY-MM-DD>-<slug>.md`. The date is the owner's
local date at first publish, and the slug comes from the title (editable until
the first publish, then locked). Frontmatter is written value by value with
`JSON.stringify` (valid YAML): `title`, `summary`, `date`, `updated` on
republish, `category`, `tags`, and `cover` only when an imported post already
had one. Never `slug` or `draft`. `date` never changes after the first publish.
Republishing a published post sets `updated` to the owner's local date at that
publish.

**Publish** (`POST /api/admin/drafts/:id/publish`, at most about 10 GitHub
calls, under the 50-subrequest limit, all with a `User-Agent` and an
installation token):

1. Mint the installation token (an RS256 App JWT, then `POST /app/installations/{id}/access_tokens`), cached in the isolate until close to expiry.
2. `GET git/ref/heads/main` → commit M and tree T.
3. For an edit, read the file on M (`GET contents` returns its blob SHA and text) and compare the SHA with `base_sha`. Different means someone changed it in git: `409`, and the editor offers to load the GitHub version. It never overwrites silently. The text is the old version for the PR's "What changed".
4. `POST git/trees` with `base_tree: T`: the file, plus `sha: null` for an old path on unpublish.
5. `POST git/commits` → C. Author: the owner's GitHub no-reply identity from the plain var `GIT_AUTHOR` (`TheRizz <19941577+TheRizz@users.noreply.github.com>`), never `OWNER_EMAIL`, which would go into public history. Committer: the App's bot. A unit test checks that no GitHub request body contains `OWNER_EMAIL`.
6. `POST git/refs` → `refs/heads/blog/<slug>-<unix time>`.
7. `POST pulls` with the title and body below. The Worker stops here: it never merges and never turns on auto-merge. The owner reviews the PR and merges it.

Publishing again while that PR is open pushes a new commit to the same branch
(`PATCH git/refs`, `force: false`) instead of opening a second PR, refreshes the
body (`PATCH pulls`) and adds a comment saying what changed since the previous
`publish` revision.

**The PR.** Built from the post alone (never `OWNER_EMAIL`, draft ids or other
drafts), so the owner can review it on GitHub, from a phone too:

- **Title:** `Publish: <title>`, `Update: <title>` (the post is on `main`) or `Unpublish: <title>`.
- **Overview:** `https://ry-mart.com/blog/<slug>`, summary, category and tags, reading time (the build's formula), "Created <date>" and, on an update, "Updated <date>".
- **Images:** each figure inline as `![alt](https://photos.ry-mart.com/blog/<uuid>-1024.webp)` with its caption, so the alt text is reviewed beside the picture.
- **What changed:** for an update, a table of the frontmatter fields that changed (old → new), then each body section (split at H2 and H3 lines) that was added, removed or edited, by heading, with its word-count change, and figures added or removed. For a new post, its section headings and word count. For an unpublish, the deleted path. Plain string work, well inside 10 ms of CPU.
- **Review checklist** (task list): reads well; alt text and captions right; summary and tags right; nothing private in the text or images; `ci` green, then **Squash and merge**.

**Status.** The editor polls every 10 s. The Worker makes one GraphQL query
(PR state, checks, merge commit), then `GET actions/runs?head_sha=<merge>&event=push`,
then reads `/api/health`. Stages: *PR #N opened → CI running (about 2 min) →
waiting for your review (links to the PR) → merged → deploying (about 1 min) →
Live*, where Live means `/api/health` reports the merge SHA. Then the draft's
images get `published = 1`. A PR closed on GitHub without a merge puts the
draft back to Draft. On a CI failure: a link to the run, "Fix and republish" or
"Cancel" (closes the PR, deletes the branch). On a deploy failure: a link to
the run (one real deploy has already needed a manual re-run).

**Editing a published post.** `/api/admin/posts` lists `content/blog` on `main`
with one GraphQL tree-and-blob query, cached by tree SHA. Edit imports the file
into a draft (`kind: edit`, `source_path`, `base_sha`) or reuses the existing
one. Publishing keeps the file name and `date` and sets `updated` to the
publish day, and the post page shows both dates. The slug is locked, so a link
that was copied and shared keeps working.

**Unpublishing** is the same PR flow with a `sha: null` tree entry. The post
leaves the site on the next deploy, but stays in public git history, and the UI
says so. For something urgent, a WAF custom rule blocking `/blog/<slug>` takes
effect in seconds (hosting guide §6).

**The App's reach.** Contents and Pull requests write, Actions and Checks read,
no Workflows permission, installed on this repo only, and never a ruleset bypass
actor. A second ruleset stops it from creating or updating any branch except
`blog/**` (`main` changes only through a PR that passes `ci`). The Worker never
calls a merge endpoint, but Contents and Pull requests write still let a stolen
key merge **any** open PR whose `ci` is green (Dependabot's, the owner's
unfinished work, or a stranger's fork PR), close PRs, and create tags (nothing
deploys from a tag). Two guards limit what that can ship:

- **`ci.yml`:** a first step, inline in the YAML and run before checkout and `pnpm install`, reads the PR's file list from the API and fails when the PR author is the bot, or any commit has the bot as committer, and a file outside `content/blog/` changed. It runs no script from the repo, because the Workflows permission protects only `.github/workflows/`, not `.github/scripts/`.
- **`deploy.yml`:** runs on `main` after the merge. The App has no Workflows permission, so GitHub refuses its commits and merges that edit `.github/workflows/` (Step 10.8 confirms this). Before install, build or deploy, it fails when `github.actor`, or the author or merger of the PR behind the commit, is the bot and the compare API's file list for `<before>...<sha>` touches anything outside `content/blog/`. A failed deploy e-mails the owner, who reverts the merge.

Both guards depend on the `ci` check staying required in the `main` ruleset;
hosting guide §2.10 checks it.

#### 4.9.8 Security

| Threat | Defence |
|--------|---------|
| Reaching admin on a host Access doesn't cover (`*.workers.dev`, Previews) | Host check (404), JWT check on every admin request, `workers_dev: false`, `preview_urls: false` |
| Path variants (`/ADMIN`, `/%61dmin`, `/admin.data`) Access may not match | Canonicalise to detect admin, then 404 any spelling that isn't already canonical, even with a valid token. The gate runs first for every request that reaches the Worker. No server loaders in the admin branch. |
| Forged or replayed token | RS256 against the team keys, exact issuer and audience, `maxTokenAge`, `type: app`, owner e-mail. Header only, no cookie fallback. The binding cookie, logout (about 30 s) and "Revoke existing tokens" are enforced by Access, and they cover every admin request because only Access-matched paths are served. |
| CSRF (the Access cookie defaults to SameSite None) | SameSite Lax, plus Origin, Sec-Fetch-Site, content type and `X-Admin` checks. No CORS headers. |
| XSS riding the owner's session | Only Markdown is stored. All HTML comes from the shared pipeline with `rehype-sanitize`. Figure `src` must be an R2 key. No raw HTML. Admin CSP, sent instead of the site-wide one on every admin path: `default-src 'self'; script-src 'self' 'nonce-…' 'sha256-<theme script>' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https://photos.ry-mart.com blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` (a per-request nonce for React Router's inline scripts; no analytics and no WebSocket). Site-wide CSP from §4.8 everywhere else. |
| Malicious upload (SVG with script, polyglot, huge file) | Magic-byte allowlist that must match the recorded type, type set from the sniff, `nosniff`, inline disposition, 10 MB cap, owner only |
| Private data in the public repo | Drafts only in D1. Owner e-mail and App key are Worker secrets, and commits use the no-reply author. EXIF stripped in the browser, and the Worker refuses files with metadata. PR body holds post content only. `*.pem` and `*.key` are gitignored, and the App key is converted outside the repo. Push protection is on. |
| Private data in logs | The Worker never logs draft bodies or image keys (Workers observability is on). `publish_error` holds status codes and run URLs only. `backup.yml` prints no content. |
| Stolen App key | It can push `blog/**` branches, open and close PRs, create tags, and merge **any** PR whose `ci` is green, including a stranger's fork PR. The Worker itself never merges, and auto-merge is off in the repo. The `ci.yml` guard fails its own PRs that touch code. The `deploy.yml` guard refuses to deploy a bot merge that touches code, and the owner reverts it. Rotate the key in the App settings. |
| Lost work | Rev check (409), conflict snapshot, `localStorage` copy, revisions, Time Travel, nightly export, `base_sha` check before publish. Images of a downloaded `.md` are never deleted automatically. |
| Test identity leaking into production | See §4.9.9 |
| A compromised dependency in CI | Cloudflare token only on Wrangler steps, not during install or build. `pnpm` runs install scripts only for `esbuild` and `workerd` (`allowBuilds`). Backups use their own narrow credentials. |

#### 4.9.9 Testing

Tests sign their own tokens. Production auth has no switch to turn it off.

- **Unit (Vitest, Node):** `verifyAccessJwt` with a generated key pair and a local key set: valid, wrong audience, wrong issuer, expired, HS256 confusion, wrong e-mail. `requireOwner`: wrong host, missing or foreign Origin, cross-site `Sec-Fetch-Site`, a missing header with a valid `CF_Authorization` cookie, and `/ADMIN`, `/API/ADMIN/me`, `/%61pi/admin/me`, `/admin.data` returning 404 even with a valid token. A table-driven test walks every admin route and expects 404 without a token. Bridge golden tests: parse → doc → serialize is idempotent, the rendered HTML is the same before and after a round trip, typed syntax stays escaped, `16:9` and `10:30am` survive, bad figures fail. Upload sniffing (SVG, a renamed file, and a type that differs from the row are 415), a raw phone JPEG with GPS is 415, the GIF key has no width suffix, and no `Exif` segment after re-encoding. D1 revision checks with fakes. The GitHub client against fetch fakes: the full publish sequence, slug collision, `base_sha` 409, token expiry, no request to a merge or auto-merge endpoint, and no request body containing `OWNER_EMAIL`. PR title and body for a new post, an update (frontmatter table, sections added, removed and edited) and an unpublish. The frontmatter writer round-trips through `gray-matter` and `postFrontmatter`.
- **E2E (Playwright against `vite preview`):** `pnpm e2e:keys` runs **before** `pnpm build` (in CI and in the local `pnpm e2e` server command), because the Vite plugin copies `.dev.vars` into the build output at build time and `vite preview` reads that copy. It writes only the public key (`ACCESS_TEST_JWKS`) to the gitignored `apps/web/.dev.vars`, and the private key to the gitignored `e2e/.auth/`. Wrangler drops `.dev.vars` keys that aren't declared once a `secrets` block exists, so `OWNER_EMAIL` is not declared in `secrets.required`; `deploy.yml` checks `wrangler secret list` for it instead, and the gate fails closed without it. Global setup signs a token and fails fast with a clear message if `/api/admin/me` doesn't accept it. Tests send it in `Cf-Access-Jwt-Assertion`. The Worker reads `ACCESS_TEST_JWKS` only when the host is `localhost` or `127.0.0.1`. If it is set on any other host, the gate logs an alert and refuses every admin request. GitHub is a local stub through a `GITHUB_API_BASE` override, which is honoured on localhost only. Local D1 and R2 come from Miniflare.
- **Guards in CI:** a grep fails if `ACCESS_TEST_JWKS` or `GITHUB_API_BASE` appears in `wrangler.jsonc`. `deploy.yml` never writes `.dev.vars`, and `wrangler deploy` never uploads it. A fixture test seeds a draft and checks its text and image keys never appear in `posts.json`, the RSS feed, the sitemap, the search index or a PR body. A bundle check keeps TipTap out of public chunks.
- **Production checks** after each auth change are in the hosting guide runbook (§5 and §6).

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
| D1 or Access outage | The admin is down. The public site is unaffected. | Drafts have a `localStorage` copy. Nightly export to R2. |
| Publish stuck (CI failed, or merged but the deploy failed) | The post isn't live yet | The editor shows the stage and links to the run. Fix and republish, or re-run the deploy. |

**Monitoring (all free):** Cloudflare Web Analytics (cookieless) for traffic,
Workers Logs and Observability for errors, an `uptime.yml` GitHub Action cron
every 30 min that hits `/` and `/api/health` and opens an issue on failure,
plus Cloudflare billing and usage notifications.

---

## 6. Trade-off analysis

| Decision | We gain | We give up | Revisit when |
|----------|---------|------------|--------------|
| Cloudflare instead of a Python VPS | $0 hosting, no servers to run, edge latency, WebSockets built in | Python for the backend. Some lock-in through the Durable Objects API. | You need heavy Python-only libraries (ML or data work) on the backend. You could then add a small Python service beside this one. |
| Content as code | Versioning, review in PRs, $0, prerendered SEO | Non-technical editors can't help. Posting from a phone needs the editor (§4.9). | Content other than posts needs an editor too. |
| Browser editor that publishes through a PR (§4.9) | Posting from any device, private drafts, git history, CI checks and a review of every publish kept | A PR to merge by hand for every publish, then about a minute to live. Two stores (D1 and git). A GitHub App key in the Worker. Text is public on the PR before it is live. | Merging by hand becomes a chore (turn on auto-merge for publish PRs), or the wait becomes painful (make the App a bypass actor, about 1 minute, or move posts to D1, ADR-0005 option B). |
| Cloudflare Access for the admin (§4.9.1) | $0, no login code, MFA through Google | Part of the config lives in the Zero Trust dashboard. A card on file. | Another person needs access, or the admin grows. Move it to `admin.ry-mart.com`. |
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
- Editing snippets, photos or the resume in the browser (only blog posts get the editor)
- Slug redirects after a rename (for example a `content/redirects.json` written in the same commit)
- Truly private draft images (a WAF-blocked `drafts/` prefix, copied on publish)
- Cover images: render `cover` on post cards and as the OG image, then add a cover picker to the editor
- Auto-merge for publish PRs, if merging each one by hand becomes a chore
- A faster publish path that skips CI (the App as a ruleset bypass actor)

---

## 8. Open questions for the owner

1. ~~**Domain name:** which name and which TLD?~~ **Decided:** `ry-mart.com`, registered at Cloudflare. Photos are served from `photos.ry-mart.com`.
2. **Public or private repo?** A public repo gets unlimited Actions minutes. A private one gets 2,000 minutes a month, which is still plenty.
3. **Resume privacy:** show phone and address, or only e-mail and LinkedIn?
4. ~~**Should game lobbies allow spectators?**~~ **Decided:** yes, up to 8 per lobby. The next one is told the lobby is full.
5. **Analytics:** is Cloudflare Web Analytics (cookieless, so no cookie banner) acceptable?

Authoring (§4.9). Answered by the owner on 2026-10-12:

6. ~~**Sign-in method:** the Cloudflare login you already use, or direct Google login through Access?~~ **Decided:** the existing Cloudflare login (the Access "Cloudflare" identity provider, restricted to account members). No Google Cloud setup.
7. ~~**Session length:** 24 hours or up to 7 days?~~ **Decided:** 24 hours.
8. ~~**`workers_dev: false` and `preview_urls: false`?**~~ **Decided:** yes. The `<subdomain>.workers.dev` fallback URL and Preview URLs go away.
9. ~~**Publish speed and exposure:** about 4 minutes, with the text public on a GitHub PR from the click, or the fast path?~~ **Decided:** the PR flow. Posts aren't sensitive, so the text being public on the PR first is fine.
10. ~~**Repo settings:** change the `main` ruleset to match hosting guide §2.4 and turn on auto-merge?~~ **Decided:** yes to the §2.4 ruleset, no to auto-merge. Publish opens a PR with an overview and a summary of the changes (§4.9.7), and the owner reviews and merges it by hand. The owner sets required approvals to 0 in the `main` ruleset (GitHub doesn't let you approve your own PRs). The GitHub default branch is now `main`.
11. ~~**Updated date:** show "Updated <date>" on posts edited after publishing?~~ **Decided:** yes. A republish sets `updated` automatically, `date` never changes, and the post shows both.
12. ~~**Slugs:** lock a post's URL after the first publish, or add redirects later?~~ **Decided:** locked after the first publish, so a copied link keeps working.
13. ~~**Draft images:** are unguessable URLs private enough?~~ **Decided:** yes. No `drafts/` prefix.
14. ~~**Card on file:** acceptable, with a billing alert?~~ **Decided:** yes. The owner has put a card on file and set the R2 billing alert (hosting guide §2.8).
