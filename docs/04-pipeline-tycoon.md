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
| First visit | `POST /api/tycoon/players` → anonymous player id + secret token (kept in localStorage). Rate-limited per IP (20 a minute, enough for a shared office network). |
| Each page load | `POST /api/tycoon/session` → canonical state with offline earnings applied, a new session id and golden-packet seed. Starting a session ends any other open session (newest wins). |
| Every 5 min, on tab close (`keepalive`), before a migration, at the ending | `PUT /api/tycoon/save` with the log since the last save. |
| Linking (rare) | `POST /api/tycoon/pair` → a code; `POST /api/tycoon/pair/claim` → a secret for the new device; `DELETE /api/tycoon/device` to unlink (§3.1). |

About 12 requests per hour of active play, none per click. A save from a superseded session gets
`409 session_replaced` and the page asks you to reload.

### 2.4 Storage

A separate D1 database, `tycoon`, so game data never shares a database with the blog. One row per
player (`players`: id, token hash, state JSON, rules version, state time, session id, save
counter, timestamps), plus `devices` (one secret hash per linked device) and `pairing_codes`.
Expand-only migrations, like `blog`. Included in the nightly backup.

## 3. Phases

1. **Web game with validated saves** — everything in §1 except the CLI and the public leaderboard.
2. **Pairing codes and the CLI** (§3.1, §3.2).
3. **Leaderboard and moderation** — opt-in top 50 by lifetime Records, cached for a few minutes; names 3–16 of `[A-Za-z0-9_]`, profanity-filtered, hideable from `/admin`.

### 3.1 Linking devices

Either side can show a code and the other claims it:

- **Web → CLI:** Stats → *Play in your terminal* → *Show a link code*, then
  `npx @rymart/pipeline-tycoon link <CODE>`.
- **CLI → web:** `pipeline-tycoon code` (or `c` on the CLI's Stats tab), then Stats → *Have a code
  from another device?* in the browser. That browser switches to the CLI's game (after a warning);
  its old game stays on the server.

Codes are 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no look-alikes), work once, for
10 minutes, one live code per player. Claiming is rate-limited (10 a minute per IP), so guessing
one of ~887 million codes in its 10 minutes is hopeless. A claim mints a **new secret for that
device** (stored hashed in `devices`), so unlinking one device (`pipeline-tycoon unlink`) revokes
only its own secret. The first link unlocks the *Works On My Machine* achievement (rules v2).

### 3.2 The CLI

`packages/pipeline-tycoon-cli`, published as **`@rymart/pipeline-tycoon`**. It shares more than
the rules: the sync controller and HTTP client (`TycoonController`, `TycoonClient` in
`tycoon-core/src/client.ts`) are the same code the web page runs, so both sync identically.

- **Screen:** the web scene as a terminal schematic — tiers around the core, links drawn with box
  characters, packets moving along them, the golden packet ◆ (`g` catches it), the shop beside it.
  Truecolor, 256 or 16 colours, or none (`NO_COLOR`, `--no-color`). Needs 80×24.
- **Keys:** space/enter process, 1–0 build, `x` ×1/×10/×100, tab/←→ panels, letters buy upgrades,
  `m m` migrate, `c` link code, `s` save, `q` save and quit.
- **Storage:** only `<player>.<secret>`, in `~/.config/pipeline-tycoon/config.json` (mode 0600;
  `%APPDATA%` on Windows).
- **Bundle:** esbuild bundles the CLI, the shared code and zod into one file with no runtime
  dependencies (~110 kB gzipped). `stage.mjs` lays out exactly what goes to npm.
- **Out of date:** a rules bump makes the server answer 426; the CLI says to run
  `npx @rymart/pipeline-tycoon@latest`.

## 4. Owner to-dos

- ~~Before phase 2 ships: an npm account and an org named `rymart`.~~ Done: npm user `ry-mart`, org `rymart`; the CLI publishes as `@rymart/pipeline-tycoon`.
- ~~Before deploying phase 1: the Cloudflare API token needs D1 edit on `tycoon`.~~ Done (deployed).
- ~~Before the first CLI release, once: see §5, *First release*.~~ Done 2026-10-22: 0.1.0 published by hand, trusted publisher set up; 0.1.1 was the first release from `release-cli.yml`.

## 5. Releasing the CLI

Bump `version` in `packages/pipeline-tycoon-cli/package.json`, merge, **let the site deploy
first** (a new `RULES_VERSION` must be live before a CLI that speaks it), then tag:

```sh
git tag cli-v0.1.1 && git push origin cli-v0.1.1
```

`release-cli.yml` checks the tag matches the version, runs the core and CLI tests, stages the
package and publishes it with npm trusted publishing (no token stored; provenance attached).

**First release (once).** npm can only trust a workflow for a package that already exists, so
`0.1.0` goes out by hand:

1. `npm login` as `ry-mart` (a member of the `rymart` org).
2. From the repo: `pnpm install && pnpm --filter @rymart/pipeline-tycoon run stage`.
3. `npm publish packages/pipeline-tycoon-cli/publish --access public --no-provenance`.
4. On npmjs.com: package → Settings → *Trusted publisher* → GitHub Actions, repository
   `TheRizz/personal-website`, workflow `release-cli.yml`, environment empty, and tick **Allow npm
   publish** (otherwise the workflow may only stage releases).
5. The connection shows *Pending validation* until the workflow first publishes through it (npm
   gives two days), so push a tag soon after.
6. From then on, releases are tags.
