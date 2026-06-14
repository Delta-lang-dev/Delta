// src/index.ts
// ─── Delta Public API ─────────────────────────────────────────────────────
// Entry point for consuming Delta as a library (not via CLI).
// Downstream tools, editor plugins, and the Delta Playground
// import from here rather than from internal modules directly.

export { tokenise }                       from "./lexer";
export type { Token, TokKind }            from "./lexer";
export { LexError }                       from "./lexer";

export { parse, Parser }                  from "./parser";
export { ParseError }                     from "./parser";

export * as AST                           from "./ast";

export { resolve }                        from "./resolver";
export type {
  ResolvedProgram,
  Diagnostic,
  DiagSeverity,
  Registry,
}                                         from "./resolver";

export { emit }                           from "./emitter";
export type { EmitOptions, EmitResult }   from "./emitter";

export { getAdapter, getSupportedLanguages, ADAPTER_INFO } from "./targets";
export type { LanguageAdapter, AdapterInfo }               from "./targets";

export { runGuard, DEFAULT_IGNORE }       from "./guards";
export type { GuardResult }              from "./guards";

export {
  applyWithCaptures,
  applyCaptures,
  matchPattern,
  patternToRegex,
  extractMetaVars,
}                                         from "./types/captures";
export type { CaptureMap }               from "./types/captures";

// ── Convenience: run a complete compile pipeline ───────────────────────────

import { tokenise }   from "./lexer";
import { parse }      from "./parser";
import { resolve }    from "./resolver";
import { emit }       from "./emitter";
import type { EmitOptions, EmitResult } from "./emitter";

export interface CompileOptions extends Partial<EmitOptions> {
  /** Absolute path of the working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Suppress diagnostic output. Defaults to false. */
  silent?: boolean;
}

export interface CompileResult {
  results:     EmitResult[];
  diagnostics: import("./resolver").Diagnostic[];
  hasErrors:   boolean;
}

/**
 * Compile and run a Delta source string end-to-end.
 *
 * @example
 * ```ts
 * import { compile } from "@delta-lang/cli";
 *
 * const { results, hasErrors } = await compile(source, { cwd: "/my/project", preview: true });
 * ```
 */
export async function compile(
  src:  string,
  opts: CompileOptions = {}
): Promise<CompileResult> {
  const cwd     = opts.cwd     ?? process.cwd();
  const preview = opts.preview ?? false;
  const verbose = opts.verbose ?? false;

  const tokens = tokenise(src);
  const ast    = parse(tokens);
  const { order, registry, diagnostics, hasErrors } = resolve(ast, cwd);

  if (hasErrors) {
    return { results: [], diagnostics, hasErrors };
  }

  const results = await emit(order, registry, { cwd, preview, verbose });
  return { results, diagnostics, hasErrors };
}
