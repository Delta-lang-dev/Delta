// __tests__/emitter.test.ts
// ─── Delta Emitter Integration Tests ─────────────────────────────────────
// These tests exercise the full pipeline: source → tokens → AST → resolved → emitted.
// We use real file I/O in a temp directory so the emitter can read/write files.

import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import { tokenise }  from "../src/lexer";
import { parse }     from "../src/parser";
import { resolve }   from "../src/resolver";
import { emit }      from "../src/emitter";

// ── Test workspace ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delta-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function writeFile(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function readFile(name: string): string {
  return fs.readFileSync(path.join(tmpDir, name), "utf8");
}

async function run(deltaSource: string, preview = false) {
  const tokens = tokenise(deltaSource);
  const ast    = parse(tokens);
  const { order, registry, hasErrors, diagnostics } = resolve(ast, tmpDir);
  if (hasErrors) throw new Error(`Resolver errors: ${diagnostics.map(d=>d.message).join("; ")}`);
  return emit(order, registry, { cwd: tmpDir, preview, verbose: false });
}

// ── patch ─────────────────────────────────────────────────────────────────

describe("emit — patch", () => {
  test("patches a TypeScript function body", async () => {
    writeFile("app.ts", `
export function greet(name: string): string {
  return "Hello " + name;
}
`);
    const src = `patch "app.ts" in TypeScript {
  find fn greet() {}
  replace with { return \`Hi, \${name}!\`; }
  why: "modernise greeting"
}`;
    const results = await run(src);
    expect(results).toHaveLength(1);
    expect(results[0]!.applied).toBe(true);
    expect(readFile("app.ts")).toContain("Hi,");
    expect(readFile("app.ts")).not.toContain("Hello");
  });

  test("preview mode does not write file", async () => {
    const original = "export function foo() { return 1; }";
    writeFile("foo.ts", original);
    const src = `patch "foo.ts" in TypeScript {
  find fn foo() {}
  replace with { return 99; }
}`;
    const results = await run(src, true);
    expect(results[0]!.applied).toBe(false);
    expect(readFile("foo.ts")).toBe(original);
  });

  test("patch on missing file produces no results", async () => {
    const src = `patch "missing.ts" in TypeScript {
  find fn ghost() {}
  replace with { return 0; }
}`;
    // resolver warns but does not error; emitter skips missing files
    const tokens = tokenise(src);
    const ast    = parse(tokens);
    const { order, registry } = resolve(ast, tmpDir);
    const results = await emit(order, registry, { cwd: tmpDir, preview: false, verbose: false });
    expect(results).toHaveLength(0);
  });
});

// ── fix + apply ───────────────────────────────────────────────────────────

describe("emit — fix + apply", () => {
  test("applies a fix across all matching files", async () => {
    writeFile("a.ts", "if (x == null) return;");
    writeFile("b.ts", "if (y == null) return;");
    writeFile("c.py", "if z == None: pass");   // should not match *.ts scope

    const src = `
fix strictNull {
  pattern: { == null }
  replace: { === null }
  scope:   "**/*.ts"
}
apply fix strictNull to project
`;
    const results = await run(src);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(readFile("a.ts")).toContain("=== null");
    expect(readFile("b.ts")).toContain("=== null");
    // Python file should be untouched
    expect(readFile("c.py")).not.toContain("=== null");
  });

  test("fix with no matches produces no results", async () => {
    writeFile("clean.ts", "const x = 1;");
    const src = `
fix unused {
  pattern: { WILL_NOT_MATCH_XYZ }
  replace: { nothing }
  scope:   "**/*.ts"
}
apply fix unused to project
`;
    const results = await run(src);
    expect(results).toHaveLength(0);
  });

  test("preview mode does not write fixed files", async () => {
    const original = "if (x == null) return;";
    writeFile("test.ts", original);
    const src = `
fix sNull { pattern: { == null } replace: { === null } scope: "**/*.ts" }
apply fix sNull to project
`;
    const results = await run(src, true);
    expect(results.every(r => !r.applied)).toBe(true);
    expect(readFile("test.ts")).toBe(original);
  });
});

// ── intent ────────────────────────────────────────────────────────────────

describe("emit — intent", () => {
  test("injects code at function entry", async () => {
    writeFile("service.ts", `
export function processOrder(id: string) {
  return fetch(\`/api/orders/\${id}\`);
}
`);
    const src = `
intent "add audit logging" {
  scope:    "**/*.ts"
  language: TypeScript
  inject:   { logger.audit("fn called"); }
  where:    function_entry
}
`;
    const results = await run(src);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(readFile("service.ts")).toContain("logger.audit");
  });
});

// ── migrate ───────────────────────────────────────────────────────────────

describe("emit — migrate (via apply)", () => {
  test("renames a symbol across TypeScript files", async () => {
    writeFile("api.ts", `
import { fetchUser } from "./db";
const user = fetchUser(id);
export { fetchUser };
`);
    const src = `
migrate "rename fetchUser" in TypeScript {
  rename: fetchUser -> getUser
  scope:  "**/*.ts"
}
apply migrate "rename fetchUser" to project
`;
    const results = await run(src);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const content = readFile("api.ts");
    expect(content).toContain("getUser");
    expect(content).not.toContain("fetchUser");
  });
});

// ── diff output ───────────────────────────────────────────────────────────

describe("emit — diff output", () => {
  test("result includes before, after, and diff", async () => {
    writeFile("x.ts", "if (a == null) {}");
    const src = `
fix eq { pattern: { == null } replace: { === null } scope: "**/*.ts" }
apply fix eq to project
`;
    const results = await run(src);
    expect(results[0]!.before).toContain("== null");
    expect(results[0]!.after).toContain("=== null");
    expect(results[0]!.diff).toContain("---");
  });
});

// ── full pipeline ─────────────────────────────────────────────────────────

describe("full pipeline — compile() convenience function", () => {
  test("compile() chains all stages correctly", async () => {
    const { compile } = await import("../src/index");
    writeFile("target.ts", "if (x == null) return null;");
    const src = `
fix strictEq { pattern: { == null } replace: { === null } scope: "**/*.ts" }
apply fix strictEq to project
`;
    const { results, hasErrors } = await compile(src, { cwd: tmpDir });
    expect(hasErrors).toBe(false);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(readFile("target.ts")).toContain("=== null");
  });
});
