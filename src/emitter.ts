// src/emitter.ts
import * as fs from "fs";
import * as path from "path";
import { createPatch } from "diff";
import fg from "fast-glob";
import * as AST from "./ast";
import { Registry } from "./resolver";
import { runGuard, DEFAULT_IGNORE } from "./guards";
import { getAdapter } from "./targets";
import { applyWithCaptures } from "./types/captures";

export interface EmitOptions {
  cwd: string;
  preview: boolean;
  verbose: boolean;
  ignore?: string[];
}

export interface EmitResult {
  file: string;
  before: string;
  after: string;
  diff: string;
  applied: boolean;
  errors: string[];
}

export async function emit(
  order: AST.TopDecl[],
  registry: Registry,
  opts: EmitOptions
): Promise<EmitResult[]> {
  const results: EmitResult[] = [];
  const ignore = [...DEFAULT_IGNORE, ...(opts.ignore ?? [])];

  for (const decl of order) {
    switch (decl.kind) {
      case "GuardDecl": {
        const pass = await runGuard(decl, opts.cwd);
        if (!pass.ok) {
          console.error(`\n✗ GUARD FAILED: "${decl.label}"`);
          pass.failures.forEach(f => console.error("  →", f));
          if (decl.onFail.includes("block_apply")) {
            throw new Error(`Guard '${decl.label}' blocked apply`);
          }
        } else if (opts.verbose) {
          console.log(`✓ Guard "${decl.label}" passed`);
        }
        break;
      }

      case "PatchDecl": {
        const abs = path.resolve(opts.cwd, decl.file);
        if (!fs.existsSync(abs)) break;
        
        const before = fs.readFileSync(abs, "utf8");
        const after = await getAdapter(decl.lang).applyPatch(before, decl);
        
        if (before === after) break;
        
        const diff = createPatch(decl.file, before, after);
        const r: EmitResult = { file: decl.file, before, after, diff, applied: false, errors: [] };
        
        if (!opts.preview) {
          fs.writeFileSync(abs, after, "utf8");
          r.applied = true;
        }
        if (opts.verbose || opts.preview) console.log(diff);
        results.push(r);
        break;
      }

      case "ApplyStmt": {
        const target = decl.applyKind === "fix" 
          ? registry.fixes.get(decl.name)! 
          : registry.migrates.get(decl.name)!;

        const files = await fg(target.scope, { cwd: opts.cwd, absolute: true, ignore });
        
        for (const f of files) {
          const before = fs.readFileSync(f, "utf8");
          let after: string;

          if (decl.applyKind === "fix") {
            // Support for $VAR captures
            const fix = target as any; // Cast based on your registry structure
            after = applyWithCaptures(before, fix.pattern.trim(), fix.replace.trim());
          } else {
            after = await getAdapter((target as any).lang).applyMigrate(before, target as any);
          }

          if (before === after) continue;

          const rel = path.relative(opts.cwd, f);
          const diff = createPatch(rel, before, after);
          const r: EmitResult = { file: rel, before, after, diff, applied: false, errors: [] };

          if (!opts.preview && !decl.preview) {
            fs.writeFileSync(f, after, "utf8");
            r.applied = true;
          }
          if (opts.verbose || decl.preview || opts.preview) console.log(diff);
          results.push(r);
        }
        break;
      }

      case "IntentDecl": {
        const files = await fg(decl.scope, { cwd: opts.cwd, absolute: true, ignore });
        const adapter = getAdapter(decl.language);
        for (const f of files) {
          const before = fs.readFileSync(f, "utf8");
          const after = await adapter.applyIntent(before, decl);
          if (before === after) continue;

          const rel = path.relative(opts.cwd, f);
          const r: EmitResult = { 
            file: rel, before, after, 
            diff: createPatch(rel, before, after), 
            applied: false, errors: [] 
          };

          if (!opts.preview) {
            fs.writeFileSync(f, after, "utf8");
            r.applied = true;
          }
          results.push(r);
        }
        break;
      }

      case "TraceDecl": {
        const adapter = getAdapter(decl.language);
        const report = await adapter.trace(decl, opts.cwd);
        console.log(`\n── Trace: ${decl.ident} ──\n`, report);
        break;
      }
    }
  }
  return results;
}
