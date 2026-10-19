import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("blog", "routes/blog.tsx"),
  route("blog/:slug", "routes/blog.$slug.tsx"),
  // Rendered by the Worker on each request from D1, so a photo shows as soon as it is uploaded.
  route("photos", "routes/photos.tsx"),
  route("games", "routes/games.tsx"),
  route("games/tictactoe", "routes/games.tictactoe.tsx"),
  route("games/tictactoe/:code", "routes/games.tictactoe.$code.tsx"),
  // Owner only, behind the owner gate (design doc §4.9.2). Never prerendered.
  route("admin", "routes/admin.tsx", [
    index("routes/admin._index.tsx"),
    route("drafts/:id", "routes/admin.drafts.$id.tsx"),
    route("posts/:slug", "routes/admin.posts.$slug.tsx"),
    route("photos", "routes/admin.photos.tsx"),
  ]),
  // Sections that are built in later phases share one placeholder page.
  ...["resume", "snippets", "search"].map((path) =>
    route(path, "routes/coming-soon.tsx", { id: `coming-soon-${path}` }),
  ),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
