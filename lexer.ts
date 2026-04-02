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

const KEYWORDS: Record<string, TokKind> = {
  patch: "KW_PATCH", fix: "KW_FIX", intent: "KW_INTENT",
  migrate: "KW_MIGRATE", guard: "KW_GUARD", trace: "KW_TRACE",
  apply: "KW_APPLY", import: "KW_IMPORT", from: "KW_FROM",
  in: "KW_IN", with: "KW_WITH", to: "KW_TO", find: "KW_FIND",
  replace: "KW_REPLACE", why: "KW_WHY", scope: "KW_SCOPE",
  language: "KW_LANGUAGE", inject: "KW_INJECT", where: "KW_WHERE",
  assert: "KW_ASSERT", on_fail: "KW_ON_FAIL", follow: "KW_FOLLOW",
  report: "KW_REPORT", flag: "KW_FLAG", severity: "KW_SEVERITY",
  note: "KW_NOTE", pattern: "KW_PATTERN", rename: "KW_RENAME",
  move: "KW_MOVE", remove: "KW_REMOVE", preserve: "KW_PRESERVE",
  preview: "KW_PREVIEW", fn: "KW_FN", all: "KW_ALL", no: "KW_NO",
  block: "KW_BLOCK",
};

export interface Token {
  kind:  TokKind;
  value: string;
  line:  number;
  col:   number;
}

export class LexError extends Error {
  constructor(msg: string, public line: number, public col: number) {
    super(\`Lex error at \${line}:\${col} — \${msg}\`);
  }
}

export function tokenise(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;

  const peek  = (n = 0) => src[i + n] ?? "";
  const adv   = () => {
    const c = src[i++];
    if (c === "\\n") { line++; col = 1; } else { col++; }
    return c;
  };
  const tok   = (kind: TokKind, value: string) =>
    tokens.push({ kind, value, line, col });

  while (i < src.length) {
    // Whitespace
    if (/\\s/.test(peek())) { adv(); continue; }

    // Line comment
    if (peek() === "/" && peek(1) === "/") {
      let v = "";
      while (i < src.length && peek() !== "\\n") v += adv();
      tok("COMMENT", v.trim());
      continue;
    }

    // String literal "…"
    if (peek() === '"') {
      adv(); let v = "";
      while (i < src.length && peek() !== '"') {
        if (peek() === "\\\\" ) { adv(); v += adv(); } else v += adv();
      }
      adv();
      tok("STRING", v);
      continue;
    }

    // Arrow ->
    if (peek() === "-" && peek(1) === ">") {
      adv(); adv(); tok("ARROW", "->"); continue;
    }

    // Single chars
    const singles: Record<string, TokKind> = {
      ":": "COLON", ",": "COMMA", ".": "DOT",
      "(": "LPAREN", ")": "RPAREN",
    };
    if (singles[peek()]) { tok(singles[peek()], adv()); continue; }

    // Brace — decide RAW_SOURCE vs LBRACE
    if (peek() === "{") {
      adv();
      // If previous meaningful token was a block-opener keyword, read raw
      const last = tokens.filter(t => t.kind !== "COMMENT").at(-1);
      const rawOpeners: TokKind[] = [
        "KW_FIND", "KW_REPLACE", "KW_WITH", "KW_INJECT"
      ];
      if (last && rawOpeners.includes(last.kind)) {
        let depth = 1, raw = "";
        while (i < src.length && depth > 0) {
          const c = adv();
          if (c === "{") depth++;
          else if (c === "}") { depth--; if (depth === 0) break; }
          raw += c;
        }
        tok("RAW_SOURCE", raw.trim());
      } else {
        tok("LBRACE", "{");
      }
      continue;
    }
    if (peek() === "}") { adv(); tok("RBRACE", "}"); continue; }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(peek())) {
      let v = "";
      while (/[a-zA-Z0-9_]/.test(peek())) v += adv();
      tok(KEYWORDS[v] ?? "IDENT", v);
      continue;
    }

    throw new LexError(\`Unexpected character '\${peek()}'\`, line, col);
  }

  tok("EOF", "");
  return tokens.filter(t => t.kind !== "COMMENT");
}