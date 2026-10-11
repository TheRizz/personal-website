import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("blog", "routes/blog.tsx"),
  route("blog/:slug", "routes/blog.$slug.tsx"),
  // Sections that are built in later phases share one placeholder page.
  ...["resume", "snippets", "photos", "games", "search"].map((path) =>
    route(path, "routes/coming-soon.tsx", { id: `coming-soon-${path}` }),
  ),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
