-- Current projects on the home page, edited at /admin/projects. Times are Unix milliseconds.
-- Expand-only: `wrangler rollback` doesn't roll back D1.
--
-- An `active` project shows on the home page: priority 1, 2 and 3 first, then every other active
-- project. A `backlog` project shows only in the folded Backlog list and never has a priority. At
-- most one active project holds each priority; the API moves a priority, it never duplicates it.
-- Every text field is plain text, never Markdown or HTML.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'backlog')),
  priority INTEGER CHECK (priority IN (1, 2, 3)),
  progress INTEGER CHECK (progress BETWEEN 0 AND 100),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (status = 'active' OR priority IS NULL)
);

CREATE UNIQUE INDEX projects_one_per_priority ON projects(priority) WHERE priority IS NOT NULL;
