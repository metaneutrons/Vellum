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
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      /* no-unnecessary-type-assertion is deliberately absent. Its autofix removes
         27 casts here and creates ten new no-unsafe findings doing it: the casts
         it calls unnecessary are the ones holding `any` in check, so it and the
         no-unsafe family disagree about the same lines. Revisit once those
         boundaries carry schemas rather than assertions. */
      "@typescript-eslint/require-await": "error",
      /* With primitives ignored. Almost every `||` here is deliberate: the code
         uses it to catch the EMPTY STRING as well as null, and `??` would let it
         through. `device.label?.trim() || contentName?.trim() || device.mac`
         depends on exactly that, and its tests assert that a blank name counts as
         no name. Applying the rule blindly would have broken it — and the same
         shape appears in header parsing, credential fallbacks and `disabled ||
         loading`. The rule keeps its value where a nullable object or number is
         meant. */
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true, boolean: true, number: true } },
      ],
      "@typescript-eslint/no-empty-function": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/no-base-to-string": "error",
      /* The stylistic tail, all autofixable and none of it load-bearing. */
      "@typescript-eslint/consistent-type-definitions": "error",
      "@typescript-eslint/consistent-indexed-object-style": "error",
      "@typescript-eslint/array-type": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/prefer-regexp-exec": "error",
      "@typescript-eslint/prefer-for-of": "error",
      "@typescript-eslint/no-unnecessary-type-parameters": "error",
      "@typescript-eslint/no-useless-default-assignment": "error",
      "@typescript-eslint/no-duplicate-type-constituents": "error",
      /* no-meaningless-void-operator is absent for the same family of reasons: its
         fix strips the `void` from `void remaining;`, which was there to say the
         value is deliberately unused — and the bare expression it leaves behind
         then trips no-unused-expressions. The marker IS the point.

/* no-unnecessary-type-conversion is deliberately absent, for the same reason
         as no-unnecessary-type-assertion above: its six findings here are all
         `Number(count)` on a Drizzle `sql<number>` aggregate. Postgres returns
         count(*) as bigint and the driver hands that over as a STRING, so the
         declared number is a claim and the conversion is what makes it true.
         Applying the fix would put "3" where a number is expected.
         Measured against the dev database, not assumed.

         non-nullable-type-assertion-style is absent too: its fix rewrites
         `x as string` into `x!`, which no-non-null-assertion forbids in production
         code. The two rules disagree about the same six lines. */
      /* With the arrow shorthand allowed. The rule's point is a `return f()` that
         hides a void call behind something that looks like a value; `onClick={() =>
         setOpen(true)}` is not that, and armed bare it produced 286 findings in
         production code against 7 real ones. */
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],
      /* Numbers and booleans are fine in a template; the rule exists for objects
         and for `unknown` out of a catch, which stringify to "[object Object]".
         Bare it flagged 164 in production, 3 of which were the real thing. */
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      /* Armed once the boundaries it complains about carried real checks rather
         than assertions. Its findings split three ways: dead defensive code, a
         chain the type already ruled out, and — the majority here — a `??` behind
         an `as` that had removed the very nullability the fallback was for. Only
         the first two are safe to simply delete. */
      "@typescript-eslint/no-unnecessary-condition": "error",
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
    /* Anything under a __tests__ directory is test code too, even when it is a
       shared helper rather than a *.test.ts file. */
    files: [
      "**/*.test.ts",
      "**/*.property.test.ts",
      "**/*.test.tsx",
      "**/__tests__/**/*.ts",
      "**/__tests__/**/*.tsx",
    ],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      /* A test that drives an HTTP route reads its answer as JSON, and JSON is
         `any` by construction. Demanding a parsed type there would mean asserting
         the very shape under test, so the assertion would pass by definition
         rather than by behaviour. These stay off for tests only — 85 of the 160
         findings sat here, and none of them describes a risk in shipped code. */
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      /* A mock stands in for something async, so it returns a promise without
         ever awaiting one — `vi.fn(async () => ({ ok: true }))` is the shape, not
         an oversight. 69 of the 71 require-await findings were exactly that. */
      "@typescript-eslint/require-await": "off",
      /* A test that asserts on a thrown value wants the value, not a re-narrowing
         of `unknown` at every catch. */
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  }
);
