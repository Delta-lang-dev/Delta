/** @type {import("jest").Config} */
module.exports = {
  preset:              "ts-jest",
  testEnvironment:     "node",
  roots:               ["<rootDir>/src", "<rootDir>/__tests__"],
  testMatch:           ["**/__tests__/**/*.test.ts"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/cli.ts",    // CLI tested via integration, not unit
    "!src/lsp.ts",    // LSP tested via vscode-delta
  ],
  coverageThreshold: {
    global: {
      branches:  70,
      functions: 80,
      lines:     80,
      statements: 80,
    },
  },
  moduleNameMapper: {
    "^(\.{1,2}/.*)\.js$": "$1",
  },
};
