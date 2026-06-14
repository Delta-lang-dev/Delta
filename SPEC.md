# Delta (Δ) Language Specification

Version 1.0 — June 2026

---

## Overview

Delta (Δ) is a universal, language-agnostic code transformation language. It provides six composable constructs for describing how source code should change — without coupling the description to any specific programming language's syntax or toolchain.

Delta transforms are declarative: you describe *what* should change and *why*, not *how* to implement the change. The Delta compiler handles the mechanics.

---

## Design Goals

1. **Readable** — A Delta transform should be understandable by someone unfamiliar with the target language
2. **Composable** — Multiple constructs combine naturally in a single `.delta` file
3. **Safe by default** — `preview` mode never writes to disk; guards block unsafe transforms
4. **Language-agnostic** — The same six keywords work across TypeScript, Python, Go, Rust, Java, and more
5. **AST-accurate** — Delta uses real parsers (TypeScript Compiler API, tree-sitter) — not text search

---

## File Format

Delta files use the `.delta` extension and UTF-8 encoding. Comments use `//`.

```delta
// This is a comment
patch "src/app.ts" in TypeScript {
  find fn greet() {}
  replace with { return "Hello!"; }
  why: "update greeting"
}
```

---

## Constructs

### 1. patch

Surgically replaces a specific function or block in a specific file.

```ebnf
PatchDecl ::= "patch" STRING "in" Language "{" PatchBody "}"
PatchBody ::= FindClause ReplaceClause WhyClause?
FindClause ::= "find" ("fn" IDENT "(" ")" "{" "}" | "block" STRING "{" "}")
ReplaceClause ::= "replace" "with" "{" RAW_SOURCE "}"
WhyClause ::= "why" ":" STRING
```

**Example:**
```delta
patch "src/auth.ts" in TypeScript {
  find fn hashPassword(password: string) {}
  replace with {
    return await bcrypt.hash(password, 12);
  }
  why: "upgrade to async bcrypt"
}
```

---

### 2. fix

Defines a reusable pattern → replacement rule applied across a glob scope.

```ebnf
FixDecl ::= "fix" IDENT "{" FixBody "}"
FixBody ::= PatternClause ReplaceClause ScopeClause SeverityClause? NoteClause?
PatternClause  ::= "pattern" ":" "{" RAW_SOURCE "}"
ScopeClause    ::= "scope"   ":" STRING
SeverityClause ::= "severity" ":" ("bug" | "perf" | "style" | "security")
NoteClause     ::= "note"    ":" STRING
```

Patterns may include `$VAR` capture groups that match any expression.

**Example:**
```delta
fix strictNull {
  pattern:  { $X == null }
  replace:  { $X === null }
  scope:    "**/*.ts"
  severity: bug
  note:     "Use strict equality"
}
```

---

### 3. intent

Injects code at every function entry or exit point across matching files.

```ebnf
IntentDecl ::= "intent" STRING "{" IntentBody "}"
IntentBody ::= ScopeClause LanguageClause InjectClause WhereClause PreserveClause? GuardRef?
LanguageClause ::= "language" ":" Language
InjectClause   ::= "inject"   ":" "{" RAW_SOURCE "}"
WhereClause    ::= "where"    ":" ("function_entry" | "function_exit")
PreserveClause ::= "preserve" ":" STRING
GuardRef       ::= "guard"    ":" IDENT
```

**Example:**
```delta
intent "add audit logging" {
  scope:    "src/api/**"
  language: TypeScript
  inject:   { logger.audit(arguments.callee.name); }
  where:    function_entry
}
```

---

### 4. migrate

Renames symbols, moves files, and removes deprecated APIs across the codebase.

```ebnf
MigrateDecl ::= "migrate" STRING "in" Language "{" MigrateBody "}"
MigrateBody ::= MigrateRule+ ScopeClause?
MigrateRule ::= RenameRule | MoveRule | RemoveRule
RenameRule  ::= "rename" ":" IDENT "->" IDENT
MoveRule    ::= "move"   ":" STRING "->" STRING
RemoveRule  ::= "remove" ":" "deprecated" IDENT
```

**Example:**
```delta
migrate "lodash to native" in TypeScript {
  rename: _.map    -> [].map
  rename: _.filter -> [].filter
  remove: deprecated _.each
  scope:  "src/**/*.ts"
}
```

---

### 5. guard

Asserts invariants before any transform is applied. Blocks apply on failure.

```ebnf
GuardDecl ::= "guard" STRING "{" GuardBody "}"
GuardBody ::= ScopeClause AssertClause+ OnFailClause
AssertClause ::= "assert" ":" AssertExpr
AssertExpr   ::= FnExistsExpr | NoImportExpr | AllContainExpr | NoRawSqlExpr
FnExistsExpr   ::= "fn" IDENT "(" ")" "exists"
NoImportExpr   ::= "no" "file" "imports" "from" STRING
AllContainExpr ::= "all" "files" "contain" STRING
OnFailClause   ::= "on_fail" ":" OnFailAction ("," OnFailAction)*
OnFailAction   ::= "block_apply" | "warn" | "show_diff"
```

**Example:**
```delta
guard "api contract" {
  scope:   "src/**"
  assert:  fn verifyToken() exists
  assert:  no file imports from "../admin"
  on_fail: block_apply, show_diff
}
```

---

### 6. trace

Performs data-flow analysis, tracking a value through assignments, calls, and returns.

```ebnf
TraceDecl ::= "trace" IDENT "in" STRING "{" TraceBody "}"
TraceBody ::= LanguageClause OriginClause FollowClause ReportClause FlagClause*
OriginClause ::= "origin" ":" Expression
FollowClause ::= "follow" ":" FollowKind ("," FollowKind)*
FollowKind   ::= "assignments" | "function_calls" | "returns"
ReportClause ::= "report" ":" ("full_chain" | "summary")
FlagClause   ::= "flag"   ":" STRING
```

**Example:**
```delta
trace userInput in "src/" {
  language: TypeScript
  origin:   req.body.email
  follow:   assignments, function_calls, returns
  report:   full_chain
  flag:     "any path that reaches db.query without sanitize"
}
```

---

### 7. apply

Executes a named fix or migration against a target.

```ebnf
ApplyStmt ::= "apply" ApplyKind IDENT "to" ApplyTarget "preview"?
ApplyKind  ::= "fix" | "migrate"
ApplyTarget ::= "project" | "file" STRING | "directory" STRING
```

**Example:**
```delta
apply fix strictNull to project preview
apply migrate "lodash to native" to project
```

---

### 8. import

Imports constructs from another `.delta` file.

```ebnf
ImportStmt ::= "import" IDENT "from" STRING
```

**Example:**
```delta
import securityGuards from "./guards/security.delta"
```

---

## Language Identifiers

| ID | Toolchain |
|---|---|
| `TypeScript` | TypeScript Compiler API |
| `JavaScript` | TypeScript Compiler API (JS mode) |
| `Python` | tree-sitter-python |
| `Go` | tree-sitter-go |
| `Rust` | tree-sitter-rust |
| `Java` | tree-sitter-java |
| `Kotlin` | tree-sitter (generic fallback) |
| `Swift` | tree-sitter (generic fallback) |
| `Ruby` | tree-sitter (generic fallback) |
| `CPP` | tree-sitter (generic fallback) |
| `CSharp` | tree-sitter (generic fallback) |
| `PHP` | tree-sitter (generic fallback) |

---

## Compiler Pipeline

Delta source goes through four stages:

```
Source (.delta)
    │
    ▼
[1] Lexer        — tokenise into TokKind stream
    │
    ▼
[2] Parser       — produce typed AST (TopDecl[])
    │
    ▼
[3] Resolver     — 4-pass semantic validation + topological sort
    │              Pass 1: Registry (collect declarations)
    │              Pass 2: Validation (check each declaration)
    │              Pass 3: Reference resolution (apply → fix/migrate)
    │              Pass 4: Execution order (guards → patches/fixes/intents/migrates → traces)
    ▼
[4] Emitter      — execute transforms against real files
                   Read file → apply transform → write file → produce diff
```

---

## Execution Order

The Resolver enforces this execution order regardless of declaration order in the source file:

1. **import** — resolved first, inlined
2. **guard** — must pass before any transform runs
3. **patch** — single-file surgical transforms
4. **fix** + **intent** + **migrate** — multi-file transforms (in declaration order)
5. **trace** — analysis runs after all transforms

---

## Error Handling

All Delta errors include:
- **Message**: human-readable description
- **Line/col**: source location in the `.delta` file
- **Severity**: `error` (blocking) or `warning` (non-blocking)

The compiler exits with code `1` if any `error`-severity diagnostic is produced.
