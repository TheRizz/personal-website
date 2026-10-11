# ADR-0002: Content as code (Markdown/YAML in the repo)

**Status:** Proposed · **Date:** 2026-10-11 · **Deciders:** Ryan Martinez

## Context

The resume, blog posts, snippets and photo metadata have to be stored, tagged
and served. There is one author. The usual approach would be a SQL database
with an API and an admin UI.

## Options considered

1. **Markdown/YAML files in git, compiled to JSON at build time.** Free. Versioned. Changes are reviewed in a PR with a preview URL. Content is prerendered for SEO. No backend is involved in reading content.
2. **SQL database (Cloudflare D1, or Postgres on a VPS) + REST API + admin UI.** Lets you publish from any device, but you need authentication, an admin UI, migrations and backups. Every page view also needs a database query or a cache layer.
3. **Headless CMS (Contentful, Sanity).** Nice editing experience, but adds a vendor, free-tier limits and API keys at build time.

## Decision

Choose **Option 1**. Frontmatter is validated with zod schemas
(`packages/content-schema`), and invalid content fails CI.

## Consequences

- Publishing means `git push`, then a PR preview, then a merge. You can't publish quickly from a phone (the GitHub mobile web editor works as a fallback).
- Tags and categories are checked at build time against `content/taxonomy.yaml`, which prevents tag drift.
- Photos are binary and stay **out of git**. They go in R2, and only the manifest (`photos.yaml`) is versioned.
- **Upgrade path:** a git-backed CMS (Decap CMS or TinaCMS) can be added later without changing the storage model. If dynamic content is ever needed (comments, likes), add D1 for just that data.
