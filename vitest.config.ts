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
      // (node_modules, tests and config files are excluded) is kept, and only
      // modules the suite imports are measured, so `scripts/` is out of scope.
      //
      // Leave roughly a point of margin: coverage here is NOT reproducible to
      // the last statement, so a threshold set flush against a measurement is a
      // gate that fails at random.
      //
      // Two independent sources of drift, both learned the hard way. CI runs
      // Node 22 (.nvmrc) while a dev machine may run something newer, and v8
      // reports different statement counts per version — 70.24 locally against
      // 70.12 in CI. Worse, CI itself varies run to run: two runs over identical
      // source measured 70.12 and 69.96, roughly four statements apart, which
      // broke a release PR that changed no code at all. Something in the suite is
      // timing- or environment-dependent; until that is found, the floor has to
      // sit below the noise, not on top of it.
      //
      // Observed in CI (Node 22): statements 69.96-70.12, branches 63.98,
      // functions 68.04, lines 73.11. Raise these only against CI numbers, never
      // a local run, and keep the margin.
      thresholds: {
        statements: 69,
        branches: 63,
        functions: 67,
        lines: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
