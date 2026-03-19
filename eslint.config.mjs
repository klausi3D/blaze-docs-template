import js from "@eslint/js";
import globals from "globals";

const strictRules = {
  ...js.configs.recommended.rules,
  eqeqeq: ["error", "always"],
  curly: ["error", "multi-line"],
  "no-var": "error",
  "prefer-const": "error",
  "object-shorthand": ["error", "always"],
  "prefer-template": "error",
  "no-implicit-coercion": "error",
};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "output/**"],
  },
  {
    files: ["src/assets/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        __PRECACHE_MANIFEST__: "readonly",
        __BUILD_HASH__: "readonly",
      },
    },
    rules: strictRules,
  },
  {
    files: ["tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        document: "readonly",
      },
    },
    rules: strictRules,
  },
];
