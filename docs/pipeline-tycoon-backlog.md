# Pipeline Tycoon: improvement backlog

A scheduled task works through this list one item per run (see "How the scheduled runs work" at
the end). Ryan can reorder, add, strike or annotate items at any time by editing this file; the
next run follows whatever is here. Highest value first.

Sizes: **S** fits one run easily, **M** fits one run, **L** must be split into M items first.
"Rules bump" means the item changes numbers in `@site/tycoon-core`, so `RULES_VERSION` goes up,
old tabs are told to reload, and the CLI needs a new release (docs/04-pipeline-tycoon.md §5).

## Up next

1. **Offline time in a tab left open** (M, save robustness, read ADR-0006 first). Offline
   earnings are only credited when a session starts. A tab left open keeps its session, and the
   client measures play time with `performance.now()`, which on iOS likely stops while the phone
   sleeps; if so, locking the phone for an hour with the game open earns nothing for that hour,
   while closing the tab and reopening would have shown "While you were away". Confirm first
   (log `Date.now()` against `performance.now()` across a lock on Ryan's iPhone, or ask him),
   then on `resume()` after a long hidden gap with no unconfirmed save, start a fresh session so
   the server credits the gap. E2E test with a faked clock.
2. **Golden packet you can't miss** (S, UI, no rules bump). Pulse the packet's trail, add a soft
   chime when sound is on, and show its remaining time as a ring; respect reduced motion.
3. **Keyboard help** (S, UI, no rules bump). `?` opens a small list of keys (space, 1–0, x for
   amount, tab switching, g to catch a golden packet like the CLI); mention it in the hint line.
4. **Install on the home screen** (M, no rules bump). A web app manifest scoped to
   `/games/pipeline-tycoon` with an icon drawn from the core node, `display: standalone`, and
   theme colour from the scene, so iPhone "Add to Home Screen" opens the game full screen.
5. **Unsaved-play safety net** (M, save robustness). Keep the pending action log in localStorage
   between saves so a killed tab (iOS memory pressure) does not lose up to 5 minutes; on the next
   load, send it as the first save of the new session if the server's seq still matches, otherwise
   drop it. Needs a careful server-side check and e2e test; read ADR-0006 first.
6. **Performance pass** (M). Cap live packets and particles at high tiers, measure frame time at
   iPhone width with CPU throttling in Playwright, record before/after numbers in the PR. (Phaser
   already pauses itself when the tab is hidden.)
7. **More achievements** (S, rules bump). 8–10 fun ones: catch 3 golden packets in one session,
   own 100 interns and nothing else, migrate with exactly 1 AP, 10 minutes without clicking, buy
   an upgrade within a second of affording it, own one of every tier, reach the ending without
   clicking after the first migration. Batch with another rules-bump item when possible.
8. **Offline cap upgrade** (M, rules bump). An AP-priced upgrade that raises the 8-hour offline
   cap to 12 h then 24 h. Needs a "spend AP" control in the Migrate tab (AP stay a production
   bonus otherwise).
9. **Balance check of the mid game** (M, rules bump only if needed). Run the pacing bot, chart
    time between purchases, look for walls of more than ~3 minutes with nothing to buy; retune only
    inside the pacing test's targets.
10. **Leaderboard, part 1: API and storage** (M, phase 3 of the spec). Opt-in name (3–16 of
    `[A-Za-z0-9_]`, profanity filter), top 50 by lifetime Records, cached a few minutes. New
    expand-only migration in `apps/web/migrations-tycoon/` (deploy applies it).
11. **Leaderboard, part 2: web and CLI UI** (M). Stats tab section to pick a name and see the
    board; CLI panel.
12. **Leaderboard, part 3: moderation** (S). Hide a name from `/admin`.
13. **Share a milestone** (S, no rules bump). After a migration or the ending, a Share button
    using the Web Share API on phones (copy to clipboard elsewhere): "I migrated my data platform
    3 times and processed 4.2 trillion records in Pipeline Tycoon" with the page link.
14. **CLI catches up** (S). Bring Max, wait times and milestone progress to the terminal shop so
    the two stay alike; patch release, Ryan pushes the tag.

## Needs Ryan first

Runs skip these until Ryan writes a decision under the item.

- **What happens after "Integrate Earth"?** The ending teases a greyed-out ACCEPT. A second act
  (new tier set from the "unknown origin", a second prestige layer) is the biggest possible
  addition but is a design choice.
- **A full visual restyle of the shop panel** to the repo's taste skill. Batch 1 already removed
  the tracked capital labels and monospace numbers outside the scene; the dark terminal scene
  itself is the game's look and stays unless Ryan says otherwise.
- **Sound effects beyond the current set** (style is taste).
- **Timed events or daily bonuses** (bring players back, but change the game's calm feel).

## Done

- 2026-10-30 (in PR #43): the game fits one phone screen. The records counter and settings button sit
  on the scene's top edge instead of above it, the scene takes 38 % of a box one screen tall
  (`svh`, so Safari's toolbar sliding away doesn't resize it mid-scroll), and after one scroll the
  counter, scene, tabs and at least two shop rows show together. Node labels now sit on the side
  away from the core and nodes shrink on a short scene, so labels no longer land on neighbouring
  nodes. Toasts moved to the top of the scene (on a laptop the bottom edge was below the fold);
  the overclock banner moved into the counter line.
- 2026-10-30 (bug hunt in the project thread, [PR #42](https://github.com/TheRizz/personal-website/pull/42)): tapping the core stopped working after
  a migration on iPhone until a reload. The scene had one touch pointer and also took touches
  from anywhere on the page, so a tap on a shop or Migrate button whose end iOS never delivered
  kept that pointer busy for good. The scene now only listens to touches on itself, answers up
  to four fingers at once (two thumbs both count) and frees a pointer whose finger has gone.
  Also: quick taps on shop buttons no longer zoom the page on iOS, a first-time tip disappears
  as soon as it has been followed, and the help line under the game talks about tapping on
  phones.
- 2026-10-30 (PR #41): first-time hints. A new game shows three tips once each in the scene's
  toast ("Tap the core", "Buy an intern, it works while you don't", "Upgrades tab has something
  for you"), each when its moment comes; remembered in this browser, none on a game that already
  has progress.
- 2026-10-29 (PR #40): settings panel. A gear next to the records opens a sheet with sound,
  number style (short, long, scientific), reduce motion for the scene, and "Copy my save code";
  kept in this browser. On phones the mute button lives in the sheet.
- 2026-10-29 (PR #39, built in the project thread): Buy Max; "in 2m" wait time on every
  generator and upgrade you can't afford yet; each generator shows its output and share of
  production, and a bar to its next ×2 milestone; locked achievements show progress; a dot on the
  Migrate tab when a migration is worth at least 1 AP; more stats (best production, per click,
  permanent bonus); a "new version, save and reload" notice for tabs left open across a deploy;
  tracked capital labels and monospace numbers outside the scene replaced with the site's text
  face.

## Changelog

One line per run: date (UTC), what happened, PR link.

- 2026-10-29: backlog created; first batch built in the project thread (PR #39).
- 2026-10-29: settings panel (scheduled run, [PR #40](https://github.com/TheRizz/personal-website/pull/40)).
- 2026-10-30: first-time hints (scheduled run, [PR #41](https://github.com/TheRizz/personal-website/pull/41)).
- 2026-10-30: bug hunt in the project thread ([PR #42](https://github.com/TheRizz/personal-website/pull/42)): taps after a migration, two-thumb tapping, iOS
  zoom, tips; new items 1 (notes) and 2 added.
- 2026-10-30: game fits one phone screen, with the label overlap and laptop toast fixes (scheduled
  run, [PR #43](https://github.com/TheRizz/personal-website/pull/43)).

## How the scheduled runs work

- One open PR at a time. A run first looks at the last scheduled-run PR: if it is still open, the
  run only addresses review comments and failing CI on it, then stops. If it was merged, the run
  moves its item to Done and starts the next one. If it was closed without merging, the item goes
  back to "Up next" with a note, or is struck if Ryan's comment says so.
- Runs never merge, never push to `main`, never push tags (CLI releases stay with Ryan) and never
  deploy. A rules bump says in the PR that a CLI tag is needed after deploy.
- Each PR passes the unit tests, the pacing test and the browser tests, and checks the change at
  iPhone width (390 × 844).
- The game's dark terminal scene stays as it is. Shop and overlays follow the site's text face,
  sentence-case labels and tabular numbers; the repo's "taste" design skill applies to UI items
  within that look.
