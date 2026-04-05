// src/guards.ts
// ─── Delta Guard Runner ───────────────────────────────────────────────────
// Evaluates GuardDecl assertions against the actual codebase.
// Called BEFORE any write operation — if a guard fails with block_apply,
// the entire emit is aborted.

import * as fs  from "fs";
import fg       from "fast-glob";
import * as path from "path";
import * as AST from "./ast";

export interface GuardResult {
  ok:       boolean;
  label:    string;
  passed:   string[];
  failures: string[];
}

export async function runGuard(
  g:   AST.GuardDecl,
  cwd: string
): Promise<GuardResult> {
  const files    = await fg(g.scope, { cwd, absolute: true });
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
  a:     AST.AssertExpr,
  files: string[],
  cwd:   string
): Promise<CheckResult> {

  if (a.type === "fn_exists") {
    const found = files.some(f => {
      const src = fs.readFileSync(f, "utf8");
      return src.includes(a.sig.replace(/\\s+/g, " ").trim());
    });
    return {
      ok:  found,
      msg: found
        ? \`✓ fn '\${a.sig}' exists\`
        : \`✗ fn '\${a.sig}' not found in scope\
