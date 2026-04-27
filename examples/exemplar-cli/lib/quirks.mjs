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

// Detect which of `def.brokenListFilters` the user populated on this call.
// Returns a {flag: value} map (empty when none). Callers should drop these
// from the wire query, fetch the full list, and run `clientFilter` on the
// result.
export function pickBrokenFilters(values, def) {
  if (!def?.brokenListFilters?.length) return {};
  const out = {};
  for (const k of def.brokenListFilters) {
    const v = values[k];
    if (v !== undefined && v !== "") out[k] = String(v);
  }
  return out;
}

// Client-side fallback for list endpoints whose upstream-API filter is
// silently ignored. Compares each requested value against the row's
// same-named field with case-insensitive equality OR substring match (the
// substring covers prefix-style number lookups users typically want).
export function clientFilter(items, filters) {
  const checks = Object.entries(filters);
  if (!checks.length) return items;
  return items.filter((row) =>
    checks.every(([k, target]) => {
      const v = row?.[k];
      if (v === undefined || v === null) return false;
      const a = String(v).toLowerCase();
      const b = String(target).toLowerCase();
      return a === b || a.includes(b);
    }),
  );
}
