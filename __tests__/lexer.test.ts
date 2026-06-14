// __tests__/lexer.test.ts
// ─── Delta Lexer Unit Tests ───────────────────────────────────────────────

import { tokenise, LexError, Token, TokKind } from "../src/lexer";

// ── Helpers ───────────────────────────────────────────────────────────────

const kinds = (src: string): TokKind[] =>
  tokenise(src).map(t => t.kind);

const vals = (src: string): string[] =>
  tokenise(src).map(t => t.value);

// ── Keywords ──────────────────────────────────────────────────────────────

describe("keywords", () => {
  const kws: [string, TokKind][] = [
    ["patch",    "KW_PATCH"],
    ["fix",      "KW_FIX"],
    ["intent",   "KW_INTENT"],
    ["migrate",  "KW_MIGRATE"],
    ["guard",    "KW_GUARD"],
    ["trace",    "KW_TRACE"],
    ["apply",    "KW_APPLY"],
    ["import",   "KW_IMPORT"],
    ["from",     "KW_FROM"],
    ["in",       "KW_IN"],
    ["with",     "KW_WITH"],
    ["to",       "KW_TO"],
    ["find",     "KW_FIND"],
    ["replace",  "KW_REPLACE"],
    ["why",      "KW_WHY"],
    ["scope",    "KW_SCOPE"],
    ["language", "KW_LANGUAGE"],
    ["inject",   "KW_INJECT"],
    ["where",    "KW_WHERE"],
    ["assert",   "KW_ASSERT"],
    ["on_fail",  "KW_ON_FAIL"],
    ["follow",   "KW_FOLLOW"],
    ["report",   "KW_REPORT"],
    ["flag",     "KW_FLAG"],
    ["severity", "KW_SEVERITY"],
    ["note",     "KW_NOTE"],
    ["pattern",  "KW_PATTERN"],
    ["rename",   "KW_RENAME"],
    ["move",     "KW_MOVE"],
    ["remove",   "KW_REMOVE"],
    ["preserve", "KW_PRESERVE"],
    ["preview",  "KW_PREVIEW"],
    ["fn",       "KW_FN"],
    ["all",      "KW_ALL"],
    ["no",       "KW_NO"],
    ["block",    "KW_BLOCK"],
  ];

  test.each(kws)('"%s" tokenises to %s', (kw, expected) => {
    expect(kinds(kw)).toEqual([expected, "EOF"]);
  });
});

// ── Identifiers ───────────────────────────────────────────────────────────

describe("identifiers", () => {
  test("simple ident", () => {
    expect(kinds("myVar")).toEqual(["IDENT", "EOF"]);
  });

  test("ident with underscores and digits", () => {
    expect(kinds("my_var_2")).toEqual(["IDENT", "EOF"]);
  });

  test("ident does not capture trailing punctuation", () => {
    const toks = tokenise("foo:");
    expect(toks[0]!.kind).toBe("IDENT");
    expect(toks[0]!.value).toBe("foo");
    expect(toks[1]!.kind).toBe("COLON");
  });
});

// ── Strings ───────────────────────────────────────────────────────────────

describe("string literals", () => {
  test("basic string", () => {
    const toks = tokenise('"hello world"');
    expect(toks[0]!.kind).toBe("STRING");
    expect(toks[0]!.value).toBe("hello world");
  });

  test("string with escape sequence", () => {
    const toks = tokenise('"say \\"hi\\""');
    expect(toks[0]!.kind).toBe("STRING");
  });

  test("unterminated string throws LexError", () => {
    expect(() => tokenise('"unterminated')).toThrow(LexError);
  });
});

// ── Punctuation ───────────────────────────────────────────────────────────

describe("punctuation", () => {
  test("arrow", () => expect(kinds("->")).toEqual(["ARROW", "EOF"]));
  test("colon", () => expect(kinds(":")).toEqual(["COLON", "EOF"]));
  test("comma", () => expect(kinds(",")).toEqual(["COMMA", "EOF"]));
  test("dot",   () => expect(kinds(".")).toEqual(["DOT", "EOF"]));
  test("lparen",() => expect(kinds("(")).toEqual(["LPAREN", "EOF"]));
  test("rparen",() => expect(kinds(")")).toEqual(["RPAREN", "EOF"]));
  test("lbrace standalone", () => expect(kinds("{")).toEqual(["LBRACE", "EOF"]));
  test("rbrace", () => expect(kinds("}")).toEqual(["RBRACE", "EOF"]));
});

// ── Raw source blocks ─────────────────────────────────────────────────────

describe("raw source blocks", () => {
  test("find { body } produces RAW_SOURCE", () => {
    const toks = tokenise("find { const x = 1; }");
    const raw  = toks.find(t => t.kind === "RAW_SOURCE");
    expect(raw).toBeDefined();
    expect(raw!.value).toBe("const x = 1;");
  });

  test("replace { body } produces RAW_SOURCE", () => {
    const toks = tokenise("replace { return 42; }");
    const raw  = toks.find(t => t.kind === "RAW_SOURCE");
    expect(raw!.value).toBe("return 42;");
  });

  test("nested braces in raw source are preserved", () => {
    const toks = tokenise("find { if (x) { return 1; } }");
    const raw  = toks.find(t => t.kind === "RAW_SOURCE");
    expect(raw!.value).toBe("if (x) { return 1; }");
  });

  test("unterminated raw block throws LexError", () => {
    expect(() => tokenise("find { unclosed")).toThrow(LexError);
  });

  test("inject { body } produces RAW_SOURCE", () => {
    const toks = tokenise("inject { console.log('hi'); }");
    const raw  = toks.find(t => t.kind === "RAW_SOURCE");
    expect(raw!.value).toContain("console.log");
  });

  test("with { body } produces RAW_SOURCE", () => {
    const toks = tokenise("with { return x + 1; }");
    const raw  = toks.find(t => t.kind === "RAW_SOURCE");
    expect(raw!.value).toBe("return x + 1;");
  });

  test("standalone { } is LBRACE / RBRACE not RAW_SOURCE", () => {
    const toks = tokenise("guard { }");
    expect(toks.some(t => t.kind === "LBRACE")).toBe(true);
    expect(toks.some(t => t.kind === "RBRACE")).toBe(true);
    expect(toks.some(t => t.kind === "RAW_SOURCE")).toBe(false);
  });
});

// ── Comments ──────────────────────────────────────────────────────────────

describe("comments", () => {
  test("line comments are stripped from output", () => {
    const toks = tokenise("// this is a comment\npatch");
    expect(toks.every(t => t.kind !== "COMMENT")).toBe(true);
    expect(toks[0]!.kind).toBe("KW_PATCH");
  });

  test("inline comment is stripped", () => {
    const k = kinds("fix myFix // inline comment\n{");
    expect(k).toContain("KW_FIX");
    expect(k).toContain("IDENT");
    expect(k).not.toContain("COMMENT");
  });
});

// ── Position tracking ─────────────────────────────────────────────────────

describe("position tracking", () => {
  test("first token is at line 1 col 1", () => {
    const toks = tokenise("patch");
    expect(toks[0]!.line).toBe(1);
  });

  test("token after newline is on line 2", () => {
    const toks = tokenise("patch\nfix");
    const fix  = toks.find(t => t.kind === "KW_FIX")!;
    expect(fix.line).toBe(2);
  });
});

// ── Full construct tokenisation ───────────────────────────────────────────

describe("full construct tokenisation", () => {
  test("patch declaration tokenises correctly", () => {
    const src = `patch "src/index.ts" in TypeScript {
  find fn getUser() {}
  replace with { return null; }
  why: "simplify"
}`;
    const k = kinds(src);
    expect(k).toContain("KW_PATCH");
    expect(k).toContain("STRING");
    expect(k).toContain("KW_IN");
    expect(k).toContain("IDENT");       // TypeScript
    expect(k).toContain("KW_FIND");
    expect(k).toContain("KW_FN");
    expect(k).toContain("KW_REPLACE");
    expect(k).toContain("KW_WITH");
    expect(k).toContain("RAW_SOURCE");  // replace body
    expect(k).toContain("KW_WHY");
    expect(k).toContain("EOF");
  });

  test("all six constructs tokenise without errors", () => {
    const sources = [
      `patch "f.ts" in TypeScript { find fn foo() {} replace with { } }`,
      `fix nullCheck { pattern: { x == null } replace: { x === null } scope: "**/*.ts" }`,
      `intent "add logging" { scope: "src/**" language: TypeScript inject: { console.log("hi"); } where: function_entry }`,
      `migrate "v1 to v2" in TypeScript { rename: oldFn -> newFn }`,
      `guard "safety" { scope: "src/**" assert: fn main() exists on_fail: warn }`,
      `trace userInput in "src/" { language: TypeScript origin: req.body follow: assignments report: full_chain }`,
    ];

    for (const src of sources) {
      expect(() => tokenise(src)).not.toThrow();
    }
  });
});

// ── Error cases ───────────────────────────────────────────────────────────

describe("error handling", () => {
  test("unexpected character throws LexError", () => {
    expect(() => tokenise("patch @bad")).toThrow(LexError);
  });

  test("LexError includes line and col", () => {
    try {
      tokenise("@");
    } catch (e) {
      expect(e).toBeInstanceOf(LexError);
      expect((e as LexError).line).toBe(1);
      expect((e as LexError).col).toBeDefined();
    }
  });
});
