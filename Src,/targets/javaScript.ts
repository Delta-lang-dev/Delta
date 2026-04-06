// src/targets/javascript.ts
// ─── Delta JavaScript Language Adapter ───────────────────────────────────
// JavaScript is a subset of TypeScript so we reuse the TypeScript Compiler
// API for all AST operations. The key differences are:
//   • No type annotations to preserve
//   • Handles .js .jsx .mjs .cjs file extensions
//   • ScriptTarget set to Latest with allowJs
//   • CommonJS require() imports handled alongside ES module imports
//   • JSX expression bodies handled for React components

import ts   from "typescript";
import * as fs   from "fs";
import * as path from "path";
import fg        from "fast-glob";
import * as AST  from "../ast";
import {
  GenericAdapter,
  getIndentAt,
  indentBlock,
  replaceAll,
  escapeRegex,
} from "./generic";

// ═══════════════════════════════════════════════════════════════════════════
//  JavaScriptAdapter
// ═══════════════════════════════════════════════════════════════════════════

export class JavaScriptAdapter extends GenericAdapter {

  constructor() {
    super("JavaScript", [".js", ".jsx", ".mjs", ".cjs"]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyPatch
  //  Parses the file as JavaScript using the TypeScript Compiler API
  //  with JSX support enabled. Falls back to generic for line/block anchors.
  // ─────────────────────────────────────────────────────────────────────────

  async applyPatch(src: string, decl: AST.PatchDecl): Promise<string> {

    if (decl.find.type === "line" || decl.find.type === "block") {
      return super.applyPatch(src, decl);
    }

    const fnName = decl.find.name;
    const result = this.replaceFnJS(src, fnName, decl.replace.body);

    if (result === null) {
      console.warn(
        `[delta:JavaScript] Function '${fnName}' not found — falling back to regex`
      );
      return super.applyPatch(src, decl);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  replaceFnJS
  //  JavaScript-specific function replacement.
  //  Handles all JS function forms including CommonJS module.exports patterns.
  // ─────────────────────────────────────────────────────────────────────────

  private replaceFnJS(
    src:         string,
    fnName:      string,
    replacement: string
  ): string | null {

    // Parse with JSX support so React component files work correctly
    const sf = ts.createSourceFile(
      "_.jsx",
      src,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.JSX
    );

    let result: string | null = null;

    const visit = (node: ts.Node): void => {
      if (result !== null) return;

      // ── function declaration ─────────────────────────────────────────────
      // function foo(...) { ... }
      // async function foo(...) { ... }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === fnName
      ) {
        result = replaceBlockBody(src, sf, node, replacement);
        return;
      }

      // ── function expression ──────────────────────────────────────────────
      // const foo = function(...) { ... }
      // var foo = function foo(...) { ... }
      if (
        ts.isFunctionExpression(node) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name) &&
        node.parent.name.text === fnName
      ) {
        result = replaceBlockBody(src, sf, node, replacement);
        return;
      }

      // ── arrow function ───────────────────────────────────────────────────
      // const foo = (...) => { ... }
      // const foo = (...) => expr
      if (
        ts.isArrowFunction(node) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name) &&
        node.parent.name.text === fnName
      ) {
        result = replaceArrowBodyJS(src, sf, node, replacement);
        return;
      }

      // ── class method ─────────────────────────────────────────────────────
      // class Foo { bar(...) { ... } }
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === fnName
      ) {
        result = replaceBlockBody(src, sf, node, replacement);
        return;
      }

      // ── CommonJS module.exports.foo = function(...) { ... } ───────────────
      if (
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression)
      ) {
        const left  = node.expression.left;
        const right = node.expression.right;

        // module.exports.foo = function(...)
        if (
          ts.isPropertyAccessExpression(left) &&
          left.name.text === fnName &&
          (ts.isFunctionExpression(right) || ts.isArrowFunction(right))
        ) {
          if (ts.isFunctionExpression(right)) {
            result = replaceBlockBody(src, sf, right, replacement);
          } else {
            result = replaceArrowBodyJS(src, sf, right, replacement);
          }
          return;
        }

        // exports.foo = function(...)
        if (
          ts.isPropertyAccessExpression(left) &&
          ts.isIdentifier(left.expression) &&
          left.expression.text === "exports" &&
          left.name.text === fnName &&
          (ts.isFunctionExpression(right) || ts.isArrowFunction(right))
        ) {
          if (ts.isFunctionExpression(right)) {
            result = replaceBlockBody(src, sf, right, replacement);
          } else {
            result = replaceArrowBodyJS(src, sf, right, replacement);
          }
          return;
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyMigrate
  //  Handles both ES module and CommonJS import/require rewrites.
  // ─────────────────────────────────────────────────────────────────────────

  async applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string> {
    let out = src;

    for (const rule of decl.rules) {

      if (rule.type === "rename") {
        out = this.migrateRename(out, rule.from.trim(), rule.to.trim());
        continue;
      }

      if (rule.type === "replace") {
        const from = rule.from.trim();
        const to   = rule.to.trim();

        // Handle require() → import rewrites
        if (from.startsWith("require(") || to.startsWith("import ")) {
          out = this.migrateRequireToImport(out, from, to);
          continue;
        }

        out = out.includes(from) ? out.split(from).join(to) : out;
        continue;
      }

      if (rule.type === "remove") {
        const target = rule.target.trim();
        out = out
          .split("\n")
          .filter(line => {
            if (line.includes("require(") && line.includes(target)) return false;
            if (line.includes("import")   && line.includes(target)) return false;
            if (line.includes(target + "("))                        return false;
            return true;
          })
          .join("\n");
        continue;
      }
    }

    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  migrateRename
  //  Renames a symbol using the TypeScript Compiler API with JSX support.
  // ─────────────────────────────────────────────────────────────────────────

  private migrateRename(src: string, from: string, to: string): string {
    if (!from || !to || from === to) return src;

    // Extract bare symbol name from "obj.method()" → "method"
    const fromName = extractJSSymbol(from);
    const toName   = extractJSSymbol(to);

    if (!fromName || !toName) return replaceAll(src, from, to);

    const sf = ts.createSourceFile(
      "_.jsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX
    );

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

    let result = src;
    for (const r of replacements.reverse()) {
      result = result.slice(0, r.start) + toName + result.slice(r.end);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  migrateRequireToImport
  //  Converts CommonJS require() calls to ES module imports.
  //  Example:
  //    const stripe = require("stripe")
  //    → import Stripe from "stripe"
  // ─────────────────────────────────────────────────────────────────────────

  private migrateRequireToImport(
    src:  string,
    from: string,
    to:   string
  ): string {
    // Match: const X = require("pkg") or const { X } = require("pkg")
    const requireRe = /const\s+(\{[^}]+\}|\w+)\s*=\s*require\((['"][^'"]+['"])\)/g;

    return src.replace(requireRe, (match, binding, pkg) => {
      // If the to pattern is an import statement, use it directly
      if (to.trim().startsWith("import ")) return to.trim();

      // Otherwise construct a default import
      return `import ${binding} from ${pkg}`;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyIntent
  //  Injects code at function entry/exit using JSX-aware AST parsing.
  //  Also handles React functional components (arrow functions returning JSX).
  // ─────────────────────────────────────────────────────────────────────────

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const sf     = ts.createSourceFile(
      "_.jsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX
    );
    const inject = decl.inject.trim();
    const lines  = src.split("\n");
    const insertions: Array<{ line: number; indent: string }> = [];

    const visit = (node: ts.Node): void => {
      const isFnLike =
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node)  ||
        ts.isArrowFunction(node)       ||
        ts.isMethodDeclaration(node);

      if (isFnLike) {
        const body = (node as ts.FunctionDeclaration).body;

        if (body && ts.isBlock(body)) {
          if (decl.where === "function_entry") {
            const bodyText = body.getText(sf);

            // Guard: skip if inject already present
            if (decl.guard && bodyText.includes(inject.slice(0, 24))) {
              ts.forEachChild(node, visit);
              return;
            }

            const bodyStartLine = src
              .slice(0, body.getStart(sf))
              .split("\n").length;

            const fnIndent   = getIndentAt(src, node.getStart(sf));
            const bodyIndent = fnIndent + "  ";
            insertions.push({ line: bodyStartLine, indent: bodyIndent });
          }

          if (decl.where === "function_exit") {
            const bodyEndLine = src
              .slice(0, body.getEnd())
              .split("\n").length - 1;

            const fnIndent   = getIndentAt(src, node.getStart(sf));
            const bodyIndent = fnIndent + "  ";
            insertions.push({ line: bodyEndLine - 1, indent: bodyIndent });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);

    insertions.sort((a, b) => b.line - a.line);
    for (const ins of insertions) {
      lines.splice(ins.line, 0, ins.indent + inject);
    }

    return lines.join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  trace
  //  Data-flow analysis for JavaScript files.
  //  Same logic as TypeScript adapter but parses as JSX
  //  and also tracks CommonJS require() patterns.
  // ─────────────────────────────────────────────────────────────────────────

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);
    const files  = await fg(
      ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
      {
        cwd:      absDir,
        absolute: true,
        ignore:   ["**/node_modules/**", "**/dist/**"],
      }
    );

    const report: string[]  = [];
    const flagged: string[] = [];

    report.push(`── Trace: ${decl.ident}  (${decl.dir})`);
    report.push(`   Origin:   ${decl.origin}`);
    report.push(`   Language: JavaScript`);
    report.push("");

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      const sf  = ts.createSourceFile(
        file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX
      );
      const rel = path.relative(cwd, file);

      const visit = (node: ts.Node): void => {

        // Track assignments
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
            checkFlagsJS(line, text, rel, decl.flags, flagged);
          }
        }

        // Track function calls
        if (
          decl.follow.includes("function_calls") &&
          ts.isCallExpression(node)
        ) {
          const callText = node.getText(sf);
          if (callText.includes(decl.ident)) {
            const line = getLineNumber(src, node.getStart(sf));
            report.push(`  → ${rel}:${line}  ${callText.trim()}`);
            checkFlagsJS(line, callText, rel, decl.flags, flagged);
          }
        }

        // Track return statements
        if (
          decl.follow.includes("returns") &&
          ts.isReturnStatement(node) &&
          node.expression
        ) {
          const retText = node.expression.getText(sf);
          if (retText.includes(decl.ident)) {
            const line = getLineNumber(src, node.getStart(sf));
            report.push(`  → ${rel}:${line}  return ${retText.trim()}`);
            checkFlagsJS(line, retText, rel, decl.flags, flagged);
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
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace the body of a block-bodied function node.
 * Works for FunctionDeclaration, FunctionExpression, MethodDeclaration.
 */
function replaceBlockBody(
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
    src.slice(0, openBrace + 1)    +
    "\n" + indented + "\n" + indent +
    src.slice(closeBrace - 1)
  );
}

/**
 * Replace the body of an arrow function.
 * Handles both block (() => { ... }) and expression (() => expr) forms.
 * Expression bodies are converted to block bodies with the replacement.
 */
function replaceArrowBodyJS(
  src:         string,
  sf:          ts.SourceFile,
  node:        ts.ArrowFunction,
  replacement: string
): string {
  const body   = node.body;
  const indent = getIndentAt(src, node.getStart(sf));

  if (ts.isBlock(body)) {
    const openBrace  = body.getStart(sf);
    const closeBrace = body.getEnd();
    const bodyIndent = indent + "  ";
    const indented   = indentBlock(replacement, bodyIndent);

    return (
      src.slice(0, openBrace + 1)    +
      "\n" + indented + "\n" + indent +
      src.slice(closeBrace - 1)
    );
  }

  // Expression body — wrap in braces
  const exprStart  = body.getStart(sf);
  const exprEnd    = body.getEnd();
  const bodyIndent = indent + "  ";
  const indented   = indentBlock(replacement, bodyIndent);

  return (
    src.slice(0, exprStart) +
    "{\n" + indented + "\n" + indent + "}" +
    src.slice(exprEnd)
  );
}

/**
 * Extract the base symbol name from a JS pattern.
 * "module.exports.foo()" → "foo"
 * "stripe.charges.create()" → "create"
 * "myFunction" → "myFunction"
 */
function extractJSSymbol(pattern: string): string {
  const withoutArgs = pattern.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const parts = withoutArgs.split(".");
  return parts[parts.length - 1]?.trim() ?? "";
}

/**
 * Get the 1-indexed line number for a character position.
 */
function getLineNumber(src: string, charPos: number): number {
  return src.slice(0, charPos).split("\n").length;
}

/**
 * Check a text snippet against flag conditions and collect matches.
 */
function checkFlagsJS(
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

    const reachesMatch = f.match(/reaches\s+(.+)/);
    if (reachesMatch) {
      matched = lower.includes(
        reachesMatch[1].trim().replace(/\s+/g, "")
      );
    } else if (f.includes("without hashing")) {
      matched = lower.includes("password") &&
                !lower.includes("hash")    &&
                !lower.includes("bcrypt");
    } else if (f.includes("raw sql")) {
      matched = /`.*SELECT|`.*INSERT|`.*UPDATE|\$\{.*\}.*WHERE/.test(text);
    } else if (f.includes("no validation") || f.includes("skips validation")) {
      matched = !lower.includes("validate") &&
                !lower.includes("sanitize") &&
                !lower.includes("zod")      &&
                !lower.includes("joi");
    }

    if (matched) {
      flagged.push(`  ⚠  FLAGGED: ${file}:${line}`);
      flagged.push(`     ${text.trim()}`);
      flagged.push(`     Flag: "${flag}"`);
      flagged.push("");
    }
  }
}
