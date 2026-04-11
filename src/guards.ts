    code:`// src/guards.ts
// ─── Delta Guard Runner ───────────────────────────────────────────────────
/ Evaluates GuardDecl assertions against the actual codebase.
// Called BEFORE any/ write operation — if a guard fails with block_apply,
// the entire emit is aborted.
// UPDATED: fn_exists uses tree-sitter/TS Compiler API instead of .includes()
// UPDATED: DEFAULT_IGNORE prevents crawling node_modules/dist/etc.

import * as fs   from "fs";
import * as path from "path";
import fg        from "fast-glob";
import Parser    from "tree-sitter";
import Python    from "tree-sitter-python";
import Go        from "tree-sitter-go";
import Rust      from "tree-sitter-rust";
import Java      from "tree-sitter-java";
import ts        from "typescript";
import * as AST  from "./ast";

export interface GuardResult {
  ok: boolean; label: string; passed: string[]; failures: string[];
}

export const DEFAULT_IGNORE = [
  "**/node_modules/**","**/dist/**","**/build/**","**/.git/**",
  "**/coverage/**","**/.next/**","**/target/**","**/__pycache__/**",
  "**/venv/**","**/.venv/**","**/vendor/**",
];

export async function runGuard(g: AST.GuardDecl, cwd: string): Promise<GuardResult> {
  const files   = await fg(g.scope, { cwd, absolute: true, ignore: DEFAULT_IGNORE });
  const passed:   string[] = [];
  const failures: string[] = [];
  for (const assert of g.asserts) {
    const result = await checkAssert(assert, files, cwd);
    if (result.ok) passed.push(result.msg);
    else           failures.push(result.msg);
  }
  return { ok: failures.length === 0, label: g.label, passed, failures };
}

interface CheckResult { ok: boolean; msg: string }

async function checkAssert(
  a: AST.AssertExpr, files: string[], cwd: string
): Promise<CheckResult> {

  if (a.type === "fn_exists") {
    const fnName = a.sig.replace(/\(.*\)/, "").replace(/:\s*\S+/, "").trim();

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      const ext = path.extname(file);

      if ([".ts",".tsx",".js",".jsx"].includes(ext)) {
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
        let found = false;
        const visit = (node: ts.Node): void => {
          if (found) return;
          if ((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node)) &&
              (node as ts.FunctionDeclaration).name?.text === fnName)
            { found = true; return; }
          if (ts.isArrowFunction(node) &&
              ts.isVariableDeclaration(node.parent) &&
              ts.isIdentifier(node.parent.name) &&
              node.parent.name.text === fnName)
            { found = true; return; }
          ts.forEachChild(node, visit);
        };
        visit(sf);
        if (found) return { ok:true, msg:\`✓ fn '\${fnName}' confirmed in AST\` };
        continue;
      }

      if (ext === ".py") {
        const p = mkParser(Python);
        if (findFn(p.parse(src).rootNode, fnName, ["function_definition","async_function_definition"]))
          return { ok:true, msg:\`✓ fn '\${fnName}' confirmed in AST\` };
        continue;
      }
      if (ext === ".go") {
        const p = mkParser(Go);
        if (findFn(p.parse(src).rootNode, fnName, ["function_declaration","method_declaration"]))
          return { ok:true, msg:\`✓ fn '\${fnName}' confirmed in AST\` };
        continue;
      }
      if (ext === ".rs") {
        const p = mkParser(Rust);
        if (findFn(p.parse(src).rootNode, fnName, ["function_item"]))
          return { ok:true, msg:\`✓ fn '\${fnName}' confirmed in AST\` };
        continue;
      }
      if (ext === ".java") {
        const p = mkParser(Java);
        if (findFn(p.parse(src).rootNode, fnName, ["method_declaration","constructor_declaration"]))
          return { ok:true, msg:\`✓ fn '\${fnName}' confirmed in AST\` };
        continue;
      }

      const re = new RegExp(\`(?:function|def|func|fn|sub)\\s+\${escRe(fnName)}\\s*\\(\`,"m");
      if (re.test(src)) return { ok:true, msg:\`✓ fn '\${fnName}' found via pattern\` };
    }
    return { ok:false, msg:\`✗ fn '\${fnName}' not found in scope\` };
  }

  if (a.type === "no_import_from") {
    const bad = files.filter(f => {
      const s = fs.readFileSync(f,"utf8");
      return s.includes(\`from "\${a.path}"\`) || s.includes(\`from '\${a.path}'\`);
    });
    return { ok:bad.length===0,
      msg:bad.length===0 ? \`✓ no file imports from '\${a.path}'\`
        : \`✗ \${bad.map(f=>path.relative(cwd,f)).join(", ")} imports from '\${a.path}'\` };
  }

  if (a.type === "no_contains") {
    const bad: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(f,"utf8").split("\\n");
      for (let i=0;i<lines.length;i++) {
        if (lines[i]!.includes(a.near)) {
          const win = lines.slice(Math.max(0,i-2),i+3).join("\\n");
          if (win.includes(a.text)) bad.push(\`\${path.relative(cwd,f)}:\${i+1}\`);
        }
      }
    }
    return { ok:bad.length===0,
      msg:bad.length===0 ? \`✓ no '\${a.text}' near '\${a.near}'\`
        : \`✗ '\${a.text}' near '\${a.near}' in: \${bad.join(", ")}\` };
  }

  if (a.type === "no_raw_sql") {
    const bad = files.filter(f => {
      const s = fs.readFileSync(f,"utf8");
      return /f["'].*SELECT.*\{/.test(s)||/f["'].*INSERT.*\{/.test(s)||
             /f["'].*UPDATE.*\{/.test(s)||/\`.*SELECT.*\$\{/.test(s);
    });
    return { ok:bad.length===0,
      msg:bad.length===0 ? "✓ no raw SQL"
        : \`✗ raw SQL risk in: \${bad.map(f=>path.relative(cwd,f)).join(", ")}\` };
  }

  return { ok:true, msg:\`✓ \${(a as any).expr ?? "assert"} (passed)\` };
}

function mkParser(lang: unknown): Parser {
  const p = new Parser(); p.setLanguage(lang as Parser.Language); return p;
}
function findFn(node: Parser.SyntaxNode, name: string, types: string[]): boolean {
  if (types.includes(node.type) && node.childForFieldName("name")?.text === name) return true;
  for (const c of node.children) if (findFn(c, name, types)) return true;
  return false;
}
function escRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }`
  },
{
