import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import kerfjs from "eslint-plugin-kerfjs";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tsdoc from "eslint-plugin-tsdoc";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**", "playwright-report/**", "test-results/**", "coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `allowDefaultProject` covers the handful of plain `.mjs` build
        // utilities under `scripts/`, which belong to no tsconfig project
        // (NEWS-264). Without it, un-ignoring `scripts/**` trades one silent
        // hole for a parsing error per file.
        projectService: {
          allowDefaultProject: ["scripts/*.mjs", "scripts/release/*.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
      import: importX,
      tsdoc: tsdoc,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true, allow: [{ from: "file", name: "SafeHtml" }, { from: "lib", name: "URLSearchParams" }] }],
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "tsdoc/syntax": "warn",
    },
  },
  kerfjs.configs.recommended,
  {
    // The plain `.mjs` build utilities under `scripts/` (NEWS-264).
    //
    // They used to be covered by `scripts/**` being ignored wholesale, which also
    // hid ~950 lines of real TypeScript. Un-ignoring the directory brought these
    // in too — and `strictTypeChecked` on untyped JS produced 87 errors, almost
    // all of them "unsafe any", because there are no types to be safe about. That
    // is the ruleset being wrong for the file, not 87 bugs.
    //
    // So they get the type-aware rules switched off and the two Node globals they
    // actually use declared. Real linting — unused vars, undefined names,
    // import order — without pretending untyped JS can satisfy a type-aware
    // config.
    files: ["scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "tsdoc/syntax": "off",
    },
  },
);
