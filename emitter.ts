// src/emitter.ts
// ─── Delta Emitter ────────────────────────────────────────────────────────
// Takes the resolved program and produces modified source files.
// Supports both --preview (print diff) and --apply (write to disk).

import * as fs   from "fs";
import * as path from "path";
import { createPatch } from "diff";
import fg           from "fast-glob";
import * as AST     from "./ast";
import { Registry } from "./resolver";
import { runGuard  } from "./guards";
import { getParser } from "./targets";

export interface EmitOptions {
  cwd:     string;
  preview: boolean;
  verbose: boolean;
}

export interface EmitResult {
  file:    string;
  before:  string;
  after:   string;
  diff:    string;
  applied: boolean;
  errors:  string[];
}

export async function emit(
  order:    AST.TopDecl[],
  registry: Registry,
  opts:     EmitOptions
): Promise<EmitResult[]> {
  const results: EmitResult[] = [];

  for (const decl of order) {
    switch (decl.kind) {

      case "GuardDecl": {
        const pass = await runGuard(decl, opts.cwd);
        if (!pass.ok) {
          console.error(\`\\n✗ GUARD FAILED: "\${decl.label}"\`);
          for (const f of pass.failures) console.error("  →", f);
          if (decl.onFail.includes("block_apply")) {
            throw new Error(\`Guard '\${decl.label}' blocked apply\`);
          }
        } else if (opts.verbose) {
          console.log(\`✓ Guard "\${decl.label}" passed\`);
        }
        break;
      }

      case "PatchDecl": {
        const abs    = path.resolve(opts.cwd, decl.file);
        if (!fs.existsSync(abs)) break;
        const before = fs.readFileSync(abs, "utf8");
        const parser = getParser(decl.lang);
        const after  = await parser.applyPatch(before, decl);
        const diff   = createPatch(decl.file, before, after);
        const r: EmitResult = { file: decl.file, before, after, diff,
                                 applied: false, errors: [] };
        if (!opts.preview) {
          fs.writeFileSync(abs, after, "utf8");
          r.applied = true;
        }
        if (opts.verbose || opts.preview) console.log(diff);
        results.push(r);
        break;
      }

      case "ApplyStmt": {
        if (decl.applyKind === "fix") {
          const fix   = registry.fixes.get(decl.name)!;
          const files = await fg(fix.scope, { cwd: opts.cwd, absolute: true });
          for (const f of files) {
            const before = fs.readFileSync(f, "utf8");
            const after  = before.replaceAll(fix.pattern.trim(), fix.replace.trim());
            if (before === after) continue;
            const rel  = path.relative(opts.cwd, f);
            const diff = createPatch(rel, before, after);
            const r: EmitResult = { file: rel, before, after, diff,
                                     applied: false, errors: [] };
            if (!opts.preview && !decl.preview) {
              fs.writeFileSync(f, after, "utf8"); r.applied = true;
            }
            if (opts.verbose || decl.preview || opts.preview) console.log(diff);
            results.push(r);
          }
        }

        if (decl.applyKind === "migrate") {
          const mig   = registry.migrates.get(decl.name)!;
          const files = await fg(mig.scope, { cwd: opts.cwd, absolute: true });
          const parser = getParser(mig.lang);
          for (const f of files) {
            const before = fs.readFileSync(f, "utf8");
            const after  = await parser.applyMigrate(before, mig);
            if (before === after) continue;
            const rel  = path.relative(opts.cwd, f);
            const diff = createPatch(rel, before, after);
            const r: EmitResult = { file: rel, before, after, diff,
                                     applied: false, errors: [] };
            if (!opts.preview && !decl.preview) {
              fs.writeFileSync(f, after, "utf8"); r.applied = true;
            }
            results.push(r);
          }
        }
        break;
      }

      case "IntentDecl": {
        const files  = await fg(decl.scope, { cwd: opts.cwd, absolute: true });
        const parser = getParser(decl.language);
        for (const f of files) {
          const before = fs.readFileSync(f, "utf8");
          const after  = await parser.applyIntent(before, decl);
          if (before === after) continue;
          const rel  = path.relative(opts.cwd, f);
          const diff = createPatch(rel, before, after);
          const r: EmitResult = { file: rel, before, after, diff,
                                   applied: false, errors: [] };
          if (!opts.preview) { fs.writeFileSync(f, after, "utf8"); r.applied = true; }
          results.push(r);
        }
        break;
      }

      case "TraceDecl": {
        const parser = getParser(decl.language);
        const report = await parser.trace(decl, opts.cwd);
        console.log("\\n── Trace:", decl.ident, "──");
        console.log(report);
        break;
      }
    }
  }

  return results;
}