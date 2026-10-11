# ADR-0001: Hosting platform and backend runtime

**Status:** Proposed · **Date:** 2026-10-11 · **Deciders:** Ryan Martinez

## Context

The site needs (a) static and prerendered React pages, (b) somewhere to store
photos, and (c) a stateful WebSocket service for 1v1 game lobbies. The owner
knows a Python API with a SQL database best, but cost should be as low as
possible and nobody should have to run servers. Deployment must go through
GitHub Actions.

## Options considered

### A. Cloudflare Workers (static assets) + Durable Objects + R2 — TypeScript
- **Cost:** $0 on Workers Free (100k dynamic requests per day; SQLite-backed DOs included since April 2025; R2 10 GB free with no egress fees). Only the domain is paid for, about $10–12 per year.
- **WebSockets:** one Durable Object per lobby is a single authoritative instance, so no Redis or pub/sub is needed. The Hibernation API means idle sockets aren't billed for duration, incoming messages are billed at 20:1, and auto-response pings are free.
- **Ops:** no OS, TLS or scaling work. Atomic deploys and `wrangler rollback`.
- **Cons:** the backend is TypeScript, not Python. The DO API is specific to Cloudflare. Free-tier limits fail hard (429) instead of billing overages.

### B. FastAPI + SQLite/Postgres on a small VPS (Hetzner, DigitalOcean, Lightsail) — Python
- **Cost:** about $5–7 per month (about $60–85 per year) plus the domain.
- **WebSockets:** native in FastAPI/Starlette. Lobby state lives in memory on a single process, or in Redis if you scale to more than one.
- **Ops:** you own OS patching, Docker, Caddy TLS, backups, firewall and uptime. Deploys over SSH from GitHub Actions (`docker compose pull && up -d`).
- **Pros:** familiar language, portable, and any Python library works.

### C. PaaS free tiers (Render, Railway, Koyeb) — Python
- **Cost:** $0 to about $5 per month.
- **Cons:** free web services sleep when idle, so the first request after a sleep takes about 30 s or more and open WebSockets are dropped. That's a poor fit for game lobbies. Free tiers also change often.

## Decision

Choose **Option A**. The game and the site run as one Worker with static assets
and a `GameLobby` Durable Object, and photos go in R2.

## Consequences

- One language (TypeScript) across the frontend, backend and shared game rules (`packages/game-core`). The browser and the server use the same move validation.
- Running cost is the domain only. The $5/month Workers Paid plan is the escape hatch if traffic grows.
- **Limiting lock-in:** game rules are pure TS with no Cloudflare imports. The DO is a thin transport layer of about 200 lines. Moving to Option B later means rewriting only that layer as a FastAPI WebSocket endpoint and porting `game-core` (or calling it through a small Node sidecar).
- If a Python backend becomes necessary later (for example, ML features), add it as a separate service (Option B) behind `/api/py/*`. The rest of the design doesn't change.

## Revisit when

- The free-tier daily limits are reached regularly. Upgrade to Paid first, then reconsider.
- Features need Python-only libraries or long-running CPU jobs.
