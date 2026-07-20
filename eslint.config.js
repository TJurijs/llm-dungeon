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
);
