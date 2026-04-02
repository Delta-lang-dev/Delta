// src/parser.ts
// ─── Delta Parser ─────────────────────────────────────────────────────────
// Recursive descent. Each parse* method consumes tokens and returns an AST node.

import { Token, TokKind } from "./lexer";
import * as AST from "./ast";

export class ParseError extends Error {
  constructor(msg: string, public tok: Token) {
    super(\`Parse error at \${tok.line}:\${tok.col} — \${msg} (got '\${tok.value}')\`);
  }
}

export class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  // ── Helpers ────────────────────────────────────────────────────────────
  private peek(n = 0): Token { return this.tokens[this.pos + n]!; }
  private cur(): Token       { return this.peek(); }
  private adv(): Token       { return this.tokens[this.pos++]!; }
  private at(k: TokKind)     { return this.cur().kind === k; }

  private expect(k: TokKind): Token {
    if (!this.at(k)) throw new ParseError(\`Expected \${k}\`, this.cur());
    return this.adv();
  }
  private eat(k: TokKind): string {
    return this.expect(k).value;
  }
  private maybeEat(k: TokKind): string | undefined {
    if (this.at(k)) return this.adv().value;
  }

  private span(): AST.Span {
    const t = this.cur();
    return { start: { line: t.line, col: t.col },
             end:   { line: t.line, col: t.col } };
  }

  // ── Entry ──────────────────────────────────────────────────────────────
  parse(): AST.Program {
    const span  = this.span();
    const decls: AST.TopDecl[] = [];
    while (!this.at("EOF")) decls.push(this.parseTopDecl());
    return { decls, span };
  }

  private parseTopDecl(): AST.TopDecl {
    const k = this.cur().kind;
    if (k === "KW_PATCH")   return this.parsePatch();
    if (k === "KW_FIX")     return this.parseFix();
    if (k === "KW_INTENT")  return this.parseIntent();
    if (k === "KW_MIGRATE") return this.parseMigrate();
    if (k === "KW_GUARD")   return this.parseGuard();
    if (k === "KW_TRACE")   return this.parseTrace();
    if (k === "KW_APPLY")   return this.parseApply();
    if (k === "KW_IMPORT")  return this.parseImport();
    throw new ParseError("Expected a top-level declaration", this.cur());
  }

  // ── patch ──────────────────────────────────────────────────────────────
  private parsePatch(): AST.PatchDecl {
    const span = this.span();
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
      this.adv(); this.expect("COLON"); why = this.eat("STRING");
    }

    this.expect("RBRACE");
    return { kind: "PatchDecl", span, file, lang,
             find, replace: { body: replaceBody }, why };
  }

  private parseFindClause(): AST.FindClause {
    if (this.at("KW_FN")) {
      this.adv();
      const name = this.eat("IDENT");
      // consume optional param list
      if (this.at("LPAREN")) {
        this.adv();
        while (!this.at("RPAREN") && !this.at("EOF")) this.adv();
        this.expect("RPAREN");
      }
      let body: string | undefined;
      if (this.at("RAW_SOURCE")) body = this.adv().value;
      else if (this.at("LBRACE")) {
        this.adv(); body = this.eat("RAW_SOURCE"); this.expect("RBRACE");
      }
      return { type: "fn", name, body };
    }
    if (this.at("KW_BLOCK")) {
      this.adv();
      const label = this.eat("STRING");
      const body  = this.eat("RAW_SOURCE");
      return { type: "block", label, body };
    }
    // line
    this.adv(); // consume 'line' ident
    const regex = this.eat("STRING");
    return { type: "line", regex };
  }

  // ── fix ────────────────────────────────────────────────────────────────
  private parseFix(): AST.FixDecl {
    const span = this.span();
    this.expect("KW_FIX");
    const name = this.eat("IDENT");
    this.expect("LBRACE");

    this.expect("KW_PATTERN"); this.expect("COLON");
    const pattern = this.eat("RAW_SOURCE");
    this.maybeEat("COMMA");

    this.expect("KW_REPLACE"); this.expect("COLON");
    const replace = this.eat("RAW_SOURCE");
    this.maybeEat("COMMA");

    this.expect("KW_SCOPE"); this.expect("COLON");
    const scope = this.eat("STRING");
    this.maybeEat("COMMA");

    let severity: AST.SeverityLevel | undefined;
    if (this.at("KW_SEVERITY")) {
      this.adv(); this.expect("COLON");
      severity = this.eat("IDENT") as AST.SeverityLevel;
      this.maybeEat("COMMA");
    }

    let note: string | undefined;
    if (this.at("KW_NOTE")) {
      this.adv(); this.expect("COLON"); note = this.eat("STRING");
    }

    this.expect("RBRACE");
    return { kind: "FixDecl", span, name, pattern, replace, scope, severity, note };
  }

  // ── intent ─────────────────────────────────────────────────────────────
  private parseIntent(): AST.IntentDecl {
    const span = this.span();
    this.expect("KW_INTENT");
    const label = this.eat("STRING");
    this.expect("LBRACE");

    let scope = "**/*", language: AST.LangId = "TypeScript";
    let preserve: string | undefined, inject = "", where: AST.InjectSite = "function_entry";
    let guard: string | undefined;

    while (!this.at("RBRACE") && !this.at("EOF")) {
      const k = this.cur().kind;
      if (k === "KW_SCOPE")    { this.adv(); this.expect("COLON"); scope    = this.eat("STRING"); }
      else if (k === "KW_LANGUAGE") { this.adv(); this.expect("COLON"); language = this.eat("IDENT") as AST.LangId; }
      else if (k === "KW_PRESERVE"){ this.adv(); this.expect("COLON"); preserve = this.eat("STRING"); }
      else if (k === "KW_INJECT")  { this.adv(); this.expect("COLON"); inject   = this.eat("RAW_SOURCE"); }
      else if (k === "KW_WHERE")   { this.adv(); this.expect("COLON"); where    = this.eat("IDENT") as AST.InjectSite; }
      else if (k === "KW_GUARD" || k === "KW_PRESERVE") { this.adv(); this.expect("COLON"); guard = this.eat("STRING"); }
      else this.adv();
      this.maybeEat("COMMA");
    }

    this.expect("RBRACE");
    return { kind: "IntentDecl", span, label, scope, language, preserve, inject, where, guard };
  }

  // ── migrate ────────────────────────────────────────────────────────────
  private parseMigrate(): AST.MigrateDecl {
    const span = this.span();
    this.expect("KW_MIGRATE");
    const label = this.eat("STRING");
    this.expect("KW_IN");
    const lang = this.eat("IDENT") as AST.LangId;
    this.expect("LBRACE");

    const rules: AST.MigrateRule[] = [];
    let scope = "**/*";

    while (!this.at("RBRACE") && !this.at("EOF")) {
      if (this.at("KW_RENAME")) {
        this.adv(); this.expect("COLON");
        const from = this.eat("RAW_SOURCE") || this.eat("IDENT");
        this.expect("ARROW");
        const to = this.eat("RAW_SOURCE") || this.eat("IDENT");
        rules.push({ type: "rename", from, to });
      } else if (this.at("KW_MOVE")) {
        this.adv(); this.expect("COLON");
        const from = this.eat("STRING"); this.expect("ARROW");
        const to   = this.eat("STRING");
        rules.push({ type: "move", from, to });
      } else if (this.at("KW_REMOVE")) {
        this.adv(); this.expect("COLON");
        rules.push({ type: "remove", target: this.eat("IDENT") || this.eat("RAW_SOURCE") });
      } else if (this.at("KW_SCOPE")) {
        this.adv(); this.expect("COLON"); scope = this.eat("STRING");
      } else { this.adv(); }
      this.maybeEat("COMMA");
    }

    this.expect("RBRACE");
    return { kind: "MigrateDecl", span, label, lang, scope, rules };
  }

  // ── guard ──────────────────────────────────────────────────────────────
  private parseGuard(): AST.GuardDecl {
    const span = this.span();
    this.expect("KW_GUARD");
    const label = this.eat("STRING");
    this.expect("LBRACE");

    let scope = "**/*";
    const asserts: AST.AssertExpr[] = [];
    const onFail:  AST.FailAction[] = [];

    while (!this.at("RBRACE") && !this.at("EOF")) {
      if (this.at("KW_SCOPE"))   { this.adv(); this.expect("COLON"); scope = this.eat("STRING"); }
      else if (this.at("KW_ASSERT")) {
        this.adv(); this.expect("COLON");
        asserts.push(this.parseAssert());
      }
      else if (this.at("KW_ON_FAIL")) {
        this.adv(); this.expect("COLON");
        while (this.at("IDENT")) {
          onFail.push(this.adv().value as AST.FailAction);
          this.maybeEat("COMMA");
        }
      }
      else this.adv();
      this.maybeEat("COMMA");
    }

    this.expect("RBRACE");
    return { kind: "GuardDecl", span, label, scope, asserts, onFail };
  }

  private parseAssert(): AST.AssertExpr {
    if (this.at("KW_FN")) {
      this.adv(); return { type: "fn_exists", sig: this.cur().value + (this.adv(), "") };
    }
    if (this.at("KW_NO")) {
      this.adv();
      if (this.cur().value === "file") {
        this.adv(); this.adv(); // "imports" "from"
        return { type: "no_import_from", path: this.eat("STRING") };
      }
      if (this.cur().value === "raw") {
        this.adv(); return { type: "no_raw_sql" };
      }
      // no file contains X near Y
      this.adv(); // "contains"
      const text = this.eat("STRING");
      this.adv(); // "near"
      const near = this.eat("STRING");
      return { type: "no_contains", text, near };
    }
    if (this.at("KW_ALL")) {
      this.adv();
      const selector = this.eat("IDENT");
      const pred     = this.eat("IDENT") + " " + this.eat("IDENT");
      return { type: "all_have", selector, pred };
    }
    return { type: "raw", expr: this.eat("STRING") };
  }

  // ── trace ──────────────────────────────────────────────────────────────
  private parseTrace(): AST.TraceDecl {
    const span = this.span();
    this.expect("KW_TRACE");
    const ident = this.eat("IDENT");
    this.expect("KW_IN");
    const dir = this.eat("STRING");
    this.expect("LBRACE");

    let language: AST.LangId = "TypeScript", origin = "";
    const follow: AST.FollowKind[] = [], flags: string[] = [];
    let report: AST.ReportKind = "full_chain";

    while (!this.at("RBRACE") && !this.at("EOF")) {
      const k = this.cur().kind;
      if (k === "KW_LANGUAGE") { this.adv(); this.expect("COLON"); language = this.eat("IDENT") as AST.LangId; }
      else if (k === "IDENT" && this.cur().value === "origin") { this.adv(); this.expect("COLON"); origin = this.eat("RAW_SOURCE") || this.eat("STRING"); }
      else if (k === "KW_FOLLOW") { this.adv(); this.expect("COLON"); follow.push(this.eat("IDENT") as AST.FollowKind); while(this.at("COMMA")){ this.adv(); follow.push(this.eat("IDENT") as AST.FollowKind); } }
      else if (k === "KW_REPORT") { this.adv(); this.expect("COLON"); report = this.eat("IDENT") as AST.ReportKind; }
      else if (k === "KW_FLAG")   { this.adv(); this.expect("COLON"); flags.push(this.eat("STRING")); }
      else this.adv();
      this.maybeEat("COMMA");
    }

    this.expect("RBRACE");
    return { kind: "TraceDecl", span, ident, dir, language, origin, follow, report, flags };
  }

  // ── apply ──────────────────────────────────────────────────────────────
  private parseApply(): AST.ApplyStmt {
    const span = this.span();
    this.expect("KW_APPLY");
    const applyKind = this.eat("IDENT") as AST.ApplyKind;
    const name      = this.eat("IDENT") || this.eat("STRING");
    let   target: AST.ApplyTarget = { type: "project" };

    if (this.at("KW_TO")) {
      this.adv();
      if (this.cur().value === "project")    { this.adv(); target = { type: "project" }; }
      else if (this.cur().value === "file")  { this.adv(); target = { type: "file", path: this.eat("STRING") }; }
      else if (this.cur().value === "dir")   { this.adv(); target = { type: "dir",  path: this.eat("STRING") }; }
    }

    const preview = this.at("KW_PREVIEW") ? (this.adv(), true) : false;
    return { kind: "ApplyStmt", span, applyKind, name, target, preview };
  }

  private parseImport(): AST.ImportStmt {
    const span = this.span();
    this.expect("KW_IMPORT");
    const alias = this.eat("IDENT");
    this.expect("KW_FROM");
    const path = this.eat("STRING");
    return { kind: "ImportStmt", span, alias, path };
  }
}

export function parse(tokens: Token[]): AST.Program {
  return new Parser(tokens).parse();
}