// src/targets/index.ts
// ─── Delta Language Adapter Registry ─────────────────────────────────────
// UPDATED: queryFiles() added to LanguageAdapter interface.
// This method is required by the upgraded guards.ts fn_exists check.

import * as AST from "../ast";
import { TypeScriptAdapter } from "./typescript";
import { JavaScriptAdapter } from "./javascript";
import { PythonAdapter      } from "./python";
import { GoAdapter          } from "./go";
import { RustAdapter        } from "./rust";
import { JavaAdapter        } from "./java";
import { GenericAdapter     } from "./generic";

export interface LanguageAdapter {
  applyPatch(src: string, decl: AST.PatchDecl): Promise<string>;
  applyMigrate(src: string, decl: AST.MigrateDecl): Promise<string>;
  applyIntent(src: string, decl: AST.IntentDecl): Promise<string>;
  trace(decl: AST.TraceDecl, cwd: string): Promise<string>;
  /**
   * NEW — AST-accurate symbol search used by guards.ts fn_exists check.
   * Returns all matching locations with file path, line number, and text.
   */
  queryFiles(
    files: string[],
    query: string
  ): Promise<Array<{ file: string; line: number; text: string }>>;
}

const REGISTRY: Partial<Record<AST.LangId, LanguageAdapter>> = {
  TypeScript:  new TypeScriptAdapter(),
  JavaScript:  new JavaScriptAdapter(),
  Python:      new PythonAdapter(),
  Go:          new GoAdapter(),
  Rust:        new RustAdapter(),
  Java:        new JavaAdapter(),
  Kotlin:      new GenericAdapter("Kotlin",  [".kt", ".kts"]),
  Swift:       new GenericAdapter("Swift",   [".swift"]),
  Ruby:        new GenericAdapter("Ruby",    [".rb"]),
  CPP:         new GenericAdapter("CPP",     [".cpp", ".cc", ".h", ".hpp"]),
  CSharp:      new GenericAdapter("CSharp",  [".cs"]),
  PHP:         new GenericAdapter("PHP",     [".php"]),
};

export function getAdapter(lang: AST.LangId): LanguageAdapter {
  const adapter = REGISTRY[lang];
  if (adapter) return adapter;
  console.warn(`[delta] No adapter for '${lang}' — using GenericAdapter`);
  return new GenericAdapter(lang, []);
}

export function getSupportedLanguages(): AST.LangId[] {
  return ["TypeScript", "JavaScript", "Python", "Go", "Rust", "Java"];
}

export interface AdapterInfo {
  lang:       AST.LangId;
  parser:     string;
  extensions: string[];
  maturity:   "stable" | "beta" | "planned";
  supports: {
    patch:   boolean;
    fix:     boolean;
    intent:  boolean;
    migrate: boolean;
    guard:   boolean;
    trace:   boolean;
  };
}

export const ADAPTER_INFO: AdapterInfo[] = [
  {
    lang: "TypeScript", parser: "TypeScript Compiler API",
    extensions: [".ts", ".tsx"], maturity: "stable",
    supports: { patch:true, fix:true, intent:true, migrate:true, guard:true, trace:true },
  },
  {
    lang: "JavaScript", parser: "TypeScript Compiler API",
    extensions: [".js", ".jsx", ".mjs", ".cjs"], maturity: "stable",
    supports: { patch:true, fix:true, intent:true, migrate:true, guard:true, trace:true },
  },
  {
    lang: "Python", parser: "tree-sitter-python",
    extensions: [".py"], maturity: "stable",
    supports: { patch:true, fix:true, intent:true, migrate:true, guard:true, trace:true },
  },
  {
    lang: "Go", parser: "tree-sitter-go",
    extensions: [".go"], maturity: "stable",
    supports: { patch:true, fix:true, intent:true, migrate:true, guard:true, trace:true },
  },
  {
    lang: "Rust", parser: "tree-sitter-rust",
    extensions: [".rs"], maturity: "stable",
    supports: { patch:true, fix:true, intent:false, migrate:true, guard:true, trace:true },
  },
  {
    lang: "Java", parser: "tree-sitter-java",
    extensions: [".java"], maturity: "beta",
    supports: { patch:true, fix:true, intent:false, migrate:true, guard:true, trace:false },
  },
  {
    lang: "Kotlin", parser: "generic fallback",
    extensions: [".kt", ".kts"], maturity: "beta",
    supports: { patch:true, fix:true, intent:false, migrate:true, guard:false, trace:false },
  },
  {
    lang: "Swift", parser: "generic fallback",
    extensions: [".swift"], maturity: "beta",
    supports: { patch:true, fix:true, intent:false, migrate:true, guard:false, trace:false },
  },
  {
    lang: "Ruby", parser: "generic fallback",
    extensions: [".rb"], maturity: "beta",
    supports: { patch:true, fix:true, intent:false, migrate:true, guard:false, trace:false },
  },
  {
    lang: "CPP", parser: "generic fallback",
    extensions: [".cpp", ".cc", ".h", ".hpp"], maturity: "beta",
    supports: { patch:true, fix:true, intent:false, migrate:false, guard:false, trace:false },
  },
  {
    lang: "CSharp", parser: "generic fallback",
    extensions: [".cs"], maturity: "beta",
    supports: { patch:true, fix:true, intent:false, migrate:true, guard:false, trace:false },
  },
  {
    lang: "PHP", parser: "generic fallback",
    extensions: [".php"], maturity: "beta",
    supports: { patch:true, fix:true, intent:false, migrate:true, guard:false, trace:false },
  },
];
