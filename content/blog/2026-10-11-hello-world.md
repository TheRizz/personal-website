---
title: "Hello, world"
date: 2026-10-11
summary: "The first post on the new site, and a quick tour of how it's built."
tags: [meta, cloudflare]
---

This is the first post on the site. Replace it with your own writing, or delete it
once real posts exist.

## How the site is built

The site runs on a single Cloudflare Worker. Pages are rendered with React Router,
and posts like this one are Markdown files in `content/blog/`.

```ts
export default {
  fetch() {
    return new Response("hello");
  },
};
```

## Writing a new post

Add a Markdown file named `YYYY-MM-DD-your-slug.md` to `content/blog/`, fill in the
frontmatter, and open a pull request.
