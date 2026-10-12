# personal-website

A personal website with a resume, a categorised blog, code snippets, photos,
site-wide tags and search, and a 1v1 WebSocket game lobby (tic-tac-toe). It's
built with React and runs on Cloudflare's free tier. It deploys through GitHub
Actions, and the only running cost is the domain (about $10–12 per year).

> **Status:** the scaffold, deploy pipeline, site shell, blog and games are built (most of
> Phase 1, Step 2.1, a first cut of Step 3.2, and Phases 7–8). Tic-tac-toe is playable.
> Resume, snippets, photos and search are placeholder pages.
> The visual style is modelled on [godobject.dev](https://godobject.dev/).

## Quickstart

Requires Node 24 and pnpm (`npm i -g pnpm`).

```sh
pnpm install
pnpm dev          # http://localhost:5173, drafts included
pnpm build        # builds content, then prerenders every page
pnpm --filter web preview   # serves the production build on the Workers runtime
pnpm e2e          # builds, serves on :4173 (or reuses a server already there), runs Playwright
```

Checks that CI runs: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm e2e`. Before the first `pnpm e2e`, install the browser with
`pnpm exec playwright install chromium`.

To play, open `/games`: create a tic-tac-toe lobby and send the code or invite link to a
friend. The game design is in [design doc §4.5](docs/01-system-design.md#45-game-service-design).

### Writing a post

Add `content/blog/YYYY-MM-DD-your-slug.md`:

```yaml
---
title: "Post title"
date: 2026-10-11
summary: "One or two sentences shown in lists and link previews."
tags: [cloudflare, typescript]
draft: false
---
```

Bad frontmatter fails the build with the file name and field. Site name, intro text and
social links live in [`apps/web/app/site.ts`](apps/web/app/site.ts).

## Planning docs

| Doc                                                                     | What's in it                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [System design](docs/01-system-design.md)                               | Requirements, architecture, data model, API and WebSocket protocol, trade-offs       |
| [Hosting, purchases and ops](docs/02-hosting-and-costs.md)              | What to buy, account setup, CI/CD, go-live checklist, runbook                        |
| [Execution plan](docs/03-execution-plan.md)                             | Phased, PR-sized steps with acceptance criteria                                      |
| [ADR-0001: Hosting platform](docs/adr/0001-hosting-platform.md)         | Cloudflare Workers + Durable Objects compared with a Python VPS                      |
| [ADR-0002: Content as code](docs/adr/0002-content-as-code.md)           | Markdown/YAML in git compared with a database and CMS                                |
| [ADR-0003: Client-side search](docs/adr/0003-client-side-search.md)     | MiniSearch compared with server-side full-text search                                |
| [ADR-0004: Owner-only admin](docs/adr/0004-owner-only-admin-access.md)  | Cloudflare Access plus a Worker JWT check, compared with in-app login                |
| [ADR-0005: In-browser authoring](docs/adr/0005-in-browser-authoring.md) | Private drafts in D1 published as Markdown PRs, compared with D1-first and Decap CMS |

## Stack at a glance

- **Frontend:** React 19 + React Router v7 (Vite) with prerendered content routes and Tailwind CSS
- **Backend:** one Cloudflare Worker that serves static assets and `/api/*`, plus a Durable Object for each game lobby
- **Storage:** content in Markdown/YAML in this repo, photos in Cloudflare R2
- **Search:** MiniSearch index built in CI
- **CI/CD:** GitHub Actions with PR previews, production deploys, smoke tests, automatic rollback and an uptime cron
