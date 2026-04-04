// src/parser.ts
// ─── Delta Parser ─────────────────────────────────────────────────────────
// Recursive descent parser. Consumes a token stream from the lexer and
// builds a fully typed AST. Each parse* method handles one grammar rule.

import { Token, TokKind, LexError } from "./lexer";
import * as AST from "./ast";

// ── Error type ─────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(
    msg: string,
    public tok: Token
  ) {
    super(
      `Parse error at ${tok.line}:${tok.col} — ${msg} (got '${tok.value}')`
    );
    this.name = "ParseError";
  }
}

// ── Parser class ───────────────────────────────────────────────────────────

export class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  // ── Low-level helpers ───────────────────────────────────────────────────

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1]!;
  }

  private cur(): Token {
    return this.peek();
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return tok!;
  }

  private at(kind: TokKind): boolean {
    return this.cur().kind === kind;
  }

  private atValue(value: string): boolean {
    return this.cur().value === value;
  }

  // Consume a token of the expected kind or throw a clear error.
  private expect(kind: TokKind): Token {
    if (!this.at(kind)) {
      throw new ParseError(`Expected ${kind}`, this.cur());
    }
    return this.advance();
  }

  // Consume and return the value of a token of the expected kind.
  private eat(kind: TokKind): string {
    return this.expect(kind).value;
  }

  // Consume a token of the given kind only if it is present.
  // Returns the value if consumed, undefined otherwise.
  private maybeEat(kind: TokKind): string | undefined {
    if (this.at(kind)) return this.advance().value;
    return undefined;
  }

  // Build a Span from the current token position.
  private spanHere(): AST.Span {
    const t = this.cur();
    return {
      start: { line: t.line, col: t.col },
      end:   { line: t.line, col: t.col },
    };
  }

  // ── Entry point ─────────────────────────────────────────────────────────

  parse(): AST.Program {
    const span  = this.spanHere();
    const decls: AST.TopDecl[] = [];

    while (!this.at("EOF")) {
      decls.push(this.parseTopDecl());
    }

    return { decls, span };
  }

  // ── Top-level dispatch ──────────────────────────────────────────────────

  private parseTopDecl(): AST.TopDecl {
    switch (this.cur().kind) {
      case "KW_PATCH":   return this.parsePatch();
      case "KW_FIX":     return this.parseFix();
      case "KW_INTENT":  return this.parseIntent();
      case "KW_MIGRATE": return this.parseMigrate();
      case "KW_GUARD":   return this.parseGuard();
      case "KW_TRACE":   return this.parseTrace();
      case "KW_APPLY":   return this.parseApply();
      case "KW_IMPORT":  return this.parseImport();
      default:
        throw new ParseError(
          "Expected a top-level declaration (patch, fix, intent, migrate, guard, trace, apply, or import)",
          this.cur()
        );
    }
  }

  // ── patch ────────────────────────────────────────────────────────────────
  //
  // patch "file.ts" in TypeScript {
  //   find fn functionName(params) { oldBody }
  //   replace with { newBody }
  //   why: "reason"
  // }

  private parsePatch(): AST.PatchDecl {
    const span = this.spanHere();
    this.expect("KW_PATCH");

    const file = this.eat("STRING");

    this.expect("KW_IN");
    const lang = this.eat("IDENT") as AST.LangId;

    this.expect("LBRACE");

    this.expect("KW_FIND");
    const find = this.parseFindClause();

    this.expect("KW_REPLACE");
    this.maybeEat("KW_WITH");
    const replaceBody = this.eat("RAW_SOURCE");

    let why: string | undefined;
    if (this.at("KW_WHY")) {
      this.advance();
      this.expect("COLON");
      why = this.eat("STRING");
    }

    this.expect("RBRACE");

    return {
      kind:    "PatchDecl",
      span,
      file,
      lang,
      find,
      replace: { body: replaceBody },
      why,
    };
  }

  private parseFindClause(): AST.FindClause {
    // find fn functionName(params) { optionalBody }
    if (this.at("KW_FN")) {
      this.advance();
      const name = this.eat("IDENT");

      // Consume optional parameter list: (anything)
      if (this.at("LPAREN")) {
        this.advance();
        let depth = 1;
        while (!this.at("EOF") && depth > 0) {
          if (this.at("LPAREN"))      depth++;
          else if (this.at("RPAREN")) depth--;
          if (depth > 0) this.advance();
        }
        this.expect("RPAREN");
      }

      // Optional body block
      let body: string | undefined;
      if (this.at("RAW_SOURCE")) {
        body = this.advance().value;
      }

      return { type: "fn", name, body };
    }

    // find block "label" { body }
    if (this.at("KW_BLOCK")) {
      this.advance();
      const label = this.eat("STRING");
      const body  = this.eat("RAW_SOURCE");
      return { type: "block", label, body };
    }

    // find line ~= "regex"  (line-based matching)
    // 'line' is parsed as IDENT here since it is not a keyword
    if (this.atValue("line")) {
      this.advance();
      this.maybeEat("IDENT"); // consume optional ~= operator as IDENT
      const regex = this.eat("STRING");
      return { type: "line", regex };
    }

    throw new ParseError(
      "Expected find clause: 'fn <name>', 'block <label>', or 'line ~= <regex>'",
      this.cur()
    );
  }

  // ── fix ──────────────────────────────────────────────────────────────────
  //
  // fix name {
  //   pattern: { old code }
  //   replace: { new code }
  //   scope:   "**/*.ts"
  //   severity: bug
  //   note:    "explanation"
  // }

  private parseFix(): AST.FixDecl {
    const span = this.spanHere();
    this.expect("KW_FIX");
    const name = this.eat("IDENT");
    this.expect("LBRACE");

    this.expect("KW_PATTERN");
    this.expect("COLON");
    const pattern = this.eat("RAW_SOURCE");
    this.maybeEat("COMMA");

    this.expect("KW_REPLACE");
    this.expect("COLON");
    const replace = this.eat("RAW_SOURCE");
    this.maybeEat("COMMA");

    this.expect("KW_SCOPE");
    this.expect("COLON");
    const scope = this.eat("STRING");
    this.maybeEat("COMMA");

    let severity: AST.SeverityLevel | undefined;
    if (this.at("KW_SEVERITY")) {
      this.advance();
      this.expect("COLON");
      severity = this.eat("IDENT") as AST.SeverityLevel;
      this.maybeEat("COMMA");
    }

    let note: string | undefined;
    if (this.at("KW_NOTE")) {
      this.advance();
      this.expect("COLON");
      note = this.eat("STRING");
    }

    this.expect("RBRACE");

    return { kind: "FixDecl", span, name, pattern, replace, scope, severity, note };
  }

  // ── intent ───────────────────────────────────────────────────────────────
  //
  // intent "description" {
  //   scope:    "src/**"
  //   language: TypeScript
  //   preserve: "existing error handling"
  //   inject:   { code to inject }
  //   where:    function_entry
  //   guard:    "no duplicates"
  // }

  private parseIntent(): AST.IntentDecl {
    const span = this.spanHere();
    this.expect("KW_INTENT");
    const label = this.eat("STRING");
    this.expect("LBRACE");

    let scope    = "**/*";
    let language: AST.LangId = "TypeScript";
    let preserve: string | undefined;
    let inject   = "";
    let where: AST.InjectSite = "function_entry";
    let guard: string | undefined;

    while (!this.at("RBRACE") && !this.at("EOF")) {
      if (this.at("KW_SCOPE")) {
        this.advance(); this.expect("COLON");
        scope = this.eat("STRING");

      } else if (this.at("KW_LANGUAGE")) {
        this.advance(); this.expect("COLON");
        language = this.eat("IDENT") as AST.LangId;

      } else if (this.at("KW_PRESERVE")) {
        this.advance(); this.expect("COLON");
        preserve = this.eat("STRING");

      } else if (this.at("KW_INJECT")) {
        this.advance(); this.expect("COLON");
        inject = this.eat("RAW_SOURCE");

      } else if (this.at("KW_WHERE")) {
        this.advance(); this.expect("COLON");
        const w = this.eat("IDENT");
        if (w === "before" || w === "after") {
          const target = this.eat("IDENT");
          where = { [w]: target } as AST.InjectSite;
        } else {
          where = w as AST.InjectSite;
        }

      } else if (this.at("KW_GUARD")) {
        this.advance(); this.expect("COLON");
        guard = this.eat("STRING");

      } else {
        // Unknown clause — skip to avoid infinite loop
        this.advance();
      }

      this.maybeEat("COMMA");
    }

    this.expect("RBRACE");

    return { kind: "IntentDecl", span, label, scope, language, preserve, inject, where, guard };
  }

  // ── migrate ──────────────────────────────────────────────────────────────
  //
  // migrate "lib v1 -> v2" in TypeScript {
  //   rename: oldFn() -> newFn()
  //   move:   "old/path" -> "new/path"
  //   replace: { old } with { new }
  //   remove: deprecated deprecatedFn()
  //   scope:  "**/*.ts"
  // }

  private parseMigrate(): AST.MigrateDecl {
    const span = this.spanHere();
    this.expect("KW_MIGRATE");
    const label = this.eat("STRING");
    this.expect("KW_IN");
    const lang = this.eat("IDENT") as AST.LangId;
    this.expect("LBRACE");

    const rules: AST.MigrateRule[] = [];
    let scope = "**/*";

    while (!this.at("RBRACE") && !this.at("EOF")) {

      if (this.at("KW_RENAME")) {
        this.advance(); this.expect("COLON");
        const from = this.parseRawOrIdent();
        this.expect("ARROW");
        const to = this.parseRawOrIdent();
        rules.push({ type: "rename", from, to });

      } else if (this.at("KW_MOVE")) {
        this.advance(); this.expect("COLON");
        const from = this.eat("STRING");
        this.expect("ARROW");
        const to = this.eat("STRING");
        rules.push({ type: "move", from, to });

      } else if (this.at("KW_REPLACE")) {
        this.advance(); this.expect("COLON");
        const from = this.parseRawOrIdent();
        this.maybeEat("KW_WITH");
        const to = this.parseRawOrIdent();
        rules.push({ type: "replace", from, to });

      } else if (this.at("KW_REMOVE")) {
        this.advance(); this.expect("COLON");
        // 'deprecated' is parsed as IDENT — skip it
        if (this.atValue("deprecated")) this.advance();
        const target = this.parseRawOrIdent();
        rules.push({ type: "remove", target });

      } else if (this.at("KW_SCOPE")) {
        this.advance(); this.expect("COLON");
        scope = this.eat("STRING");

      } else {
        this.advance();
      }

      this.maybeEat("COMMA");
    }

    this.expect("RBRACE");

    return { kind: "MigrateDecl", span, label, lang, scope, rules };
  }

  // Helper: accept either a RAW_SOURCE block or fall back to an IDENT
  private parseRawOrIdent(): string {
    if (this.at("RAW_SOURCE")) return this.advance().value;
    if (this.at("STRING"))     return this.advance().value;
    if (this.at("IDENT"))      return this.advance().value;
    throw new ParseError("Expected a value (code block, string, or identifier)", this.cur());
  }

  // ── guard ────────────────────────────────────────────────────────────────
  //
  // guard "label" {
  //   scope:   "src/**"
  //   assert:  fn functionName() exists
  //   assert:  no file imports from "../admin"
  //   on_fail: block_apply, show_diff
  // }

  private parseGuard(): AST.GuardDecl {
    const span = this.spanHere();
    this.expect("KW_GUARD");
    const label = this.eat("STRING");
    this.expect("LBRACE");

    let scope = "**/*";
    const asserts: AST.AssertExpr[] = [];
    const onFail:  AST.FailAction[] = [];

    while (!this.at("RBRACE") && !this.at("EOF")) {

      if (this.at("KW_SCOPE")) {
        this.advance(); this.expect("COLON");
        scope = this.eat("STRING");

      } else if (this.at("KW_ASSERT")) {
        this.advance(); this.expect("COLON");
        asserts.push(this.parseAssertExpr());

      } else if (this.at("KW_ON_FAIL")) {
        this.advance(); this.expect("COLON");
        // Collect one or more comma-separated fail actions
        while (this.at("IDENT")) {
          onFail.push(this.advance().value as AST.FailAction);
          this.maybeEat("COMMA");
        }

      } else {
        this.advance();
      }

      this.maybeEat("COMMA");
    }

    this.expect("RBRACE");

    return { kind: "GuardDecl", span, label, scope, asserts, onFail };
  }

  private parseAssertExpr(): AST.AssertExpr {
    // assert: fn functionName() exists
    if (this.at("KW_FN")) {
      this.advance();
      let sig = "";
      // Collect everything up to 'exists'
      while (!this.at("EOF") && !this.atValue("exists") && !this.at("KW_ASSERT") && !this.at("RBRACE")) {
        sig += this.advance().value + " ";
      }
      if (this.atValue("exists")) this.advance();
      return { type: "fn_exists", sig: sig.trim() };
    }

    // assert: no file imports from "../path"
    // assert: no file contains "text" near "other"
    // assert: no raw f-string SQL queries exist
    if (this.at("KW_NO")) {
      this.advance();

      if (this.atValue("file")) {
        this.advance(); // consume 'file'

        if (this.atValue("imports")) {
          this.advance(); // consume 'imports'
          this.maybeEat("KW_FROM");
          const path = this.eat("STRING");
          return { type: "no_import_from", path };
        }

        if (this.atValue("contains")) {
          this.advance(); // consume 'contains'
          const text = this.eat("STRING");
          // consume 'near'
          if (this.atValue("near")) this.advance();
          const near = this.eat("STRING");
          return { type: "no_contains", text, near };
        }
      }

      if (this.atValue("raw")) {
        // consume remaining words of the clause
        while (!this.at("EOF") && !this.at("KW_ASSERT") && !this.at("RBRACE") && !this.at("KW_ON_FAIL")) {
          this.advance();
        }
        return { type: "no_raw_sql" };
      }

      // Fallthrough — consume remaining tokens as raw expr
      let expr = "no ";
      while (!this.at("EOF") && !this.at("KW_ASSERT") && !this.at("RBRACE") && !this.at("KW_ON_FAIL")) {
        expr += this.advance().value + " ";
      }
      return { type: "raw", expr: expr.trim() };
    }

    // assert: all exported fns have return types
    if (this.at("KW_ALL")) {
      this.advance();
      const selector = this.at("IDENT") ? this.advance().value : "";
      let pred = "";
      while (!this.at("EOF") && !this.at("KW_ASSERT") && !this.at("RBRACE") && !this.at("KW_ON_FAIL")) {
        pred += this.advance().value + " ";
      }
      return { type: "all_have", selector, pred: pred.trim() };
    }

    // Raw string assertion fallback
    if (this.at("STRING")) {
      return { type: "raw", expr: this.advance().value };
    }

    // Unknown — consume and return raw
    let expr = "";
    while (!this.at("EOF") && !this.at("KW_ASSERT") && !this.at("RBRACE") && !this.at("KW_ON_FAIL")) {
      expr += this.advance().value + " ";
    }
    return { type: "raw", expr: expr.trim() };
  }

  // ── trace ────────────────────────────────────────────────────────────────
  //
  // trace variableName in "src/" {
  //   language: TypeScript
  //   origin:   req.body.password
  //   follow:   assignments, function_calls, returns
  //   report:   full_chain
  //   flag:     "any path that reaches console.log"
  // }

  private parseTrace(): AST.TraceDecl {
    const span = this.spanHere();
    this.expect("KW_TRACE");
    const ident = this.eat("IDENT");
    this.expect("KW_IN");
    const dir = this.eat("STRING");
    this.expect("LBRACE");

    let language: AST.LangId  = "TypeScript";
    let origin                 = "";
    const follow: AST.FollowKind[] = [];
    let report: AST.ReportKind = "full_chain";
    const flags: string[]      = [];

    while (!this.at("RBRACE") && !this.at("EOF")) {

      if (this.at("KW_LANGUAGE")) {
        this.advance(); this.expect("COLON");
        language = this.eat("IDENT") as AST.LangId;

      } else if (this.atValue("origin")) {
        this.advance(); this.expect("COLON");
        origin = this.at("RAW_SOURCE")
          ? this.advance().value
          : this.eat("STRING");

      } else if (this.at("KW_FOLLOW")) {
        this.advance(); this.expect("COLON");
        follow.push(this.eat("IDENT") as AST.FollowKind);
        while (this.at("COMMA")) {
          this.advance();
          if (this.at("IDENT")) follow.push(this.eat("IDENT") as AST.FollowKind);
        }

      } else if (this.at("KW_REPORT")) {
        this.advance(); this.expect("COLON");
        report = this.eat("IDENT") as AST.ReportKind;

      } else if (this.at("KW_FLAG")) {
        this.advance(); this.expect("COLON");
        flags.push(this.eat("STRING"));

      } else {
        this.advance();
      }

      this.maybeEat("COMMA");
    }

    this.expect("RBRACE");

    return { kind: "TraceDecl", span, ident, dir, language, origin, follow, report, flags };
  }

  // ── apply ────────────────────────────────────────────────────────────────
  //
  // apply fix   name to project
  // apply fix   name to file "path"
  // apply fix   name to dir  "path" preview
  // apply migrate "label" to project preview

  private parseApply(): AST.ApplyStmt {
    const span = this.spanHere();
    this.expect("KW_APPLY");

    const applyKind = this.eat("IDENT") as AST.ApplyKind;

    // Name can be a bare identifier or a quoted string
    const name = this.at("STRING")
      ? this.advance().value
      : this.eat("IDENT");

    let target: AST.ApplyTarget = { type: "project" };

    if (this.at("KW_TO")) {
      this.advance();
      const dest = this.cur().value;

      if (dest === "project") {
        this.advance();
        target = { type: "project" };
      } else if (dest === "file") {
        this.advance();
        target = { type: "file", path: this.eat("STRING") };
      } else if (dest === "dir") {
        this.advance();
        target = { type: "dir", path: this.eat("STRING") };
      }
    }

    const preview = this.at("KW_PREVIEW") ? (this.advance(), true) : false;

    return { kind: "ApplyStmt", span, applyKind, name, target, preview };
  }

  // ── import ───────────────────────────────────────────────────────────────
  //
  // import guards from "./guards.delta"

  private parseImport(): AST.ImportStmt {
    const span = this.spanHere();
    this.expect("KW_IMPORT");
    const alias = this.eat("IDENT");
    this.expect("KW_FROM");
    const path = this.eat("STRING");
    return { kind: "ImportStmt", span, alias, path };
  }
}

// ── Convenience export ─────────────────────────────────────────────────────

export function parse(tokens: Token[]): AST.Program {
  return new Parser(tokens).parse();
}
