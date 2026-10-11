# ADR-0003: Client-side search index

**Status:** Proposed · **Date:** 2026-10-11 · **Deciders:** Ryan Martinez

## Context

Users need to search across posts, snippets, photo captions and the resume,
filtering by type and tag. The content is small (well under 1,000 documents)
and changes only when the site is deployed.

## Options considered

1. **MiniSearch index built in CI, loaded lazily by the browser.** Results update on every keystroke with fuzzy and prefix matching and field boosts. No backend and no per-query cost. Works offline once loaded.
2. **Pagefind.** A static search library that indexes the built HTML in chunks and scales to very large sites. It's a weaker fit for structured filters over mixed content types and for a React command palette.
3. **Server-side full-text search** (D1 / SQLite FTS5 behind `/api/search`). Scales well and would allow query analytics, but every keystroke costs a network round trip and counts as a Worker request.
4. **Hosted search** (Algolia, Typesense Cloud). Excellent, but adds a vendor, keys and possible cost. Overkill at this size.

## Decision

Choose **Option 1 (MiniSearch)**. Only the first 1,000 characters of each body
are indexed, and the index has a hard budget of 300 KB gzipped, enforced in CI.

## Consequences

- The search UI and the tag filters share the same data model.
- There are no search analytics. If you want them, log only the query string to Workers Analytics Engine (free tier).
- **Revisit when** the gzipped index goes over 300 KB or there are more than 5k documents. Move to Pagefind (static) or D1 FTS5 (server-side). The `Search` component should sit behind a small `searchProvider` interface so the backend can be swapped without changing the UI.
