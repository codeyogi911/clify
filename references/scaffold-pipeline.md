# Scaffold pipeline — per-phase detail

The `clify` skill's six phases are summarized in `skills/clify/SKILL.md`. This file is the in-depth reference for each phase, covering edge cases and the file-by-file substitution checklist. Read it when the lean SKILL.md is too terse for the situation at hand — you don't need to load it on every scaffolding run.

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

### Resource grouping

Group by the first non-version path segment. `/v1/items/:id` → `items`. `/api/v2/customers/:id/orders` → `customers` with `orders` as a sub-resource (flatten to `customer-orders`).

### Nesting cap

Two levels max — `<resource> <action>` or `<sub-resource> <action>`. Anything deeper gets flattened into a hyphenated resource name. If a single resource has more than ~10 actions, split it into sub-resources rather than packing them all into one command file.

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

Edit `SCHEME` and `ENV_VAR` constants. Add a branch in `applyAuth` if your scheme isn't already there. The validation gate accepts: `bearer | api-key-header | basic | none`. For OAuth-style flows that need refresh, model them as `bearer` — the refresh logic lives in `login.mjs`.

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
  "coverage": { "totalParsed": N, "totalIncluded": M, "totalDropped": K }
}
```

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

Re-author resource lists, common workflows, error handling. Keep the structural sections (Layout, Use, Test).

---

## Phase 6: Validate, simplify, report

### Failure remediation

- **manifest** — fix the named field; cross-manifest mismatches usually mean `package.json` was edited but `plugin.json` wasn't.
- **coverage** — every `included: false` needs `dropped: true` + a valid `reason`.
- **structural** — a resource or action is in coverage but not in `--help`, or vice versa. Check the registry vs the help-text generator.
- **nuances** — declared a hard-fail nuance but didn't add the artifact. Either add it or set the nuance to empty.
- **secrets** — a real key pattern leaked. Remove it.
- **ci** — `.github/workflows/test.yml` missing or doesn't run `npm test`.
- **tests** — exemplar smoke/integration tests fail. Read `stderrTail` and fix the source.

Up to 3 attempts. After that, surface the remaining failures to the user verbatim. Never claim done with failures.

### Simplify pass

After the gate passes, run `/simplify` over the files you edited. Look for:

- Duplicated payload-building logic across `create`/`update` actions of the same resource → factor into `buildPayload`.
- Per-resource flag specs that share 80%+ fields → factor into a shared object spread.
- Help text that re-states what `flags[].description` already says → drop.

Don't break a contract from `conventions.md` to win clarity. The contracts win.

### Report

End-of-scaffold summary should include:

- API name + version (if known)
- Resources × actions: how many, listed
- Dropped endpoints: how many, with reasons
- Declared nuances: which fields are non-empty in `.clify.json.nuances`
- Knowledge files written: list
- Validation gate result: pass/fail with categories
- Path to generated repo
- Next step: `cd <repo> && npm test`
