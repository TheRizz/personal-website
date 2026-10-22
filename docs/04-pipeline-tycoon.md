# Pipeline Tycoon: design spec

An idle "tycoon" game at `/games/pipeline-tycoon`: you start by copy-pasting CSVs by hand and end
up integrating every byte of data on Earth. Decisions below were settled in a design interview on
2026-10-22; ADR-0006 records the anti-cheat architecture.

## 1. Game design

| Topic | Decision |
| --- | --- |
| Model | Hybrid: Cookie Clicker style menus (HTML) plus a live "factory" scene (Phaser) that fills in as you buy. |
| Currency | One: **Records**. Prestige currency: **Architecture Points (AP)**. |
| Click | The big node in the scene "processes" records. Click upgrades add a share of production per click. |
| Generators | 10 tiers, each ~10–15× the cost of the last: Intern copy-pasting CSVs, Cron job script, SFTP drop folder, REST API connector, Message queue, ETL cluster, Data lake, Multi-region mesh, Orbital relay satellites, Planetary integration grid. Cost grows 15 % per unit owned. |
| Upgrades | Per-generator ×2 multipliers at ownership milestones, click upgrades, and synergies (one tier boosts another). |
| Events | **Golden packet**: drifts across the scene now and then; clicking it gives a burst or a short production overclock. No negative events. |
| Prestige | **Platform Migration**: reset generators, upgrades and Records for AP; each AP is a permanent production boost. One prestige layer. |
| Achievements | ~30, each a permanent +1 % production. Some reward trying things (e.g. linking the CLI, phase 2). |
| Ending | Soft: buying **Integrate Earth** plays a victory screen, then `INCOMING CONNECTION REQUEST — ORIGIN: UNKNOWN — PROTOCOL: UNRECOGNIZED` with a greyed-out ACCEPT. Play continues. |
| Pacing targets | First purchase < 15 s; first migration ≈ 45 min; 3–4 migrations to the ending; ≈ 3 h active. A greedy bot in the test suite checks these stay in range. |
| Art | Drawn in code: dark terminal / neon schematic, glowing nodes, packets moving along links, monospace text. No image assets (and no `data:`/`blob:` textures, so the CSP is unchanged). |
| Sound | Light effects, **muted by default**, with a toggle. |
| Layout | Phone: scene on top, shop in a tabbed bottom panel (Generators / Upgrades / Migrate / Stats). Desktop: scene and shop side by side. |

## 2. Architecture

```
packages/tycoon-core      rules + replay validator (shared by web, Worker and CLI)
apps/web/app/routes/games.pipeline-tycoon.tsx   page (prerendered shell)
apps/web/app/components/games/tycoon/*          HTML shop + Phaser scene (client-only import)
apps/web/app/lib/games/tycoon/*                 client game loop + sync
apps/web/worker/tycoon-api.ts                   /api/tycoon/* endpoints
apps/web/migrations-tycoon/*.sql                D1 database `tycoon` (binding TYCOON_DB)
packages/pipeline-tycoon-cli (phase 2)          npx @rymart/pipeline-tycoon
```

### 2.1 One rules module

Everything that affects numbers lives in `@site/tycoon-core`: costs, rates, upgrade effects,
achievements, golden-packet schedule, migration, the ending and the offline cap. The browser, the
Worker and the CLI import the same code, so progress is identical everywhere and the server can
re-run what a client claims. Every save carries `RULES_VERSION`; the server refuses an older one
with "update to keep playing" and migrates stored saves forward.

### 2.2 Server-validated saves (ADR-0006)

The client never uploads its state. It uploads an **action log** — what the player did and when,
relative to the last save — and the server **replays** it from the last state it accepted:

- Time credited for a save is `min(client elapsed, server elapsed + 5 s)`; a fast clock or speed hack
  gains nothing. Gaps between actions longer than the offline cap are capped.
- Clicks are batched per second and capped at 20 per second.
- Purchases the replayed state can't afford, golden packets that weren't on screen, and anything
  else invalid are **dropped**, not fatal. The server returns the canonical state and the client
  adopts it, so an honest client never notices and a cheating one gets nothing.
- Golden packets come from a seeded schedule the server issues per session, so they can't be
  invented.
- On load, offline time since the last save is credited up to **8 hours**, by the server's clock.

### 2.3 Few requests

| When | Request |
| --- | --- |
| First visit | `POST /api/tycoon/players` → anonymous player id + secret token (kept in localStorage). Rate-limited per IP. |
| Each page load | `POST /api/tycoon/session` → canonical state with offline earnings applied, a new session id and golden-packet seed. Starting a session ends any other open session (newest wins). |
| Every 5 min, on tab close (`keepalive`), before a migration, at the ending | `PUT /api/tycoon/save` with the log since the last save. |

About 12 requests per hour of active play, none per click. A save from a superseded session gets
`409 session_replaced` and the page asks you to reload.

### 2.4 Storage

A separate D1 database, `tycoon`, so game data never shares a database with the blog. One row per
player (`players`: id, token hash, state JSON, rules version, state time, session id, save
counter, timestamps). Expand-only migrations, like `blog`. Included in the nightly backup.

## 3. Phases

1. **Web game with validated saves** — everything in §1 except the CLI and the public leaderboard.
2. **Pairing codes and the CLI** — "Link a device" shows a 6-character code; `npx @rymart/pipeline-tycoon` renders the same scene as a terminal schematic (space processes, number keys buy).
3. **Leaderboard and moderation** — opt-in top 50 by lifetime Records, cached for a few minutes; names 3–16 of `[A-Za-z0-9_]`, profanity-filtered, hideable from `/admin`.

## 4. Owner to-dos

- ~~Before phase 2 ships: an npm account and an org named `rymart`.~~ Done: npm user `ry-mart`, org `rymart`; the CLI publishes as `@rymart/pipeline-tycoon`.
- Before deploying phase 1: the Cloudflare API token in GitHub secrets needs D1 edit on the new
  `tycoon` database (an account-wide D1 Edit permission already covers it).
