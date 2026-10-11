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
| R2 object storage (photos), 10 GB free | Cloudflare | $0 (a payment method may be needed to turn R2 on) | Yes, for photos |
| GitHub repo and Actions | GitHub Free | $0 | Yes |
| Web Analytics, DNS, TLS certificates, DDoS protection | Cloudflare | $0 | Included |
| Email Routing (`hello@yourdomain` forwarded to Gmail) | Cloudflare | $0 | Optional |
| **Total** | | **≈ $10–12 per year** | |

**Upgrade path if you outgrow the free tier:** the Workers Paid plan is $5/month.
It raises the limits for requests, Durable Objects and logs. You only need it if
the site gets more than about 100k API requests per day, which is unlikely for a
personal site. Static page views never count toward that limit.

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

Work through these as **Phase 1** of the execution plan. Each step lists a
check you can run to confirm it worked.

### 2.1 Cloudflare account and domain
1. Sign up at dash.cloudflare.com and turn on 2FA (use a hardware key or authenticator app).
2. **Domain Registration → Register Domains**: search for the name and buy it. Turn on **auto-renew** and **WHOIS redaction** (free).
   - If you already own a domain at another registrar, add it to Cloudflare as a zone and change its nameservers to Cloudflare's. A transfer is optional.
3. ✅ Check: the domain shows as **Active** in the dashboard.

### 2.2 Workers and R2
1. **Workers & Pages**: find **Your subdomain** (`<name>.workers.dev`) and select **Change** if you want a different name. This is the fallback URL. If no subdomain appears yet, one is set up when you create your first Worker or the first time you run `wrangler deploy`. This step doesn't block anything else, since the site is served from your own domain.
2. **R2 → Enable R2**. Add a payment method if asked; usage under 10 GB is not billed.
3. Create a bucket named `photos`. Under **Settings → Custom Domains**, attach `photos.<yourdomain>`.
4. ✅ Check: upload a test image in the dashboard and open `https://photos.<yourdomain>/test.jpg`.

### 2.3 API token for GitHub Actions
1. **My Profile → API Tokens → Create Token → Custom token** with these permissions:
   - Account · Workers Scripts · Edit
   - Account · Workers R2 Storage · Edit
   - Account · Account Settings · Read
   - Zone · Workers Routes · Edit (limited to your zone)
2. Note your **Account ID**, shown on the Workers overview page.
3. ✅ Check: run `CLOUDFLARE_API_TOKEN=… npx wrangler whoami` locally. It should list the account.

### 2.4 GitHub repository settings
1. **Settings → General → Default branch**: make it `main`. Dependabot opens its pull requests against the default branch.
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

### 2.5 Custom domain for the site
1. In `apps/web/wrangler.jsonc`, add `"routes": [{ "pattern": "<yourdomain>", "custom_domain": true }]`.
   - For `www`, don't add a Worker route. Add a proxied DNS record instead (**DNS → Records**: type `AAAA`, name `www`, IPv6 `100::`, proxy on). Then create a redirect rule (**Rules → Redirect Rules**) with a wildcard pattern: request URL `https://www.<yourdomain>/*`, target URL `https://<yourdomain>/${1}`, status `301`, **Preserve query string** on. Turn on **SSL/TLS → Edge Certificates → Always Use HTTPS** so `http://` requests are upgraded before the rule runs.
2. Deploy once (through CI or `wrangler deploy`). Cloudflare creates the DNS records and certificate automatically.
3. ✅ Check: `curl -I https://<yourdomain>` returns `200` with a valid certificate.

### 2.6 Optional extras (free)
- **Email Routing:** forward `hello@<yourdomain>` to your personal inbox.
- **Web Analytics:** turn it on for the zone. It's cookieless, so you don't need a cookie banner.
- **Notifications:** turn on "Usage-based billing" and "Workers weekly summary" e-mails, so you hear early if you're getting close to the free limits.
- **Security → Settings:** "Always Use HTTPS" on, minimum TLS 1.2, HSTS on once everything works.

---

## 3. Local development prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22 LTS | `nvm install 22` (pin it in `.nvmrc`) |
| pnpm | 9.x | `corepack enable` |
| Wrangler | 4.x | dev dependency, run with `pnpm wrangler` |
| Playwright browsers | match the package | `pnpm exec playwright install chromium` |

`pnpm dev` runs the React Router dev server with the Cloudflare Vite plugin.
Workers, Durable Objects and WebSockets run locally in `workerd`, the same
runtime as production.

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
  ├─ e2e (Playwright vs local wrangler dev)    └─ on failure → wrangler rollback + fail job
  └─ preview: wrangler versions upload
        --preview-alias pr-<n>  → comment URL  uptime.yml (cron */30)
                                                └─ curl / and /api/health → open issue on fail
```

`cloudflare/wrangler-action` runs Wrangler in CI. Pin every action to a commit
SHA, set `permissions:` to the minimum each job needs, and use
`concurrency: deploy-production` so two deploys never overlap.

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
- [ ] A third browser joining shows spectator mode, or "full" if spectators are off
- [ ] An invalid code shows a friendly "Lobby not found" message
- [ ] Creating more than 10 lobbies a minute from one IP returns 429

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
| Publish a blog post | Add `content/blog/YYYY-MM-DD-slug.md`, open a PR, check the preview URL, merge |
| Add a snippet | Add `content/snippets/<slug>.md`, open a PR, merge |
| Add photos | `pnpm photos:upload ./my-folder --album yosemite-2026 --tags hiking,landscape`. This resizes, uploads to R2 and adds to `photos.yaml`. Commit the manifest and open a PR. |
| Update resume | Edit `content/resume.yaml` and merge. CI regenerates the PDF. |
| Roll back production | `pnpm wrangler rollback` or the GitHub Actions "Rollback" `workflow_dispatch` |
| See errors | Cloudflare dashboard → Workers → `site` → Logs / Observability |
| Rotate the API token | Create a new token, update the GitHub environment secret, revoke the old token |
| Free limit reached | Workers & Pages → Plans → Workers Paid ($5/month). No code change needed. |
