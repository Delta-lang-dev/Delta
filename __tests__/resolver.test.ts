// __tests__/resolver.test.ts
// ─── Delta Resolver Unit Tests ────────────────────────────────────────────

import { tokenise }  from "../src/lexer";
import { parse }     from "../src/parser";
import { resolve }   from "../src/resolver";
import type { Diagnostic } from "../src/resolver";

// ── Helpers ───────────────────────────────────────────────────────────────

const cwd = "/tmp"; // resolver checks file existence; /tmp always exists

function resolveStr(src: string) {
  return resolve(parse(tokenise(src)), cwd);
}

const errors = (src: string): Diagnostic[] =>
  resolveStr(src).diagnostics.filter(d => d.severity === "error");

const warnings = (src: string): Diagnostic[] =>
  resolveStr(src).diagnostics.filter(d => d.severity === "warning");

const hasError = (src: string, msg: string): boolean =>
  errors(src).some(d => d.message.toLowerCase().includes(msg.toLowerCase()));

const hasWarning = (src: string, msg: string): boolean =>
  warnings(src).some(d => d.message.toLowerCase().includes(msg.toLowerCase()));

// ── Registry: duplicate detection ─────────────────────────────────────────

describe("registry — duplicate detection", () => {
  test("duplicate fix names produce error", () => {
    const src = `
      fix foo { pattern: { x } replace: { y } scope: "**/*.ts" }
      fix foo { pattern: { a } replace: { b } scope: "**/*.ts" }
    `;
    expect(hasError(src, "duplicate fix")).toBe(true);
  });

  test("duplicate migrate labels produce error", () => {
    const src = `
      migrate "v1" in TypeScript { rename: a -> b }
      migrate "v1" in TypeScript { rename: c -> d }
    `;
    expect(hasError(src, "duplicate migrate")).toBe(true);
  });

  test("duplicate guard labels produce error", () => {
    const src = `
      guard "safety" { scope: "src/**" assert: fn main() exists on_fail: warn }
      guard "safety" { scope: "src/**" assert: fn main() exists on_fail: warn }
    `;
    expect(hasError(src, "duplicate guard")).toBe(true);
  });

  test("duplicate import alias produces warning", () => {
    const src = `
      import a from "./a.delta"
      import a from "./b.delta"
    `;
    expect(hasWarning(src, "duplicate import")).toBe(true);
  });

  test("unique names pass without errors", () => {
    const src = `
      fix foo { pattern: { x } replace: { y } scope: "**/*.ts" }
      fix bar { pattern: { a } replace: { b } scope: "**/*.ts" }
    `;
    expect(errors(src).filter(e => e.message.includes("Duplicate"))).toHaveLength(0);
  });
});

// ── Patch validation ──────────────────────────────────────────────────────

describe("patch validation", () => {
  test("invalid language ID produces error", () => {
    const src = `patch "f.ts" in COBOL { find fn foo() {} replace with { x } }`;
    expect(hasError(src, "unknown language")).toBe(true);
  });

  test("empty replace body produces error", () => {
    const src = `patch "/tmp/forge.py" in Python { find fn foo() {} replace with {  } }`;
    expect(hasError(src, "empty")).toBe(true);
  });

  test("missing file produces warning not error", () => {
    const src = `patch "does_not_exist_xyz.ts" in TypeScript { find fn foo() {} replace with { return 1; } }`;
    expect(hasWarning(src, "not found")).toBe(true);
    expect(errors(src).some(e => e.message.includes("not found"))).toBe(false);
  });

  test("valid patch on existing file passes", () => {
    const src = `patch "/tmp/forge.py" in Python { find fn foo() {} replace with { return 1; } }`;
    expect(errors(src)).toHaveLength(0);
  });
});

// ── Fix validation ────────────────────────────────────────────────────────

describe("fix validation", () => {
  test("empty pattern produces error", () => {
    const src = `fix bad { pattern: {  } replace: { x } scope: "**/*.ts" }`;
    expect(hasError(src, "empty pattern")).toBe(true);
  });

  test("empty replace produces error", () => {
    const src = `fix bad { pattern: { x } replace: {  } scope: "**/*.ts" }`;
    expect(hasError(src, "empty replace")).toBe(true);
  });

  test("empty scope produces error", () => {
    const src = `fix bad { pattern: { x } replace: { y } scope: "" }`;
    expect(hasError(src, "no scope")).toBe(true);
  });

  test("unknown severity produces warning", () => {
    const src = `fix f { pattern: { x } replace: { y } scope: "**" severity: oops }`;
    expect(hasWarning(src, "unknown severity")).toBe(true);
  });

  test("valid severity values pass", () => {
    for (const sev of ["bug", "perf", "style", "security"]) {
      const src = `fix f { pattern: { x } replace: { y } scope: "**" severity: ${sev} }`;
      expect(warnings(src).some(w => w.message.includes("severity"))).toBe(false);
    }
  });
});

// ── Intent validation ─────────────────────────────────────────────────────

describe("intent validation", () => {
  test("invalid language produces error", () => {
    const src = `intent "x" { scope: "**" language: COBOL inject: { x; } where: function_entry }`;
    expect(hasError(src, "unknown language")).toBe(true);
  });

  test("empty inject produces error", () => {
    const src = `intent "x" { scope: "**" language: TypeScript inject: {  } where: function_entry }`;
    expect(hasError(src, "empty inject")).toBe(true);
  });

  test("empty scope produces warning not error", () => {
    const src = `intent "x" { scope: "" language: TypeScript inject: { x; } where: function_entry }`;
    expect(hasWarning(src, "no scope")).toBe(true);
    expect(errors(src).some(e => e.message.includes("scope"))).toBe(false);
  });
});

// ── Migrate validation ────────────────────────────────────────────────────

describe("migrate validation", () => {
  test("invalid language produces error", () => {
    const src = `migrate "x" in COBOL { rename: a -> b }`;
    expect(hasError(src, "unknown language")).toBe(true);
  });

  test("no rules produces warning", () => {
    const src = `migrate "empty" in TypeScript { scope: "**" }`;
    expect(hasWarning(src, "no rules")).toBe(true);
  });

  test("rename from === to produces warning", () => {
    const src = `migrate "same" in TypeScript { rename: foo -> foo }`;
    expect(hasWarning(src, "identical")).toBe(true);
  });

  test("empty rename from produces error", () => {
    const src = `migrate "bad" in TypeScript { rename: "" -> newFn }`;
    expect(hasError(src, "empty 'from'")).toBe(true);
  });
});

// ── Guard validation ──────────────────────────────────────────────────────

describe("guard validation", () => {
  test("no asserts produces warning", () => {
    const src = `guard "empty" { scope: "src/**" on_fail: warn }`;
    expect(hasWarning(src, "no assert")).toBe(true);
  });

  test("no on_fail produces warning", () => {
    const src = `guard "nofail" { scope: "src/**" assert: fn main() exists }`;
    expect(hasWarning(src, "no on_fail")).toBe(true);
  });
});

// ── Trace validation ──────────────────────────────────────────────────────

describe("trace validation", () => {
  test("invalid language produces error", () => {
    const src = `trace x in "src/" { language: COBOL origin: req.body follow: assignments report: full_chain }`;
    expect(hasError(src, "unknown language")).toBe(true);
  });

  test("empty origin produces error", () => {
    const src = `trace x in "src/" { language: TypeScript origin: "" follow: assignments report: full_chain }`;
    expect(hasError(src, "no origin")).toBe(true);
  });

  test("no follow produces warning", () => {
    const src = `trace x in "src/" { language: TypeScript origin: req.body report: full_chain }`;
    expect(hasWarning(src, "no follow")).toBe(true);
  });
});

// ── Apply validation ──────────────────────────────────────────────────────

describe("apply validation", () => {
  test("apply undeclared fix produces error", () => {
    const src = `apply fix nonExistent to project`;
    expect(hasError(src, "no fix with that name")).toBe(true);
  });

  test("apply undeclared migrate produces error", () => {
    const src = `apply migrate "ghost" to project`;
    expect(hasError(src, "no migrate with that label")).toBe(true);
  });

  test("apply declared fix passes", () => {
    const src = `
      fix myFix { pattern: { x } replace: { y } scope: "**/*.ts" }
      apply fix myFix to project
    `;
    expect(errors(src)).toHaveLength(0);
  });
});

// ── Topological sort ──────────────────────────────────────────────────────

describe("execution order", () => {
  test("guards sort before patches", () => {
    const src = `
      patch "/tmp/forge.py" in Python { find fn foo() {} replace with { x } }
      guard "safety" { scope: "src/**" assert: fn main() exists on_fail: warn }
    `;
    const { order } = resolveStr(src);
    const gIdx = order.findIndex(d => d.kind === "GuardDecl");
    const pIdx = order.findIndex(d => d.kind === "PatchDecl");
    expect(gIdx).toBeLessThan(pIdx);
  });

  test("traces sort after everything else", () => {
    const src = `
      fix f { pattern: { x } replace: { y } scope: "**/*.ts" }
      trace t in "src/" { language: TypeScript origin: x follow: assignments report: full_chain }
    `;
    const { order } = resolveStr(src);
    const fIdx = order.findIndex(d => d.kind === "FixDecl");
    const tIdx = order.findIndex(d => d.kind === "TraceDecl");
    expect(tIdx).toBeGreaterThan(fIdx);
  });
});

// ── hasErrors flag ────────────────────────────────────────────────────────

describe("hasErrors flag", () => {
  test("clean program returns hasErrors=false", () => {
    const src = `fix f { pattern: { x } replace: { y } scope: "**/*.ts" }`;
    expect(resolveStr(src).hasErrors).toBe(false);
  });

  test("program with errors returns hasErrors=true", () => {
    const src = `apply fix ghost to project`;
    expect(resolveStr(src).hasErrors).toBe(true);
  });
});
