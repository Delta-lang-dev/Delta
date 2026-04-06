// src/targets/rust.ts
// ─── Delta Rust Language Adapter ─────────────────────────────────────────
// Uses tree-sitter-rust for AST-accurate transformations.
// Rust has unique patterns: impl blocks, trait implementations,
// lifetime annotations, ownership semantics, and macro invocations
// that require special handling beyond generic regex replacement.

import Parser from "tree-sitter";
import Rust   from "tree-sitter-rust";
import * as fs   from "fs";
import * as path from "path";
import fg        from "fast-glob";
import * as AST  from "../ast";
import {
  GenericAdapter,
  getIndentAt,
  indentBlock,
  replaceAll,
} from "./generic";

export class RustAdapter extends GenericAdapter {

  private parser: Parser;

  constructor() {
    super("Rust", [".rs"]);
    this.parser = new Parser();
    this.parser.setLanguage(Rust as unknown as Parser.Language);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyPatch
  // ─────────────────────────────────────────────────────────────────────────

  async applyPatch(src: string, decl: AST.PatchDecl): Promise<string> {
    if (decl.find.type === "line" || decl.find.type === "block") {
      return super.applyPatch(src, decl);
    }

    const result = this.replaceRustFn(src, decl.find.name, decl.replace.body);
    if (result === null) {
      console.warn(
        `[delta:Rust] Function '${decl.find.name}' not found — falling back to regex`
      );
      return super.applyPatch(src, decl);
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  replaceRustFn
  //  Handles Rust function forms:
  //    fn function_name(params) -> ReturnType { ... }
  //    pub fn function_name(params) -> ReturnType { ... }
  //    async fn function_name(params) -> ReturnType { ... }
  //    pub async fn function_name(...) -> ReturnType { ... }
  //  Also handles impl block methods.
  // ─────────────────────────────────────────────────────────────────────────

  private replaceRustFn(
    src:         string,
    fnName:      string,
    replacement: string
  ): string | null {

    const tree = this.parser.parse(src);
    const node = this.findRustFn(tree.rootNode, fnName);
    if (!node) return null;

    const bodyNode = node.childForFieldName("body");
    if (!bodyNode) return null;

    const openBrace  = bodyNode.startIndex;
    const closeBrace = bodyNode.endIndex;
    const indent     = getIndentAt(src, node.startIndex);
    const bodyIndent = indent + "    "; // Rust uses 4 spaces
    const indented   = indentBlock(replacement, bodyIndent);

    return (
      src.slice(0, openBrace + 1) +
      "\n" + indented + "\n" + indent +
      src.slice(closeBrace - 1)
    );
  }

  private findRustFn(
    node:   Parser.SyntaxNode,
    name:   string
  ): Parser.SyntaxNode | null {

    // function_item covers all fn forms including pub, async, pub async
    if (node.type === "function_item") {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text === name) return node;
    }

    for (const child of node.children) {
      const found = this.findRustFn(child, name);
      if (found) return found;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyMigrate
  //  Handles Rust crate renames, use statement rewrites,
  //  and method renames across the codebase.
  // ─────────────────────────────────────────────────────────────────────────

  async applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string> {
    let out = src;

    for (const rule of decl.rules) {

      if (rule.type === "rename") {
        out = this.rustRename(out, rule.from.trim(), rule.to.trim());
        continue;
      }

      if (rule.type === "replace") {
        const from = rule.from.trim();
        const to   = rule.to.trim();
        // Handle use statement rewrites
        if (from.startsWith("use ") || to.startsWith("use ")) {
          out = out.split(from).join(to);
          continue;
        }
        // Handle extern crate rewrites
        if (from.startsWith("extern crate")) {
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
            if (line.trim().startsWith("use ") && line.includes(target)) return false;
            if (line.includes(target + "("))                              return false;
            if (line.includes(target + "::"))                            return false;
            return true;
          })
          .join("\n");
        continue;
      }
    }

    return out;
  }

  private rustRename(src: string, from: string, to: string): string {
    if (!from || !to || from === to) return src;

    const fromName = extractRustSymbol(from);
    const toName   = extractRustSymbol(to);
    if (!fromName || !toName) return replaceAll(src, from, to);

    const tree = this.parser.parse(src);
    const replacements: Array<{ start: number; end: number }> = [];

    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "identifier" && node.text === fromName) {
        replacements.push({ start: node.startIndex, end: node.endIndex });
      }
      // Also match type_identifier for struct/enum names
      if (node.type === "type_identifier" && node.text === fromName) {
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
  //  Injects code at function entry using tree-sitter.
  //  Skips macro invocations and attribute macros.
  // ─────────────────────────────────────────────────────────────────────────

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const tree   = this.parser.parse(src);
    const lines  = src.split("\n");
    const inject = decl.inject.trim();
    const insertions: Array<{ line: number; indent: string }> = [];

    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "function_item") {
        const bodyNode = node.childForFieldName("body");
        if (!bodyNode) { for (const c of node.children) visit(c); return; }

        if (decl.where === "function_entry") {
          const bodyStartLine = bodyNode.startPosition.row + 1;
          const fnIndent      = getIndentAt(src, node.startIndex);
          const bodyIndent    = fnIndent + "    ";

          const window = lines.slice(bodyStartLine, bodyStartLine + 4).join("\n");
          if (decl.guard && window.includes(inject.slice(0, 20))) {
            for (const c of node.children) visit(c);
            return;
          }

          insertions.push({ line: bodyStartLine, indent: bodyIndent });
        }

        if (decl.where === "function_exit") {
          const bodyEndLine = bodyNode.endPosition.row;
          const fnIndent    = getIndentAt(src, node.startIndex);
          const bodyIndent  = fnIndent + "    ";
          insertions.push({ line: bodyEndLine, indent: bodyIndent });
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
  //  Data-flow analysis for Rust source files.
  //  Tracks let bindings, function calls, and return expressions.
  // ─────────────────────────────────────────────────────────────────────────

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);
    const files  = await fg(["**/*.rs"], {
      cwd: absDir, absolute: true,
      ignore: ["**/target/**"],
    });

    const report: string[]  = [];
    const flagged: string[] = [];

    report.push(`── Trace: ${decl.ident}  (${decl.dir})`);
    report.push(`   Origin:   ${decl.origin}`);
    report.push(`   Language: Rust`);
    report.push(`   Follow:   ${decl.follow.join(", ")}`);
    report.push("");

    for (const file of files) {
      const src  = fs.readFileSync(file, "utf8");
      const tree = this.parser.parse(src);
      const rel  = path.relative(cwd, file);

      const visit = (node: Parser.SyntaxNode): void => {

        // let_declaration: let x = traced_value;
        if (
          decl.follow.includes("assignments") &&
          node.type === "let_declaration"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsRust(line, text, rel, decl.flags, flagged);
          }
        }

        // call_expression: some_fn(traced_value)
        if (
          decl.follow.includes("function_calls") &&
          node.type === "call_expression"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsRust(line, text, rel, decl.flags, flagged);
          }
        }

        // return_expression
        if (
          decl.follow.includes("returns") &&
          node.type === "return_expression"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsRust(line, text, rel, decl.flags, flagged);
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

function extractRustSymbol(pattern: string): string {
  const withoutArgs = pattern.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const parts = withoutArgs.split("::");
  return parts[parts.length - 1]?.trim() ?? "";
}

function checkFlagsRust(
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
    } else if (f.includes("unwrap")) {
      // Flag unsafe .unwrap() calls on traced values
      matched = lower.includes(".unwrap()");
    } else if (f.includes("no validation")) {
      matched = !lower.includes("is_ok()") &&
                !lower.includes("is_some()") &&
                !lower.includes("validate") &&
                !lower.includes("match ");
    }

    if (matched) {
      flagged.push(`  ⚠  FLAGGED: ${file}:${line}`);
      flagged.push(`     ${text.trim()}`);
      flagged.push(`     Flag: "${flag}"`);
      flagged.push("");
    }
  }
}
