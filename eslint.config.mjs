import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: [".next/", "node_modules/", "drizzle/", "firmware/", "public/"] },
  ...tseslint.configs.strict,
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
