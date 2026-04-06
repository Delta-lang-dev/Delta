// src/targets/index.ts
// ─── Delta Language Adapter Registry ─────────────────────────────────────
// Maps every supported LangId to its adapter implementation.
// The emitter calls getAdapter(lang) and gets back an object that knows
// how to apply patches, migrations, intents, and traces for that language.
// Adding a new language = create an adapter file + register it here.

import * as AST from "../ast";

// ═══════════════════════════════════════════════════════════════════════════
//  LanguageAdapter interface
//  Every language adapter must implement all four methods.
// ═══════════════════════════════════════════════════════════════════════════

export interface LanguageAdapter {

  /**
   * Apply a patch declaration to a source string.
   * Locates the target function/block/line and replaces it.
   * Returns the modified source string unchanged if the target is not found.
   */
  applyPatch(
    src:  string,
    decl: AST.PatchDecl
  ): Promise<string>;

  /**
   * Apply a migration declaration to a source string.
   * Processes all rename/move/replace/remove rules in order.
   * Returns the modified source string.
   */
  applyMigrate(
    src:  string,
    decl: AST.MigrateDecl
  ): Promise<string>;

  /**
   * Apply an intent declaration to a source string.
   * Injects code at all matching injection sites.
   * Respects the guard clause to avoid duplicate injections.
   * Returns the modified source string.
   */
  applyIntent(
    src:  string,
    decl: AST.IntentDecl
  ): Promise<string>;

  /**
   * Run a trace declaration against all files in a directory.
   * Performs static data-flow analysis and returns a formatted
   * report string describing the full call chain and any flagged paths.
   */
  trace(
    decl: AST.TraceDecl,
    cwd:  string
  ): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Adapter imports
//  Each language has its own file in src/targets/
// ═══════════════════════════════════════════════════════════════════════════

import { TypeScriptAdapter } from "./typescript";
import { JavaScriptAdapter } from "./javascript";
import { PythonAdapter      } from "./python";
import { GoAdapter          } from "./go";
import { RustAdapter        } from "./rust";
import { JavaAdapter        } from "./java";
import { GenericAdapter     } from "./generic";

// ═══════════════════════════════════════════════════════════════════════════
//  Registry
//  Maps LangId → adapter instance.
//  Adapters are singletons — one instance shared across all emit calls.
// ═══════════════════════════════════════════════════════════════════════════

const REGISTRY: Partial<Record<AST.LangId, LanguageAdapter>> = {
  TypeScript:  new TypeScriptAdapter(),
  JavaScript:  new JavaScriptAdapter(),
  Python:      new PythonAdapter(),
  Go:          new GoAdapter(),
  Rust:        new RustAdapter(),
  Java:        new JavaAdapter(),

  // These languages use the generic regex-based adapter for now.
  // Replace with dedicated adapters as they are implemented.
  Kotlin:      new GenericAdapter("Kotlin",  [".kt", ".kts"]),
  Swift:       new GenericAdapter("Swift",   [".swift"]),
  Ruby:        new GenericAdapter("Ruby",    [".rb"]),
  CPP:         new GenericAdapter("CPP",     [".cpp", ".cc", ".cxx", ".h", ".hpp"]),
  CSharp:      new GenericAdapter("CSharp",  [".cs"]),
  PHP:         new GenericAdapter("PHP",     [".php"]),
};

// ═══════════════════════════════════════════════════════════════════════════
//  getAdapter
//  The single entry point the emitter uses.
//  Always returns an adapter — falls back to GenericAdapter if the
//  language is not in the registry so the emitter never crashes.
// ═══════════════════════════════════════════════════════════════════════════

export function getAdapter(lang: AST.LangId): LanguageAdapter {
  const adapter = REGISTRY[lang];

  if (adapter) return adapter;

  // Fallback — should not happen for any LangId in our AST type,
  // but handles edge cases if new languages are added to LangId
  // before their adapter is registered.
  console.warn(
    `[delta] No adapter registered for '${lang}' — falling back to GenericAdapter. ` +
    `Results may be less accurate than a dedicated adapter.`
  );

  return new GenericAdapter(lang, []);
}

// ═══════════════════════════════════════════════════════════════════════════
//  getSupportedLanguages
//  Returns the list of languages that have dedicated (non-generic) adapters.
//  Used by the CLI to show the supported languages table.
// ═══════════════════════════════════════════════════════════════════════════

export function getSupportedLanguages(): AST.LangId[] {
  return [
    "TypeScript",
    "JavaScript",
    "Python",
    "Go",
    "Rust",
    "Java",
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
//  getAdapterInfo
//  Returns metadata about an adapter for display in the CLI and website.
// ═══════════════════════════════════════════════════════════════════════════

export interface AdapterInfo {
  lang:       AST.LangId;
  parser:     string;
  extensions: string[];
  maturity:   "stable" | "beta" | "planned";
  supports:   {
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
    lang:       "TypeScript",
    parser:     "TypeScript Compiler API",
    extensions: [".ts", ".tsx"],
    maturity:   "stable",
    supports:   { patch: true, fix: true, intent: true, migrate: true, guard: true, trace: true },
  },
  {
    lang:       "JavaScript",
    parser:     "TypeScript Compiler API",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    maturity:   "stable",
    supports:   { patch: true, fix: true, intent: true, migrate: true, guard: true, trace: true },
  },
  {
    lang:       "Python",
    parser:     "tree-sitter-python",
    extensions: [".py"],
    maturity:   "stable",
    supports:   { patch: true, fix: true, intent: true, migrate: true, guard: true, trace: true },
  },
  {
    lang:       "Go",
    parser:     "tree-sitter-go",
    extensions: [".go"],
    maturity:   "stable",
    supports:   { patch: true, fix: true, intent: true, migrate: true, guard: true, trace: true },
  },
  {
    lang:       "Rust",
    parser:     "tree-sitter-rust",
    extensions: [".rs"],
    maturity:   "stable",
    supports:   { patch: true, fix: true, intent: false, migrate: true, guard: true, trace: true },
  },
  {
    lang:       "Java",
    parser:     "tree-sitter-java",
    extensions: [".java"],
    maturity:   "beta",
    supports:   { patch: true, fix: true, intent: false, migrate: true, guard: true, trace: false },
  },
  {
    lang:       "Kotlin",
    parser:     "tree-sitter-kotlin (generic fallback)",
    extensions: [".kt", ".kts"],
    maturity:   "beta",
    supports:   { patch: true, fix: true, intent: false, migrate: true, guard: false, trace: false },
  },
  {
    lang:       "Swift",
    parser:     "tree-sitter-swift (generic fallback)",
    extensions: [".swift"],
    maturity:   "beta",
    supports:   { patch: true, fix: true, intent: false, migrate: true, guard: false, trace: false },
  },
  {
    lang:       "Ruby",
    parser:     "tree-sitter-ruby (generic fallback)",
    extensions: [".rb"],
    maturity:   "beta",
    supports:   { patch: true, fix: true, intent: false, migrate: true, guard: false, trace: false },
  },
  {
    lang:       "CPP",
    parser:     "tree-sitter-cpp (generic fallback)",
    extensions: [".cpp", ".cc", ".h", ".hpp"],
    maturity:   "beta",
    supports:   { patch: true, fix: true, intent: false, migrate: false, guard: false, trace: false },
  },
  {
    lang:       "CSharp",
    parser:     "tree-sitter-c-sharp (generic fallback)",
    extensions: [".cs"],
    maturity:   "beta",
    supports:   { patch: true, fix: true, intent: false, migrate: true, guard: false, trace: false },
  },
  {
    lang:       "PHP",
    parser:     "tree-sitter-php (generic fallback)",
    extensions: [".php"],
    maturity:   "beta",
    supports:   { patch: true, fix: true, intent: false, migrate: true, guard: false, trace: false },
  },
];
