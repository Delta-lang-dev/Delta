code:`// src/types/captures.ts
// ─── Delta Meta-Variable Capture System ──────────────────────────────────
// Handles $UPPER_SNAKE_CASE wildcards in patch find/replace blocks.
// Example: find { logger($MSG) } replace with { console.log($MSG) }

export type CaptureMap = Map<string, string>;

/**
 * Replace $VAR placeholders in a template with captured values.
 * applyCaptures("logger.info($MSG)", Map{MSG: '"hello"'})
 * → 'logger.info("hello")'
 */
export function applyCaptures(template: string, captures: CaptureMap): string {
  let result = template;
  captures.forEach((value, key) => {
    result = result.replaceAll(\`$\${key}\`, value);
    result = result.replaceAll(\`\\\${\${key}}\`, value);
  });
  return result;
}

/**
 * Extract $VAR names from a pattern string.
 * extractMetaVars("fn login($USER, $PASS)") → ["USER", "PASS"]
 */
export function extractMetaVars(pattern: string): string[] {
  const matches = pattern.matchAll(/\$([A-Z][A-Z0-9_]*)/g);
  return [...matches].map(m => m[1]!);
}

/**
 * Build a RegExp from a pattern containing $VAR wildcards.
 * patternToRegex("logger($MSG)") → /logger\((?<MSG>[^,)\s]+)\)/
 */
export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^{}()|[\]\\]/g, "\\$&")
    .replace(/\\\$([A-Z][A-Z0-9_]*)/g, "(?<$1>[^,)\\s]+)");
  return new RegExp(escaped, "gm");
}

/**
 * Match a pattern with $VARs against source. Returns CaptureMap or null.
 */
export function matchPattern(src: string, pattern: string): CaptureMap | null {
  const re    = patternToRegex(pattern);
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
 */
export function applyWithCaptures(
  src: string, findPattern: string, replaceTemplate: string
): string {
  const metaVars = extractMetaVars(findPattern);
  if (metaVars.length === 0) {
    return src.split(findPattern.trim()).join(replaceTemplate.trim());
  }
  const re = patternToRegex(findPattern);
  return src.replace(re, (_match, ...args) => {
    const groups = args[args.length - 1] as Record<string, string>;
    const captures: CaptureMap = new Map(Object.entries(groups ?? {}));
    return applyCaptures(replaceTemplate, captures);
  });
}`
  },
{
