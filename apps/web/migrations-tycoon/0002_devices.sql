-- Linking devices to a Pipeline Tycoon player (docs/04-pipeline-tycoon.md §3, phase 2). Times are
-- Unix milliseconds. Expand-only.
--
-- `devices`: extra secrets that act as the player (one per linked device; the first device's
-- secret stays in players.token_hash). Only SHA-256 hashes (hex) are stored.
-- `pairing_codes`: short-lived, single-use codes a signed-in device shows so another can join.

CREATE TABLE devices (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  client TEXT NOT NULL CHECK (client IN ('web', 'cli')),
  created_at INTEGER NOT NULL
);

CREATE INDEX devices_by_player ON devices(player_id);

CREATE TABLE pairing_codes (
  code TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  expires_at INTEGER NOT NULL
);

CREATE INDEX pairing_codes_by_player ON pairing_codes(player_id);
