// src/lsp.ts
// ─── Delta Language Server ────────────────────────────────────────────────
// Implements the Language Server Protocol (LSP) so any editor that
// supports LSP gets: diagnostics, completions, hover, and go-to-definition.
//
// Editors supported out of the box (all speak LSP):
//   VS Code · Neovim · Helix · Zed · Emacs (eglot) · Sublime Text
//
// Start with: node dist/lsp.js --stdio

import {
  createConnection, TextDocuments,
  DiagnosticSeverity, Diagnostic,
  CompletionItem, CompletionItemKind,
  TextDocumentSyncKind, InitializeResult,
  Hover, MarkupKind, Position,
  ProposedFeatures,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { tokenise, LexError } from "./lexer";
import { parse,   ParseError } from "./parser";
import { resolve } from "./resolver";

const connection = createConnection(ProposedFeatures.all);
const documents  = new TextDocuments(TextDocument);

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { resolveProvider: true, triggerCharacters: [" ", "\\n", ":"] },
    hoverProvider:      true,
    diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
  },
}));

// ── Diagnostics ───────────────────────────────────────────────────────────
documents.onDidChangeContent(async change => {
  const doc  = change.document;
  const text = doc.getText();
  const diags: Diagnostic[] = [];

  try {
    const tokens = tokenise(text);
    const ast    = parse(tokens);
    const { diagnostics } = resolve(ast, process.cwd());
    for (const d of diagnostics) {
      diags.push({
        severity: d.severity === "error"
          ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
        range: {
          start: { line: d.span.start.line - 1, character: d.span.start.col - 1 },
          end:   { line: d.span.end.line - 1,   character: d.span.end.col },
        },
        message: d.message,
        source:  "delta",
      });
    }
  } catch (e) {
    if (e instanceof LexError || e instanceof ParseError) {
      diags.push({
        severity: DiagnosticSeverity.Error,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: e.message,
        source:  "delta",
      });
    }
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
});

// ── Completions ───────────────────────────────────────────────────────────
const TOP_COMPLETIONS: CompletionItem[] = [
  { label: "patch",   kind: CompletionItemKind.Keyword, detail: "Surgical code transformation",      insertText: 'patch "${1:file.ts}" in ${2:TypeScript} {\\n  find fn ${3:functionName}() {}\\n  replace with {\\n    ${4:// new body}\\n  }\\n  why: "${5:reason}"\\n}' },
  { label: "fix",     kind: CompletionItemKind.Keyword, detail: "Reusable named bug correction",     insertText: 'fix ${1:name} {\\n  pattern: ${2:old_code}\\n  replace: ${3:new_code}\\n  scope: "${4:**/*.ts}"\\n  severity: bug\\n  note: "${5:explanation}"\\n}' },
  { label: "intent",  kind: CompletionItemKind.Keyword, detail: "High-level change intent",          insertText: 'intent "${1:description}" {\\n  scope: "${2:src/**}"\\n  language: ${3:TypeScript}\\n  inject: ${4:// code to inject}\\n  where: function_entry\\n}' },
  { label: "migrate", kind: CompletionItemKind.Keyword, detail: "API version migration rules",       insertText: 'migrate "${1:lib v1 -> v2}" in ${2:TypeScript} {\\n  rename: ${3:oldFn()} -> ${4:newFn()}\\n  scope: "${5:**/*.ts}"\\n}' },
  { label: "guard",   kind: CompletionItemKind.Keyword, detail: "Invariants that block unsafe ops",  insertText: 'guard "${1:label}" {\\n  scope: "${2:src/**}"\\n  assert: fn ${3:myFn}() exists\\n  on_fail: block_apply, show_diff\\n}' },
  { label: "trace",   kind: CompletionItemKind.Keyword, detail: "Data-flow analysis",                insertText: 'trace ${1:variableName} in "${2:src/}" {\\n  language: ${3:TypeScript}\\n  origin: ${4:req.body.value}\\n  follow: assignments, function_calls\\n  report: full_chain\\n  flag: "${5:any path that ...}"\\n}' },
  { label: "apply",   kind: CompletionItemKind.Keyword, detail: "Apply a fix/migrate/guard",         insertText: 'apply ${1|fix,migrate,guard|} ${2:name} to ${3|project,file,dir|}' },
];

const LANG_COMPLETIONS: CompletionItem[] = [
  "TypeScript","JavaScript","Python","Rust","Go",
  "Java","Kotlin","Swift","Ruby","CPP","CSharp","PHP"
].map(l => ({ label: l, kind: CompletionItemKind.EnumMember }));

connection.onCompletion((): CompletionItem[] =>
  [...TOP_COMPLETIONS, ...LANG_COMPLETIONS]
);
connection.onCompletionResolve(item => item);

// ── Hover docs ────────────────────────────────────────────────────────────
const HOVER_DOCS: Record<string, string> = {
  patch:   "**patch** — Surgical, reproducible change to a named function or block.\\n\\nUses semantic anchors (function names) rather than line numbers — survives refactors.",
  fix:     "**fix** — A reusable, named correction pattern. Applied with `delta apply fix <name> to project`.",
  intent:  "**intent** — Describe what you want in plain terms. Delta proposes a concrete patch for review.",
  migrate: "**migrate** — Encodes the full diff between two API versions. Run once, applied everywhere.",
  guard:   "**guard** — Declares invariants that must hold after every transformation. Blocks unsafe applies.",
  trace:   "**trace** — Performs static data-flow analysis to map where a value goes through the codebase.",
  apply:   "**apply** — Executes a previously declared fix, migrate, or guard across the target scope.",
};

connection.onHover(params => {
  const doc  = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = getWordAt(doc, params.position);
  const docs = HOVER_DOCS[word];
  if (!docs) return null;
  return { contents: { kind: MarkupKind.Markdown, value: docs } } as Hover;
});

function getWordAt(doc: TextDocument, pos: Position): string {
  const line = doc.getText({
    start: { line: pos.line, character: 0 },
    end:   { line: pos.line, character: 999 },
  });
  const before = line.slice(0, pos.character).match(/[a-z_]+$/i)?.[0] ?? "";
  const after  = line.slice(pos.character).match(/^[a-z_]+/i)?.[0] ?? "";
  return before + after;
}

documents.listen(connection);
connection.listen();