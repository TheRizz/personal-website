# Pipeline Tycoon: improvement backlog

A scheduled task works through this list one item per run (see "How the scheduled runs work" at
the end). Ryan can reorder, add, strike or annotate items at any time by editing this file; the
next run follows whatever is here. Highest value first.

Sizes: **S** fits one run easily, **M** fits one run, **L** must be split into M items first.
"Rules bump" means the item changes numbers in `@site/tycoon-core`, so `RULES_VERSION` goes up,
old tabs are told to reload, and the CLI needs a new release (docs/04-pipeline-tycoon.md §5).

## Up next

1. **"New version, reload" notice** (S, robustness, no rules bump). iPhone keeps tabs open for
   days, so an old tab keeps running old code after a deploy (seen during the sync fixes). Detect a
   newer build (e.g. a build id returned by `/api/tycoon/session` and `save`) and show a quiet
   banner with a Reload button; save first so nothing is lost.
2. **Buy "Max"** (S, UI, no rules bump). Add Max beside ×1/×10/×100 in the generator shop and the
   keyboard shortcut; uses `affordableCount`.
3. **Next milestone on each generator** (S, UI, no rules bump). Show "12 / 25 → ×2" under each
   generator so the next upgrade is always visible.
4. **"Something to buy" dot on the shop tabs** (S, UI, no rules bump). A small dot on Upgrades
   (and Migrate once a migration is worth it) when you can afford something there, so phone
   players on the Generators tab don't miss it.
5. **Golden packet on phone** (S, UI, no rules bump). When a packet appears while the shop panel
   is scrolled or a tab other than the scene is in view, show a small tappable chip at the panel
   edge; respect reduced motion.
6. **Number notation setting** (S, UI, no rules bump). Short (1.2 B) or scientific (1.2e9), kept
   in localStorage; also in the CLI (`n` key) if cheap.
7. **Pause the scene when hidden; performance pass** (M, performance). Stop the Phaser loop on
   `visibilitychange`, cap live packets, measure frame time at iPhone width with Playwright's CPU
   throttling, record before/after numbers in the PR.
8. **Unsaved-play safety net** (M, save robustness). Keep the pending action log in localStorage
   between saves so a killed tab (iOS memory pressure) does not lose up to 5 minutes; on the next
   load, send it as the first save of the new session if the server's seq still matches, otherwise
   drop it. Needs a careful server-side check and e2e test; read ADR-0006 first.
9. **More achievements** (S, rules bump). 6–8 fun ones: catch 3 golden packets in a row, own 100
   interns, migrate with exactly 1 AP, play 10 minutes without clicking, etc. Batch with another
   rules-bump item when possible.
10. **Leaderboard, part 1: API and storage** (M, phase 3 of the spec). Opt-in name (3–16 of
    `[A-Za-z0-9_]`, profanity filter), top 50 by lifetime Records, cached a few minutes. New
    expand-only migration in `apps/web/migrations-tycoon/` (deploy applies it).
11. **Leaderboard, part 2: web and CLI UI** (M). Stats tab section to pick a name and see the
    board; CLI panel.
12. **Leaderboard, part 3: moderation** (S). Hide a name from `/admin`.
13. **Balance check of the mid game** (M, rules bump only if needed). Run the pacing bot, chart
    time between purchases, look for walls of more than ~3 minutes with nothing to buy; retune only
    inside the pacing test's targets.
14. **Offline cap upgrade** (M, rules bump). An AP-priced upgrade that raises the 8-hour offline
    cap to 12 h then 24 h.

## Needs Ryan first

Runs skip these until Ryan writes a decision under the item.

- **What happens after "Integrate Earth"?** The ending teases a greyed-out ACCEPT. A second act
  (new tier set, second prestige layer) is the biggest possible addition but is a design choice.
- **Sound effects beyond the current set** (style is taste).
- **Rename or restyle anything visible** beyond UI polish of existing elements.

## Done

_Nothing yet._

## Changelog

One line per run: date (UTC), what happened, PR link.

- 2026-10-29: backlog created.

## How the scheduled runs work

- One open PR at a time. A run first looks at the last scheduled-run PR: if it is still open, the
  run only addresses review comments and failing CI on it, then stops. If it was merged, the run
  moves its item to Done and starts the next one. If it was closed without merging, the item goes
  back to "Up next" with a note, or is struck if Ryan's comment says so.
- Runs never merge, never push to `main`, never push tags (CLI releases stay with Ryan) and never
  deploy. A rules bump says in the PR that a CLI tag is needed after deploy.
- Each PR passes the unit tests, the pacing test and the browser tests, and checks the change at
  iPhone width (390 × 844) with a screenshot in the PR.
- The game's existing look (dark terminal / neon schematic, monospace) stays. The repo's "taste"
  design skill does not apply to this game except for items marked UI, and even then only within
  the existing look.
