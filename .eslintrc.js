module.exports = {
  env: {
    browser: false,
    es2021: true,
    mocha: true,
    node: true,
  },
  plugins: ["node", "prettier", "@typescript-eslint", "mocha"],
  extends: [
    "plugin:prettier/recommended",
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:node/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 12,
  },
  rules: {
    "prettier/prettier": ["warn"],
    indent: 0, // avoid conflict with prettier's indent system
    "linebreak-style": ["error", "unix"],
    quotes: ["error", "double", { avoidEscape: true }],
    semi: ["error", "always"],
    "spaced-comment": ["error", "always", { exceptions: ["-", "+"] }],
    "no-console": 2,
    camelcase: "off",
    "@typescript-eslint/camelcase": "off",
    "mocha/no-exclusive-tests": "error",
    "@typescript-eslint/no-var-requires": "off",
    "node/no-unsupported-features/es-syntax": ["error", { ignores: ["modules"] }],
  },
  settings: {
    node: {
      tryExtensions: [".js", ".ts"],
    },
  },
  overrides: [
    {
      files: ["scripts/*.ts"],
      rules: {
        "no-console": 0,
      },
    },
  ],
};
