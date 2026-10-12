-- Drafts, their revisions and image rows (design doc §4.9.5). Times are Unix milliseconds.
-- Migrations are expand-only: `wrangler rollback` restores the Worker but never the database.

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('new', 'edit')),
  source_path TEXT,
  base_sha TEXT,
  slug TEXT UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  category TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  cover_key TEXT,
  body_md TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'publishing', 'published', 'failed', 'archived')),
  pr_number INTEGER,
  pr_branch TEXT,
  head_sha TEXT,
  merge_sha TEXT,
  publish_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE draft_revisions (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  meta TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('interval', 'manual', 'publish', 'restore', 'conflict')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (draft_id, rev)
) WITHOUT ROWID;

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  ext TEXT NOT NULL CHECK (ext IN ('webp', 'jpg', 'png', 'gif')),
  widths TEXT NOT NULL DEFAULT '[]',
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER,
  alt TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'orphan')),
  published INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  orphaned_at INTEGER
);

CREATE INDEX drafts_by_updated ON drafts(updated_at);
CREATE INDEX images_by_draft ON images(draft_id);
CREATE INDEX images_by_state ON images(state, orphaned_at);
