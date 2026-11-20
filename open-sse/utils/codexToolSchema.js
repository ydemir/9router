// Codex-specific tool JSON Schema compatibility.
//
// `https://chatgpt.com/backend-api/codex/responses` validates every function
// tool's `parameters` with a regex engine that does not implement Unicode
// property escapes. A `pattern` such as
//
//   "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./\\[\\]]{1,200}$"
//
// is a perfectly valid ECMAScript `u`-mode regex, but Codex answers
//
//   400 Invalid schema for function 'Artifact': '^\p{Cc}...' is not a 'regex'
//   param: tools[0].parameters
//
// The request is deterministically malformed for this provider, so every
// account fails identically and the combo pays a full failover before landing
// somewhere that accepts it (#3922).
//
// Scope guardrail (#3667): this is NOT a global schema sanitizer. Providers
// that support these constraints keep them untouched. Codex also rejects the
// `uniqueItems` keyword (#5750).

// `\p{...}` / `\P{...}` with an odd number of preceding backslashes — an even
// count means the backslash itself is escaped, so `\\p{Cc}` is a literal "p".
const UNICODE_PROPERTY_ESCAPE = /(^|[^\\])(\\\\)*\\[pP]\{/;
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const LITERALS = new Set(["default", "enum", "const", "examples"]);

export function hasUnicodePropertyEscape(pattern) {
  return typeof pattern === "string" && UNICODE_PROPERTY_ESCAPE.test(pattern);
}

// Copy-on-write walk: returns the original reference when nothing changed, so
// untouched schemas keep object identity and callers can cheaply detect a no-op.
// Schema maps use arbitrary names, and literal values are never schema nodes.
function stripNode(node, stats) {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const cleaned = stripNode(item, stats);
      if (cleaned !== item) changed = true;
      return cleaned;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;

  let changed = false;
  const next = { ...node };
  for (const [key, value] of Object.entries(node)) {
    if (key === "uniqueItems" || (key === "pattern" && hasUnicodePropertyEscape(value))) {
      stats.removed++;
      changed = true;
      delete next[key];
      continue;
    }
    if (LITERALS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      const removedBefore = stats.removed;
      const entries = Object.entries(value).map(([name, schema]) => [name, stripNode(schema, stats)]);
      if (stats.removed !== removedBefore) {
        next[key] = Object.fromEntries(entries);
        changed = true;
      }
      continue;
    }
    const cleaned = stripNode(value, stats);
    if (cleaned !== value) changed = true;
    next[key] = cleaned;
  }
  return changed ? next : node;
}

// Remove only the `pattern` and `uniqueItems` constraints Codex rejects.
// Returns the same reference when the schema is already compatible.
export function stripUnsupportedCodexToolSchema(schema, stats = { removed: 0 }) {
  return stripNode(schema, stats);
}
