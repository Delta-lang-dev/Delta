// src/targets/generic.ts
// ─── Delta Generic Language Adapter ──────────────────────────────────────
// Regex and string-based fallback adapter used by any language that does
// not yet have a dedicated tree-sitter or compiler API adapter.
// All dedicated adapters (TypeScript, Python, Go, etc.) extend this class
// and override only the methods they need to improve on.

import * as fs   from "fs";
import * as path from "path";
import fg        from "fast-glob";
import * as AST  from "../ast";
import { LanguageAdapter } from "./index";

// ════════════════════════════════════════════════════════════════�[...]
//  GenericAdapter
// ════════════════════════════════════════════════════════════════�[...]

export class GenericAdapter implements LanguageAdapter {

  constructor(
    protected readonly langName: string,
    protected readonly extensions: string[]
  ) {}

  /**
   * Required by LanguageAdapter interface. 
   * Provides a list of files to be processed by the engine.
   */
  queryFiles(): string[] {
    return [];
  }

  // ───────────────────────────────────────────────────────────────��[...]
  //  applyPatch
  //  Locates the target using regex patterns and replaces the body.
  // ───────────────────────────────────────────────────────────────��[...]

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
        console.warn(
          `[delta] Invalid regex in patch find clause: ${find.regex}`
        );
        return src;
      }
    }

    if (find.type === "block") {
      const target = find.body?.trim() ?? find.label;
      if (src.includes(target)) {
        return src.replace(target, replace.body.trim());
      }
      console.warn(
        `[delta] Block anchor '${find.label}' not found in target file`
      );
      return src;
    }

    return src;
  }

  // ... (Keep all your existing protected/private methods below this)
  
  protected replaceFunctionBody(
    src:         string,
    fnName:      string,
    replacement: string
  ): string {
    const cStylePattern = new RegExp(
      '(?:export\\s+)?' +
      '(?:async\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+)*' +
      '(?:function\\s+|fn\\s+|func\\s+)?' +
      `(${escapeRegex(fnName)})` +
      '\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+?)?\\s*' +
      '\\{',
      "m"
    );

    const match = cStylePattern.exec(src);
    if (match) {
      const openBraceIdx = match.index + match[0].length - 1;
      const closeIdx     = findMatchingBrace(src, openBraceIdx);

      if (closeIdx !== -1) {
        const indent = getIndentAt(src, match.index);
        const indentedReplacement = indentBlock(replacement, indent + "  ");
        return (
          src.slice(0, openBraceIdx + 1) +
          "\n" + indentedReplacement + "\n" + indent +
          src.slice(closeIdx)
        );
      }
    }

    const pyPattern = new RegExp(
      `^([ \\t]*)(async\\s+)?def\\s+${escapeRegex(fnName)}\\s*\\([^)]*\\)\\s*(?:->\\s*[^:]+)?:`,
      "m"
    );

    const pyMatch = pyPattern.exec(src);
    if (pyMatch) {
      const baseIndent  = pyMatch[1];
      const bodyIndent  = baseIndent + "    ";
      const defLineEnd  = pyMatch.index + pyMatch[0].length;
      const lines     = src.slice(defLineEnd).split("\n");
      let bodyLines   = 0;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "" || line.trim().startsWith("#")) {
          bodyLines = i;
          continue;
        }
        if (!line.startsWith(bodyIndent)) break;
        bodyLines = i;
      }

      const bodyStart = defLineEnd;
      const bodyEnd   = defLineEnd + lines.slice(0, bodyLines + 1).join("\n").length;

      const indentedBody = replacement
        .split("\n")
        .map(l => l.trim() ? bodyIndent + l.trim() : "")
        .join("\n");

      return src.slice(0, bodyStart) + "\n" + indentedBody + src.slice(bodyEnd);
    }

    console.warn(
      `[delta:${this.langName}] Function '${fnName}' not found — patch skipped`
    );
    return src;
  }

  async applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string> {
    let out = src;
    for (const rule of decl.rules) {
      if (rule.type === "rename") {
        const from = rule.from.trim();
        const to   = rule.to.trim();
        if (!from || !to || from === to) continue;
        out = replaceAll(out, from, to);
      }
      if (rule.type === "replace") {
        const from = rule.from.trim();
        const to   = rule.to.trim();
        if (!from) continue;
        out = replaceAll(out, from, to);
      }
      if (rule.type === "remove") {
        const target = rule.target.trim();
        out = out.split("\n").filter(line => !line.includes(target)).join("\n");
      }
    }
    return out;
  }

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const lines  = src.split("\n");
    const inject = decl.inject.trim();
    const insertions: Array<{ line: number; code: string }> = [];
    const fnOpenRe = /^(\s*)(?:export\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:function\s+|fn\s+|func\s+)?\w+\s*\([^)]*\)[^{]*\{/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
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

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);
    const patterns = this.extensions.length > 0
      ? this.extensions.map(ext => `**/*${ext}`)
      : ["**/*"];

    const files = await fg(patterns, {
      cwd,
      absolute: true,
      ignore:   ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    });

    const origin = decl.origin.trim();
    const report: string[] = [];
    const flagged: string[] = [];

    for (const file of files) {
      const src   = fs.readFileSync(file, "utf8");
      const lines = src.split("\n");
      const rel   = path.relative(cwd, file);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(decl.ident) && !line.includes(origin)) continue;
        const lineRef = `${rel}:${i + 1}`;
        for (const flag of decl.flags) {
          if (matchesFlag(line, flag)) {
            flagged.push(`  ⚠  FLAGGED: ${lineRef}\n     ${line.trim()}\n     Flag: "${flag}"`);
          }
        }
        report.push(`  → ${lineRef}  ${line.trim()}`);
      }
    }
    return report.join("\n") + (flagged.length ? "\n\n" + flagged.join("\n") : "");
  }
}

// ────────────────────────────────────────────────────────────────[...]
//  Utility functions (stay outside the class)
// ────────────────────────────────────────────────────────────────[...]

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceAll(src: string, from: string, to: string): string {
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
    const ch = src[i];
    const prev = src[i - 1];
    if (!inStr && (ch === '"' || ch === "'" || ch === "`") && prev !== "\\") {
      inStr = ch; continue;
    }
    if (inStr && ch === inStr && prev !== "\\") {
      inStr = null; continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function getIndentAt(src: string, charIdx: number): string {
  const lineStart = src.lastIndexOf("\n", charIdx - 1) + 1;
  return src.slice(lineStart).match(/^(\s*)/)?.[1] ?? "";
}

export function indentBlock(code: string, indent: string): string {
  return code.split("\n").map(line => line.trim() ? indent + line.trimStart() : "").join("\n");
}

function matchesFlag(line: string, flag: string): boolean {
  const f = flag.toLowerCase();
  const l = line.toLowerCase();
  if (f.includes("raw sql")) return /['"]SELECT|INSERT|UPDATE|DELETE/.test(line);
  return f.split(" ").some(word => word.length > 3 && l.includes(word));
}

const decl_ident_placeholder = "";
