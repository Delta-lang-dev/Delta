// src/resolver.ts
// ─── Delta Semantic Resolver ──────────────────────────────────────────────
// Stage three of the compiler. Validates the AST against the real filesystem,
// checks for undefined references, and sorts declarations into the correct
// execution order before the emitter runs.

import * as fs   from "fs";
import * as path from "path";
import * as AST  from "./ast";

// ── Diagnostic types ───────────────────────────────────────────────────────

export type DiagSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagSeverity;
  message:  string;
  span:     AST.Span;
  hint?:    string;
}

// ── Registry ───────────────────────────────────────────────────────────────
// Collected during Pass 1. Lets the resolver answer "is this fix/migrate/guard
// defined?" when it hits an apply statement in Pass 2.

export interface Registry {
  fixes:    Map<string, AST.FixDecl>;
  migrates: Map<string, AST.MigrateDecl>;
  guards:   Map<string, AST.GuardDecl>;
  imports:  Map<string, AST.ImportStmt>;
}

// ── Output ─────────────────────────────────────────────────────────────────

export interface ResolvedProgram {
  ast:         AST.Program;
  diagnostics: Diagnostic[];
  order:       AST.TopDecl[];  // topologically sorted execution order
  registry:    Registry;
  hasErrors:   boolean;
}

// ── Valid language IDs ─────────────────────────────────────────────────────

const VALID_LANG_IDS = new Set<AST.LangId>([
  "TypeScript", "JavaScript", "Python",
  "Rust",       "Go",         "Java",
  "Kotlin",     "Swift",      "Ruby",
  "CPP",        "CSharp",     "PHP",
]);

// ── Valid severity levels ──────────────────────────────────────────────────

const VALID_SEVERITIES = new Set<AST.SeverityLevel>([
  "bug", "perf", "style", "security",
]);

// ── Execution priority ────────────────────────────────────────────────────
// Guards always run first so they can block unsafe operations.
// Imports are resolved before everything else.
// Patches and fixes run before migrations.
// Intents run after patches so guards can check the patched state.
// Traces run last since they are read-only analysis.
// Apply statements run immediately after their referenced declaration type.

const EXEC_PRIORITY: Record<AST.TopDecl["kind"], number> = {
  ImportStmt:   0,
  GuardDecl:    1,
  PatchDecl:    2,
  FixDecl:      3,
  ApplyStmt:    4,
  MigrateDecl:  5,
  IntentDecl:   6,
  TraceDecl:    7,
};

// ═══════════════════════════════════════════════════════════════════════════
//  Main resolve function
// ═══════════════════════════════════════════════════════════════════════════

export function resolve(
  ast: AST.Program,
  cwd: string
): ResolvedProgram {

  const diagnostics: Diagnostic[] = [];
  const registry: Registry = {
    fixes:    new Map(),
    migrates: new Map(),
    guards:   new Map(),
    imports:  new Map(),
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  const error = (message: string, span: AST.Span, hint?: string): void => {
    diagnostics.push({ severity: "error", message, span, hint });
  };

  const warn = (message: string, span: AST.Span, hint?: string): void => {
    diagnostics.push({ severity: "warning", message, span, hint });
  };

  const info = (message: string, span: AST.Span): void => {
    diagnostics.push({ severity: "info", message, span });
  };

  const fileExists = (filePath: string): boolean =>
    fs.existsSync(path.resolve(cwd, filePath));

  // ── Pass 1: Build the registry ────────────────────────────────────────────
  // Walk every top-level declaration and register named constructs.
  // Duplicate names are caught here before anything tries to look them up.

  for (const decl of ast.decls) {

    if (decl.kind === "FixDecl") {
      if (registry.fixes.has(decl.name)) {
        error(
          `Duplicate fix name '${decl.name}' — each fix must have a unique name`,
          decl.span,
          `Rename one of them or merge them into a single fix block`
        );
      } else {
        registry.fixes.set(decl.name, decl);
      }
    }

    if (decl.kind === "MigrateDecl") {
      if (registry.migrates.has(decl.label)) {
        error(
          `Duplicate migrate label '${decl.label}'`,
          decl.span,
          `Each migrate block must have a unique label`
        );
      } else {
        registry.migrates.set(decl.label, decl);
      }
    }

    if (decl.kind === "GuardDecl") {
      if (registry.guards.has(decl.label)) {
        error(
          `Duplicate guard label '${decl.label}'`,
          decl.span,
          `Each guard block must have a unique label`
        );
      } else {
        registry.guards.set(decl.label, decl);
      }
    }

    if (decl.kind === "ImportStmt") {
      if (registry.imports.has(decl.alias)) {
        warn(
          `Duplicate import alias '${decl.alias}' — the second import will shadow the first`,
          decl.span
        );
      }
      registry.imports.set(decl.alias, decl);
    }
  }

  // ── Pass 2: Validate each declaration ─────────────────────────────────────
  // Check that referenced files exist, language IDs are valid,
  // apply statements reference declared names, etc.

  for (const decl of ast.decls) {

    switch (decl.kind) {

      // ── patch validation ─────────────────────────────────────────────────
      case "PatchDecl": {
        // Language ID must be valid
        if (!VALID_LANG_IDS.has(decl.lang)) {
          error(
            `Unknown language '${decl.lang}'`,
            decl.span,
            `Valid languages: ${[...VALID_LANG_IDS].join(", ")}`
          );
        }

        // Target file should exist — warn rather than error because
        // the file might be created by an earlier step in the pipeline
        if (!fileExists(decl.file)) {
          warn(
            `Patch target '${decl.file}' not found in ${cwd}`,
            decl.span,
            `The patch will be skipped at runtime if the file does not exist`
          );
        }

        // Replace body must not be empty
        if (!decl.replace.body.trim()) {
          error(
            `Patch replace body is empty — nothing to replace with`,
            decl.span,
            `Add the new code inside the replace with { } block`
          );
        }

        // Find clause must have a name for fn type
        if (decl.find.type === "fn" && !decl.find.name.trim()) {
          error(
            `Patch find clause is missing a function name`,
            decl.span
          );
        }

        break;
      }

      // ── fix validation ───────────────────────────────────────────────────
      case "FixDecl": {
        if (!decl.pattern.trim()) {
          error(
            `Fix '${decl.name}' has an empty pattern`,
            decl.span,
            `Add the code pattern to match inside the pattern: { } block`
          );
        }

        if (!decl.replace.trim()) {
          error(
            `Fix '${decl.name}' has an empty replace`,
            decl.span,
            `Add the replacement code inside the replace: { } block`
          );
        }

        if (!decl.scope.trim()) {
          error(
            `Fix '${decl.name}' has no scope — at least one glob pattern is required`,
            decl.span,
            `Example: scope: "**/*.ts"`
          );
        }

        if (decl.severity && !VALID_SEVERITIES.has(decl.severity)) {
          warn(
            `Unknown severity '${decl.severity}' in fix '${decl.name}'`,
            decl.span,
            `Valid severities: bug, perf, style, security`
          );
        }

        break;
      }

      // ── intent validation ────────────────────────────────────────────────
      case "IntentDecl": {
        if (!VALID_LANG_IDS.has(decl.language)) {
          error(
            `Unknown language '${decl.language}' in intent '${decl.label}'`,
            decl.span,
            `Valid languages: ${[...VALID_LANG_IDS].join(", ")}`
          );
        }

        if (!decl.inject.trim()) {
          error(
            `Intent '${decl.label}' has an empty inject block`,
            decl.span,
            `Add the code to inject inside the inject: { } block`
          );
        }

        if (!decl.scope.trim()) {
          warn(
            `Intent '${decl.label}' has no scope — will match all files`,
            decl.span,
            `Consider adding: scope: "src/**" to limit the scope`
          );
        }

        break;
      }

      // ── migrate validation ───────────────────────────────────────────────
      case "MigrateDecl": {
        if (!VALID_LANG_IDS.has(decl.lang)) {
          error(
            `Unknown language '${decl.lang}' in migrate '${decl.label}'`,
            decl.span,
            `Valid languages: ${[...VALID_LANG_IDS].join(", ")}`
          );
        }

        if (decl.rules.length === 0) {
          warn(
            `Migrate '${decl.label}' has no rules — nothing will be changed`,
            decl.span,
            `Add at least one rename, move, replace, or remove rule`
          );
        }

        // Validate each rule
        for (const rule of decl.rules) {
          if (rule.type === "rename") {
            if (!rule.from.trim()) {
              error(`Migrate '${decl.label}' rename rule has empty 'from'`, decl.span);
            }
            if (!rule.to.trim()) {
              error(`Migrate '${decl.label}' rename rule has empty 'to'`, decl.span);
            }
            if (rule.from.trim() === rule.to.trim()) {
              warn(
                `Migrate '${decl.label}' rename rule has identical from and to — no change will occur`,
                decl.span
              );
            }
          }

          if (rule.type === "move") {
            if (!fileExists(rule.from)) {
              warn(
                `Migrate '${decl.label}' move source '${rule.from}' not found`,
                decl.span,
                `The move will be skipped if the file does not exist at runtime`
              );
            }
          }
        }

        break;
      }

      // ── guard validation ─────────────────────────────────────────────────
      case "GuardDecl": {
        if (!decl.scope.trim()) {
          warn(
            `Guard '${decl.label}' has no scope — will check all files`,
            decl.span,
            `Consider adding: scope: "src/**" to limit scope`
          );
        }

        if (decl.asserts.length === 0) {
          warn(
            `Guard '${decl.label}' has no assert clauses — it will always pass`,
            decl.span,
            `Add at least one assert: clause to make the guard useful`
          );
        }

        if (decl.onFail.length === 0) {
          warn(
            `Guard '${decl.label}' has no on_fail action — failures will be silently ignored`,
            decl.span,
            `Add: on_fail: block_apply, show_diff`
          );
        }

        break;
      }

      // ── trace validation ─────────────────────────────────────────────────
      case "TraceDecl": {
        if (!VALID_LANG_IDS.has(decl.language)) {
          error(
            `Unknown language '${decl.language}' in trace '${decl.ident}'`,
            decl.span,
            `Valid languages: ${[...VALID_LANG_IDS].join(", ")}`
          );
        }

        if (!decl.origin.trim()) {
          error(
            `Trace '${decl.ident}' has no origin — cannot start data-flow analysis`,
            decl.span,
            `Add: origin: req.body.fieldName`
          );
        }

        if (!decl.dir.trim()) {
          error(
            `Trace '${decl.ident}' has no directory — specify where to trace`,
            decl.span,
            `Add: in "src/"`
          );
        }

        if (decl.follow.length === 0) {
          warn(
            `Trace '${decl.ident}' has no follow kinds — will only report the origin`,
            decl.span,
            `Add: follow: assignments, function_calls, returns`
          );
        }

        break;
      }

      // ── apply validation ─────────────────────────────────────────────────
      case "ApplyStmt": {
        if (decl.applyKind === "fix") {
          if (!registry.fixes.has(decl.name)) {
            error(
              `apply fix '${decl.name}' — no fix with that name is declared`,
              decl.span,
              `Declared fixes: ${[...registry.fixes.keys()].join(", ") || "none"}`
            );
          }
        }

        if (decl.applyKind === "migrate") {
          if (!registry.migrates.has(decl.name)) {
            error(
              `apply migrate '${decl.name}' — no migrate with that label is declared`,
              decl.span,
              `Declared migrates: ${[...registry.migrates.keys()].join(", ") || "none"}`
            );
          }
        }

        if (decl.applyKind === "guard") {
          if (!registry.guards.has(decl.name)) {
            error(
              `apply guard '${decl.name}' — no guard with that label is declared`,
              decl.span,
              `Declared guards: ${[...registry.guards.keys()].join(", ") || "none"}`
            );
          }
        }

        break;
      }

      // ── import validation ────────────────────────────────────────────────
      case "ImportStmt": {
        if (!fileExists(decl.path)) {
          error(
            `Import '${decl.path}' not found`,
            decl.span,
            `Check the path is relative to your working directory`
          );
        }

        if (!decl.path.endsWith(".delta")) {
          warn(
            `Import '${decl.path}' does not have a .delta extension`,
            decl.span,
            `Delta import files should end in .delta`
          );
        }

        break;
      }
    }
  }

  // ── Pass 3: Topological sort ──────────────────────────────────────────────
  // Sort declarations into the correct execution order.
  // We use a stable sort so declarations of the same type
  // execute in the order they appear in the source file.

  const order = [...ast.decls].sort((a, b) => {
    const pa = EXEC_PRIORITY[a.kind] ?? 9;
    const pb = EXEC_PRIORITY[b.kind] ?? 9;
    return pa - pb;
  });

  // ── Pass 4: Cross-reference checks ───────────────────────────────────────
  // Check for apply statements that appear BEFORE their declaration.
  // This is a warning not an error — the sort handles it at runtime —
  // but it is confusing to read and we want to flag it.

  const declaredAt: Map<string, number> = new Map();
  const appliedAt:  Map<string, number> = new Map();

  ast.decls.forEach((decl, idx) => {
    if (decl.kind === "FixDecl")     declaredAt.set(`fix:${decl.name}`, idx);
    if (decl.kind === "MigrateDecl") declaredAt.set(`migrate:${decl.label}`, idx);
    if (decl.kind === "GuardDecl")   declaredAt.set(`guard:${decl.label}`, idx);
    if (decl.kind === "ApplyStmt") {
      const key = `${decl.applyKind}:${decl.name}`;
      appliedAt.set(key, idx);
    }
  });

  for (const [key, applyIdx] of appliedAt) {
    const declIdx = declaredAt.get(key);
    if (declIdx !== undefined && applyIdx < declIdx) {
      warn(
        `apply '${key.split(":")[1]}' appears before its declaration`,
        ast.decls[applyIdx]!.span,
        `Move the apply statement after the ${key.split(":")[0]} declaration for clarity`
      );
    }
  }

  // ── Summary info diagnostic ───────────────────────────────────────────────

  const patchCount   = ast.decls.filter(d => d.kind === "PatchDecl").length;
  const fixCount     = ast.decls.filter(d => d.kind === "FixDecl").length;
  const migrateCount = ast.decls.filter(d => d.kind === "MigrateDecl").length;
  const guardCount   = ast.decls.filter(d => d.kind === "GuardDecl").length;
  const traceCount   = ast.decls.filter(d => d.kind === "TraceDecl").length;
  const intentCount  = ast.decls.filter(d => d.kind === "IntentDecl").length;

  info(
    `Resolved: ${patchCount} patch, ${fixCount} fix, ${intentCount} intent, ` +
    `${migrateCount} migrate, ${guardCount} guard, ${traceCount} trace`,
    ast.decls[0]?.span ?? { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } }
  );

  const hasErrors = diagnostics.some(d => d.severity === "error");

  return { ast, diagnostics, order, registry, hasErrors };
}
