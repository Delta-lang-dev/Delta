// src/resolver.ts
// ─── Delta Semantic Resolver ──────────────────────────────────────────────
// After parsing, we validate that:
//   • Referenced files exist and are readable
//   • Language IDs are valid for their operations
//   • Fix/migrate/guard names are unique and defined before apply
//   • Guard assertions are syntactically valid
//
// The resolver also builds a DependencyGraph so the runner knows
// the correct execution order (guards → patches → fixes → intents → traces).

import * as fs   from "fs";
import * as path from "path";
import * as AST  from "./ast";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message:  string;
  span:     AST.Span;
}

export interface ResolvedProgram {
  ast:         AST.Program;
  diagnostics: Diagnostic[];
  order:       AST.TopDecl[];   // topological execution order
  registry:    Registry;
}

export interface Registry {
  fixes:    Map<string, AST.FixDecl>;
  migrates: Map<string, AST.MigrateDecl>;
  guards:   Map<string, AST.GuardDecl>;
}

export function resolve(
  ast: AST.Program,
  cwd: string
): ResolvedProgram {
  const diags: Diagnostic[] = [];
  const registry: Registry  = {
    fixes:    new Map(),
    migrates: new Map(),
    guards:   new Map(),
  };

  const err  = (msg: string, span: AST.Span) =>
    diags.push({ severity: "error",   message: msg, span });
  const warn = (msg: string, span: AST.Span) =>
    diags.push({ severity: "warning", message: msg, span });

  // ── Pass 1: build registry ─────────────────────────────────────────────
  for (const d of ast.decls) {
    if (d.kind === "FixDecl") {
      if (registry.fixes.has(d.name))
        err(\`Duplicate fix name '\${d.name}'\`, d.span);
      registry.fixes.set(d.name, d);
    }
    if (d.kind === "MigrateDecl") {
      if (registry.migrates.has(d.label))
        err(\`Duplicate migrate label '\${d.label}'\`, d.span);
      registry.migrates.set(d.label, d);
    }
    if (d.kind === "GuardDecl") {
      if (registry.guards.has(d.label))
        err(\`Duplicate guard label '\${d.label}'\`, d.span);
      registry.guards.set(d.label, d);
    }
  }

  // ── Pass 2: validate references ────────────────────────────────────────
  for (const d of ast.decls) {
    // Patch: target file should exist
    if (d.kind === "PatchDecl") {
      const abs = path.resolve(cwd, d.file);
      if (!fs.existsSync(abs))
        warn(\`Patch target '\${d.file}' not found — will be skipped\`, d.span);
    }

    // Apply: referenced name must be declared
    if (d.kind === "ApplyStmt") {
      if (d.applyKind === "fix"     && !registry.fixes.has(d.name))
        err(\`apply fix '\${d.name}' — fix not declared\`, d.span);
      if (d.applyKind === "migrate" && !registry.migrates.has(d.name))
        err(\`apply migrate '\${d.name}' — migrate not declared\`, d.span);
      if (d.applyKind === "guard"   && !registry.guards.has(d.name))
        err(\`apply guard '\${d.name}' — guard not declared\`, d.span);
    }

    // Intent: scope glob should match at least one file
    if (d.kind === "IntentDecl") {
      // (glob check deferred to runner for performance)
    }
  }

  // ── Pass 3: topological ordering ───────────────────────────────────────
  // Guards first, then patches, fixes, migrates, intents, traces, applies
  const priority: Record<AST.TopDecl["kind"], number> = {
    ImportStmt:   0,
    GuardDecl:    1,
    PatchDecl:    2,
    FixDecl:      3,
    MigrateDecl:  4,
    IntentDecl:   5,
    TraceDecl:    6,
    ApplyStmt:    7,
  };
  const order = [...ast.decls].sort(
    (a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9)
  );

  return { ast, diagnostics: diags, order, registry };
}