# Scaffold pipeline — per-phase detail

The `clify` skill's seven phases are summarized in `skills/clify/SKILL.md`. This file is the in-depth reference for each phase, covering edge cases and the file-by-file substitution checklist. Read it when the lean SKILL.md is too terse for the situation at hand — you don't need to load it on every scaffolding run.

---

## Phase 1: Fetch & detect

### OpenAPI / Swagger fast path

If the URL serves JSON or YAML with a top-level `openapi:` or `swagger:` key, parse it directly. Fields you care about:

- `paths.<path>.<method>` → method, path, operation id
- `parameters` → required path/query params (per-method or path-level)
- `requestBody.content.<media-type>.schema` → body shape; `multipart/form-data` triggers the multipart nuance
- `responses.*.headers["Retry-After"]` / `X-RateLimit-*` → rate-limit nuance signal
- `deprecated: true` → deprecated nuance
- `securitySchemes` → auth scheme detection (`http: bearer` → `bearer`, `apiKey: header` → `api-key-header`, `http: basic` → `basic`)

### HTML / Markdown crawl

If the URL serves HTML or Markdown, use `WebFetch` and:

1. Extract anchor URLs that look like API doc pages — strip nav, marketing, changelog, examples-only pages.
2. Normalize URLs (drop fragments, lowercase host, strip trailing slash).
3. Fetch up to depth 2 with 1s rate limit.
4. Stop early if the dedupe set converges (no new URLs at depth N).

If a fetched body is empty or shorter than ~200 bytes, the page is JS-rendered. Ask the user via `AskUserQuestion`:

> "This page renders client-side and I can't extract endpoints from it. Do you have an OpenAPI/Swagger URL, or should I try a different docs URL?"

---

## Phase 2: Parse & group

### Verb mapping

| HTTP | Action | Notes |
|---|---|---|
| GET (collection) | `list` | Returns array; honor pagination headers/body |
| GET (single, has `:id` in path) | `get` | Requires `--id` flag |
| POST | `create` | Returns the created resource (or 201 with location header) |
| PUT/PATCH | `update` | Requires `--id` flag |
| DELETE | `delete` | Requires `--id` flag |

Anything else: use the API's own verb (`approve`, `cancel`, `merge-upstream`).

**Status-mutation canonical naming (HARD-FAIL):** Endpoints matching `POST /<r>/:id/status/<state>` MUST map to action `mark-<state>` — no exceptions, no per-resource variation. The validator hard-fails on bare verbs (`void`, `confirm`) for status-mutation paths.

### Resource grouping

Group by the first non-version path segment. `/v1/items/:id` → `items`. `/api/v2/customers/:id/orders` → `customers` with `orders` as a sub-resource (flatten to `customer-orders`).

### Nesting cap

Two levels max — `<resource> <action>` or `<sub-resource> <action>`. Anything deeper gets flattened into a hyphenated resource name. If a single resource has more than ~10 actions, split it into sub-resources rather than packing them all into one command file.

### Family-consistency check (HARD-FAIL in validator)

After grouping endpoints by resource, group AGAIN by sub-path tail. Common shared sub-paths: `/comments`, `/attachments`, `/refunds`, `/tags`, `/notes`, `/metadata`. If ≥3 sibling resources expose the same sub-path (e.g. invoices, credit-notes, vendor-credits all have `/:id/comments`), then any sibling that shares the parent shape but LACKS that sub-path must be either:

- **Included** — add the missing endpoints to that resource (default behaviour).
- **Explicitly dropped** — record one entry per missing endpoint in `coverage.json` with `reason: "sibling-asymmetry-confirmed"` (only when the API genuinely lacks the sub-path for that sibling; verify against docs before using this).

Why hard-fail: in the Fix Coffee Zoho rollout, `/comments` was generated for 5 of 7 sibling resources and silently skipped on the rest. Users had to hand-add the missing actions. The family-consistency check catches this at gate time.

### List-filter extraction (canonical contract)

Generated CLIs systematically lose information at this step — collapsing
documented variant names into bare flags, then blanket-marking the
result as BROKEN when one probe with the wrong name fails. The
`filter-coverage` validator check (v0.6+) enforces the rules below.

1. **Every documented query-parameter on a `GET …/list` endpoint becomes
   its own flag, named verbatim.** When the docs list
   `customer_name_startswith`, `customer_name_contains`,
   `reference_number_startswith`, `date_start`, `date_end`, `filter_by`,
   emit ALL of them — six flags, not one collapsed `--customer_name`.
   The suffix encodes the server-side match mode and is not optional.
2. **Enum values go in the flag spec.** When the docs say `filter_by`
   accepts `All|NotShipped|Shipped|Delivered`, set
   `flags.filter_by.enum: ["All", "NotShipped", "Shipped", "Delivered"]`
   AND include them in `flags.filter_by.description`. The exemplar's
   help generator reads `enum` and renders inline allowed-values.
3. **Sort flags are auto-emit.** For any list endpoint, add
   `--sort_column` (string) and `--sort_order` (`asc|desc`, enum) even if
   not explicitly tabled. Almost every paginated list API supports them
   and the absence in docs is almost always an omission.
4. **Per-flag probe.** When the API can be reached at generation time,
   probe each filter individually:
   - Make one unfiltered request → record `baselineCount` (response row count).
   - For each filter, make one request with a value that should match ≥1
     record (use a real value sampled from the unfiltered response, or
     the first enum value for `filter_by`-style flags).
   - Record `filteredCount`.
   - Status:
     - `filteredCount < baselineCount` (and ≥0) → `verified`.
     - `filteredCount === baselineCount` → `broken` (server ignored it).
     - couldn't probe (no creds, network blocked, rate-limited) →
       `untested`. Leave the flag working, do NOT add to
       `brokenListFilters`.
5. **Write the probe log to `.clify.json.filterProbes`.** Schema:
   ```json
   {
     "filterProbes": [
       { "resource": "packages", "filter": "filter_by",        "baselineCount": 319, "filteredCount": 83,  "status": "verified" },
       { "resource": "packages", "filter": "status",           "baselineCount": 319, "filteredCount": 319, "status": "broken" },
       { "resource": "packages", "filter": "date_start",       "baselineCount": 319, "filteredCount": 319, "status": "untested", "note": "no upstream test data in date range" }
     ]
   }
   ```
   The validator's `filter-coverage` check reads this in Phase 6:
   - If a list action declares filter-shaped flags (anything not in
     `{id, page, cursor, limit, offset, per_page, sort_column,
     sort_order}`) and `filterProbes` has zero entries for that
     resource → HARD-FAIL ("Phase 5 skipped probe step").
   - If every filter on a list action is in `brokenListFilters` AND
     `filterProbes` shows no individual probes → HARD-FAIL (the
     blanket-mark anti-pattern).
   - If a filter is `untested` → WARN, not fail. Untested-at-generation
     is fine; silent blanket-marking is not.

**Worked example — Zoho Inventory `packages list`:** Docs declare
`filter_by` (enum: All|NotShipped|Shipped|Delivered), `customer_name_startswith`,
`reference_number_startswith`, `date_start`, `date_end`, `sort_column`, `sort_order`.
Pre-v0.6 generation collapsed these into a bare `--status`, probed it,
saw the API ignore `status`, and marked all nine filters as broken.
Correct generation: emit each flag verbatim, probe `--filter_by Shipped`
(returns 83 vs unfiltered 319 → `verified`), probe the rest, only mark
the genuinely-ignored ones as broken. The `customer_name_startswith` and
`reference_number_startswith` are usually verified; `filter_by` is
verified; `status` (if mistakenly emitted) is broken.

### Nuance detection cheat sheet

| Signal | Nuance | Artifact |
|---|---|---|
| `cursor` / `next_page_token` / `page` / `offset` / `Link: rel=next` in responses | pagination=cursor\|page\|offset\|link-header | Multi-page integration test |
| `Idempotency-Key` header documented | idempotency=[<resource>.<action>...] | `--idempotency-key` flag wired; integration test asserts header |
| `multipart/form-data` content type | multiPart=[<resource>.<action>...] | `--file` flag wired; integration test posts a fixture |
| `deprecated: true` or "deprecated" prose | deprecated=[<resource>.<action>...] | `knowledge/deprecated-<resource>.md` OR coverage drop with reason `deprecated-in-docs` |
| `X-RateLimit-*` headers, "rate limit" prose | rateLimits=true | `knowledge/rate-limit.md` (soft warn) |
| OAuth scopes documented | authScopes=true | `knowledge/auth-scopes.md` (soft warn) |
| `If-Match` / `ETag` documented | conditional=[<resource>.<action>...] | `--if-match` flag (soft warn) |

---

## Phase 3: Consult

### Resource grouping

Surface ambiguous groupings via `AskUserQuestion`:

> "I parsed N endpoints into K resources. Two are ambiguous: should `/v1/users/:id/preferences` be a sub-resource of `users` (flattened to `user-preferences`) or its own top-level resource `preferences`? My default is `user-preferences`."

### Drop list

If you found endpoints that won't fit (webhook subscription POSTs, streaming SSE endpoints, deeply-nested actions, beta-flagged endpoints), surface the list:

> "I'm going to drop these N endpoints. Reasons: [...]. Confirm or call out any I should keep?"

Allowed drop reasons (validation gate enforces): `user-excluded-step-7`, `deprecated-in-docs`, `beta-flagged`, `internal-only`, `nesting-depth-cap`, `webhook-not-cli-shaped`, `streaming-not-cli-shaped`.

### Repo location

The generated CLI is a **separate project**, not nested inside the cwd. Default placement: `<parent-of-cwd>/<api-name>-cli/`. Ask:

> "Where should I put `<api-name>-cli/`? Default is `<parent-of-cwd>` (sibling of your current directory). I'll also `git init` the new repo unless you say otherwise."

Options:
- **Default** — parent of cwd. Right answer for almost every case.
- **Custom path** — user supplies absolute or relative.
- **Here (nested)** — only when explicit; warn that this couples the new CLI's git history to the parent.

---

## Phase 4: Init from exemplar

```
clify scaffold-init <api-name> --target <chosen-parent-dir>
```

What this does:

1. Copies `examples/exemplar-cli/` to `<target>/<api-name>-cli/` (refuses if dir exists).
2. Renames every file/dir containing `exemplar` to use `<api-name>` instead.
3. In every text file, rewrites `exemplar` → `<api-name>`, `EXEMPLAR` → `<API_NAME>`, `Exemplar` → `<API Title>` in that order.

After scaffold-init:

```
cd <chosen-parent-dir>/<api-name>-cli && git init -q && git add -A && git commit -q -m "Initial scaffold from clify exemplar"
```

The initial commit makes Phase 5's substitutions a clean diff the user can review.

---

## Phase 5: Substitute — file-by-file checklist

### `commands/<resource>.mjs`

Replace the exemplar's three command files (`items.mjs`, `item-variants.mjs`, `orders.mjs`, `login.mjs`) with one file per parsed resource. Each default-exports:

```js
export default {
  name: "<resource>",
  actions: {
    <action>: { method, path, description, flags: { /* ... */ } },
    // ...
  },
  buildPayload(values) { /* return JSON body */ },
};
```

Keep `login.mjs` if the API has authentication; delete it if `auth.scheme === "none"`.

Flag rules:

- Path params (`:id`, `:itemId`) become required string flags with the same name.
- Query params become optional flags.
- Body fields become individual flags. Common rule: keep a `--body <json>` raw escape hatch.
- Idempotent endpoints get `--idempotency-key` (a string flag).
- Conditional endpoints get `--if-match` (a string flag).
- Multipart upload endpoints take `--file <path>` (required).

### `bin/<api-name>-cli.mjs`

Edit only:
- The `import` lines for each `commands/<resource>.mjs` file.
- The `COMMANDS = [...]` array.

Leave `loadEnv`, `splitGlobal`, `runResourceAction`, `interpolatePath`, `main` exactly as in the exemplar.

### `lib/auth.mjs`

The exemplar ships with FIVE schemes implemented: `bearer | api-key-header | basic | none | oauth-refresh`. Pick the right one by editing the `SCHEME` constant (which the exemplar guards with a `__EXEMPLAR_DEV_SCHEME` env fallback for testing — REPLACE the entire line with a hardcoded `const SCHEME = "<chosen>";` so generated CLIs never honor the env override).

For `bearer | api-key-header | basic | none`: set `SCHEME` and `ENV_VAR`. Done.

For `oauth-refresh` (Zoho, Google, Notion, GitHub Apps, Slack, Stripe Connect, …):

1. Set `SCHEME = "oauth-refresh"`, `ENV_VAR = "<API>_API_KEY"`.
2. Set the OAuth substitution constants — `TOKEN_URL`, `REFRESH_ENV`, `CLIENT_ID_ENV`, `CLIENT_SECRET_ENV`, `NO_CACHE_ENV` — to the API's prefix.
3. Set `OAUTH_WIRE_PREFIX` (default `"Bearer"`; override for APIs like Zoho that use `"Zoho-oauthtoken"`).
4. **Do NOT modify** `refreshAccessToken`, `resolveOAuthToken`, `applyAuth`, or `authStatus`. The exemplar's precedence (env access wins → env refresh creds mint → cache only when refreshTokenHash matches → stored creds → fail) is the contract. Re-rolling it has been the #1 source of generated-CLI auth bugs.
5. Also update `.clify.json.auth.{tokenUrl, refreshEnvVar, clientIdEnvVar, clientSecretEnvVar}` — the validator hard-fails their absence under `oauth-refresh`.

If the OAuth provider needs additional region/datacenter routing (e.g. Zoho's `accounts.zoho.<dc>` host), wrap `TOKEN_URL` in a small function that reads a `<API>_DC` env var and selects the right hostname; do not split into a separate auth flow. See `~/Repos/zoho-inventory-cli/lib/auth.mjs` for the reference DC-routing pattern (this is the only API-specific extension allowed in the OAuth file).

### `lib/api.mjs`

Generally unchanged. Edit the `BASE_URL` default if the API doesn't have a single canonical URL (e.g., region-routed APIs may need a `<API>_REGION` env var that selects the base URL — add it next to `BASE_URL`).

### `.clify.json`

```json
{
  "apiName": "<api-name>",
  "docsUrl": "<original URL>",
  "crawledUrls": ["<every fetched URL>"],
  "contentHash": "sha256:<hash of all crawled bodies>",
  "generatedAt": "<ISO-8601 UTC>",
  "clifyVersion": "<from clify package>",
  "auth": { "envVar": "<API>_API_KEY", "scheme": "<scheme>", "validationCommand": "<resource> <action>" },
  "nuances": { /* every detected nuance */ },
  "coverage": { "totalParsed": N, "totalIncluded": M, "totalDropped": K },
  "filterProbes": [
    { "resource": "<r>", "filter": "<flag>", "baselineCount": <int>, "filteredCount": <int>, "status": "verified" | "broken" | "untested", "note": "<optional>" }
  ]
}
```

`filterProbes` is read by the `filter-coverage` validator check (v0.6+).
One entry per probed-or-skipped filter. Skipping a filter entirely (no
entry) is forbidden when the resource declares filter-shaped flags —
the validator hard-fails that.

### `.env.example`

For `scheme !== none`, include:

```
# @required
# @how-to-get <where to obtain the credential>
# @format <pattern, optional>
<API>_API_KEY=your_<api>_api_key_here

# @optional
# @validation-command <resource> <action>
# <API>_BASE_URL=http://127.0.0.1:3000
```

### `skills/<api-name>-cli-workflow/SKILL.md`

Rewrite Triggers, Quick Reference table, Common Workflows. Preserve the YAML frontmatter shape (name, description, allowed-tools). The skill must mention every resource and the `knowledge/` directory.

### `skills/<api-name>-cli-{auth,resources,knowledge}/SKILL.md`

Light edit. Auth: update token storage notes. Resources: regenerate the resource × action table from the parsed registry. Knowledge: list the knowledge files extracted from docs.

### `test/integration.test.mjs`

For each resource, exercise every action against the mock server. Fixture data should match the API's response shape. Add nuance tests:

- Pagination → multi-page test using a function handler that toggles on `req.query.cursor`.
- Idempotency → assert `server.requests[0].headers["idempotency-key"]` is sent.
- Multipart → use a temp file and assert `content-type` matches `/multipart\/form-data/`.

### `coverage.json`

One entry per parsed endpoint. Schema:

```json
{ "method": "GET", "path": "/items", "resource": "items", "action": "list", "included": true }
{ "method": "POST", "path": "/items/bulk", "resource": null, "action": null, "included": false, "dropped": true, "reason": "user-excluded-step-7" }
```

### `knowledge/<short-topic>.md`

For each business rule, gotcha, or quirk extracted from prose. Frontmatter:

```yaml
---
type: business-rule | gotcha | pattern | shortcut | quirk
applies-to: ["<resource>.<action>", ...]
source: docs | runtime
confidence: high | medium | low
extracted: <YYYY-MM-DD>
---
```

### `README.md` and `AGENTS.md`

Re-author resource lists, common workflows, error handling. Keep the structural sections — and **lead with `## Install` and `## Authenticate`** before any other section. The validator hard-fails if either is missing.

`## Install` — `git clone … && npm install && npm link && <bin> --version`. No more, no less.

`## Authenticate` — scheme-aware. Static schemes show the env-var path AND the `<bin> login --token` path. `oauth-refresh` shows the three OAuth env vars (`<API>_REFRESH_TOKEN`, `<API>_CLIENT_ID`, `<API>_CLIENT_SECRET`), the `<API>_NO_CACHE` opt-out, AND the `<bin> login --refresh-token --client-id --client-secret` form. Reference: `examples/exemplar-cli/README.md`.

---

## Phase 6: Validate & simplify

### Failure remediation

- **manifest** — fix the named field; cross-manifest mismatches usually mean `package.json` was edited but `plugin.json` wasn't. `bin file is not executable` → run `chmod +x bin/<api>-cli.mjs` (the scaffold-init step does this automatically; if it's missing, the user generated outside `scaffold-init`).
- **coverage** — every `included: false` needs `dropped: true` + a valid `reason`. `family-consistency: sibling-asymmetry` → either include the missing endpoints or add explicit drop entries with `reason: "sibling-asymmetry-confirmed"`. `status-mutation actions must use canonical mark-<state> naming` → rename the actions in `commands/<r>.mjs` and `coverage.json`.
- **structural** — a resource or action is in coverage but not in `--help`, or vice versa. Check the registry vs the help-text generator. `README.md missing required section(s)` → add `## Install` and/or `## Authenticate`.
- **secrets** — `dry-run output leaks credential-shaped value` → the LLM bypassed the exemplar's `redactHeaders` in `lib/api.mjs`. Restore the redaction; only `--show-secrets` opts out.
- **nuances** — declared a hard-fail nuance but didn't add the artifact. Either add it or set the nuance to empty.
- **ci** — `.github/workflows/test.yml` missing or doesn't run `npm test`.
- **tests** — exemplar smoke/integration tests fail. Read `stderrTail` and fix the source.

Up to 3 attempts. After that, surface the remaining failures to the user verbatim. Never claim done with failures.

### Simplify pass

After the gate passes, run `/simplify` over the files you edited. Look for:

- Duplicated payload-building logic across `create`/`update` actions of the same resource → factor into `buildPayload`.
- Per-resource flag specs that share 80%+ fields → factor into a shared object spread.
- Help text that re-states what `flags[].description` already says → drop.

Don't break a contract from `conventions.md` to win clarity. The contracts win.

---

## Phase 7: Verify (subagent pass) & ship

The validator catches structural failures, but it can't catch "the LLM substituted the wrong env var" or "the OAuth `TOKEN_URL` is still the exemplar default". Phase 7 spawns an `Explore` subagent to audit the generated repo against an end-to-end checklist before the skill declares done.

### Subagent prompt template

> Audit the generated CLI at `<absolute-path>` against this checklist. Report each item as PASS / FAIL with one-line evidence. Do not modify files.
>
> 1. **Bin executable**: `stat -f %Lp bin/<api>-cli.mjs` returns `755` (or run the bin directly: `bin/<api>-cli.mjs --version` exits 0 without `node` prefix).
> 2. **Dry-run secret redaction**: run `<bin> <pick-a-list-action> --dry-run --json` with a fake credential-shaped env var. Output must contain `"<redacted>"` for auth headers and must NOT contain the fake credential value.
> 3. **README structure**: `README.md` contains `## Install` and `## Authenticate` headings, in order, before any other `##` heading.
> 4. **OAuth wiring** (when `.clify.json.auth.scheme === "oauth-refresh"`): `lib/auth.mjs` `TOKEN_URL` is NOT the exemplar default (`api.exemplar.test/oauth/token`); `REFRESH_ENV` / `CLIENT_ID_ENV` / `CLIENT_SECRET_ENV` use the API's prefix; `.env.example` documents the three OAuth vars with `@required-when scheme=oauth-refresh` annotations.
> 5. **Family-consistency**: re-group `coverage.json.endpoints` by sub-path tail. For each tail in `[comments, attachments, refunds, tags, notes, metadata]` exposed by ≥3 resources, every sibling either includes that sub-path OR has a `coverage.json` drop with `reason: "sibling-asymmetry-confirmed"`.
> 6. **Status-verb canonical**: every `POST /<r>/:id/status/<state>` endpoint maps to action `mark-<state>` in `commands/<r>.mjs` and `coverage.json`.
> 7. **No hand-rolled OAuth logic** (when scheme is oauth-refresh): `lib/auth.mjs`'s function bodies for `refreshAccessToken`, `resolveOAuthToken`, `applyAuth`, `authStatus` match the exemplar's structure (acceptable diffs: constants only). If the LLM extended these, FAIL with the offending file:line.
>
> Return a JSON object: `{ ok, items: [{ id, status, evidence }], blockers: [...] }`.

### Acting on the report

- All items PASS → ship: write the end-of-scaffold report and surface the repo path to the user.
- Any FAIL → loop back to Phase 5 (Substitute), fix the offending files, re-run Phase 6 (Validate), then re-run Phase 7. Up to 2 retries. After that, surface the failures verbatim and stop — never claim done.

### Report (final)

End-of-scaffold summary should include:

- API name + version (if known)
- Resources × actions: how many, listed
- Dropped endpoints: how many, with reasons (group by reason for readability)
- Declared nuances: which fields are non-empty in `.clify.json.nuances`
- Knowledge files written: list
- Validation gate result: pass with N checks
- Verification subagent result: pass with N items
- Path to generated repo
- Next steps: `cd <repo> && npm install && npm link && <bin> --help`
