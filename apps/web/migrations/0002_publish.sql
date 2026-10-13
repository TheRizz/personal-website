-- Publishing (design doc §4.9.7, Steps 10.9–10.10). Expand-only: `wrangler rollback` doesn't roll back D1.
ALTER TABLE drafts ADD COLUMN pr_action TEXT CHECK (pr_action IN ('publish', 'unpublish'));
ALTER TABLE drafts ADD COLUMN pr_blob_sha TEXT;  -- git blob SHA of the file the PR last pushed; NULL for unpublish
ALTER TABLE drafts ADD COLUMN post_date TEXT;    -- frontmatter date (YYYY-MM-DD) of the version on main; NULL when not on main
