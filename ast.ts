// src/ast.ts
// ─── Delta Abstract Syntax Tree ───────────────────────────────────────────
// Every construct in the Delta grammar maps to a typed AST node here.

export type LangId =
  | "TypeScript" | "JavaScript" | "Python"
  | "Rust"       | "Go"         | "Java"
  | "Kotlin"     | "Swift"      | "Ruby"
  | "CPP"        | "CSharp"     | "PHP";

export type SeverityLevel = "bug" | "perf" | "style" | "security";
export type FailAction    = "block_apply" | "warn" | "show_diff";
export type InjectSite    = "function_entry" | "function_exit"
                          | { before: string } | { after: string };
export type FollowKind    = "assignments" | "function_calls"
                          | "returns"    | "mutations";
export type ReportKind    = "full_chain" | "summary" | "callers";
export type ApplyKind     = "fix" | "migrate" | "guard";
export type ApplyTarget   = { type: "project" }
                          | { type: "file";  path: string }
                          | { type: "dir";   path: string };

// ── Shared ────────────────────────────────────────────────────────────────
export interface Position { line: number; col: number }
export interface Span     { start: Position; end: Position }

export interface BaseNode  { kind: string; span: Span }

// ── Top-level ─────────────────────────────────────────────────────────────
export type TopDecl =
  | PatchDecl | FixDecl   | IntentDecl
  | MigrateDecl | GuardDecl | TraceDecl
  | ApplyStmt   | ImportStmt;

export interface Program { decls: TopDecl[]; span: Span }

export interface ImportStmt extends BaseNode {
  kind: "ImportStmt";
  alias: string;
  path:  string;
}

// ── Patch ─────────────────────────────────────────────────────────────────
export interface PatchDecl extends BaseNode {
  kind:    "PatchDecl";
  file:    string;
  lang:    LangId;
  find:    FindClause;
  replace: ReplaceClause;
  why?:    string;
}
export type FindClause =
  | { type: "fn";    name: string; body?: string }
  | { type: "block"; label: string; body: string }
  | { type: "line";  regex: string };
export interface ReplaceClause { body: string }

// ── Fix ───────────────────────────────────────────────────────────────────
export interface FixDecl extends BaseNode {
  kind:      "FixDecl";
  name:      string;
  pattern:   string;
  replace:   string;
  scope:     string;
  severity?: SeverityLevel;
  note?:     string;
}

// ── Intent ────────────────────────────────────────────────────────────────
export interface IntentDecl extends BaseNode {
  kind:      "IntentDecl";
  label:     string;
  scope:     string;
  language:  LangId;
  preserve?: string;
  inject:    string;
  where:     InjectSite;
  guard?:    string;
}

// ── Migrate ───────────────────────────────────────────────────────────────
export interface MigrateDecl extends BaseNode {
  kind:  "MigrateDecl";
  label: string;
  lang:  LangId;
  scope: string;
  rules: MigrateRule[];
}
export type MigrateRule =
  | { type: "rename";  from: string; to: string }
  | { type: "move";    from: string; to: string }
  | { type: "replace"; from: string; to: string }
  | { type: "remove";  target: string };

// ── Guard ─────────────────────────────────────────────────────────────────
export interface GuardDecl extends BaseNode {
  kind:     "GuardDecl";
  label:    string;
  scope:    string;
  asserts:  AssertExpr[];
  onFail:   FailAction[];
}
export type AssertExpr =
  | { type: "fn_exists";       sig: string }
  | { type: "no_import_from";  path: string }
  | { type: "no_contains";     near: string; text: string }
  | { type: "all_have";        selector: string; pred: string }
  | { type: "no_raw_sql" }
  | { type: "raw";             expr: string };

// ── Trace ─────────────────────────────────────────────────────────────────
export interface TraceDecl extends BaseNode {
  kind:     "TraceDecl";
  ident:    string;
  dir:      string;
  language: LangId;
  origin:   string;
  follow:   FollowKind[];
  report:   ReportKind;
  flags:    string[];
}

// ── Apply ─────────────────────────────────────────────────────────────────
export interface ApplyStmt extends BaseNode {
  kind:    "ApplyStmt";
  applyKind: ApplyKind;
  name:    string;
  target:  ApplyTarget;
  preview: boolean;
}