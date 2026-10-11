import { defineProject } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineProject({
  plugins: [tsconfigPaths()],
  test: { name: "web", include: ["app/**/*.test.{ts,tsx}"] },
});
