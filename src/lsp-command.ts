// src/lsp-command.ts
// ─── Delta LSP stdio bridge ───────────────────────────────────────────────
// Wires the Language Server (src/lsp.ts) to stdio so the VS Code extension
// can spawn it with: delta lsp --stdio
//
// The VS Code LanguageClient connects via TransportKind.stdio — it writes
// JSON-RPC messages to our stdin and reads responses from our stdout.
// We bridge those streams directly to vscode-languageserver's connection.

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  Diagnostic as LspDiagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  HoverParams,
  Hover,
  MarkupKind,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { tokenise, LexError } from "./lexer";
import { parse, ParseError } from "./parser";
import { resolve } from "./resolver";

// ── Connection ────────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents  = new TextDocuments(TextDocument);

// ── Capabilities ──────────────────────────────────────────────────────────

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync:    TextDocumentSyncKind.Incremental,
      completionProvider:  { resolveProvider: false, triggerCharacters: [" ", ":"] },
      hoverProvider:       true,
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics:  false,
      },
    },
    serverInfo: { name: "delta-lsp", version: "0.1.0" },
  };
});

// ── Diagnostics ───────────────────────────────────────────────────────────

documents.onDidChangeContent(change => {
  validateDocument(change.document);
});

function validateDocument(doc: TextDocument): void {
  const src  = doc.getText();
  const diags: LspDiagnostic[] = [];

  try {
    const tokens = tokenise(src);
    try {
      const ast = parse(tokens);
      // Run resolver with a fallback cwd
      const cwd = process.cwd();
      const { diagnostics } = resolve(ast, cwd);

      for (const d of diagnostics) {
        const line = Math.max(0, (d.line ?? 1) - 1);
        const col  = Math.max(0, (d.col  ?? 1) - 1);
        diags.push({
          range: Range.create(
            Position.create(line, col),
            Position.create(line, col + (d.length ?? 1))
          ),
          severity: d.severity === "error"
            ? DiagnosticSeverity.Error
            : d.severity === "warning"
            ? DiagnosticSeverity.Warning
            : DiagnosticSeverity.Information,
          message: d.message,
          source:  "delta",
        });
      }
    } catch (e: unknown) {
      if (e instanceof ParseError) {
        const tok  = e.tok;
        const line = Math.max(0, (tok?.line ?? 1) - 1);
        const col  = Math.max(0, (tok?.col  ?? 1) - 1);
        diags.push({
          range:    Range.create(Position.create(line, col), Position.create(line, col + 1)),
          severity: DiagnosticSeverity.Error,
          message:  e.message,
          source:   "delta",
        });
      }
    }
  } catch (e: unknown) {
    if (e instanceof LexError) {
      const line = Math.max(0, (e.line ?? 1) - 1);
      const col  = Math.max(0, (e.col  ?? 1) - 1);
      diags.push({
        range:    Range.create(Position.create(line, col), Position.create(line, col + 1)),
        severity: DiagnosticSeverity.Error,
        message:  e.message,
        source:   "delta",
      });
    }
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
}

// ── Completions ───────────────────────────────────────────────────────────

const CONSTRUCT_COMPLETIONS: CompletionItem[] = [
  { label: "patch",   kind: CompletionItemKind.Keyword, detail: "Patch a specific function or block", insertText: 'patch "${1:src/file.ts}" in ${2:TypeScript} {
  find fn ${3:name}() {}
  replace with { ${4} }
  why: "${5:reason}"
}' },
  { label: "fix",     kind: CompletionItemKind.Keyword, detail: "Define a reusable code fix pattern", insertText: 'fix ${1:name} {
  pattern: { ${2} }
  replace: { ${3} }
  scope:   "${4:**/*.ts}"
  severity: ${5:bug}
}' },
  { label: "intent",  kind: CompletionItemKind.Keyword, detail: "Inject code at function boundaries", insertText: 'intent "${1:description}" {
  scope:    "${2:src/**}"
  language: ${3:TypeScript}
  inject:   { ${4} }
  where:    ${5:function_entry}
}' },
  { label: "migrate", kind: CompletionItemKind.Keyword, detail: "Migrate from one API to another",    insertText: 'migrate "${1:label}" in ${2:TypeScript} {
  rename: ${3:oldFn} -> ${4:newFn}
  scope:  "${5:**/*.ts}"
}' },
  { label: "guard",   kind: CompletionItemKind.Keyword, detail: "Assert invariants before transforms", insertText: 'guard "${1:label}" {
  scope:   "${2:src/**}"
  assert:  fn ${3:name}() exists
  on_fail: ${4:block_apply}
}' },
  { label: "trace",   kind: CompletionItemKind.Keyword, detail: "Trace data flow through codebase",   insertText: 'trace ${1:varName} in "${2:src/}" {
  language: ${3:TypeScript}
  origin:   ${4:req.body}
  follow:   assignments, function_calls, returns
  report:   full_chain
}' },
  { label: "apply",   kind: CompletionItemKind.Keyword, detail: "Apply a fix or migration",           insertText: 'apply fix ${1:name} to ${2:project}' },
  { label: "import",  kind: CompletionItemKind.Keyword, detail: "Import a .delta file",              insertText: 'import ${1:alias} from "${2:./file.delta}"' },
];

connection.onCompletion((_pos: TextDocumentPositionParams): CompletionItem[] => {
  return CONSTRUCT_COMPLETIONS;
});

// ── Hover docs ────────────────────────────────────────────────────────────

const HOVER_DOCS: Record<string, string> = {
  patch:   "**patch** — Surgically replace a specific function or block in a file.

```delta
patch "src/app.ts" in TypeScript {
  find fn greet() {}
  replace with { return `Hi!`; }
  why: "modernise greeting"
}
```",
  fix:     "**fix** — Define a reusable find-and-replace pattern, apply it across a glob scope.

```delta
fix strictNull {
  pattern: { == null }
  replace: { === null }
  scope:   "**/*.ts"
  severity: bug
}
```",
  intent:  "**intent** — Inject code at every function entry or exit without editing each file.

```delta
intent "add logging" {
  scope: "src/**"
  language: TypeScript
  inject: { logger.info("called"); }
  where: function_entry
}
```",
  migrate: "**migrate** — Rename symbols, move files, remove deprecated APIs across the codebase.

```delta
migrate "v1 to v2" in TypeScript {
  rename: oldFn -> newFn
  scope: "**/*.ts"
}
```",
  guard:   "**guard** — Assert invariants before any transform runs. Blocks apply if assertion fails.

```delta
guard "api contract" {
  scope: "src/**"
  assert: fn getUser() exists
  on_fail: block_apply
}
```",
  trace:   "**trace** — Follow data through your codebase. Flags dangerous paths.

```delta
trace userInput in "src/" {
  language: TypeScript
  origin: req.body
  follow: assignments, function_calls
  report: full_chain
  flag: "any path that reaches console.log"
}
```",
  apply:   "**apply** — Execute a named fix or migration against a target (project, file, or directory).

`apply fix myFix to project preview`",
  import:  "**import** — Import constructs from another .delta file.

`import guards from "./guards.delta"`",
};

connection.onHover((params: HoverParams): Hover | null => {
  const doc  = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const pos    = params.position;
  const line   = doc.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line, character: 200 } });
  const word   = wordAt(line, pos.character);
  const docs   = HOVER_DOCS[word];
  if (!docs) return null;

  return {
    contents: { kind: MarkupKind.Markdown, value: docs },
    range: wordRange(pos.line, line, pos.character),
  };
});

function wordAt(line: string, col: number): string {
  const before = line.slice(0, col).match(/[a-zA-Z_]+$/) ?? [""];
  const after  = line.slice(col).match(/^[a-zA-Z_]+/)   ?? [""];
  return before[0] + after[0];
}

function wordRange(lineNum: number, line: string, col: number): Range {
  const start = col - (line.slice(0, col).match(/[a-zA-Z_]+$/) ?? [""])[0].length;
  const word  = wordAt(line, col);
  return Range.create(
    Position.create(lineNum, start),
    Position.create(lineNum, start + word.length)
  );
}

// ── Start ─────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
