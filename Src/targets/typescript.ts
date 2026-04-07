// src/targets/typescript.ts
// ─── Delta TypeScript Language Adapter ───────────────────────────────────
// Uses the TypeScript Compiler API for AST-accurate transformations.
// This gives us precise function location, type-aware migrations,
// and real data-flow analysis — far more reliable than regex alone.

import ts   from "typescript";
import * as fs   from "fs";
import * as path from "path";
import fg        from "fast-glob";
import * as AST  from "../ast";
import {
  GenericAdapter,
  findMatchingBrace,
  getIndentAt,
  indentBlock,
  replaceAll,
  escapeRegex,
} from "./generic";

// ═══════════════════════════════════════════════════════════════════════════
//  TypeScriptAdapter
//  Extends GenericAdapter and overrides every method with TS Compiler
//  API versions. Falls back to the generic implementation when the
//  compiler API cannot find a match.
// ═══════════════════════════════════════════════════════════════════════════

export class TypeScriptAdapter extends GenericAdapter {

  constructor() {
    super("TypeScript", [".ts", ".tsx"]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyPatch
  //  Uses ts.createSourceFile to build a real AST, then walks it to find
  //  the target function by name and replaces its body precisely.
  // ─────────────────────────────────────────────────────────────────────────

  async applyPatch(src: string, decl: AST.PatchDecl): Promise<string> {

    // Line-based patches do not need the compiler API
    if (decl.find.type === "line") {
      return super.applyPatch(src, decl);
    }

    // Block-based patches use generic string replacement
    if (decl.find.type === "block") {
      return super.applyPatch(src, decl);
    }

    // fn-based patches use the TypeScript Compiler API
    const fnName = decl.find.name;
    const result = this.replaceFnWithCompilerAPI(src, fnName, decl.replace.body);

    // If the compiler API could not find the function, fall back to generic
    if (result === null) {
      console.warn(
        `[delta:TypeScript] Function '${fnName}' not found via Compiler API — ` +
        `falling back to regex`
      );
      return super.applyPatch(src, decl);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  replaceFnWithCompilerAPI
  //  Core TypeScript-specific replacement logic.
  //  Handles all function forms TypeScript supports:
  //    function foo() {}
  //    async function foo() {}
  //    export function foo() {}
  //    export async function foo() {}
  //    const foo = () => {}
  //    const foo = async () => {}
  //    class methods: foo() {}
  //    object methods: foo() {}
  //  Returns null if the function is not found.
  // ─────────────────────────────────────────────────────────────────────────

  private replaceFnWithCompilerAPI(
    src:         string,
    fnName:      string,
    replacement: string
  ): string | null {

    const sf = ts.createSourceFile(
      "_.ts",
      src,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true
    );

    let result: string | null = null;

    const visit = (node: ts.Node): void => {
      // Already found — stop walking
      if (result !== null) return;

      // ── function declaration ─────────────────────────────────────────────
      // function foo(...) { ... }
      if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
        result = replaceNodeBody(src, sf, node, replacement);
        return;
      }

      // ── function expression assigned to const/let/var ────────────────────
      // const foo = function(...) { ... }
      if (
        ts.isFunctionExpression(node) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name) &&
        node.parent.name.text === fnName
      ) {
        result = replaceNodeBody(src, sf, node, replacement);
        return;
      }

      // ── arrow function assigned to const/let/var ─────────────────────────
      // const foo = (...) => { ... }
      if (
        ts.isArrowFunction(node) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name) &&
        node.parent.name.text === fnName
      ) {
        result = replaceArrowBody(src, sf, node, replacement);
        return;
      }

      // ── class method declaration ─────────────────────────────────────────
      // class Foo { bar(...) { ... } }
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === fnName
      ) {
        result = replaceNodeBody(src, sf, node, replacement);
        return;
      }

      // ── object method shorthand ──────────────────────────────────────────
      // const obj = { foo(...) { ... } }
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === fnName
      ) {
        result = replaceNodeBody(src, sf, node, replacement);
        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyMigrate
  //  Handles TypeScript-specific migration patterns using the compiler API
  //  for import statement rewrites and falls back to generic for renames.
  // ─────────────────────────────────────────────────────────────────────────

  async applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string> {
    let out = src;

    for (const rule of decl.rules) {

      if (rule.type === "rename") {
        out = this.applyRename(out, rule.from.trim(), rule.to.trim());
        continue;
      }

      if (rule.type === "replace") {
        // Multi-line replace — try exact match first, then line-by-line
        const from = rule.from.trim();
        const to   = rule.to.trim();
        if (out.includes(from)) {
          out = out.split(from).join(to);
        } else {
          // Try normalised whitespace match
          const normSrc  = normaliseWhitespace(out);
          const normFrom = normaliseWhitespace(from);
          if (normSrc.includes(normFrom)) {
            out = replaceAll(out, from, to);
          }
        }
        continue;
      }

      if (rule.type === "remove") {
        out = this.applyRemove(out, rule.target.trim());
        continue;
      }

      // move rules handled by emitter
    }

    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyRename
  //  Renames a symbol across the file using the TypeScript Compiler API
  //  to identify all reference sites, then replaces them precisely.
  //  Falls back to word-boundary regex for simple cases.
  // ─────────────────────────────────────────────────────────────────────────

  private applyRename(src: string, from: string, to: string): string {
    if (!from || !to || from === to) return src;

    // Extract just the function/method name from patterns like
    // "client.connect()" → "connect"
    const fromName = extractSymbolName(from);
    const toName   = extractSymbolName(to);

    if (!fromName || !toName) return replaceAll(src, from, to);

    const sf = ts.createSourceFile(
      "_.ts", src, ts.ScriptTarget.Latest, true
    );

    // Collect all identifier positions that match fromName
    const replacements: Array<{ start: number; end: number }> = [];

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === fromName) {
        replacements.push({
          start: node.getStart(sf),
          end:   node.getEnd(),
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);

    if (replacements.length === 0) return src;

    // Apply replacements in reverse order so positions stay valid
    let result = src;
    for (const r of replacements.reverse()) {
      result = result.slice(0, r.start) + toName + result.slice(r.end);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyRemove
  //  Removes lines containing a deprecated symbol.
  //  Also removes associated import lines.
  // ─────────────────────────────────────────────────────────────────────────

  private applyRemove(src: string, target: string): string {
    const symbolName = extractSymbolName(target);

    return src
      .split("\n")
      .filter(line => {
        // Remove import lines that import only the deprecated symbol
        if (line.includes("import") && symbolName && line.includes(symbolName)) {
          return false;
        }
        // Remove call lines containing the deprecated symbol
        if (symbolName && line.includes(symbolName + "(")) {
          return false;
        }
        return true;
      })
      .join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyIntent
  //  Injects code at function entry/exit points using the TS Compiler API
  //  for accurate function boundary detection.
  // ─────────────────────────────────────────────────────────────────────────

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const sf     = ts.createSourceFile("_.ts", src, ts.ScriptTarget.Latest, true);
    const inject = decl.inject.trim();
    const lines  = src.split("\n");

    // Collect injection points — line number + code to insert
    const insertions: Array<{ line: number; indent: string }> = [];

    const visit = (node: ts.Node): void => {
      const isFnLike =
        ts.isFunctionDeclaration(node)  ||
        ts.isFunctionExpression(node)   ||
        ts.isArrowFunction(node)        ||
        ts.isMethodDeclaration(node);

      if (isFnLike) {
        const body = (node as ts.FunctionDeclaration).body;

        if (body && decl.where === "function_entry") {
          // Check guard — skip if inject already present nearby
          const bodyText = body.getText(sf);
          if (decl.guard && bodyText.includes(inject.slice(0, 24))) {
            ts.forEachChild(node, visit);
            return;
          }

          // Line number of the opening brace
          const bodyStartLine = src
            .slice(0, body.getStart(sf))
            .split("\n").length;

          // Indent is the function's own indent + 2 spaces
          const fnIndent  = getIndentAt(src, node.getStart(sf));
          const bodyIndent = fnIndent + "  ";

          insertions.push({ line: bodyStartLine, indent: bodyIndent });
        }

        if (body && decl.where === "function_exit") {
          const bodyEndLine = src
            .slice(0, body.getEnd())
            .split("\n").length - 1;

          const fnIndent   = getIndentAt(src, node.getStart(sf));
          const bodyIndent = fnIndent + "  ";

          insertions.push({ line: bodyEndLine - 1, indent: bodyIndent });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);

    // Apply in reverse so line numbers stay valid
    insertions.sort((a, b) => b.line - a.line);
    for (const ins of insertions) {
      lines.splice(ins.line, 0, ins.indent + inject);
    }

    return lines.join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  trace
  //  Uses the TypeScript Compiler API to perform real data-flow analysis.
  //  Tracks assignments, function calls, and return values from origin.
  // ─────────────────────────────────────────────────────────────────────────

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);
    const files  = await fg(["**/*.ts", "**/*.tsx"], {
      cwd:    absDir,
      absolute: true,
      ignore: ["**/node_modules/**", "**/dist/**"],
    });

    const report: string[]  = [];
    const flagged: string[] = [];

    report.push(`── Trace: ${decl.ident}  (${decl.dir})`);
    report.push(`   Origin:   ${decl.origin}`);
    report.push(`   Language: TypeScript`);
    report.push(`   Follow:   ${decl.follow.join(", ")}`);
    report.push("");

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      const sf  = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
      const rel = path.relative(cwd, file);

      const visit = (node: ts.Node): void => {

        // Track assignments: const x = tracedValue
        if (
          decl.follow.includes("assignments") &&
          ts.isVariableDeclaration(node) &&
          node.initializer
        ) {
          const initText = node.initializer.getText(sf);
          if (initText.includes(decl.ident)) {
            const line = getLineNumber(src, node.getStart(sf));
            const text = node.getText(sf).trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlags(line, text, rel, decl.flags, flagged);
          }
        }

        // Track function calls: someFunction(tracedValue)
        if (
          decl.follow.includes("function_calls") &&
          ts.isCallExpression(node)
        ) {
          const callText = node.getText(sf);
          if (callText.includes(decl.ident)) {
            const line = getLineNumber(src, node.getStart(sf));
            report.push(`  → ${rel}:${line}  ${callText.trim()}`);
            checkFlags(line, callText, rel, decl.flags, flagged);
          }
        }

        // Track return statements: return tracedValue
        if (
          decl.follow.includes("returns") &&
          ts.isReturnStatement(node) &&
          node.expression
        ) {
          const retText = node.expression.getText(sf);
          if (retText.includes(decl.ident)) {
            const line = getLineNumber(src, node.getStart(sf));
            report.push(`  → ${rel}:${line}  return ${retText.trim()}`);
            checkFlags(line, retText, rel, decl.flags, flagged);
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
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
      `${flagged.length} flag(s) raised`
    );

    return report.join("\n");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Module-level helpers
//  Used internally by TypeScriptAdapter only.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace the body of a braced function/method node with new content.
 * Preserves the function signature exactly — only the body changes.
 */
function replaceNodeBody(
  src:         string,
  sf:          ts.SourceFile,
  node:        ts.FunctionDeclaration | ts.FunctionExpression |
               ts.MethodDeclaration,
  replacement: string
): string {
  const body = node.body;
  if (!body) return src;

  const openBrace  = body.getStart(sf);
  const closeBrace = body.getEnd();
  const indent     = getIndentAt(src, node.getStart(sf));
  const bodyIndent = indent + "  ";
  const indented   = indentBlock(replacement, bodyIndent);

  return (
    src.slice(0, openBrace + 1) +
    "\n" + indented + "\n" + indent +
    src.slice(closeBrace - 1)
  );
}

/**
 * Replace the body of an arrow function.
 * Handles both block bodies (() => { ... }) and
 * expression bodies (() => expr).
 */
function replaceArrowBody(
  src:         string,
  sf:          ts.SourceFile,
  node:        ts.ArrowFunction,
  replacement: string
): string {
  const body   = node.body;
  const indent = getIndentAt(src, node.getStart(sf));

  // Block body: () => { ... }
  if (ts.isBlock(body)) {
    const openBrace  = body.getStart(sf);
    const closeBrace = body.getEnd();
    const bodyIndent = indent + "  ";
    const indented   = indentBlock(replacement, bodyIndent);

    return (
      src.slice(0, openBrace + 1) +
      "\n" + indented + "\n" + indent +
      src.slice(closeBrace - 1)
    );
  }

  // Expression body: () => expr
  // Wrap replacement in braces
  const exprStart = body.getStart(sf);
  const exprEnd   = body.getEnd();
  const bodyIndent = indent + "  ";
  const indented   = indentBlock(replacement, bodyIndent);

  return (
    src.slice(0, exprStart) +
    "{\n" + indented + "\n" + indent + "}" +
    src.slice(exprEnd)
  );
}

/**
 * Extract the base symbol name from a pattern like "client.connect()"
 * Returns "connect". For plain names like "myFunction" returns "myFunction".
 */
function extractSymbolName(pattern: string): string {
  // Strip parentheses and arguments first
  const withoutArgs = pattern.replace(/\s*\([^)]*\)\s*/g, "").trim();
  // Take the last segment after a dot
  const parts = withoutArgs.split(".");
  return parts[parts.length - 1]?.trim() ?? "";
}

/**
 * Get the 1-indexed line number of a character position in a source string.
 */
function getLineNumber(src: string, charPos: number): number {
  return src.slice(0, charPos).split("\n").length;
}

/**
 * Normalise whitespace in a string for fuzzy matching.
 * Collapses all runs of whitespace including newlines into a single space.
 */
function normaliseWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/**
 * Check a line of code against all flag conditions and push any matches
 * into the flagged array.
 */
function checkFlags(
  line:    number,
  text:    string,
  file:    string,
  flags:   string[],
  flagged: string[]
): void {
  const lower = text.toLowerCase();

  for (const flag of flags) {
    const f = flag.toLowerCase();
    let matched = false;

    // "reaches console.log" or "reaches logger"
    const reachesMatch = f.match(/reaches\s+(.+)/);
    if (reachesMatch) {
      const target = reachesMatch[1].trim().replace(/\s+/g, "");
      matched = lower.includes(target);
    }

    // "without hashing" — password-like value reaches storage without bcrypt
    else if (f.includes("without hashing")) {
      matched = lower.includes("password") &&
                !lower.includes("hash")    &&
                !lower.includes("bcrypt")  &&
                !lower.includes("argon");
    }

    // "skips validation"
    else if (f.includes("skips validation") || f.includes("no validation")) {
      matched = !lower.includes("validate") &&
                !lower.includes("isvalid")  &&
                !lower.includes("sanitize") &&
                !lower.includes("zod")      &&
                !lower.includes("joi");
    }

    // "raw sql"
    else if (f.includes("raw sql")) {
      matched = /`.*SELECT|`.*INSERT|`.*UPDATE|\$\{.*\}.*WHERE/.test(text);
    }

    // "stripe without validation"
    else if (f.includes("stripe")) {
      matched = lower.includes("stripe") &&
                !lower.includes("number(") &&
                !lower.includes("parseint") &&
                !lower.includes("parsefloat");
    }

    if (matched) {
      flagged.push(`  ⚠  FLAGGED: ${file}:${line}`);
      flagged.push(`     ${text.trim()}`);
      flagged.push(`     Flag: "${flag}"`);
      flagged.push("");
    }
  }
}
