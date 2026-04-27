---
type: contract
source: clify v0.5
applies-to: ["bin/<api>-cli.mjs", "commands/*.mjs"]
---

# `queryFlags` and `brokenListFilters` action annotations

Two action-def annotations let generated CLIs handle common upstream-API
quirks without per-resource glue code in `bin/`.

## `queryFlags` — convert-from-X creates

Some APIs document a "convert from X" mode on a `POST` create where the
parent foreign key is a **URL query parameter**, not a body field. Putting
the FK in the JSON body is silently dropped — the resulting record has no
structural link back to the source. The canonical example is Zoho:

```
POST /creditnotes ?invoice_id=<INV>   ← convert-from-invoice mode (UI-equivalent)
POST /creditnotes  + body invoice_id  ← invoice_id stays null on the resulting CN
```

Mark the flag in the action def:

```js
create: {
  method: "POST",
  path: "/creditnotes",
  flags: { invoiceId: { type: "string", description: "Source invoice id (URL query)" }, ... },
  queryFlags: ["invoiceId"],
}
```

The runtime in `bin/<api>-cli.mjs`:
- Strips `queryFlags` keys from the body before calling `buildPayload`.
- Routes them onto the URL via `apiRequest.query`.
- Verify with `--dry-run`: `__dryRun.url` contains `?invoiceId=…` and
  `__dryRun.body` does NOT contain `invoiceId`.

## `brokenListFilters` — silently-ignored list filters

Some `GET …/list` endpoints accept filter query parameters that the server
silently ignores: `200 OK`, no error header, full unfiltered list returned.
Detection requires comparing baseline (no filter) and `FAKE-NONEXISTENT`
(impossible value) row counts — equal counts means the filter is broken.

```js
list: {
  method: "GET",
  path: "/orders",
  flags: { customerId: { type: "string", description: "Filter (BROKEN upstream — client-side fallback)" } },
  brokenListFilters: ["customerId"],
}
```

Runtime behavior when the user passes a broken filter:
1. Strip the filter from the wire query.
2. Pull the full list via cursor pagination.
3. Filter client-side (case-insensitive equals OR substring) on the
   row's same-named field.
4. Write a one-line `note: …` to stderr.

Cost goes up to the full-list response size. For small datasets this is
trivial; for larger ones, callers should pull once and filter themselves.

## Discovery checklist

When generating or auditing a CLI:

1. For every documented `POST <resource>` create — does the API doc list a
   foreign-key parameter under "Query parameters" (not "Body parameters")?
   If yes, add it to `queryFlags`. (Common APIs that do this:
   Zoho Inventory/Books, Zoho CRM, Xero, Razorpay X.)
2. For every list endpoint — pick one declared filter and compare the
   row count with `--<filter> FAKE-NONEXISTENT-XYZ` against an
   unfiltered call. Equal counts → broken; declare in `brokenListFilters`
   AND clarify the help text.

A new clify version should re-run these probes whenever the upstream
docs change (`clify sync-check` flags doc drift; the manual probe is the
final word on filter behavior).
