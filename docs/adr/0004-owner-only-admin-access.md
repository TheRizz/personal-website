# ADR-0004: Owner-only admin via Cloudflare Access and a Worker JWT check

**Status:** Accepted · **Date:** 2026-10-12 · **Deciders:** Ryan Martinez

## Context

The owner wants to write and publish blog posts from the browser (ADR-0005).
That needs an admin area (`/admin`) and an admin API (`/api/admin/*`) that only
the owner can use or even see. Today the site has no accounts, and nobody signs
in. The repo is public, so the code, route names and config are readable by
anyone, and nothing secret may live in them. The site must stay on free tiers,
and the `GameLobby` WebSockets on the same Worker must keep working.

Three facts from the Cloudflare docs shape the choice:
- The Worker uses Static Assets, so `ctx.access` is never passed to it. The Worker has to verify the Access token itself.
- A hostname or path Access app covers only the URLs it lists. `site.<sub>.workers.dev` (`workers_dev: true`) and Preview URLs (`preview_urls: true`) serve the Worker with no Access in front.
- Worker-level Access ("Protect this Worker") answers WebSocket upgrades with 403, which would break the games.

## Options considered

### A. Cloudflare Access path app, plus a JWT check in the Worker on every admin request
- **Cost:** $0. Zero Trust Free covers 50 users, and the owner uses 1 seat. Onboarding asks for a payment method but doesn't charge it.
- **How:** one self-hosted app with two paths, `ry-mart.com/admin` and `ry-mart.com/api/admin`, and an Allow policy for the owner's email. The owner signs in with the Cloudflare login they already use (Google), so there is no Google Cloud setup. The Worker then checks the `Cf-Access-Jwt-Assertion` header with `jose` (RS256, issuer, audience, `type: app`, owner email), so a request that slips past Access still fails.
- **Effort:** about 60 lines of verifier plus tests. Login UI, MFA, sessions, logout and audit logs come from Cloudflare.
- **Cons:** a vendor dashboard holds part of the config. Not tested end to end yet: one real request after setup must confirm the header reaches a Worker with Static Assets. There is deliberately no cookie fallback (decision 3).

### B. Worker-level Access ("Protect this Worker" or "Protect all Workers")
- Simpler to turn on, but it 403s WebSocket upgrades and would break `/api/lobbies/:code/ws`. Rejected.

### C. Sign in with Google inside the app (OIDC with `arctic`)
- Works on Workers and is free. You own a Google OAuth client, state and PKCE, a callback, a signed session cookie, logout, expiry and CSRF. That is about 300 lines of security-critical code against about 60 for option A.

### D. Passkeys (`@simplewebauthn/server`)
- The best phishing resistance, but credentials need storage, and registering the first passkey needs a one-time setup secret. The most work of the four.

### E. A hidden URL or a shared secret in a cookie
- The repo is public, so the URL isn't hidden, and a static secret has no expiry, revocation or MFA. Rejected.

## Decision

Choose **Option A**, with the Worker as the authority. Access is the first
layer. The Worker gate (`requireOwner`) runs before any routing and does this:

1. Canonicalise the path (percent-decode, lowercase, collapse `//`, strip a trailing `.data`) and treat `/admin`, `/admin/*`, `/api/admin` and `/api/admin/*` as admin. React Router matches `/ADMIN`, `/%61dmin` and `/admin.data` to admin routes, and Access's handling of those variants isn't documented. So any admin request whose raw path isn't already canonical is a 404, even with a valid token: only the spellings Access covers are served, and Access's binding cookie, logout and revocation apply to every one of them.
2. Return 404 unless the host is exactly `ry-mart.com`. Set `workers_dev: false` and `preview_urls: false` as well.
3. Verify the `Cf-Access-Jwt-Assertion` header (never the `CF_Authorization` cookie, which the client controls) and the owner email (a Worker secret), with a maximum token age equal to the 24-hour Access session. A missing header means Access wasn't in front. Every failure is a 404, so nothing confirms the route exists. A JWKS fetch failure fails closed.
4. On writes, require `Origin: https://ry-mart.com`, `Sec-Fetch-Site: same-origin` when present, a JSON (or image) content type and an `X-Admin: 1` header.

The admin router is mounted behind this one guard, so no route can forget it.
Design details are in [design doc §4.9.1](../01-system-design.md#491-access-control).

The owner accepted this on 2026-10-12: sign-in through the existing Cloudflare
login (the Access "Cloudflare" identity provider, restricted to account
members), 24-hour sessions, and `workers_dev` and `preview_urls` turned off
(design doc §8 Q6–8).

## Consequences

- Only the owner can load `/admin` or call `/api/admin/*`. Visitors can learn only that the routes exist and the Access team domain, and both are already public in the repo.
- Public pages stay prerendered and contain no admin markup. An "Edit" link appears on a post only after a client-side probe of `/api/admin/me` succeeds, and only browsers that carry an `owner_hint` cookie make that probe.
- New config: Access vars in `wrangler.jsonc` (team domain and AUD tag are not secret), the owner email as a secret, `run_worker_first` gains `/admin` and `/admin/*`, and `workers_dev` and `preview_urls` become `false`. The workers.dev fallback URL and Preview URLs go away.
- Tests never weaken production auth. E2E signs its own tokens against a test key that the Worker accepts only on `localhost`, and only from a gitignored `.dev.vars` written before the build. If that key is ever present on another host, the gate refuses every admin request.
- The Access cookie must be set to SameSite Lax by hand. The default is None, which would make cross-site POSTs authenticated. The Worker's Origin check covers this either way.
- A card is on file for the account, and Zero Trust Free isn't charged. R2 bills usage above its free tier, so the owner has set an R2 billing alert (hosting guide §2.8).

## Revisit when

- Someone other than the owner needs access. Add their email to the policy; 50 users are free.
- The admin surface grows (more than blog authoring). Move it to its own origin, `admin.ry-mart.com`, so XSS on the public site can't ride the owner's session.
- Cloudflare starts passing `ctx.access` to Workers with Static Assets. The manual JWT check can then use it.
