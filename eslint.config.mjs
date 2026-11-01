// Flat ESLint config for the whole workspace.
// The web app adds Next.js rules in apps/web/eslint.config.mjs (linted from that directory).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "apps/web/**",
      "**/next-env.d.ts",
      "_legacy-prototype/**",
      ".data/**",
      ".local-services/**",
      "test-results/**",
      "playwright-report/**",
      "tests/e2e/.results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["scripts/**", "tests/**", "**/*.config.*"],
    rules: { "no-console": "off" },
  },
  {
    // Tests read loosely-typed JSON responses.
    files: ["tests/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
