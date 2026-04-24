// src/targets/generic.ts
// ─── Delta Generic Language Adapter ──────────────────────────────────────
// Regex and string-based fallback adapter used by any language that does
// not yet have a dedicated tree-sitter or compiler API adapter.
// All dedicated adapters extend this class and override what they need.

import * as fs   from "fs";
import * as path from "path";
import fg        from "fast-glob";
import * as AST  from "../ast";
import { LanguageAdapter } from "./index";

export class GenericAdapter implements LanguageAdapter {

  constructor(
    protected readonly langName: string,
    protected readonly extensions: string[]
  ) {}

  // ── applyPatch ────────────────────────────────────────────────────────────

  async applyPatch(src: string, decl: AST.PatchDecl): Promise<string> {
    const { find, replace } = decl;

    if (find.type === "fn") {
      return this.replaceFunctionBody(src, find.name, replace.body);
    }

    if (find.type === "line") {
      try {
        const re = new RegExp(find.regex, "gm");
        return src.replace(re, replace.body);
      } catch (e) {
        console.warn(`[delta] Invalid regex in patch: ${find.regex}`);
        return src;
      }
    }

    if (find.type === "block") {
      const target = find.body?.trim() ?? find.label;
      if (src.includes(target)) {
        return src.replace(target, replace.body.trim());
      }
      console.warn(`[delta] Block anchor '${find.label}' not found`);
      return src;
    }

    return src;
  }

  // ── replaceFunctionBody ───────────────────────────────────────────────────

  protected replaceFunctionBody(
    src:         string,
    fnName:      string,
    replacement: string
  ): string {
    const cStylePattern = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?` +
      `(?:public\\s+|private\\s+|protected\\s+|static\\s+)*` +
      `(?:function\\s+|fn\\s+|func\\s+)?` +
      `(${escapeRegex(fnName)})` +
      `\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+?)?\\s*\\{`,
      "m"
    );

    const match = cStylePattern.exec(src);
    if (match) {
      const openBraceIdx = match.index + match[0].length - 1;
      const closeIdx     = findMatchingBrace(src, openBraceIdx);
      if (closeIdx !== -1) {
        const indent = getIndentAt(src, match.index);
        const indented = indentBlock(replacement, indent + "  ");
        return (
          src.slice(0, openBraceIdx + 1) +
          "\n" + indented + "\n" + indent +
          src.slice(closeIdx)
        );
      }
    }

    // Python def fallback
    const pyPattern = new RegExp(
      `^([ \\t]*)(async\\s+)?def\\s+${escapeRegex(fnName)}\\s*\\([^)]*\\)\\s*(?:->\\s*[^:]+)?:`,
      "m"
    );
    const pyMatch = pyPattern.exec(src);
    if (pyMatch) {
      const baseIndent  = pyMatch[1];
      const bodyIndent  = baseIndent + "    ";
      const defLineEnd  = pyMatch.index + pyMatch[0].length;
      const lines       = src.slice(defLineEnd).split("\n");
      let bodyLines     = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim() === "" || line.trim().startsWith("#")) {
          bodyLines = i; continue;
        }
        if (!line.startsWith(bodyIndent)) break;
        bodyLines = i;
      }
      const bodyEnd = defLineEnd +
        lines.slice(0, bodyLines + 1).join("\n").length;
      const indentedBody = replacement
        .split("\n")
        .map(l => l.trim() ? bodyIndent + l.trim() : "")
        .join("\n");
      return src.slice(0, defLineEnd) + "\n" + indentedBody + src.slice(bodyEnd);
    }

    console.warn(`[delta:${this.langName}] Function '${fnName}' not found`);
    return src;
  }

  // ── applyMigrate ──────────────────────────────────────────────────────────

  async applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string> {
    let out = src;
    for (const rule of decl.rules) {
      if (rule.type === "rename") {
        out = replaceAll(out, rule.from.trim(), rule.to.trim());
      }
      if (rule.type === "replace") {
        out = replaceAll(out, rule.from.trim(), rule.to.trim());
      }
      if (rule.type === "remove") {
        out = out.split("\n")
          .filter(l => !l.includes(rule.target.trim()))
          .join("\n");
      }
    }
    return out;
  }

  // ── applyIntent ───────────────────────────────────────────────────────────

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const lines  = src.split("\n");
    const inject = decl.inject.trim();
    const insertions: Array<{ line: number; code: string }> = [];

    const fnOpenRe = /^(\s*)(?:export\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:function\s+|fn\s+|func\s+)?\w+\s*\([^)]*\)[^{]*\{/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (decl.where === "function_entry" && fnOpenRe.test(line)) {
        const indent = (line.match(/^(\s*)/)?.[1] ?? "") + "  ";
        const window = lines.slice(i + 1, i + 5).join("\n");
        if (decl.guard && window.includes(inject.slice(0, 20))) continue;
        insertions.push({ line: i + 1, code: indent + inject });
      }
      if (decl.where === "function_exit" && line.trim() === "}" && i > 0) {
        const indent = (line.match(/^(\s*)/)?.[1] ?? "") + "  ";
        insertions.push({ line: i, code: indent + inject });
      }
    }

    insertions.sort((a, b) => b.line - a.line);
    for (const ins of insertions) {
      lines.splice(ins.line, 0, ins.code);
    }
    return lines.join("\n");
  }

  // ── trace ─────────────────────────────────────────────────────────────────

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);
    const patterns = this.extensions.length > 0
      ? this.extensions.map(ext => `**/*${ext}`)
      : ["**/*"];

    const files = await fg(patterns, {
      cwd:    absDir,
      absolute: true,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    });

    const report: string[]  = [];
    const flagged: string[] = [];

    report.push(`── Trace: ${decl.ident}  (${decl.dir})`);
    report.push(`   Origin: ${decl.origin}`);
    report.push("");

    for (const file of files) {
      const src   = fs.readFileSync(file, "utf8");
      const lines = src.split("\n");
      const rel   = path.relative(cwd, file);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.includes(decl.ident) && !line.includes(decl.origin)) continue;
        const lineRef = `${rel}:${i + 1}`;
        for (const flag of decl.flags) {
          if (matchesFlag(line, flag)) {
            flagged.push(`  ⚠  FLAGGED: ${lineRef}`);
            flagged.push(`     ${line.trim()}`);
            flagged.push(`     Flag: "${flag}"`);
          }
        }
        report.push(`  → ${lineRef}  ${line.trim()}`);
      }
    }

    report.push("");
    if (flagged.length > 0) {
      report.push("── Flagged paths:");
      report.push(...flagged);
    } else {
      report.push("── No flagged paths found");
    }
    report.push(`── Summary: ${files.length} file(s) scanned`);
    return report.join("\n");
  }

  // ── queryFiles ────────────────────────────────────────────────────────────
  // Required by LanguageAdapter interface.
  // Used by guards.ts for AST-accurate fn_exists checks.

  async queryFiles(
    files: string[],
    query: string
  ): Promise<Array<{ file: string; line: number; text: string }>> {
    const results: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const src   = fs.readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(query)) {
          results.push({ file, line: i + 1, text: lines[i]!.trim() });
        }
      }
    }
    return results;
  }
}

// ── Exported utility functions ────────────────────────────────────────────────
// Used by dedicated adapters that extend GenericAdapter.

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceAll(src: string, from: string, to: string): string {
  if (!from || from === to) return src;
  const escaped = escapeRegex(from);
  try {
    const re = new RegExp(`(?<![\\w.])${escaped}(?![\\w])`, "g");
    return src.replace(re, to);
  } catch {
    return src.split(from).join(to);
  }
}

export function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch   = src[i];
    const prev = src[i - 1];
    if (!inStr && (ch === '"' || ch === "'" || ch === "`") && prev !== "\\") {
      inStr = ch; continue;
    }
    if (inStr && ch === inStr && prev !== "\\") {
      inStr = null; continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function getIndentAt(src: string, charIdx: number): string {
  const lineStart = src.lastIndexOf("\n", charIdx - 1) + 1;
  return src.slice(lineStart).match(/^(\s*)/)?.[1] ?? "";
}

export function indentBlock(code: string, indent: string): string {
  return code.split("\n")
    .map(line => line.trim() ? indent + line.trimStart() : "")
    .join("\n");
}

function matchesFlag(line: string, flag: string): boolean {
  const f = flag.toLowerCase();
  const l = line.toLowerCase();
  if (f.includes("raw sql")) return /['"`].*SELECT|INSERT|UPDATE|DELETE/.test(line);
  if (f.includes("without hashing")) return l.includes("password") && !l.includes("hash");
  return f.split(" ").filter(w => w.length > 3).some(word => l.includes(word));
}
