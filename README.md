# personal-website

A personal website with a resume, a categorised blog, code snippets, photos,
site-wide tags and search, and a 1v1 WebSocket game lobby (tic-tac-toe). It's
built with React and runs on Cloudflare's free tier. It deploys through GitHub
Actions, and the only running cost is the domain (about $10–12 per year).

> **Status:** planning complete, implementation not started.

## Planning docs

| Doc | What's in it |
|-----|--------------|
| [System design](docs/01-system-design.md) | Requirements, architecture, data model, API and WebSocket protocol, trade-offs |
| [Hosting, purchases and ops](docs/02-hosting-and-costs.md) | What to buy, account setup, CI/CD, go-live checklist, runbook |
| [Execution plan](docs/03-execution-plan.md) | Phased, PR-sized steps with acceptance criteria |
| [ADR-0001: Hosting platform](docs/adr/0001-hosting-platform.md) | Cloudflare Workers + Durable Objects compared with a Python VPS |
| [ADR-0002: Content as code](docs/adr/0002-content-as-code.md) | Markdown/YAML in git compared with a database and CMS |
| [ADR-0003: Client-side search](docs/adr/0003-client-side-search.md) | MiniSearch compared with server-side full-text search |

## Stack at a glance

- **Frontend:** React 19 + React Router v7 (Vite) with prerendered content routes and Tailwind CSS
- **Backend:** one Cloudflare Worker that serves static assets and `/api/*`, plus a Durable Object for each game lobby
- **Storage:** content in Markdown/YAML in this repo, photos in Cloudflare R2
- **Search:** MiniSearch index built in CI
- **CI/CD:** GitHub Actions with PR previews, production deploys, smoke tests, automatic rollback and an uptime cron
