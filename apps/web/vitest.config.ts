import { defineProject } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineProject({
  plugins: [tsconfigPaths()],
  test: { name: "web", include: ["*.test.ts", "app/**/*.test.{ts,tsx}", "worker/**/*.test.ts"] },
});
