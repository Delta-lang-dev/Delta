// src/targets/java.ts
// ─── Delta Java Language Adapter ─────────────────────────────────────────
// Uses tree-sitter-java for AST-accurate transformations.
// Java has unique patterns: class-scoped methods, access modifiers,
// checked exceptions, annotations, and verbose import statements
// that need dedicated handling.

import Parser from "tree-sitter";
import Java   from "tree-sitter-java";
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

export class JavaAdapter extends GenericAdapter {

  private parser: Parser;

  constructor() {
    super("Java", [".java"]);
    this.parser = new Parser();
    this.parser.setLanguage(Java as any);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyPatch
  // ─────────────────────────────────────────────────────────────────────────

  async applyPatch(src: string, decl: AST.PatchDecl): Promise<string> {
    if (decl.find.type === "line" || decl.find.type === "block") {
      return super.applyPatch(src, decl);
    }

    const result = this.replaceJavaMethod(src, decl.find.name, decl.replace.body);
    if (result === null) {
      console.warn(
        `[delta:Java] Method '${decl.find.name}' not found — falling back to regex`
      );
      return super.applyPatch(src, decl);
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  replaceJavaMethod
  //  Handles Java method forms:
  //    public void methodName(params) { ... }
  //    public static ReturnType methodName(params) throws X { ... }
  //    private ReturnType methodName(params) { ... }
  //    @Override public ReturnType methodName(params) { ... }
  // ─────────────────────────────────────────────────────────────────────────

  private replaceJavaMethod(
    src:         string,
    methodName:  string,
    replacement: string
  ): string | null {

    const tree = this.parser.parse(src);
    const node = this.findJavaMethod(tree.rootNode, methodName);
    if (!node) return null;

    const bodyNode = node.childForFieldName("body");
    if (!bodyNode) return null;

    const openBrace  = bodyNode.startIndex;
    const closeBrace = bodyNode.endIndex;
    const indent     = getIndentAt(src, node.startIndex);
    const bodyIndent = indent + "    "; // Java uses 4 spaces
    const indented   = indentBlock(replacement, bodyIndent);

    return (
      src.slice(0, openBrace + 1) +
      "\n" + indented + "\n" + indent +
      src.slice(closeBrace - 1)
    );
  }

  private findJavaMethod(
    node:   Parser.SyntaxNode,
    name:   string
  ): Parser.SyntaxNode | null {

    // method_declaration covers all Java method forms
    if (node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text === name) return node;
    }

    // constructor_declaration
    if (node.type === "constructor_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text === name) return node;
    }

    for (const child of node.children) {
      const found = this.findJavaMethod(child, name);
      if (found) return found;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyMigrate
  //  Handles Java import rewrites, class renames, and method renames.
  // ─────────────────────────────────────────────────────────────────────────

  async applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string> {
    let out = src;

    for (const rule of decl.rules) {

      if (rule.type === "rename") {
        out = this.javaRename(out, rule.from.trim(), rule.to.trim());
        continue;
      }

      if (rule.type === "replace") {
        const from = rule.from.trim();
        const to   = rule.to.trim();
        // Handle import rewrites
        if (from.startsWith("import ")) {
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
            if (line.trim().startsWith("import") && line.includes(target)) return false;
            if (line.includes(target + "("))                                return false;
            return true;
          })
          .join("\n");
        continue;
      }
    }

    return out;
  }

  private javaRename(src: string, from: string, to: string): string {
    if (!from || !to || from === to) return src;

    const fromName = extractJavaSymbol(from);
    const toName   = extractJavaSymbol(to);
    if (!fromName || !toName) return replaceAll(src, from, to);

    const tree = this.parser.parse(src);
    const replacements: Array<{ start: number; end: number }> = [];

    const visit = (node: Parser.SyntaxNode): void => {
      if (
        (node.type === "identifier" || node.type === "type_identifier") &&
        node.text === fromName
      ) {
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
  //  Injects code at method entry points.
  // ─────────────────────────────────────────────────────────────────────────

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const tree   = this.parser.parse(src);
    const lines  = src.split("\n");
    const inject = decl.inject.trim();
    const insertions: Array<{ line: number; indent: string }> = [];

    const visit = (node: Parser.SyntaxNode): void => {
      if (
        node.type === "method_declaration" ||
        node.type === "constructor_declaration"
      ) {
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
  //  Data-flow analysis for Java source files.
  // ─────────────────────────────────────────────────────────────────────────

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);
    const files  = await fg(["**/*.java"], {
      cwd: absDir, absolute: true,
      ignore: ["**/target/**", "**/build/**"],
    });

    const report: string[]  = [];
    const flagged: string[] = [];

    report.push(`── Trace: ${decl.ident}  (${decl.dir})`);
    report.push(`   Origin:   ${decl.origin}`);
    report.push(`   Language: Java`);
    report.push(`   Follow:   ${decl.follow.join(", ")}`);
    report.push("");

    for (const file of files) {
      const src  = fs.readFileSync(file, "utf8");
      const tree = this.parser.parse(src);
      const rel  = path.relative(cwd, file);

      const visit = (node: Parser.SyntaxNode): void => {

        // local_variable_declaration: String x = tracedValue;
        if (
          decl.follow.includes("assignments") &&
          node.type === "local_variable_declaration"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsJava(line, text, rel, decl.flags, flagged);
          }
        }

        // method_invocation: someMethod(tracedValue)
        if (
          decl.follow.includes("function_calls") &&
          node.type === "method_invocation"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsJava(line, text, rel, decl.flags, flagged);
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
            checkFlagsJava(line, text, rel, decl.flags, flagged);
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

function extractJavaSymbol(pattern: string): string {
  const withoutArgs = pattern.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const parts = withoutArgs.split(".");
  return parts[parts.length - 1]?.trim() ?? "";
}

function checkFlagsJava(
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
    } else if (f.includes("sql")) {
      // PreparedStatement vs string concatenation
      matched = lower.includes("+ ") &&
                (lower.includes("select") ||
                 lower.includes("insert") ||
                 lower.includes("update"));
    } else if (f.includes("no validation")) {
      matched = !lower.includes("if (") &&
                !lower.includes("assert") &&
                !lower.includes("validate") &&
                !lower.includes("objects.require");
    }

    if (matched) {
      flagged.push(`  ⚠  FLAGGED: ${file}:${line}`);
      flagged.push(`     ${text.trim()}`);
      flagged.push(`     Flag: "${flag}"`);
      flagged.push("");
    }
  }
}
