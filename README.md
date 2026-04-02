# Δ Delta — Universal Code Transformation Language

> Write change intent once. Apply it across Python, TypeScript, Rust, Go, Java, and more.

## Install

\`\`\`bash
npm install -g @delta-lang/cli
# or add as a dev dependency:
npm install --save-dev @delta-lang/cli
\`\`\`

## Quick Start

\`\`\`bash
# Scaffold a starter file
delta init --lang ts

# Check a .delta file for errors without running it
delta check transform.delta

# Preview changes (no files are written)
delta run transform.delta --preview

# Apply changes for real
delta run transform.delta
\`\`\`

## Your First .delta File

\`\`\`delta
// fix a null-check bug in TypeScript
patch "src/auth/login.ts" in TypeScript {
  find fn verifyToken(token) {
    return jwt.verify(token, SECRET)
  }
  replace with {
    if (!token) return null
    try { return jwt.verify(token, SECRET) } catch { return null }
  }
  why: "jwt.verify throws on null — guard added"
}
\`\`\`

## All Constructs

| Construct  | Purpose                              |
|------------|--------------------------------------|
| \`patch\`    | Surgical named code change           |
| \`fix\`      | Reusable pattern replacement         |
| \`intent\`   | High-level cross-cutting change      |
| \`migrate\`  | API version-to-version upgrade       |
| \`guard\`    | Invariants that block unsafe changes |
| \`trace\`    | Data-flow analysis for debugging     |
| \`apply\`    | Execute a fix / migrate / guard      |

## VS Code Extension

Install from the marketplace:

\`\`\`
ext install delta-lang.delta-lang
\`\`\`

Or install from VSIX:
\`\`\`bash
cd vscode-extension && npm run package
code --install-extension delta-lang-1.0.0.vsix
\`\`\`

## CI Integration (GitHub Actions)

\`\`\`yaml
name: Delta Guard Check
on: [push, pull_request]
jobs:
  delta-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g @delta-lang/cli
      - run: delta check guards.delta
      - run: delta run guards.delta --preview
\`\`\`

## Supported Languages

TypeScript · JavaScript · Python · Rust · Go · Java · Kotlin · Swift · Ruby · C++ · C# · PHP

## How It Works

Delta is a **pure compile-time transformation tool**. It reads \`.delta\` files,
parses your target source files using tree-sitter (Python/Go/Rust/etc.) or
the TypeScript Compiler API, applies your transformations, and writes
modified source files back to disk. Zero runtime cost.

## License

MIT © Delta Language Contributors