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

// ═══════════════════════════════════════════════════════════════════════════
//  GenericAdapter
// ═══════════════════════════════════════════════════════════════════════════

export class GenericAdapter implements LanguageAdapter {

  constructor(
    protected readonly langName: string,
    protected readonly extensions: string[]
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  applyPatch
  //  Locates the target using regex patterns and replaces the body.
  //  Works for most C-family languages and Python in simple cases.
  //  Dedicated adapters override this for AST-accurate replacement.
  // ─────────────────────────────────────────────────────────────────────────

  async applyPatch(src: string, decl: AST.PatchDecl): Promise<string> {
    const { find, replace } = decl;

    // ── fn anchor ───────────────────────────────────────────────────────────
    // Matches:  function name(...) { ... }
    //           async function name(...) { ... }
    //           name(...) { ... }          (methods)
    //           def name(...):             (Python — body on next lines)
    //           fn name(...) {             (Rust/Go)
    if (find.type === "fn") {
      return this.replaceFunctionBody(src, find.name, replace.body);
    }

    // ── line anchor ─────────────────────────────────────────────────────────
    // Matches lines against a regex and replaces matching lines
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

    // ── block anchor ────────────────────────────────────────────────────────
    // Matches a raw string and replaces it
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

  // ─────────────────────────────────────────────────────────────────────────
  //  replaceFunctionBody
  //  Core logic for fn-anchor patching.
  //  Handles C-style braced functions and Python def blocks.
  //  Dedicated adapters override this with AST-accurate versions.
  // ─────────────────────────────────────────────────────────────────────────

  protected replaceFunctionBody(
    src:         string,
    fnName:      string,
    replacement: string
  ): string {

    // ── Strategy 1: C-style braced function ─────────────────────────────────
    // Matches: [async] [export] function name(...) [: Type] {
    //          [export] [async] (name) = (...) => {
    //          name(...) {           <- method syntax
    //          fn name(...) {        <- Rust
    //          func name(...) {      <- Go
    const cStylePattern = new RegExp(
      // Optional modifiers: export, async, public, private, protected, static
      `(?:export\\s+)?(?:async\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+)*` +
      // Function keyword variants
      `(?:function\\s+|fn\\s+|func\\s+)?` +
      // The function name — this is the anchor
      `(${escapeRegex(fnName)})` +
      // Parameter list and optional return type
      `\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+?)?\\s*` +
      // Opening brace
      `\\{`,
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

    // ── Strategy 2: Python def block ────────────────────────────────────────
    // def name(...):
    //     body lines (indented)
    const pyPattern = new RegExp(
      `^([ \\t]*)(async\\s+)?def\\s+${escapeRegex(fnName)}\\s*\\([^)]*\\)\\s*(?:->\\s*[^:]+)?:`,
      "m"
    );

    const pyMatch = pyPattern.exec(src);
    if (pyMatch) {
      const baseIndent  = pyMatch[1];                // indentation of the def line
      const bodyIndent  = baseIndent + "    ";       // +4 spaces for body
      const defLineEnd  = pyMatch.index + pyMatch[0].length;

      // Find where the function body ends — it ends when we hit a line
      // that is not indented deeper than the def line (or end of file)
      const lines     = src.slice(defLineEnd).split("\n");
      let bodyLines   = 0;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        // Empty lines and comment lines are part of the body
        if (line.trim() === "" || line.trim().startsWith("#")) {
          bodyLines = i;
          continue;
        }
        // A line at or less indented than the def ends the body
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

    // No match found — return unchanged and warn
    console.warn(
      `[delta:${this.langName}] Function '${fnName}' not found — patch skipped`
    );
    return src;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyMigrate
  //  Processes all migration rules against the source string in order.
  //  rename and replace rules use exact string replacement.
  //  remove rules delete lines containing the target symbol.
  //  move rules are handled at the file level by the emitter.
  // ─────────────────────────────────────────────────────────────────────────

  async applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string> {
    let out = src;

    for (const rule of decl.rules) {

      if (rule.type === "rename") {
        const from = rule.from.trim();
        const to   = rule.to.trim();
        if (!from || !to || from === to) continue;
        // Use word-boundary aware replacement to avoid partial matches
        out = replaceAll(out, from, to);
      }

      if (rule.type === "replace") {
        const from = rule.from.trim();
        const to   = rule.to.trim();
        if (!from) continue;
        out = replaceAll(out, from, to);
      }

      if (rule.type === "remove") {
        // Remove every line that contains the deprecated symbol
        const target = rule.target.trim();
        out = out
          .split("\n")
          .filter(line => !line.includes(target))
          .join("\n");
      }

      // move rules are handled at the emitter level — skip here
    }

    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyIntent
  //  Injects code at function entry or exit points using regex.
  //  Dedicated adapters override this with AST-accurate injection.
  // ─────────────────────────────────────────────────────────────────────────

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const lines  = src.split("\n");
    const inject = decl.inject.trim();
    const insertions: Array<{ line: number; code: string }> = [];

    // Match C-style function openings
    const fnOpenRe = /^(\s*)(?:export\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:function\s+|fn\s+|func\s+)?\w+\s*\([^)]*\)[^{]*\{/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (decl.where === "function_entry" && fnOpenRe.test(line)) {
        const indent = (line.match(/^(\s*)/)?.[1] ?? "") + "  ";

        // Guard check — do not inject if the next few lines already contain
        // the first 20 chars of the inject string
        const window = lines.slice(i + 1, i + 5).join("\n");
        if (decl.guard && window.includes(inject.slice(0, 20))) continue;

        insertions.push({ line: i + 1, code: indent + inject });
      }

      if (decl.where === "function_exit") {
        // Find closing braces that look like function ends
        if (line.trim() === "}" && i > 0) {
          const indent = (line.match(/^(\s*)/)?.[1] ?? "") + "  ";
          insertions.push({ line: i, code: indent + inject });
        }
      }
    }

    // Apply insertions in reverse so line numbers stay valid
    insertions.sort((a, b) => b.line - a.line);
    for (const ins of insertions) {
      lines.splice(ins.line, 0, ins.code);
    }

    return lines.join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  trace
  //  Basic text-search data-flow trace.
  //  Dedicated adapters override this with real static analysis.
  // ─────────────────────────────────────────────────────────────────────────

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);

    // Gather all files matching the language extensions
    const patterns = this.extensions.length > 0
      ? this.extensions.map(ext => `**/*${ext}`)
      : ["**/*"];

    const files = await fg(patterns, {
      cwd:      absDir,
      absolute: true,
      ignore:   ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    });

    const origin   = decl.origin.trim();
    const report: string[] = [];
    const flagged: string[] = [];

    report.push(`── Trace: ${decl.ident}  (${decl.dir})`);
    report.push(`   Origin: ${origin}`);
    report.push("");

    for (const file of files) {
      const src   = fs.readFileSync(file, "utf8");
      const lines = src.split("\n");
      const rel   = path.relative(cwd, file);

      // Find every line that mentions the traced identifier
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(decl.ident) && !line.includes(origin)) continue;

        const lineRef = `${rel}:${i + 1}`;

        // Check each flag condition
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

    report.push("");
    report.push(
      `── Summary: ${files.length} file(s) scanned, ` +
      `${flagged.length / 3} flag(s) raised`
    );

    return report.join("\n");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Utility functions
//  Used internally by GenericAdapter and by dedicated adapters
//  that extend it. Exported so subclasses can call them directly.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Escape a string for use inside a RegExp.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace all occurrences of `from` in `src` with `to`.
 * Uses a regex with word boundaries where possible to avoid
 * partial matches (e.g. replacing 'foo' not matching 'fooBar').
 */
export function replaceAll(src: string, from: string, to: string): string {
  // If from contains special regex chars, use literal replace
  const escaped = escapeRegex(from);
  try {
    // Word-boundary aware — only works for word-char delimited tokens
    const re = new RegExp(`(?<![\\w.])${escaped}(?![\\w])`, "g");
    return src.replace(re, to);
  } catch {
    // Fallback: simple replaceAll
    return src.split(from).join(to);
  }
}

/**
 * Find the index of the closing brace that matches the opening
 * brace at `openIdx` in `src`. Returns -1 if not found.
 */
export function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  let inStr: string | null = null;

  for (let i = openIdx; i < src.length; i++) {
    const ch   = src[i];
    const prev = src[i - 1];

    // Track string literals so we do not count braces inside them
    if (!inStr && (ch === '"' || ch === "'" || ch === "`") && prev !== "\\") {
      inStr = ch;
      continue;
    }
    if (inStr && ch === inStr && prev !== "\\") {
      inStr = null;
      continue;
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

/**
 * Get the leading whitespace of the line that contains the character
 * at `charIdx` in `src`.
 */
export function getIndentAt(src: string, charIdx: number): string {
  const lineStart = src.lastIndexOf("\n", charIdx - 1) + 1;
  return src.slice(lineStart).match(/^(\s*)/)?.[1] ?? "";
}

/**
 * Re-indent a block of code to a given indentation string.
 * Strips existing leading whitespace from each line first,
 * then applies the new indent.
 */
export function indentBlock(code: string, indent: string): string {
  return code
    .split("\n")
    .map(line => {
      const trimmed = line.trimStart();
      return trimmed ? indent + trimmed : "";
    })
    .join("\n");
}

/**
 * Check whether a source line matches a natural-language flag description.
 * Handles common patterns like "reaches console.log", "skips validation",
 * "raw SQL query", "without hashing".
 */
function matchesFlag(line: string, flag: string): boolean {
  const f = flag.toLowerCase();
  const l = line.toLowerCase();

  // "any path that reaches X"
  const reachesMatch = f.match(/reaches\s+(.+)/);
  if (reachesMatch) {
    const target = reachesMatch[1].trim();
    return l.includes(target.replace(/\s+/g, ""));
  }

  // "any path that skips X"
  const skipsMatch = f.match(/skips\s+(.+)/);
  if (skipsMatch) {
    // Heuristic: flag lines near the traced var that don't mention validation
    return l.includes(decl_ident_placeholder) && !l.includes(skipsMatch[1].trim());
  }

  // "raw SQL" / "raw f-string"
  if (f.includes("raw sql") || f.includes("raw f-string")) {
    return /f['"].*SELECT|f['"].*INSERT|f['"].*UPDATE|f['"].*DELETE/.test(line);
  }

  // "without hashing"
  if (f.includes("without hashing")) {
    return l.includes("password") && !l.includes("hash") && !l.includes("bcrypt");
  }

  // "no type coercion" / "no validation"
  if (f.includes("no type coercion") || f.includes("no validation")) {
    return !l.includes("number(") && !l.includes("parseint") &&
           !l.includes("parsefloat") && !l.includes("validate");
  }

  // Generic fallback — check if any word from the flag appears in the line
  const flagWords = f
    .replace(/any path that |without |no |skips |reaches /g, "")
    .split(/\s+/)
    .filter(w => w.length > 3);

  return flagWords.some(word => l.includes(word));
}

// Placeholder used by matchesFlag — replaced at call site in dedicated adapters
const decl_ident_placeholder = "";
