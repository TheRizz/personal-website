-- The Photos page (execution plan Phase 5, built as uploads from /admin). Times are Unix
-- milliseconds. Expand-only: `wrangler rollback` doesn't roll back D1.
--
-- A photo shows on /photos once it is `ready`: every variant is in R2 under
-- photos/<id>-<width>.<ext>. The caption and alt text are plain text, never Markdown or HTML.

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL CHECK (ext IN ('webp', 'jpg', 'gif')),
  widths TEXT NOT NULL DEFAULT '[]',
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  caption TEXT NOT NULL DEFAULT '',
  alt TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX photos_by_state ON photos(state, created_at);
