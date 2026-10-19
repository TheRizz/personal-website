# Hosting, Purchases and Operations Guide

This guide covers what to buy, what to sign up for, how to wire it together, and
how to confirm everything works. Prices were checked in October 2026. Confirm
them on the vendor pages before you buy.

## 1. Shopping list

| Item | Vendor | Cost | Required? |
|------|--------|------|-----------|
| Domain name (e.g. `ryanmartinez.dev` / `.com`) | Cloudflare Registrar (sells at cost) | **~$10.46/yr for .com**, ~$12/yr for .dev | **Yes**, the only thing you pay for |
| Cloudflare account, Workers **Free** plan | Cloudflare | $0 | Yes |
| Durable Objects, SQLite-backed (game lobbies) | Cloudflare, included in Workers Free | $0 | Yes |
| Workers Rate Limiting binding (lobby creation) | Cloudflare | $0 | Yes, no setup (see §2.5) |
| R2 object storage (photos), 10 GB free | Cloudflare | $0 (a payment method may be needed to turn R2 on) | Yes, for photos |
| GitHub repo and Actions | GitHub Free | $0 | Yes |
| Web Analytics, DNS, TLS certificates, DDoS protection | Cloudflare | $0 | Included |
| Email Routing (`hello@yourdomain` forwarded to Gmail) | Cloudflare | $0 | Optional |
| Zero Trust **Free** plan (Access, guards the owner-only admin) | Cloudflare | $0 for up to 50 users (a payment method is required at sign-up, not charged) | Yes, for the editor (Phase 10) |
| D1 database `blog` (drafts, revisions, image ledger) | Cloudflare, included in Workers Free | $0 (5 GB, 100k rows written per day) | Yes, for the editor |
| R2 bucket `blog-backups` (private, nightly draft exports) | Cloudflare | $0 within the same 10 GB | Yes, for the editor |
| Cron Trigger (daily image clean-up) | Cloudflare, included in Workers Free | $0 (5 per account) | Yes, for the editor |
| GitHub App (publishes posts as pull requests) | GitHub | $0 | Yes, for one-click publishing |
| **Total** | | **≈ $10–12 per year** | |

**Upgrade path if you outgrow the free tier:** the Workers Paid plan is $5/month.
It raises the limits for requests, Durable Objects and logs. You only need it if
the site gets more than about 100k API requests per day, which is unlikely for a
personal site. Static page views never count toward that limit.

**Cards on file:** R2 and Zero Trust both ask for a payment method, even on
their free plans. Workers Free, D1 on Workers Free and Zero Trust Free stop
with an error at their limits. **R2 does not:** storage over 10 GB-month and
operations over 1M Class A or 10M Class B a month are billed to that card
($0.015 per GB-month, $4.50 and $0.36 per million). This site's usage is far
below that, image variants are capped at three per image and backups expire
after 90 days, and a billing alert (§2.8) warns before anything is charged.
Keep this in mind against the "domain only" rule.

**Things you do *not* need to buy:** a VPS, a managed database, an SSL
certificate, a CDN, an image host, a separate WebSocket service, or e-mail hosting.

### Why not the "usual" Python stack?

| Option | Yearly cost | Notes |
|--------|-------------|-------|
| **Cloudflare Workers + DO + R2 (chosen)** | ~$10–12 (domain) | Nothing to patch. WebSockets built in. Edge-cached. |
| FastAPI + Postgres on a Hetzner, DigitalOcean or Lightsail VPS | ~$60–85 + domain | You manage OS updates, TLS (Caddy), backups and uptime. |
| Render or Railway free tiers | $0–60 + domain | Free web services sleep when idle, which breaks WebSocket lobbies and makes cold starts slow. |
| Oracle Cloud Always Free VM | domain only | Free, but sign-up is unreliable and idle instances can be reclaimed. Same ops burden as a VPS. |

---

## 2. One-time setup (in order)

Work through §2.1–2.6 as **Phase 1** of the execution plan. §2.7–2.9 belong
to Step 10.0 and §2.10 to Step 10.7 (owner-only authoring). Each step lists a
check you can run to confirm it worked.

### 2.1 Cloudflare account and domain
1. Sign up at dash.cloudflare.com and turn on 2FA (use a hardware key or authenticator app).
2. **Domain Registration → Register Domains**: search for the name and buy it. Turn on **auto-renew** and **WHOIS redaction** (free).
   - If you already own a domain at another registrar, add it to Cloudflare as a zone and change its nameservers to Cloudflare's. A transfer is optional.
3. ✅ Check: the domain shows as **Active** in the dashboard.

### 2.2 Workers and R2
1. **Workers & Pages**: find **Your subdomain** (`<name>.workers.dev`) and select **Change** if you want a different name. The site doesn't use it: `workers_dev` and `preview_urls` are `false` for this Worker (design doc §8 Q8), so it is not a fallback URL and nothing is served there. If no subdomain appears yet, one is set up when you create your first Worker or the first time you run `wrangler deploy`. This step doesn't block anything else, since the site is served from your own domain.
2. **R2 → Enable R2**. Add a payment method if asked; usage under 10 GB is not billed.
3. Create a bucket named `photos`. Under **Settings → Custom Domains**, attach `photos.<yourdomain>`.
4. ✅ Check: upload a test image in the dashboard and open `https://photos.<yourdomain>/test.jpg`.

### 2.3 API token for GitHub Actions
1. **My Profile → API Tokens → Create Token → Custom token** with these permissions:
   - Account · Workers Scripts · Edit
   - Account · Workers R2 Storage · Edit
   - Account · Account Settings · Read
   - Zone · Workers Routes · Edit (limited to your zone)
   - Account · D1 · Edit (added at Step 10.0: `deploy.yml` applies D1 migrations). Workflows set this token only on their Wrangler steps (migrations, deploy, rollback), never on the whole job, so `pnpm install` and `pnpm build` can't read it. The nightly backup uses separate credentials (§2.9).
2. Note your **Account ID**, shown on the Workers overview page.
3. ✅ Check: run `CLOUDFLARE_API_TOKEN=… npx wrangler whoami` locally. It should list the account.

### 2.4 GitHub repository settings
1. **Settings → General → Default branch**: make it `main`. Dependabot opens its pull requests against the default branch. Done (2026-10-12).
2. **Settings → Environments → New environment**, named exactly `main`. The deploy and rollback workflows ask for that name. If it doesn't exist, GitHub quietly creates an empty one, and the deploy fails with "it's necessary to set a CLOUDFLARE_API_TOKEN environment variable".
   - **Deployment branches and tags:** Selected branches and tags → add `main`.
   - **Required reviewers** (optional): add yourself, and leave **Prevent self-review** off so you can approve your own deploys.
   - **Environment secrets** (under Secrets, not Variables): `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. **Settings → Rules → Rulesets → New branch ruleset** targeting `main`:
   - Turn on **Restrict deletions**, **Block force pushes**, **Require a pull request before merging** and **Require status checks to pass** (add the `ci` check).
   - Set **Required approvals** to `0`. GitHub doesn't let you approve your own pull request, so `1` blocks every merge.
   - Leave **Restrict updates** off. It stops everyone without bypass permission from changing `main`, including by merging pull requests.
4. **Settings → Code security**: turn on Dependabot alerts and security updates, secret scanning and push protection.
5. ✅ Check: a test PR shows the `ci` check as required and can be merged without an approval. The deploy job's first step, **Check Cloudflare credentials**, passes.
6. ✅ Check: `gh api repos/TheRizz/personal-website/environments/main/deployment-branch-policies --jq '.branch_policies[].name'` prints only `main`. The `main` environment holds the Cloudflare token, so no other branch may deploy.

> **The live ruleset doesn't match this yet** (checked 2026-10-12): it requires
> 1 approval, has **Restrict updates** on and no required status check, so
> every merge goes through the admin bypass. The owner sets approvals to 0
> themselves. Fix the rest at the latest at Step 10.7 (§2.10): the guards on
> publish PRs rely on `ci` being required. Auto-merge stays off; the owner
> merges every PR, publish PRs included, by hand.

### 2.5 Custom domain for the site
1. In `apps/web/wrangler.jsonc`, add `"routes": [{ "pattern": "<yourdomain>", "custom_domain": true }]`.
   - For `www`, don't add a Worker route. Add a proxied DNS record instead (**DNS → Records**: type `AAAA`, name `www`, IPv6 `100::`, proxy on). Then create a redirect rule (**Rules → Redirect Rules**) with a wildcard pattern: request URL `https://www.<yourdomain>/*`, target URL `https://<yourdomain>/${1}`, status `301`, **Preserve query string** on. Turn on **SSL/TLS → Edge Certificates → Always Use HTTPS** so `http://` requests are upgraded before the rule runs.
2. Deploy once (through CI or `wrangler deploy`). Cloudflare creates the DNS records and certificate automatically.
3. ✅ Check: `curl -I https://<yourdomain>` returns `200` with a valid certificate.
4. The same deploy creates the `LOBBY_CREATE_LIMITER` rate-limit binding from `wrangler.jsonc` (namespace `1001`, 10 requests per 60 s per client IP). There is nothing to set up in the dashboard; the namespace is just a number that must be unique in the account. Keep `limit` equal to `LOBBY_CREATE_LIMIT_PER_MINUTE` in `game-core`.
5. ✅ Check: the first deploy on Workers Free accepts the binding (the deploy output lists it), and the 429 check in §5 passes. If the binding is refused, the fallback is a WAF rate-limit rule (design doc §4.5).

### 2.6 Optional extras (free)
- **Email Routing:** forward `hello@<yourdomain>` to your personal inbox.
- **Web Analytics:** turn it on for the zone. It's cookieless, so you don't need a cookie banner.
- **Notifications:** turn on "Usage-based billing" and "Workers weekly summary" e-mails, so you hear early if you're getting close to the free limits.
- **Security → Settings:** "Always Use HTTPS" on, minimum TLS 1.2. The Worker and the `_headers` file already send `Strict-Transport-Security: max-age=31536000` (since Step 10.1), so leave the dashboard HSTS setting off; Step 9.4 only decides whether to add `includeSubDomains` and `preload`.

### 2.7 Cloudflare Access for the admin (Step 10.0)
1. **Zero Trust** (left menu of dash.cloudflare.com): pick a team name, for example `rymart`, which gives `https://rymart.cloudflareaccess.com`. Choose the **Free** plan and enter payment details. You won't be charged.
2. **Integrations → Identity providers:** keep the default **Cloudflare** login with **Restrict to account members** on. You already sign in to Cloudflare with Google, so no Google Cloud setup is needed. Don't add One-time PIN.
3. **Access controls → Applications → Add an application → Self-hosted**, named `Site admin`:
   - **Destinations:** `ry-mart.com` with path `admin`, and `ry-mart.com` with path `api/admin`. Don't add `/*`: `admin/*` doesn't cover bare `/admin`.
   - **Session duration:** 24 hours (design doc §8 Q7).
   - **Login methods:** only the identity provider from step 2, with Instant Auth on.
   - **Policy** `Owner only`: Action **Allow**, Include **Emails** = your address.
   - **Cookie settings:** SameSite **Lax** (the default None allows cross-site requests), HttpOnly on, **Binding cookie** on, Cookie Path off.
   - **CORS settings:** leave empty.
4. Note the **Application Audience (AUD) tag** and the team domain, and send them back. They aren't secret. Step 10.1 adds them to `wrangler.jsonc` as `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`; don't commit anything now.
5. Never turn on **Protect this Worker** or **Protect all Workers** for the `site` Worker. They answer WebSocket upgrades with 403 and break the games.
6. ✅ Check: `curl -sI https://ry-mart.com/admin` and `curl -sI https://ry-mart.com/api/admin/me` both return `302` to `<team>.cloudflareaccess.com`. You can sign in with your account, and a private window signed in with another Google account is refused.

### 2.8 D1, backup bucket and image headers (Step 10.0)
1. `cd apps/web && pnpm wrangler d1 create blog`. Note the `database_id` it prints and send it back (it isn't secret). Step 10.4 adds the `DB` binding to `wrangler.jsonc`, after §2.9 has given the CI token D1 access; don't commit it now.
2. **R2 → Create bucket** `blog-backups`. Don't attach a custom domain and leave r2.dev off. **Settings → Object lifecycle rules:** delete objects after 90 days.
3. If §2.2 isn't done yet, do it now: image sections need the `photos` bucket at `photos.ry-mart.com`. Leave r2.dev off for `photos` too.
4. **Rules → Transform Rules → Modify Response Header**: when the hostname equals `photos.ry-mart.com`, set `X-Content-Type-Options` to `nosniff`.
5. **Notifications → Add:** a **Usage Based Billing** alert for R2 (storage and Class A and B operations), sent to your e-mail, set well under the free amounts (for example 5 GB and 500k Class A). R2 bills overage instead of stopping. Done (2026-10-12), with a card on file.
6. ✅ Check: `pnpm wrangler d1 list` shows `blog`. `curl -sI https://photos.ry-mart.com/test.jpg` shows `x-content-type-options: nosniff`. `blog-backups` shows the lifecycle rule and has no public URL. The R2 billing alert is listed under Notifications.

### 2.9 Worker secret and CI tokens (Step 10.0)
1. `cd apps/web && pnpm wrangler secret put OWNER_EMAIL` with the address from the Access policy. It stays out of the public repo. `deploy.yml` checks `wrangler secret list` for it and fails without it, and the admin gate refuses everything if it is missing.
2. Edit the CI API token from §2.3 and add **Account · D1 · Edit**.
3. Backup credentials, stored as `main` environment secrets for `backup.yml` only:
   - a Cloudflare API token with only **Account · D1 · Read** (use Edit only if `wrangler d1 export` refuses Read), as `BACKUP_D1_TOKEN`;
   - **R2 → Manage API tokens → Create Account API token**, **Object Read & Write**, scoped to the `blog-backups` bucket only. Store the Access Key ID and Secret as `BACKUP_R2_KEY_ID` and `BACKUP_R2_SECRET`. The job uploads with the S3 API, so it never needs account-wide R2 access.
4. ✅ Check: `pnpm wrangler secret list` shows `OWNER_EMAIL`. `CLOUDFLARE_API_TOKEN=… pnpm wrangler d1 list` works with the CI token. The backup R2 key can list `blog-backups` and is refused on `photos`.

### 2.10 GitHub publishing (Step 10.7)
1. Fix the `main` ruleset to match §2.4: **Required approvals** `0` (you set this yourself; GitHub doesn't let you approve your own PRs), **Restrict updates** off, **Require status checks** with `ci` (source: GitHub Actions). Keep the Admin role's bypass. Your own PRs, publish PRs included, now merge by hand without the bypass once `ci` passes.
2. **Settings → General → Pull Requests:** turn on **Automatically delete head branches**. Leave **Allow auto-merge** off: you review and merge every publish PR yourself.
3. **Settings → Rules → Rulesets → New branch ruleset** `bot scope`: target all branches, exclude `main` and `blog/**`. Turn on **Restrict creations**, **Restrict updates** and **Restrict deletions**. Bypass: the Admin role, **Dependabot**, and the **Claude** GitHub App if it is installed (Claude Code sessions push `claude/*` branches; they show up as you, but add the App in case the push is checked as the App). This keeps the publishing App on `blog/**` branches. Check 10 below confirms your own pushes still work.
4. **Settings (your account) → Developer settings → GitHub Apps → New GitHub App**, for example `ry-mart-publisher`:
   - Homepage `https://ry-mart.com`. Webhook off. "Only on this account".
   - Repository permissions: **Contents** read and write, **Pull requests** read and write, **Actions** read, **Checks** read. Metadata read is automatic. **Workflows: no access.**
   - Generate a private key. **Install** the App on `personal-website` only.
   - Note the **Client ID**, the **installation ID** (the number at the end of the installation's settings URL) and the bot login, `<app-slug>[bot]`.
   - **Settings → Secrets and variables → Actions → Variables → New repository variable** `PUBLISH_BOT` = the bot login, for example `ry-mart-publisher[bot]`. The guards in `ci.yml` and `deploy.yml` (Step 10.8) use it to recognise the App, and `deploy.yml` refuses to deploy once the Worker has the App's key but this variable is missing. It isn't secret.
   - Never add the App as a bypass actor in any ruleset.
5. Store the key as downloaded. The Worker reads GitHub's `.pem` as it is (PKCS#1, `BEGIN RSA PRIVATE KEY`) and a PKCS#8 one too, so there is nothing to convert. Keep the downloaded `.pem` **outside the repo** (for example `~/keys/`) and never copy it into the working tree; the repo is public. Either way works, and the first works from a phone with only the downloaded file:
   - **Dashboard:** Workers & Pages → the site's Worker → **Settings → Variables and Secrets → Add**. Type **Secret**, name `GITHUB_APP_PRIVATE_KEY`, and paste the whole file as the value, `-----BEGIN` and `-----END` lines included. On a phone, open the file and use **Select All** before copying: a dragged selection can miss the first or last line, and the Worker then refuses the key (lost line breaks don't matter; a lost line does). Add `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_INSTALLATION_ID` the same way.
   - **Terminal:**
     ```sh
     cd apps/web
     pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/keys/<app>.pem
     pnpm wrangler secret put GITHUB_APP_CLIENT_ID
     pnpm wrangler secret put GITHUB_APP_INSTALLATION_ID
     ```
   Keep the `.pem` (on the phone or in `~/keys/`) until check 11 passes (after Step 10.8; that check needs a computer), then delete it. `.gitignore` ignores `*.pem` and `*.key` as a backstop. If **Publish** then answers "Publishing isn't set up: …", that message names the setting or App permission to fix (never a value), and the Worker's logs (dashboard → Workers & Pages → the site's Worker → **Logs**) record the same cause as `Publishing is misconfigured: …`.
6. ✅ Check: `gh api repos/TheRizz/personal-website --jq '{allow_auto_merge, delete_branch_on_merge}'` shows `false` and `true`.
7. ✅ Check: `gh api repos/TheRizz/personal-website/rulesets --jq '.[] | {id, name}'` lists both rulesets (the list has no rules). For each id, `gh api repos/TheRizz/personal-website/rulesets/<id> --jq '{rules, bypass_actors}'`: `main` has a `required_status_checks` rule with `ci`, `required_approving_review_count: 0` and no `update` rule, and neither lists the publishing App as a bypass actor.
8. ✅ Check: on a throwaway PR, merging is blocked while `ci` runs. Once it passes, **Squash and merge** works by hand with no approval and no bypass, and the head branch is deleted.
9. ✅ Check: `pnpm wrangler secret list` shows the three `GITHUB_APP_*` names. The App's installation page lists only `personal-website`.
10. ✅ Check: your own branch pushes still work with `bot scope` on. Push a new `test/x` branch from your local git, and have a Claude Code session push a `claude/test` branch. Delete both. If the Claude push is refused, add that App as a bypass actor (step 3).
11. ✅ Check (after Step 10.8 merges): with `export GH_TOKEN=$(pnpm app-token --key ~/keys/<app>.pem --client-id <Client ID>)`, the App token can create `blog/test` and is refused on `test`:
    ```sh
    main=$(gh api repos/TheRizz/personal-website/git/ref/heads/main --jq .object.sha)
    gh api repos/TheRizz/personal-website/git/refs -f ref=refs/heads/blog/test -f sha="$main"   # works
    gh api repos/TheRizz/personal-website/git/refs -f ref=refs/heads/test -f sha="$main"        # refused
    gh api -X DELETE repos/TheRizz/personal-website/git/refs/heads/blog/test
    ```
    Then `unset GH_TOKEN` and delete the `.pem`.

---

## 3. Local development prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 24 | `nvm install 24` (pinned in `.nvmrc`) |
| pnpm | 12.x | `corepack enable` (version pinned in `package.json`) |
| Wrangler | 4.x | dev dependency, run with `pnpm wrangler` |
| Playwright browsers | match the package | `pnpm exec playwright install chromium` |

`pnpm dev` runs the React Router dev server with the Cloudflare Vite plugin.
Workers, Durable Objects and WebSockets run locally in `workerd`, the same
runtime as production.

`pnpm e2e` runs the Playwright tests in Chromium against the production build
served by `vite preview` (also `workerd`) on port 4173. Install the browser once
with `pnpm exec playwright install chromium`.

---

## 4. CI/CD overview (GitHub Actions)

```
 PR opened / updated                          push to main
 ─────────────────────                        ─────────────────────────────
 ci.yml                                       deploy.yml (environment: main)
  ├─ install (pnpm, cached)                    ├─ needs: same checks as ci.yml
  ├─ lint · typecheck · format check           ├─ build content + app + resume.pdf
  ├─ unit tests (vitest, game-core, worker)    ├─ wrangler deploy
  ├─ build content (schema validation)         ├─ smoke test (curl pages, /api/health,
  ├─ build app, check index size budget        │   create lobby + WS handshake)
  ├─ e2e (Playwright vs vite preview)          └─ on failure → wrangler rollback + fail job
  └─ preview: wrangler versions upload
        --preview-alias pr-<n>  → comment URL  uptime.yml (cron */30)
                                                └─ curl / and /api/health → open issue on fail
```

`cloudflare/wrangler-action` runs Wrangler in CI. Pin every action to a commit
SHA, set `permissions:` to the minimum each job needs, and use
`concurrency: deploy-production` so two deploys never overlap.

`ci.yml` runs the Playwright e2e suite after `pnpm build`. It installs Chromium,
serves that build with `vite preview` on port 4173 (`CI=true` stops it building
again) and uploads `playwright-report/` as an artifact when a test fails. The
preview job is not built yet, and can't work as drawn: version URLs aren't
generated for a Worker that has a Durable Object (execution plan Step 1.3).

Phase 10 adds:
- `deploy.yml` runs `wrangler d1 migrations apply blog --remote` before `wrangler deploy`. Migrations only add tables and columns, because `wrangler rollback` doesn't roll back D1. `CLOUDFLARE_API_TOKEN` moves from the job's `env:` to the Wrangler steps only.
- `deploy.yml` gets a first step, before checkout and install: if `github.actor`, or the author or merger of the PR behind the commit, is the publishing App's bot and the push changes anything outside `content/blog/`, the deploy fails (design doc §4.9.7). It also checks that `OWNER_EMAIL` is in `wrangler secret list` before deploying.
- `backup.yml` runs nightly in the `main` environment with its own credentials (§2.9): `wrangler d1 export` of `blog`, uploaded to `blog-backups` with the S3 API. It never prints content, because Actions logs on a public repo are public.
- `ci.yml` gets a first step, inline in the YAML and before checkout, that reads the PR's file list from the API and fails when the publishing App's bot authored the PR or committed to it and it touches anything outside `content/blog/`. It also runs `build-content --check-images` when posts change.
- PR CI never gets Cloudflare or GitHub App secrets. E2E uses a test identity that works only on localhost (design doc §4.9.9).

---

## 5. Making sure everything works (go-live checklist)

Run this after the first full production deploy, and again after any
infrastructure change.

**Site**
- [ ] `https://<domain>` and `https://www.<domain>` both resolve, and `www` redirects to the bare domain
- [ ] All top-level routes load with no console errors: `/`, `/resume`, `/blog`, `/snippets`, `/photos`, `/tags`, `/search`, `/games`
- [ ] Viewing page source on a blog post shows prerendered HTML content, not an empty `<div id="root">`
- [ ] `/resume.pdf` downloads and looks right
- [ ] `/sitemap.xml`, `/rss.xml` and `/robots.txt` are valid (check RSS with a feed validator)
- [ ] Photos load from `photos.<domain>` with `srcset`, and the lightbox works
- [ ] Search: `Ctrl+K` opens the palette, typos still match, type and tag filters work, a `/search?q=` URL can be shared
- [ ] Tag pages list mixed content types with correct counts
- [ ] Lighthouse score ≥ 90 for performance, accessibility, best practices and SEO on `/` and one blog post
- [ ] securityheaders.com grade A, and CSP shows no violations in the console

**Games**
- [ ] Browser A creates a lobby and gets a code. Browser B (a different device or network) joins with the code.
- [ ] Moves show up on both screens, out-of-turn clicks are rejected, and wins and draws are detected
- [ ] Refreshing a tab mid-game reconnects to the same seat
- [ ] Rematch swaps who goes first and the score carries over
- [ ] A third browser joining shows spectator mode. With 8 spectators watching, the next visitor sees "This game is full".
- [ ] An invalid code shows a friendly "Lobby not found" message
- [ ] Creating more than 10 lobbies a minute from one IP returns 429

**Authoring (owner only, after Phase 10)**
- [ ] In a private window, `/admin` and `/api/admin/me` go to the Access login, and another account is refused
- [ ] `/ADMIN`, `/%61dmin`, `/api/ADMIN/me` and `/%61pi/admin/me` return 404 or the login even while you are signed in, never the editor or your e-mail
- [ ] `https://site.<subdomain>.workers.dev/api/admin/me` doesn't resolve or returns 404, even with a made-up `Cf-Access-Jwt-Assertion` header
- [ ] Signed in, `https://ry-mart.com/api/admin/me` shows your e-mail, and a blog post shows **Edit**. A private window shows no Edit link.
- [ ] Page source of a blog post contains no admin markup
- [ ] A form on another origin that POSTs to `/api/admin/drafts` is refused
- [ ] An SVG upload is refused. A phone photo uploaded through the editor has no GPS data (`exiftool` on the downloaded variant).
- [ ] A test post goes from Publish to a PR with the overview, you merge it, and the editor shows Live. Then it unpublishes the same way.
- [ ] Sign out works, and reloading `/admin` asks you to sign in again
- [ ] The nightly backup ran, and its log shows no draft text

**Operations**
- [ ] Deploying a deliberately broken commit to a preview fails the smoke test (test the rollback path once)
- [ ] `wrangler rollback` works when run by hand
- [ ] The uptime workflow has run at least once and passed
- [ ] Cloudflare usage notifications are on
- [ ] Domain auto-renew is on and the card on file is valid

---

## 6. Runbook (day-2 operations)

| Task | How |
|------|-----|
| Write a post | `/admin` → **New post**. It autosaves a few seconds after you stop typing. **Image** uploads a photo and inserts an image section; set its alt text, caption and size, and move it with the arrows. |
| Add a photo to the Photos page | `/admin` → **Manage photos** → **Add photo**, pick it, add a caption if you like (it shows under the photo) and **Save photo**. It is on `/photos` straight away, with no PR. Change a caption or delete a photo on the same screen; `/photos` catches up within a minute. A deleted photo's files can stay in the edge cache for up to a year: purge its `photos/<id>…` URLs (**Caching → Configuration → Custom Purge**) if it must go everywhere now. |
| Publish a post from the editor | **Publish** → confirm. The text is public on a GitHub PR from that moment. The status goes PR opened → CI → waiting for your review → merged → deploying → Live. Open the PR from the editor, check the overview, images and "What changed", then **Squash and merge** once `ci` passes. It is live about a minute later. Before Step 10.9 ships: **Download .md**, add it to `content/blog/` and open a PR. Downloading protects the draft's images from clean-up, so discarding the draft afterwards is safe. |
| Publish a blog post by hand | Add `content/blog/YYYY-MM-DD-slug.md`, open a PR, merge once `ci` passes |
| Edit a published post | **Edit** on the post (signed in), or `/admin` → the post → **Edit**. Change it, then **Publish changes** and merge the `Update:` PR, even for a typo. `updated` is set to that day. Before Step 10.9 ships: edit `content/blog/<file>.md` by hand and open a PR. |
| Unpublish a post | `/admin` → the post → **Unpublish**, then merge the `Unpublish:` PR. It's gone about a minute after the merge, but stays in git history. This works for any post file on `main`, even one the editor can't edit. The post's images stay at `photos.ry-mart.com`: if they must go too, delete their `blog/<id>…` objects in the `photos` R2 bucket, then purge their URLs from the cache (**Caching → Configuration → Custom Purge**). |
| Take a post down right now | **Security → WAF → Custom rules → Create rule**: URI Path equals `/blog/<slug>`, action Block. Works in seconds. Then unpublish, and delete the rule once the deploy is live. Do the same if a `wrangler rollback` brings back an unpublished post. |
| Publish stuck | CI failed: open the run from the editor, fix the post, **Fix and republish**, or **Cancel** (closes the PR and deletes the branch). Deploy failed: **Actions → deploy → Re-run jobs**. |
| Status stays at "PR opened" while the PR shows `ci` | The status reads `ci` from GitHub Actions' check suite, filtered by its App id 15368 (`worker/github.ts`). Verify it at the Step 10.9 production check: `gh api repos/TheRizz/personal-website/commits/<head sha>/check-suites --jq '.check_suites[] \| {id: .app.id, slug: .app.slug}'` should list `15368` with slug `github-actions`. If it doesn't, drop the `appId` filter and keep the slug check. |
| Restore a draft | Revisions drawer → **Restore**. Older or deleted: `pnpm wrangler d1 time-travel restore blog --timestamp=<ISO time>` (last 7 days, rewinds the whole database, so export first). Older still: download the export from `blog-backups`, load it into a scratch database with `wrangler d1 execute <scratch> --file=<export>.sql` and copy the row back. |
| Revoke admin access | Sign out on one device: `https://ry-mart.com/cdn-cgi/access/logout`. Everywhere: **Zero Trust → Access controls → Applications → Site admin → Revoke existing tokens**. Access enforces both, and they cover every admin request because the Worker serves admin only on the paths Access matches. |
| Rotate the GitHub App key | App settings → **Generate a private key**, saved outside the repo → `pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/keys/<app>.pem` from `apps/web`, or paste the file into the dashboard secret (§2.10 step 5) → test a publish → delete the old key in the App settings and the local file |
| Add a snippet | Add `content/snippets/<slug>.md`, open a PR, merge |
| Add photos | `pnpm photos:upload ./my-folder --album yosemite-2026 --tags hiking,landscape`. This resizes, uploads to R2 and adds to `photos.yaml`. Commit the manifest and open a PR. |
| Update resume | Edit `content/resume.yaml` and merge. CI regenerates the PDF. |
| Roll back production | `pnpm wrangler rollback` or the GitHub Actions "Rollback" `workflow_dispatch` |
| See errors | Cloudflare dashboard → Workers → `site` → Logs / Observability |
| Rotate the API token | Create a new token with the same permissions (including D1 Edit), update the GitHub environment secret, revoke the old token. Rotate the backup credentials (`BACKUP_D1_TOKEN`, `BACKUP_R2_*`) the same way. |
| A deploy failed on the bot guard | The publishing App merged a PR that touches code. Revert the merge commit, then rotate the App key: it may be stolen. |
| Run the e2e tests locally | `pnpm e2e`. It builds, serves the build on port 4173 and runs Playwright. If a server is already running on 4173, it reuses that server and skips the build, so stop it or rebuild after changing code. Set `E2E_PORT` to use another port. |
| Debug a failed e2e run in CI | Download the `playwright-report` artifact from the run and open it with `pnpm exec playwright show-report <folder>`. Failed tests keep a trace. |
| Free limit reached | Workers & Pages → Plans → Workers Paid ($5/month). No code change needed. |
