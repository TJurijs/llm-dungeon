import tseslint from "typescript-eslint";

/**
 * Correctness-focused lint gate. Stylistic formatting is Prettier's job and is
 * intentionally not duplicated here. Type-aware rules run on all TypeScript
 * (app, tests, and the playtest harness); the browser frontend in web/ is
 * checked separately via tsconfig.web.json checkJs.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "data/",
      "config/",
      "playtests/",
      "evaluations/",
      "work/",
      "web/",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
    },
  },
  {
    // Boundary: the shipped app must never depend on the developer playtest
    // harness. The harness may import app modules freely (it drives the real
    // engine); the reverse direction is a design violation.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/tools/**"],
              message:
                "App code must not import the developer playtest harness (tools/). The dependency is one-way: tools may import src.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tests stub async interfaces with bodies that need no await; that pattern
    // is deliberate, so the await-presence rule stays app-only.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
);
