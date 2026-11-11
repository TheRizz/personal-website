# Pipeline Tycoon: improvement backlog

A scheduled task works through this list one item per run (see "How the scheduled runs work" at
the end). Ryan can reorder, add, strike or annotate items at any time by editing this file; the
next run follows whatever is here. Highest value first.

Sizes: **S** fits one run easily, **M** fits one run, **L** must be split into M items first.
"Rules bump" means the item changes numbers in `@site/tycoon-core`, so `RULES_VERSION` goes up,
old tabs are told to reload, and the CLI needs a new release (docs/04-pipeline-tycoon.md §5).

## Up next

1. **More achievements** (S, rules bump). 8–10 fun ones: catch 3 golden packets in one session,
   own 100 interns and nothing else, migrate with exactly 1 AP, 10 minutes without clicking, buy
   an upgrade within a second of affording it, own one of every tier, reach the ending without
   clicking after the first migration. Batch with another rules-bump item when possible.
2. **Offline cap upgrade** (M, rules bump). An AP-priced upgrade that raises the 8-hour offline
   cap to 12 h then 24 h. Needs a "spend AP" control in the Migrate tab (AP stay a production
   bonus otherwise).
3. **Balance check of the mid game** (M, rules bump only if needed). Run the pacing bot, chart
   time between purchases, look for walls of more than ~3 minutes with nothing to buy; retune only
   inside the pacing test's targets.
4. **Leaderboard, part 1: API and storage** (M, phase 3 of the spec). Opt-in name (3–16 of
   `[A-Za-z0-9_]`, profanity filter), top 50 by lifetime Records, cached a few minutes. New
   expand-only migration in `apps/web/migrations-tycoon/` (deploy applies it).
5. **Leaderboard, part 2: web and CLI UI** (M). Stats tab section to pick a name and see the
   board; CLI panel.
6. **Leaderboard, part 3: moderation** (S). Hide a name from `/admin`.
7. **Share a milestone** (S, no rules bump). After a migration or the ending, a Share button
   using the Web Share API on phones (copy to clipboard elsewhere): "I migrated my data platform
   3 times and processed 4.2 trillion records in Pipeline Tycoon" with the page link.
8. **CLI catches up** (S). Bring Max, wait times and milestone progress to the terminal shop so
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

- 2026-11-11 (in PR): performance pass. A late game (every tier owned, overclocked, the core
  tapped fast) on a phone-speed CPU went from about 23 to about 56 frames a second, the same as
  an empty factory. Packets are now sprites from one small texture instead of circles Phaser
  re-cut into triangles every frame; the scene's other circles use as many corners as their
  size needs instead of 100; the grid is drawn once per size; at most 150 packets (a fair share
  per tier), 6 floating numbers and 8 rings show at once, reusing the oldest. Looks the same.
- 2026-11-09 ([PR #54](https://github.com/TheRizz/personal-website/pull/54)): unsaved-play safety net. Between saves the page keeps what you played in
  this browser, so a tab the phone closes on its own (iOS under memory pressure, with no chance
  to save) no longer loses up to 5 minutes: the next visit sends it along and the server adds it
  first, if nothing has saved or started elsewhere since, and says "Picked up N moves you made
  before the page closed". The time it covers comes out of "While you were away", never twice.
- 2026-11-04 ([PR #51](https://github.com/TheRizz/personal-website/pull/51)): install on the home screen. The game has a web app manifest and
  its own icon (the scene's core with four tier nodes, on the scene's dark background), so on
  iPhone "Share, then Add to Home Screen" puts a "Tycoon" icon on the home screen that opens
  the game full screen with a black status bar; Android and desktop Chrome can install it too.
  On phones the help line under the game says how, and hides that once opened from the home
  screen. The PNG icons are rendered from `icon.svg` by `pnpm tycoon:icons`.
- 2026-11-04 ([PR #48](https://github.com/TheRizz/personal-website/pull/48)): keyboard help. Keys now work anywhere on the page, not only with the
  factory focused: 1–0 build, x changes the buy amount, ← and → switch shop tabs, g catches the
  golden packet (as in the CLI), and ? opens a list of them, also linked from the help line under
  the game. Space still only taps the core when it is focused, keys stay out of text fields and
  open sheets, and browser shortcuts (cmd+1 and so on) are left alone.
- 2026-10-30 ([PR #45](https://github.com/TheRizz/personal-website/pull/45)): golden packet you can't miss. It now leaves a pulsing gold trail, wears a
  ring that empties as its 12 seconds run out, plays a soft chime when it appears (if sound is
  on) and is announced to screen readers. Reduced motion keeps the trail steady.
- 2026-10-30 ([PR #44](https://github.com/TheRizz/personal-website/pull/44)): offline time in a tab left open. A phone that sleeps with the game open
  stops the page's own clock, so that time used to earn nothing. The game now compares it with
  the wall clock each frame; when a minute or more went missing and the save sent on the way out
  is in with nothing played since, it starts a fresh session, so the server credits the gap on
  its own clock (capped at 8 hours like any time away) and "While you were away" shows. Desktop
  tabs, where both clocks run on, are untouched. Not yet watched on a real iPhone.
- 2026-10-30 ([PR #43](https://github.com/TheRizz/personal-website/pull/43)): the game fits one phone screen. The records counter and settings button sit
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
- 2026-10-30: offline time in a tab left open (scheduled run, [PR #44](https://github.com/TheRizz/personal-website/pull/44)).
- 2026-10-30: golden packet you can't miss (scheduled run, [PR #45](https://github.com/TheRizz/personal-website/pull/45)).
- 2026-11-04: PR #45 merged; keyboard help (scheduled run, [PR #48](https://github.com/TheRizz/personal-website/pull/48)).
- 2026-11-04: PR #48 merged; install on the home screen (scheduled run, [PR #51](https://github.com/TheRizz/personal-website/pull/51)).
- 2026-11-09: PR #51 merged; unsaved-play safety net (scheduled run, [PR #54](https://github.com/TheRizz/personal-website/pull/54)).
- 2026-11-11: PR #54 merged; performance pass (scheduled run, PR link below once open).

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
