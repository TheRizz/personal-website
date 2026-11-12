-- Pipeline Tycoon leaderboard (docs/04-pipeline-tycoon.md, phase 3). Expand-only.
--
-- `players.lifetime_records`: a copy of state.lifetimeRecords, written with every state, so the
-- board can sort on an index instead of parsing every save. Existing rows are filled from their
-- saved state.
-- `leaderboard_names`: players who opted in with a name. Names are unique ignoring case.
-- `hidden` is set by moderation (/admin); a hidden player keeps the flag when renaming.

ALTER TABLE players ADD COLUMN lifetime_records REAL NOT NULL DEFAULT 0;

UPDATE players SET lifetime_records = COALESCE(json_extract(state, '$.lifetimeRecords'), 0);

CREATE INDEX players_by_lifetime_records ON players(lifetime_records DESC);

CREATE TABLE leaderboard_names (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
