# ADR-0006: Pipeline Tycoon saves are action logs the server replays

**Status:** Accepted · **Date:** 2026-10-22 · **Deciders:** Ryan Martinez

## Context

Pipeline Tycoon (docs/04-pipeline-tycoon.md) is an idle game with progress that syncs between the
browser and a CLI, and a public leaderboard in phase 3. The owner wants no way to edit progress
or skip time while offline, and wants as few API calls as possible (free tier: 10 ms CPU per
request, 100k D1 writes a day).

## Options considered

### A. Server-validated snapshots
The client uploads its whole state; the server checks it is plausible for the elapsed time.
"Plausible" is hard to define for purchases and upgrades: a forged state with a different mix of
generators can stay under any production bound.

### B. Fully server-authoritative
Every click and purchase is a request. Uncheatable, but one request per action, laggy on phones,
and far over the request budget.

### C. Client-only with obfuscation
Stops nobody with dev tools.

### D. Action logs replayed by the server (chosen)
The client uploads what it did since the last save; the server re-runs it with the shared rules
from the last state it accepted, crediting at most the time that really passed on its own clock.

## Decision

Choose **D**. It has A's request count (one save every 5 minutes) and B's guarantee that the
stored state is reachable by a legitimate player.

- **The server's state is canonical.** Invalid actions are dropped and the canonical state goes
  back to the client, which adopts it. Floating-point differences between engines can only drop an
  edge-case purchase, never corrupt a save.
- **Time comes from the server.** Credited time is `min(client elapsed, server elapsed + 5 s)`;
  offline time is credited at session start, capped at 8 hours.
- **Randomness comes from the server.** The golden-packet schedule is seeded per session.
- **Autoclickers** are capped at 20 clicks a second.
- **One session at a time.** Starting a session supersedes the previous one, so two clients can't
  double-count the same time.

## Consequences

- The rules must be deterministic and identical on every client: they live in one package with a
  `RULES_VERSION`, and the server refuses older versions.
- Replay cost is linear in the log; logs are capped (entries and bytes) and a 5-minute log
  replays in well under a millisecond.
- A crash loses at most the unsaved minutes (≤ 5).
- Anonymous players are a bearer token in localStorage: clearing storage without linking a device
  loses the save (accepted).
