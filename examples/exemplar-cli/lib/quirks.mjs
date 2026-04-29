// Helpers for two upstream-API quirks generated CLIs encounter often.
// See knowledge/query-flags-and-broken-list-filters.md for the full
// contract; this module is the reusable substrate the bin/ runtime
// composes against.

// Pick the queryFlag values out of `values` and return them as a flat
// query object suitable for apiRequest({ query }). Returns undefined when
// no queryFlags are populated, so callers can detect "no extra query".
export function pickQueryFlags(values, def) {
  if (!def?.queryFlags?.length) return undefined;
  const out = {};
  for (const k of def.queryFlags) {
    const v = values[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Strip queryFlag-bound keys from a values object, so callers can hand the
// remainder to a payload builder without leaking those flags into the body.
// Pure: returns a new object, leaves `values` alone.
export function stripQueryFlags(values, def) {
  if (!def?.queryFlags?.length) return { ...values };
  const out = { ...values };
  for (const k of def.queryFlags) delete out[k];
  return out;
}

// `brokenListFilters` may be either a flat list of flag names (legacy v0.5
// shape) OR a list of `{ name, match }` objects (v0.6+, per-flag match mode).
// Normalize both into `{ name, match }`. Default match is "equals".
function normalizeBrokenFilters(def) {
  if (!def?.brokenListFilters?.length) return [];
  return def.brokenListFilters.map((entry) =>
    typeof entry === "string"
      ? { name: entry, match: "equals" }
      : { name: entry.name, match: entry.match || "equals" },
  );
}

// Detect which of `def.brokenListFilters` the user populated on this call.
// Returns a `{ flag: { value, match } }` map (empty when none). Callers
// should drop these from the wire query, fetch the full list, and run
// `clientFilter` on the result.
export function pickBrokenFilters(values, def) {
  const out = {};
  for (const { name, match } of normalizeBrokenFilters(def)) {
    const v = values[name];
    if (v !== undefined && v !== "") out[name] = { value: String(v), match };
  }
  return out;
}

// Client-side fallback for list endpoints whose upstream-API filter is
// silently ignored. Per-filter match modes:
//   - "equals"     — case-insensitive exact equality.
//   - "startswith" — case-insensitive prefix match.
//   - "contains"   — case-insensitive substring match.
// `filters` is the `{ name: { value, match } }` map from pickBrokenFilters.
// Backwards-compatible: callers passing the legacy `{ name: value }` shape
// are coerced to `{ value, match: "equals-or-contains" }` for the v0.5
// hybrid behavior (case-insensitive equals OR substring).
export function clientFilter(items, filters) {
  const checks = Object.entries(filters);
  if (!checks.length) return items;
  const normalized = checks.map(([k, raw]) => {
    if (raw && typeof raw === "object" && "value" in raw) return [k, raw];
    return [k, { value: raw, match: "equals-or-contains" }];
  });
  return items.filter((row) =>
    normalized.every(([k, { value, match }]) => {
      const v = row?.[k];
      if (v === undefined || v === null) return false;
      const a = String(v).toLowerCase();
      const b = String(value).toLowerCase();
      switch (match) {
        case "equals":
          return a === b;
        case "startswith":
          return a.startsWith(b);
        case "contains":
          return a.includes(b);
        case "equals-or-contains":
        default:
          return a === b || a.includes(b);
      }
    }),
  );
}
