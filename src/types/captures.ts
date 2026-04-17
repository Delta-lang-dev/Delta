// types/captures.ts
// ─── Delta Meta-Variable Capture System ──────────────────────────────────
// Handles $UPPER_SNAKE_CASE wildcards in patch find/replace blocks.
// Example: find { logger($MSG) } replace with { console.log($MSG) }

// ⚠️  Warning: This is a lightweight regex-based system.
//     It works great for simple, local patterns but can fail on:
//     - nested expressions
//     - strings containing delimiters (commas, parentheses)
//     - comments, template literals, or multi-line code.
//     For production-grade codemods, use a real AST parser (ts-morph, Babel, recast, etc.).

export type CaptureMap = Map<string, string>;

/** Escape special characters for RegExp (used internally) */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace $VAR and ${VAR} placeholders in a template with captured values.
 * applyCaptures("logger.info($MSG)", Map{MSG: '"hello"'})
 * → 'logger.info("hello")'
 * Also supports ${MSG} form.
 */
export function applyCaptures(template: string, captures: CaptureMap): string {
  let result = template;
  for (const [key, value] of captures) {
    // Matches both $KEY and ${KEY} (most flexible and safe)
    const re = new RegExp(`\\\( \\{? \){escapeRegExp(key)}\\}?`, 'g');
    result = result.replace(re, value);
  }
  return result;
}

/**
 * Extract $VAR names from a pattern string.
 * extractMetaVars("fn login($USER, $PASS)") → ["USER", "PASS"]
 */
export function extractMetaVars(pattern: string): string[] {
  const matches = pattern.matchAll(/\$([A-Z][A-Z0-9_]*)/g);
  return [...matches].map((m) => m[1]!);
}

/**
 * Build a RegExp from a pattern containing $VAR wildcards.
 * patternToRegex("logger($MSG)") → /logger\((?<MSG>[^,)]+?)\)/g
 *
 * Capture group is deliberately simple but much better than the original:
 * [^,)]+?  → stops before comma or closing parenthesis (non-greedy).
 * Still regex, so complex nested code remains a limitation.
 */
export function patternToRegex(pattern: string): RegExp {
  let regexStr = escapeRegExp(pattern);

  // $VAR → named capture group (?<VAR>[^,)]+?)
  regexStr = regexStr.replace(
    /\\\$([A-Z][A-Z0-9_]*)/g,
    (_, name) => `(?<${name}>[^,)]+?)`
  );

  return new RegExp(regexStr, 'g');
}

/**
 * Match a pattern with $VARs against source. Returns CaptureMap or null.
 */
export function matchPattern(src: string, pattern: string): CaptureMap | null {
  const re = patternToRegex(pattern);
  const match = re.exec(src);
  if (!match?.groups) return null;

  const captures: CaptureMap = new Map();
  for (const [key, value] of Object.entries(match.groups)) {
    if (value !== undefined) captures.set(key, value);
  }
  return captures;
}

/**
 * Apply find/replace with $VAR capture support across entire source.
 * Fully robust global replacement using exec loop (no reliance on .replace callback quirks).
 */
export function applyWithCaptures(
  src: string,
  findPattern: string,
  replaceTemplate: string
): string {
  const metaVars = extractMetaVars(findPattern);

  // No meta variables → simple, exact string replacement (modern & safe)
  if (metaVars.length === 0) {
    return src.replaceAll(findPattern, replaceTemplate);
  }

  const re = patternToRegex(findPattern);

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(src)) !== null) {
    // Text before this match
    result += src.slice(lastIndex, match.index);

    // Build captures from named groups
    const captures: CaptureMap = new Map();
    if (match.groups) {
      for (const [key, value] of Object.entries(match.groups)) {
        if (value !== undefined) captures.set(key, value);
      }
    }

    // Apply template
    result += applyCaptures(replaceTemplate, captures);

    lastIndex = re.lastIndex;
  }

  // Remaining text after the last match
  result += src.slice(lastIndex);
  return result;
}
