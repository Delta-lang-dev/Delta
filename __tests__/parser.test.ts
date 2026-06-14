// __tests__/parser.test.ts
// ─── Delta Parser Unit Tests ──────────────────────────────────────────────

import { tokenise }  from "../src/lexer";
import { parse, ParseError } from "../src/parser";
import type * as AST from "../src/ast";

// ── Helper ────────────────────────────────────────────────────────────────

const parseStr = (src: string): AST.Program =>
  parse(tokenise(src));

const firstDecl = (src: string): AST.TopDecl =>
  parseStr(src).decls[0]!;

// ── patch ─────────────────────────────────────────────────────────────────

describe("patch", () => {
  test("parses fn find clause", () => {
    const src = `patch "src/app.ts" in TypeScript {
  find fn renderApp() { oldBody }
  replace with { return <App />; }
  why: "update render call"
}`;
    const d = firstDecl(src) as AST.PatchDecl;
    expect(d.kind).toBe("PatchDecl");
    expect(d.file).toBe("src/app.ts");
    expect(d.lang).toBe("TypeScript");
    expect(d.find.type).toBe("fn");
    if (d.find.type === "fn") {
      expect(d.find.name).toBe("renderApp");
    }
    expect(d.replace.body).toContain("return");
    expect(d.why).toBe("update render call");
  });

  test("parses block find clause", () => {
    const src = `patch "src/app.ts" in TypeScript {
  find block "old section" { const x = 1; }
  replace with { const x = 2; }
}`;
    const d = firstDecl(src) as AST.PatchDecl;
    expect(d.find.type).toBe("block");
    if (d.find.type === "block") {
      expect(d.find.label).toBe("old section");
    }
  });

  test("why clause is optional", () => {
    const src = `patch "f.ts" in Python { find fn foo() {} replace with { pass } }`;
    const d = firstDecl(src) as AST.PatchDecl;
    expect(d.why).toBeUndefined();
  });

  test("missing language throws ParseError", () => {
    expect(() =>
      parseStr(`patch "f.ts" { find fn foo() {} replace with { } }`)
    ).toThrow(ParseError);
  });
});

// ── fix ───────────────────────────────────────────────────────────────────

describe("fix", () => {
  test("parses full fix block", () => {
    const src = `fix nullCheck {
  pattern: { x == null }
  replace: { x === null }
  scope:   "**/*.ts"
  severity: bug
  note:    "use strict equality"
}`;
    const d = firstDecl(src) as AST.FixDecl;
    expect(d.kind).toBe("FixDecl");
    expect(d.name).toBe("nullCheck");
    expect(d.pattern).toContain("null");
    expect(d.replace).toContain("null");
    expect(d.scope).toBe("**/*.ts");
    expect(d.severity).toBe("bug");
    expect(d.note).toBe("use strict equality");
  });

  test("severity and note are optional", () => {
    const src = `fix noOp { pattern: { x } replace: { x } scope: "**/*.ts" }`;
    const d = firstDecl(src) as AST.FixDecl;
    expect(d.severity).toBeUndefined();
    expect(d.note).toBeUndefined();
  });
});

// ── intent ────────────────────────────────────────────────────────────────

describe("intent", () => {
  test("parses intent block", () => {
    const src = `intent "add logging" {
  scope:    "src/**"
  language: TypeScript
  inject:   { console.log("entry"); }
  where:    function_entry
}`;
    const d = firstDecl(src) as AST.IntentDecl;
    expect(d.kind).toBe("IntentDecl");
    expect(d.label).toBe("add logging");
    expect(d.scope).toBe("src/**");
    expect(d.language).toBe("TypeScript");
    expect(d.inject).toContain("console.log");
    expect(d.where).toBe("function_entry");
  });

  test("preserve and guard are optional", () => {
    const src = `intent "x" { scope: "**" language: TypeScript inject: { x; } where: function_entry }`;
    const d = firstDecl(src) as AST.IntentDecl;
    expect(d.preserve).toBeUndefined();
    expect(d.guard).toBeUndefined();
  });
});

// ── migrate ───────────────────────────────────────────────────────────────

describe("migrate", () => {
  test("parses rename rule", () => {
    const src = `migrate "v1 to v2" in TypeScript {
  rename: oldFn -> newFn
  scope: "src/**"
}`;
    const d = firstDecl(src) as AST.MigrateDecl;
    expect(d.kind).toBe("MigrateDecl");
    expect(d.label).toBe("v1 to v2");
    expect(d.rules[0]!.type).toBe("rename");
    const r = d.rules[0] as { type: "rename"; from: string; to: string };
    expect(r.from).toBe("oldFn");
    expect(r.to).toBe("newFn");
  });

  test("parses move rule", () => {
    const src = `migrate "reorg" in TypeScript {
  move: "src/old.ts" -> "src/new.ts"
}`;
    const d = firstDecl(src) as AST.MigrateDecl;
    const r = d.rules[0] as { type: "move"; from: string; to: string };
    expect(r.type).toBe("move");
    expect(r.from).toBe("src/old.ts");
    expect(r.to).toBe("src/new.ts");
  });

  test("parses multiple rules", () => {
    const src = `migrate "big move" in Go {
  rename: OldName -> NewName
  remove: deprecated oldHelper()
  scope: "**/*.go"
}`;
    const d = firstDecl(src) as AST.MigrateDecl;
    expect(d.rules.length).toBe(2);
  });
});

// ── guard ─────────────────────────────────────────────────────────────────

describe("guard", () => {
  test("parses fn_exists assert", () => {
    const src = `guard "api-contract" {
  scope:   "src/**"
  assert:  fn getUser() exists
  on_fail: block_apply, warn
}`;
    const d = firstDecl(src) as AST.GuardDecl;
    expect(d.kind).toBe("GuardDecl");
    expect(d.asserts[0]!.type).toBe("fn_exists");
    expect(d.onFail).toContain("block_apply");
    expect(d.onFail).toContain("warn");
  });

  test("parses no_import_from assert", () => {
    const src = `guard "no-admin-leak" {
  scope:   "src/**"
  assert:  no file imports from "../admin"
  on_fail: block_apply
}`;
    const d = firstDecl(src) as AST.GuardDecl;
    const a = d.asserts[0] as AST.AssertExpr & { type: "no_import_from" };
    expect(a.type).toBe("no_import_from");
    expect(a.path).toBe("../admin");
  });
});

// ── trace ─────────────────────────────────────────────────────────────────

describe("trace", () => {
  test("parses trace block", () => {
    const src = `trace userInput in "src/" {
  language: TypeScript
  origin:   req.body.password
  follow:   assignments, function_calls, returns
  report:   full_chain
  flag:     "any path that reaches console.log"
}`;
    const d = firstDecl(src) as AST.TraceDecl;
    expect(d.kind).toBe("TraceDecl");
    expect(d.ident).toBe("userInput");
    expect(d.dir).toBe("src/");
    expect(d.follow).toContain("assignments");
    expect(d.follow).toContain("function_calls");
    expect(d.follow).toContain("returns");
    expect(d.report).toBe("full_chain");
    expect(d.flags[0]).toContain("console.log");
  });
});

// ── apply ─────────────────────────────────────────────────────────────────

describe("apply", () => {
  test("parses apply fix to project", () => {
    const src = `apply fix nullCheck to project`;
    const d = firstDecl(src) as AST.ApplyStmt;
    expect(d.kind).toBe("ApplyStmt");
    expect(d.applyKind).toBe("fix");
    expect(d.name).toBe("nullCheck");
    expect(d.target.type).toBe("project");
    expect(d.preview).toBe(false);
  });

  test("parses apply fix to file with preview", () => {
    const src = `apply fix nullCheck to file "src/main.ts" preview`;
    const d = firstDecl(src) as AST.ApplyStmt;
    expect((d.target as any).path).toBe("src/main.ts");
    expect(d.preview).toBe(true);
  });
});

// ── import ────────────────────────────────────────────────────────────────

describe("import", () => {
  test("parses import statement", () => {
    const src = `import guards from "./guards.delta"`;
    const d = firstDecl(src) as AST.ImportStmt;
    expect(d.kind).toBe("ImportStmt");
    expect(d.alias).toBe("guards");
    expect(d.path).toBe("./guards.delta");
  });
});

// ── multi-decl programs ───────────────────────────────────────────────────

describe("multi-declaration programs", () => {
  test("parses multiple constructs in one file", () => {
    const src = `
fix noNull { pattern: { x == null } replace: { x === null } scope: "**/*.ts" }
guard "safety" { scope: "src/**" assert: fn main() exists on_fail: warn }
apply fix noNull to project
`;
    const prog = parseStr(src);
    expect(prog.decls).toHaveLength(3);
    expect(prog.decls[0]!.kind).toBe("FixDecl");
    expect(prog.decls[1]!.kind).toBe("GuardDecl");
    expect(prog.decls[2]!.kind).toBe("ApplyStmt");
  });
});

// ── error cases ───────────────────────────────────────────────────────────

describe("error handling", () => {
  test("unknown top-level token throws ParseError", () => {
    expect(() => parseStr("badKeyword { }")).toThrow(ParseError);
  });

  test("ParseError includes token position", () => {
    try {
      parseStr("badKeyword");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).tok).toBeDefined();
    }
  });
});
