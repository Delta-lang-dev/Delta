# Δ Delta

**Universal code transformation language.**

Delta lets you describe how code should change — across TypeScript, Python, Go, Rust, Java, and more — using six readable, composable constructs.

```delta
// Find every == null check in your TypeScript project
// and upgrade it to strict equality.
fix strictNull {
  pattern:  { $X == null }
  replace:  { $X === null }
  scope:    "**/*.ts"
  severity: bug
}
apply fix strictNull to project preview
```

## Install

```bash
npm install -g @delta-lang/cli
```

## Six constructs

| Construct | What it does |
|---|---|
| `patch` | Surgically replace a function or block in a specific file |
| `fix` | Define a reusable pattern → replacement rule across your codebase |
| `intent` | Inject code at every function entry or exit point |
| `migrate` | Rename symbols, move files, remove deprecated APIs |
| `guard` | Assert invariants before any transform runs |
| `trace` | Follow data through your codebase, flag dangerous paths |

## CLI

```bash
delta run transform.delta          # run a transform
delta run transform.delta --preview # preview without writing
delta check transform.delta        # validate syntax only
delta init                         # scaffold a starter transform.delta
```

## Documentation

[delta-lang.dev/docs](https://delta-lang.dev/docs) — full reference for all six constructs.

## Fix Library

[github.com/Delta-Lang-Dev/fix-library](https://github.com/Delta-Lang-Dev/fix-library) — community transforms for TypeScript, Python, Go, security, and migrations.

## Language support

**Stable:** TypeScript · JavaScript · Python · Go · Rust

**Beta:** Java · Kotlin · Swift · Ruby · C++ · C# · PHP

## VS Code extension

[vscode-delta](https://github.com/Delta-Lang-Dev/vscode-delta) — syntax highlighting, IntelliSense, LSP diagnostics, and run commands.

## Spec

[SPEC.md](./SPEC.md) — full language specification including EBNF grammar, compiler pipeline, and execution order.

## License

MIT — see [LICENSE](./LICENSE).
