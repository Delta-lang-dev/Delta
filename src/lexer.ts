// src/lexer.ts
// ─── Delta Lexer ──────────────────────────────────────────────────────────
// Hand-written recursive descent lexer. Produces a flat token stream.
// Embedded code blocks (between { }) are treated as opaque RawSource.

export type TokKind =
  | "KW_PATCH"    | "KW_FIX"     | "KW_INTENT"  | "KW_MIGRATE"
  | "KW_GUARD"    | "KW_TRACE"   | "KW_APPLY"   | "KW_IMPORT"
  | "KW_FROM"     | "KW_IN"      | "KW_WITH"     | "KW_TO"
  | "KW_FIND"     | "KW_REPLACE" | "KW_WHY"      | "KW_SCOPE"
  | "KW_LANGUAGE" | "KW_INJECT"  | "KW_WHERE"    | "KW_ASSERT"
  | "KW_ON_FAIL"  | "KW_FOLLOW"  | "KW_REPORT"   | "KW_FLAG"
  | "KW_SEVERITY" | "KW_NOTE"    | "KW_PATTERN"  | "KW_RENAME"
  | "KW_MOVE"     | "KW_REMOVE"  | "KW_PRESERVE" | "KW_PREVIEW"
  | "KW_FN"       | "KW_ALL"     | "KW_NO"       | "KW_BLOCK"
  | "IDENT"       | "STRING"     | "RAW_SOURCE"
  | "ARROW"       | "COLON"      | "COMMA"       | "DOT"
  | "LBRACE"      | "RBRACE"     | "LPAREN"      | "RPAREN"
  | "COMMENT"     | "EOF";

// Every Delta keyword maps to its token kind.
// Anything not in this map becomes an IDENT token.
const KEYWORDS: Record<string, TokKind> = {
  patch:    "KW_PATCH",
  fix:      "KW_FIX",
  intent:   "KW_INTENT",
  migrate:  "KW_MIGRATE",
  guard:    "KW_GUARD",
  trace:    "KW_TRACE",
  apply:    "KW_APPLY",
  import:   "KW_IMPORT",
  from:     "KW_FROM",
  in:       "KW_IN",
  with:     "KW_WITH",
  to:       "KW_TO",
  find:     "KW_FIND",
  replace:  "KW_REPLACE",
  why:      "KW_WHY",
  scope:    "KW_SCOPE",
  language: "KW_LANGUAGE",
  inject:   "KW_INJECT",
  where:    "KW_WHERE",
  assert:   "KW_ASSERT",
  on_fail:  "KW_ON_FAIL",
  follow:   "KW_FOLLOW",
  report:   "KW_REPORT",
  flag:     "KW_FLAG",
  severity: "KW_SEVERITY",
  note:     "KW_NOTE",
  pattern:  "KW_PATTERN",
  rename:   "KW_RENAME",
  move:     "KW_MOVE",
  remove:   "KW_REMOVE",
  preserve: "KW_PRESERVE",
  preview:  "KW_PREVIEW",
  fn:       "KW_FN",
  all:      "KW_ALL",
  no:       "KW_NO",
  block:    "KW_BLOCK",
};

// ── Token type ─────────────────────────────────────────────────────────────

export interface Token {
  kind:  TokKind;
  value: string;
  line:  number;
  col:   number;
}

// ── Error type ─────────────────────────────────────────────────────────────

export class LexError extends Error {
  constructor(
    msg: string,
    public line: number,
    public col:  number
  ) {
    super(`Lex error at ${line}:${col} — ${msg}`);
    this.name = "LexError";
  }
}

// ── These token kinds open a RAW_SOURCE block ──────────────────────────────
// When the lexer sees a { immediately after one of these tokens,
// it reads everything until the matching closing } as a single
// opaque RAW_SOURCE token rather than trying to parse it as Delta.
// This is how embedded code blocks work — Delta never parses the
// code inside find/replace/inject blocks.

const RAW_OPENERS: Set<TokKind> = new Set([
  "KW_FIND",
  "KW_REPLACE",
  "KW_WITH",
  "KW_INJECT",
]);

// ── Main tokenise function ─────────────────────────────────────────────────

export function tokenise(src: string): Token[] {
  const tokens: Token[] = [];
  let i    = 0;
  let line = 1;
  let col  = 1;

  // ── Helpers ──────────────────────────────────────────────────────────────

  const peek = (offset = 0): string => src[i + offset] ?? "";

  const advance = (): string => {
    const ch = src[i++];
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  };

  const pushTok = (kind: TokKind, value: string): void => {
    tokens.push({ kind, value, line, col });
  };

  // Returns the last non-comment token already in the array.
  const lastMeaningful = (): Token | undefined =>
    [...tokens].reverse().find(t => t.kind !== "COMMENT");

  // ── Scanners ─────────────────────────────────────────────────────────────

  const scanWhitespace = (): void => {
    while (i < src.length && /\s/.test(peek())) advance();
  };

  const scanLineComment = (): void => {
    let value = "";
    // consume the opening //
    advance(); advance();
    while (i < src.length && peek() !== "\n") {
      value += advance();
    }
    pushTok("COMMENT", value.trim());
  };

  const scanString = (): void => {
    // consume opening "
    advance();
    let value = "";
    while (i < src.length && peek() !== '"') {
      if (peek() === "\\") {
        // escape sequence — keep both chars verbatim
        advance();
        value += advance();
      } else {
        value += advance();
      }
    }
    if (i >= src.length) {
      throw new LexError("Unterminated string literal", line, col);
    }
    // consume closing "
    advance();
    pushTok("STRING", value);
  };

  const scanRawSource = (): void => {
    // The opening { was already consumed by the caller.
    // We read until the matching closing }, tracking nesting depth.
    let depth = 1;
    let raw   = "";

    while (i < src.length && depth > 0) {
      const ch = advance();
      if (ch === "{") {
        depth++;
        raw += ch;
      } else if (ch === "}") {
        depth--;
        // Do NOT include the final closing } in the raw source
        if (depth > 0) raw += ch;
      } else {
        raw += ch;
      }
    }

    if (depth > 0) {
      throw new LexError("Unterminated raw source block — missing closing }", line, col);
    }

    pushTok("RAW_SOURCE", raw.trim());
  };

  const scanIdentOrKeyword = (): void => {
    let value = "";
    while (i < src.length && /[a-zA-Z0-9_]/.test(peek())) {
      value += advance();
    }
    const kind = KEYWORDS[value] ?? "IDENT";
    pushTok(kind, value);
  };

  // ── Main loop ─────────────────────────────────────────────────────────────

  while (i < src.length) {

    // Skip whitespace
    if (/\s/.test(peek())) {
      scanWhitespace();
      continue;
    }

    // Line comment: //
    if (peek() === "/" && peek(1) === "/") {
      scanLineComment();
      continue;
    }

    // String literal: "..."
    if (peek() === '"') {
      scanString();
      continue;
    }

    // Arrow operator: ->
    if (peek() === "-" && peek(1) === ">") {
      advance(); advance();
      pushTok("ARROW", "->");
      continue;
    }

    // Single-character tokens
    switch (peek()) {
      case ":": advance(); pushTok("COLON",  ":"); continue;
      case ",": advance(); pushTok("COMMA",  ","); continue;
      case ".": advance(); pushTok("DOT",    "."); continue;
      case "(": advance(); pushTok("LPAREN", "("); continue;
      case ")": advance(); pushTok("RPAREN", ")"); continue;
      case "}": advance(); pushTok("RBRACE", "}"); continue;
    }

    // Opening brace — decide: LBRACE or start of RAW_SOURCE
    if (peek() === "{") {
      advance(); // consume the {

      const last = lastMeaningful();
      if (last && RAW_OPENERS.has(last.kind)) {
        // The previous meaningful token was find/replace/with/inject
        // so everything inside the braces is embedded source code
        scanRawSource();
      } else {
        pushTok("LBRACE", "{");
      }
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(peek())) {
      scanIdentOrKeyword();
      continue;
    }

    // Numbers (used inside raw source blocks, not top-level Delta,
    // but we tokenise them to avoid an error if they appear)
    if (/[0-9]/.test(peek())) {
      let value = "";
      while (/[0-9]/.test(peek())) value += advance();
      pushTok("IDENT", value);
      continue;
    }

    // Anything else is an error
    throw new LexError(
      `Unexpected character '${peek()}'`,
      line,
      col
    );
  }

  // Always end with an EOF token so the parser has a clean termination signal
  pushTok("EOF", "");

  // Strip comment tokens — the parser never needs them
  return tokens.filter(t => t.kind !== "COMMENT");
}
