import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  /* ".claude/" and ".codacy/" hold agent and quality-gate tooling, not project
     source: the Verity setup drops a pattern validator and its own ESLint config
     there, and linting them under this repo's rules fails on a plugin they do not
     use and on console output that is their entire purpose. */
  {
    ignores: [
      ".next/",
      "node_modules/",
      "drizzle/",
      "firmware/",
      "public/",
      ".claude/",
      ".codacy/",
      ".verity/",
    ],
  },
  ...tseslint.configs.strict,
  /* Type-aware linting, enabled one rule at a time rather than by switching the
     whole `strictTypeChecked` preset on. The preset produces 1090 findings here;
     taken in one sweep, the handful that are real defects would be buried under a
     thousand mechanical ones. This first block is the set that finds bugs rather
     than style: a forgotten await, a template that stringifies an object, a call
     into a deprecated API. */
  {
    /* Only the files tsconfig.json actually includes. Type-aware rules need the
       type checker, and a .mjs config or gate script is not in the project — it
       would fail to parse rather than be linted. Those keep the untyped rules
       above. */
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-base-to-string": "error",
    },
  },
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-console": ["error", { allow: ["error"] }],
      // Allow the `x != null` idiom (null-or-undefined); require strict elsewhere.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: {
      // Command-line scripts intentionally report progress and results.
      "no-console": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.property.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  }
);
