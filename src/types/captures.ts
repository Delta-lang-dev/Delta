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
export function applyCaptures(template: string, captures: Map<string, string>): string {
  return template.replace(/\$\{?([A-Z0-9_]+)\}?/g, (match, key) => {
    return captures.get(key) ?? match; 
    // Returns the match (e.g. $VAR) if it's not in our map
  });
}

export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^{}()|[\]\\]/g, "\\$&")
    // Match the escaped \$ followed by the name
    .replace(/\\\$([A-Z][A-Z0-9_]*)/g, "(?<$1>.+?)"); 

  // Use 'g' for multiple occurrences, 's' (dotAll) if code spans lines
  return new RegExp(escaped, "g");
}

export function applyWithCaptures(src: string, findPattern: string, replaceTemplate: string): string {
  const re = patternToRegex(findPattern);
  
  // Using the replacer function with the 'groups' argument
  return src.replace(re, (...args) => {
    const groups = args[args.length - 1] as Record<string, string>;
    const captureMap = new Map(Object.entries(groups || {}));
    return applyCaptures(replaceTemplate, captureMap);
  });
}
