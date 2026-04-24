// src/targets/go.ts
// ─── Delta Go Language Adapter ───────────────────────────────────────────
// Uses tree-sitter-go for AST-accurate transformations.
// Go is statically typed and brace-delimited like C but has unique
// patterns: receiver methods, multiple return values, defer statements,
// goroutines, and package-level imports that need special handling.

import Parser from "tree-sitter";
import Go     from "tree-sitter-go";
import * as fs   from "fs";
import * as path from "path";
import fg        from "fast-glob";
import * as AST  from "../ast";
import {
  GenericAdapter,
  getIndentAt,
  indentBlock,
  replaceAll,
  findMatchingBrace,
} from "./generic";

export class GoAdapter extends GenericAdapter {

  private parser: Parser;

  constructor() {
    super("Go", [".go"]);
    this.parser = new Parser();
    this.parser.setLanguage(Go as any);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyPatch
  // ─────────────────────────────────────────────────────────────────────────

  async applyPatch(src: string, decl: AST.PatchDecl): Promise<string> {
    if (decl.find.type === "line" || decl.find.type === "block") {
      return super.applyPatch(src, decl);
    }

    const result = this.replaceGoFn(src, decl.find.name, decl.replace.body);
    if (result === null) {
      console.warn(
        `[delta:Go] Function '${decl.find.name}' not found — falling back to regex`
      );
      return super.applyPatch(src, decl);
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  replaceGoFn
  //  Handles Go function forms:
  //    func FunctionName(params) ReturnType { ... }
  //    func (r ReceiverType) MethodName(params) ReturnType { ... }
  // ─────────────────────────────────────────────────────────────────────────

  private replaceGoFn(
    src:         string,
    fnName:      string,
    replacement: string
  ): string | null {

    const tree = this.parser.parse(src);
    const node = this.findGoFn(tree.rootNode, fnName);
    if (!node) return null;

    const bodyNode = node.childForFieldName("body");
    if (!bodyNode) return null;

    const openBrace = bodyNode.startIndex;
    const closeBrace = bodyNode.endIndex;
    const indent     = getIndentAt(src, node.startIndex);
    const bodyIndent = indent + "\t"; // Go uses tabs
    const indented   = indentBlockGo(replacement, bodyIndent);

    return (
      src.slice(0, openBrace + 1) +
      "\n" + indented + "\n" + indent +
      src.slice(closeBrace - 1)
    );
  }

  private findGoFn(
    node:   Parser.SyntaxNode,
    name:   string
  ): Parser.SyntaxNode | null {

    // func_declaration: top-level functions
    if (node.type === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text === name) return node;
    }

    // method_declaration: receiver methods
    if (node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text === name) return node;
    }

    for (const child of node.children) {
      const found = this.findGoFn(child, name);
      if (found) return found;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyMigrate
  //  Handles Go import path rewrites and symbol renames.
  // ─────────────────────────────────────────────────────────────────────────

  async applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string> {
    let out = src;

    for (const rule of decl.rules) {

      if (rule.type === "rename") {
        out = this.goRename(out, rule.from.trim(), rule.to.trim());
        continue;
      }

      if (rule.type === "replace") {
        const from = rule.from.trim();
        const to   = rule.to.trim();
        // Handle import path rewrites: import "old/pkg" → import "new/pkg"
        if (from.startsWith(`import "`) || from.startsWith(`"`) ) {
          out = out.split(from).join(to);
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
            if (line.includes(`"`) && line.includes(target)) return false;
            if (line.trim().startsWith(target + "("))         return false;
            return true;
          })
          .join("\n");
        continue;
      }
    }

    return out;
  }

  private goRename(src: string, from: string, to: string): string {
    if (!from || !to || from === to) return src;

    const fromName = extractGoSymbol(from);
    const toName   = extractGoSymbol(to);
    if (!fromName || !toName) return replaceAll(src, from, to);

    const tree = this.parser.parse(src);
    const replacements: Array<{ start: number; end: number }> = [];

    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "identifier" && node.text === fromName) {
        replacements.push({ start: node.startIndex, end: node.endIndex });
      }
      for (const child of node.children) visit(child);
    };

    visit(tree.rootNode);
    if (replacements.length === 0) return src;

    let result = src;
    for (const r of [...replacements].reverse()) {
      result = result.slice(0, r.start) + toName + result.slice(r.end);
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyIntent
  //  Injects code at function entry using tree-sitter for accuracy.
  //  Handles both regular functions and receiver methods.
  // ─────────────────────────────────────────────────────────────────────────

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const tree   = this.parser.parse(src);
    const lines  = src.split("\n");
    const inject = decl.inject.trim();
    const insertions: Array<{ line: number; indent: string }> = [];

    const visit = (node: Parser.SyntaxNode): void => {
      const isFn =
        node.type === "function_declaration" ||
        node.type === "method_declaration";

      if (isFn) {
        const bodyNode = node.childForFieldName("body");
        if (!bodyNode) { for (const c of node.children) visit(c); return; }

        if (decl.where === "function_entry") {
          // First line inside the body block
          const bodyStartLine = bodyNode.startPosition.row + 1;
          const fnIndent      = "\t"; // Go uses tabs

          // Guard check
          const window = lines.slice(bodyStartLine, bodyStartLine + 4).join("\n");
          if (decl.guard && window.includes(inject.slice(0, 20))) {
            for (const c of node.children) visit(c);
            return;
          }

          insertions.push({ line: bodyStartLine, indent: fnIndent });
        }

        if (decl.where === "function_exit") {
          const bodyEndLine = bodyNode.endPosition.row;
          insertions.push({ line: bodyEndLine, indent: "\t" });
        }
      }

      for (const child of node.children) visit(child);
    };

    visit(tree.rootNode);
    insertions.sort((a, b) => b.line - a.line);
    for (const ins of insertions) {
      lines.splice(ins.line, 0, ins.indent + inject);
    }
    return lines.join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  trace
  //  Data-flow analysis for Go source files.
  // ─────────────────────────────────────────────────────────────────────────

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);
    const files  = await fg(["**/*.go"], {
      cwd: absDir, absolute: true,
      ignore: ["**/vendor/**"],
    });

    const report: string[]  = [];
    const flagged: string[] = [];

    report.push(`── Trace: ${decl.ident}  (${decl.dir})`);
    report.push(`   Origin:   ${decl.origin}`);
    report.push(`   Language: Go`);
    report.push(`   Follow:   ${decl.follow.join(", ")}`);
    report.push("");

    for (const file of files) {
      const src  = fs.readFileSync(file, "utf8");
      const tree = this.parser.parse(src);
      const rel  = path.relative(cwd, file);

      const visit = (node: Parser.SyntaxNode): void => {

        // short_var_declaration: x := tracedValue
        if (
          decl.follow.includes("assignments") &&
          (node.type === "short_var_declaration" ||
           node.type === "var_declaration")
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsGo(line, text, rel, decl.flags, flagged);
          }
        }

        // call_expression
        if (
          decl.follow.includes("function_calls") &&
          node.type === "call_expression"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsGo(line, text, rel, decl.flags, flagged);
          }
        }

        // return_statement
        if (
          decl.follow.includes("returns") &&
          node.type === "return_statement"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsGo(line, text, rel, decl.flags, flagged);
          }
        }

        for (const child of node.children) visit(child);
      };

      visit(tree.rootNode);
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractGoSymbol(pattern: string): string {
  const withoutArgs = pattern.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const parts = withoutArgs.split(".");
  return parts[parts.length - 1]?.trim() ?? "";
}

// Go uses tabs not spaces
function indentBlockGo(code: string, indent: string): string {
  return code
    .split("\n")
    .map(line => line.trim() ? indent + line.trim() : "")
    .join("\n");
}

function checkFlagsGo(
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
      matched = lower.includes(reachesMatch[1].trim().replace(/\s+/g, ""));
    } else if (f.includes("no validation")) {
      matched = !lower.includes("if ") && !lower.includes("validate");
    } else if (f.includes("sql")) {
      matched = lower.includes("fmt.sprintf") && lower.includes("select");
    }

    if (matched) {
      flagged.push(`  ⚠  FLAGGED: ${file}:${line}`);
      flagged.push(`     ${text.trim()}`);
      flagged.push(`     Flag: "${flag}"`);
      flagged.push("");
    }
  }
}
