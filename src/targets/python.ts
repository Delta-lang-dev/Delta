// src/targets/python.ts
// ─── Delta Python Language Adapter ───────────────────────────────────────
// Uses tree-sitter-python for AST-accurate transformations.
// Python is indentation-sensitive so we cannot use brace-matching
// like the generic adapter does. tree-sitter gives us exact node
// boundaries including indentation, making replacement safe and precise.

import Parser  from "tree-sitter";
import Python  from "tree-sitter-python";
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
//  PythonAdapter
// ═══════════════════════════════════════════════════════════════════════════

export class PythonAdapter extends GenericAdapter {

  private parser: Parser;

  constructor() {
    super("Python", [".py"]);

    // Initialise the tree-sitter parser with the Python grammar
    this.parser = new Parser();
    this.parser.setLanguage(Python as any);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyPatch
  //  Uses tree-sitter to locate the target function by name and replaces
  //  its body while preserving Python indentation precisely.
  // ─────────────────────────────────────────────────────────────────────────

  async applyPatch(src: string, decl: AST.PatchDecl): Promise<string> {

    // Line and block anchors use generic regex replacement
    if (decl.find.type === "line" || decl.find.type === "block") {
      return super.applyPatch(src, decl);
    }

    const fnName = decl.find.name;
    const result = this.replacePythonFn(src, fnName, decl.replace.body);

    if (result === null) {
      console.warn(
        `[delta:Python] Function '${fnName}' not found — falling back to regex`
      );
      return super.applyPatch(src, decl);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  replacePythonFn
  //  Core Python-specific replacement logic using tree-sitter.
  //
  //  Python function structure in the tree-sitter AST:
  //
  //  function_definition          ← the whole def block
  //    name: identifier           ← the function name
  //    parameters: parameters     ← (param1, param2, ...)
  //    return_type?: type         ← -> ReturnType (optional)
  //    body: block                ← the indented body
  //
  //  We locate the function_definition node by name, then replace
  //  only the body block while keeping the signature line intact.
  // ─────────────────────────────────────────────────────────────────────────

  private replacePythonFn(
    src:         string,
    fnName:      string,
    replacement: string
  ): string | null {

    const tree = this.parser.parse(src);
    const node = this.findFunctionNode(tree.rootNode, fnName);

    if (!node) return null;

    // Get the body node — the indented block after the colon
    const bodyNode = node.childForFieldName("body");
    if (!bodyNode) return null;

    // Get the indentation of the def line
    const defLineStart = src.lastIndexOf("\n", node.startIndex) + 1;
    const defIndent    = src.slice(defLineStart).match(/^(\s*)/)?.[1] ?? "";
    const bodyIndent   = defIndent + "    "; // Python standard: 4 spaces

    // Re-indent the replacement to match the function body indentation
    const reindented = reindentPython(replacement, bodyIndent);

    // The body node start includes the newline after the colon
    // We replace from the start of the body to the end of the body
    const bodyStart = bodyNode.startIndex;
    const bodyEnd   = bodyNode.endIndex;

    return (
      src.slice(0, bodyStart) +
      "\n" + reindented +
      src.slice(bodyEnd)
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  findFunctionNode
  //  Recursively walks the tree-sitter AST to find a function_definition
  //  node with the given name. Handles:
  //    • Top-level functions
  //    • Class methods (including __init__, __str__, etc.)
  //    • Nested functions
  //    • Async functions (async_function_definition in tree-sitter)
  // ─────────────────────────────────────────────────────────────────────────

  private findFunctionNode(
    node:   Parser.SyntaxNode,
    name:   string
  ): Parser.SyntaxNode | null {

    // tree-sitter uses "function_definition" for sync
    // and "decorated_definition" wraps decorated functions
    if (
      node.type === "function_definition" ||
      node.type === "async_function_definition"
    ) {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text === name) return node;
    }

    // Walk into decorated definitions to find the inner function
    if (node.type === "decorated_definition") {
      const def = node.children.find(
        c => c.type === "function_definition" ||
             c.type === "async_function_definition"
      );
      if (def) {
        const nameNode = def.childForFieldName("name");
        if (nameNode?.text === name) return def;
      }
    }

    // Recurse into all children
    for (const child of node.children) {
      const found = this.findFunctionNode(child, name);
      if (found) return found;
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyMigrate
  //  Handles Python-specific migration patterns:
  //    • import X → from X import Y rewrites
  //    • from X import Y → from Z import Y
  //    • Function/method renames
  //    • Decorator renames
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

        // Handle import statement rewrites specially
        if (from.startsWith("import ") || from.startsWith("from ")) {
          out = this.migrateImport(out, from, to);
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
            // Remove import lines mentioning target
            if (/^(import|from)\s+/.test(line) && line.includes(target)) {
              return false;
            }
            // Remove function call lines
            if (line.trim().startsWith(target + "(")) return false;
            if (line.includes("." + target + "("))    return false;
            return true;
          })
          .join("\n");
        continue;
      }

      if (rule.type === "move") {
        // File moves handled by emitter — update import paths here
        out = this.updateImportPath(out, rule.from, rule.to);
        continue;
      }
    }

    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  migrateRename
  //  Renames a Python symbol using tree-sitter for accuracy.
  //  Handles method calls, attribute access, and bare names.
  // ─────────────────────────────────────────────────────────────────────────

  private migrateRename(src: string, from: string, to: string): string {
    if (!from || !to || from === to) return src;

    // Extract bare name from patterns like "Client.connect()" → "connect"
    const fromName = extractPySymbol(from);
    const toName   = extractPySymbol(to);

    if (!fromName || !toName) return replaceAll(src, from, to);

    const tree = this.parser.parse(src);
    const replacements: Array<{ start: number; end: number }> = [];

    const visit = (node: Parser.SyntaxNode): void => {
      // Match identifier nodes with the target name
      if (node.type === "identifier" && node.text === fromName) {
        replacements.push({ start: node.startIndex, end: node.endIndex });
      }
      for (const child of node.children) visit(child);
    };

    visit(tree.rootNode);
    if (replacements.length === 0) return src;

    // Apply in reverse to keep positions valid
    let result = src;
    for (const r of [...replacements].reverse()) {
      result = result.slice(0, r.start) + toName + result.slice(r.end);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  migrateImport
  //  Rewrites Python import statements.
  //  Handles:
  //    import old_module → import new_module
  //    from old_module import X → from new_module import X
  //    from old.path import X → from new.path import X
  // ─────────────────────────────────────────────────────────────────────────

  private migrateImport(src: string, from: string, to: string): string {
    const lines = src.split("\n");

    return lines.map(line => {
      const trimmed = line.trim();

      // Exact match — replace the whole import line
      if (trimmed === from) return to;

      // Partial match for "from X import" rewrites
      if (from.startsWith("from ")) {
        const fromModule = from.replace(/^from\s+/, "").replace(/\s+import.*$/, "");
        const toModule   = to.replace(/^from\s+/, "").replace(/\s+import.*$/, "");

        if (trimmed.startsWith(`from ${fromModule} import`) ||
            trimmed.startsWith(`from ${fromModule} `)) {
          return line.replace(fromModule, toModule);
        }
      }

      // "import X" → "import Y" direct replacement
      if (from.startsWith("import ") && trimmed.startsWith(from)) {
        return line.replace(from, to);
      }

      return line;
    }).join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  updateImportPath
  //  When a file is moved, update import statements that reference it.
  //  Example: services/old.py → services/new.py
  //    from services.old import Foo → from services.new import Foo
  // ─────────────────────────────────────────────────────────────────────────

  private updateImportPath(src: string, from: string, to: string): string {
    // Convert file paths to Python module paths
    const fromModule = pathToModule(from);
    const toModule   = pathToModule(to);

    if (!fromModule || !toModule) return src;

    return src
      .split("\n")
      .map(line => {
        if (line.includes(fromModule)) {
          return line.replace(fromModule, toModule);
        }
        return line;
      })
      .join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  applyIntent
  //  Injects code at function entry/exit or before def lines
  //  (for decorator injection). Uses tree-sitter for precise location.
  // ─────────────────────────────────────────────────────────────────────────

  async applyIntent(src: string, decl: AST.IntentDecl): Promise<string> {
    const tree   = this.parser.parse(src);
    const lines  = src.split("\n");
    const inject = decl.inject.trim();

    const insertions: Array<{
      line:   number;
      code:   string;
      type:   "before_def" | "body_entry" | "body_exit";
    }> = [];

    const visitForIntent = (node: Parser.SyntaxNode): void => {

      if (
        node.type === "function_definition" ||
        node.type === "async_function_definition"
      ) {
        const nameNode = node.childForFieldName("name");
        const bodyNode = node.childForFieldName("body");
        const fnName   = nameNode?.text ?? "";
        const defLine  = node.startPosition.row; // 0-indexed

        // ── Decorator injection ─────────────────────────────────────────
        // intent where: function_entry with @decorator inject
        if (inject.startsWith("@") && decl.where === "function_entry") {

          // Apply scope filter — e.g. only fns starting with "get_"
          if (shouldInjectDecorator(fnName, inject, decl)) {
            // Check guard: decorator not already present on previous line
            const prevLine = lines[defLine - 1] ?? "";
            if (!prevLine.trim().startsWith(inject.split("(")[0]!)) {
              const defIndent = lines[defLine]?.match(/^(\s*)/)?.[1] ?? "";
              insertions.push({
                line: defLine,
                code: defIndent + inject,
                type: "before_def",
              });
            }
          }

        // ── Body entry injection ────────────────────────────────────────
        } else if (decl.where === "function_entry" && bodyNode) {
          const bodyStartLine = bodyNode.startPosition.row + 1; // first line of body
          const defIndent     = lines[defLine]?.match(/^(\s*)/)?.[1] ?? "";
          const bodyIndent    = defIndent + "    ";

          // Guard check: skip if inject already in body
          const bodyText = lines
            .slice(bodyStartLine, bodyStartLine + 5)
            .join("\n");
          if (decl.guard && bodyText.includes(inject.slice(0, 20))) {
            for (const child of node.children) visitForIntent(child);
            return;
          }

          insertions.push({
            line: bodyStartLine,
            code: bodyIndent + inject,
            type: "body_entry",
          });

        // ── Body exit injection ─────────────────────────────────────────
        } else if (decl.where === "function_exit" && bodyNode) {
          const bodyEndLine = bodyNode.endPosition.row;
          const defIndent   = lines[defLine]?.match(/^(\s*)/)?.[1] ?? "";
          const bodyIndent  = defIndent + "    ";

          insertions.push({
            line: bodyEndLine,
            code: bodyIndent + inject,
            type: "body_exit",
          });
        }
      }

      for (const child of node.children) visitForIntent(child);
    };

    visitForIntent(tree.rootNode);

    // Apply insertions in reverse order so line numbers stay valid
    insertions.sort((a, b) => b.line - a.line);
    for (const ins of insertions) {
      lines.splice(ins.line, 0, ins.code);
    }

    return lines.join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  trace
  //  Data-flow analysis for Python files using tree-sitter.
  //  Tracks assignments, function calls, and return values.
  //  Flags SQL injection risks, unsafe attribute access, and
  //  missing type coercion patterns.
  // ─────────────────────────────────────────────────────────────────────────

  async trace(decl: AST.TraceDecl, cwd: string): Promise<string> {
    const absDir = path.resolve(cwd, decl.dir);
    const files  = await fg(["**/*.py"], {
      cwd:      absDir,
      absolute: true,
      ignore:   ["**/__pycache__/**", "**/venv/**", "**/.venv/**"],
    });

    const report: string[]  = [];
    const flagged: string[] = [];

    report.push(`── Trace: ${decl.ident}  (${decl.dir})`);
    report.push(`   Origin:   ${decl.origin}`);
    report.push(`   Language: Python`);
    report.push(`   Follow:   ${decl.follow.join(", ")}`);
    report.push("");

    for (const file of files) {
      const src  = fs.readFileSync(file, "utf8");
      const tree = this.parser.parse(src);
      const rel  = path.relative(cwd, file);

      const visit = (node: Parser.SyntaxNode): void => {

        // Track assignments: x = traced_value
        if (
          decl.follow.includes("assignments") &&
          node.type === "assignment"
        ) {
          const rightNode = node.childForFieldName("right");
          if (rightNode?.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsPy(line, text, rel, decl.flags, flagged);
          }
        }

        // Track augmented assignments: x += traced_value
        if (
          decl.follow.includes("assignments") &&
          node.type === "augmented_assignment"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsPy(line, text, rel, decl.flags, flagged);
          }
        }

        // Track function calls: some_fn(traced_value)
        if (
          decl.follow.includes("function_calls") &&
          node.type === "call"
        ) {
          const args = node.childForFieldName("arguments");
          if (args?.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsPy(line, text, rel, decl.flags, flagged);
          }
        }

        // Track return statements: return traced_value
        if (
          decl.follow.includes("returns") &&
          node.type === "return_statement"
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsPy(line, text, rel, decl.flags, flagged);
          }
        }

        // Track f-string usage — common Python injection vector
        if (
          node.type === "string" &&
          node.text.startsWith('f"') || node.text.startsWith("f'")
        ) {
          if (node.text.includes(decl.ident)) {
            const line = node.startPosition.row + 1;
            const text = node.text.trim();
            report.push(`  → ${rel}:${line}  ${text}`);
            checkFlagsPy(line, text, rel, decl.flags, flagged);
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

// ═══════════════════════════════════════════════════════════════════════════
//  Module-level helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Re-indent a block of replacement code to match Python's
 * indentation-sensitive syntax. Strips all existing leading
 * whitespace from each line and applies the target indent.
 */
function reindentPython(code: string, indent: string): string {
  const lines = code.split("\n");

  // Find the minimum indentation of non-empty lines
  const minIndent = lines
    .filter(l => l.trim().length > 0)
    .reduce((min, l) => {
      const leading = l.match(/^(\s*)/)?.[1].length ?? 0;
      return Math.min(min, leading);
    }, Infinity);

  const safeMin = isFinite(minIndent) ? minIndent : 0;

  return lines
    .map(l => {
      if (!l.trim()) return "";
      // Remove existing base indent, apply new indent
      return indent + l.slice(safeMin);
    })
    .join("\n");
}

/**
 * Extract the base symbol name from a Python pattern.
 * "Client.connect()" → "connect"
 * "db.execute"       → "execute"
 * "verify_token"     → "verify_token"
 */
function extractPySymbol(pattern: string): string {
  const withoutArgs = pattern.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const parts = withoutArgs.split(".");
  return parts[parts.length - 1]?.trim() ?? "";
}

/**
 * Convert a file path to a Python module dotted path.
 * "services/products.py" → "services.products"
 * "api/auth/login.py"    → "api.auth.login"
 */
function pathToModule(filePath: string): string {
  return filePath
    .replace(/\.py$/, "")
    .replace(/\//g, ".")
    .replace(/\\/g, ".");
}

/**
 * Determine whether a decorator should be injected onto a function
 * based on the intent's guard clause and function name conventions.
 * Example: @cache(ttl=60) only injected on functions starting with "get_"
 */
function shouldInjectDecorator(
  fnName: string,
  inject: string,
  decl:   AST.IntentDecl
): boolean {
  // If there is a guard clause, apply decorator only to read-only fns
  if (decl.guard?.includes("no cache on fns with side effects")) {
    // Heuristic: "get_" prefix suggests read-only
    return fnName.startsWith("get_") ||
           fnName.startsWith("fetch_") ||
           fnName.startsWith("load_") ||
           fnName.startsWith("read_");
  }
  // No guard — inject on all functions
  return true;
}

/**
 * Check Python source lines against flag conditions.
 * Handles Python-specific patterns like f-string SQL injection
 * and missing .get() on dict access.
 */
function checkFlagsPy(
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

    // "reaches X" — checks if text contains the target symbol
    const reachesMatch = f.match(/reaches\s+(.+)/);
    if (reachesMatch) {
      matched = lower.includes(
        reachesMatch[1].trim().replace(/\s+/g, "")
      );
    }

    // "raw f-string SQL" — Python-specific injection pattern
    else if (f.includes("raw") && f.includes("sql")) {
      matched = (
        /f['"].*SELECT.*\{/.test(text) ||
        /f['"].*INSERT.*\{/.test(text) ||
        /f['"].*UPDATE.*\{/.test(text) ||
        /f['"].*DELETE.*\{/.test(text) ||
        /f['"].*WHERE.*\{/.test(text)
      );
    }

    // "no type coercion" — int(), str(), float() missing
    else if (f.includes("no type coercion") || f.includes("type coercion")) {
      matched = !lower.includes("int(")   &&
                !lower.includes("str(")   &&
                !lower.includes("float(") &&
                !lower.includes("isinstance(");
    }

    // "no validation" — no if/assert/validate before use
    else if (f.includes("no validation") || f.includes("skips validation")) {
      matched = !lower.includes("if ")       &&
                !lower.includes("assert ")   &&
                !lower.includes("validate")  &&
                !lower.includes("isinstance");
    }

    // "without hashing" — password stored or compared without bcrypt/hashlib
    else if (f.includes("without hashing")) {
      matched = lower.includes("password") &&
                !lower.includes("hashlib") &&
                !lower.includes("bcrypt")  &&
                !lower.includes("pbkdf2")  &&
                !lower.includes("argon");
    }

    // "reaches print" or "reaches logger" — data reaching output
    else if (f.includes("reaches print") || f.includes("reaches log")) {
      matched = lower.includes("print(") || lower.includes("log");
    }

    if (matched) {
      flagged.push(`  ⚠  FLAGGED: ${file}:${line}`);
      flagged.push(`     ${text.trim()}`);
      flagged.push(`     Flag: "${flag}"`);
      flagged.push("");
    }
  }
}
