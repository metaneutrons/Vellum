import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.property.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "json-summary"],
      // Ratchet gate: thresholds sit just below current coverage of the code
      // the suite exercises, so it can only hold or improve — never silently
      // regress. Raise these as coverage grows. Default v8 include/exclude
      // (node_modules, tests and config files are excluded) is kept.
      thresholds: {
        statements: 55,
        branches: 44,
        functions: 44,
        lines: 56,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
