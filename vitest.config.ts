import { coverageConfigDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.property.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "json-summary"],
      /*
       * Retired content types are not measured, and that is a statement rather than
       * a convenience.
       *
       * `door-sign` and `door-sign-multi` still render so that existing instances
       * keep working, but nothing new can be created and the code is kept only
       * because its free-positioning editor is most of a future free-form sign
       * (docs/door-sign-retirement.md). The moment ONE test imported the registry,
       * the registry imported them, and 1 000 lines at 8 % and 4 % coverage joined
       * the average: statements fell 72.6 to 69.5 and branches to 63.13 against a
       * floor of 63, which CI's own ~0.2 point run-to-run drift would break about
       * half the time.
       *
       * The alternatives were worse. Writing tests for code that is on its way out
       * spends effort on the wrong thing, and dropping the registry assertion would
       * remove the one guard against somebody deleting a renderer that live displays
       * still name.
       *
       * Reviving this code as a free-form sign means deleting these three lines
       * first. That is deliberate: it is the moment the coverage debt becomes real.
       */
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/lib/content/renderers/door-sign.ts",
        "src/lib/content/renderers/door-sign-multi.ts",
        "src/lib/content/renderers/shared.ts",
      ],
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
        // Raised per refactor stage. The frame-invariant sweep (stage 1) took
        // this to 75.21 / 68.25 / 76.01 / 77.75; splitting load from draw
        // (stage 2) to 75.91 / 68.76 / 75.24 / 78.54, and it moved the two
        // renderers that matter: room-booking from 51.9 to 68.8 statements and
        // 38.6 to 57.6 branches, name-plate's branches from 31.6 to 43.4. Nobody
        // wrote a test for either; they became reachable without a database.
        // Functions dipped a point because the split exports small functions
        // faster than the sweep exercises every one of them, so that floor stays
        // where stage 1 put it. The margin below each is deliberate; see the note
        // above on why a threshold set flush against a measurement is a gate that
        // fails at random.
        // Stage 4 raised these again, measured at 78.70 / 71.15 / 78.18 / 81.44.
        // The providers did the moving: microsoft365 from 11.1 to 100 % of
        // statements and 0 to 80.8 % of branches, google from 12.0 to 92 % and 0 to
        // 62.5 %, once a shared contract suite existed to point at them.
        statements: 77,
        branches: 70,
        functions: 77,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
