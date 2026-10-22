-- Pipeline Tycoon saves (docs/04-pipeline-tycoon.md §2.4, ADR-0006). A separate database from
-- `blog`, so game data never shares one with the site's content. Times are Unix milliseconds.
-- Expand-only: `wrangler rollback` doesn't roll back D1.
--
-- One row per anonymous player. `state` is the canonical GameState JSON as of `state_at` (server
-- time); clients upload action logs that the Worker replays onto it. `token_hash` is the SHA-256
-- (hex) of the player's secret; the secret itself is never stored. `session` is the only session
-- allowed to save (starting a new one supersedes it), and `seq` counts accepted saves.

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  state_at INTEGER NOT NULL,
  session TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
