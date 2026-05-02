# clify Conventions

Rules and contracts for generated CLI repos. Rigid contracts (error format, `.clify.json` shape, env var override) **must** be followed exactly. Flexible guidance (command structure, nesting) should be adapted to the API.

The hand-crafted exemplar at [`examples/exemplar-cli/`](../examples/exemplar-cli/) is the canonical implementation of every rule below. When a contract here is ambiguous, the exemplar wins. The exemplar is structurally inspired by [`google/agents-cli`](https://github.com/google/agents-cli) — hierarchical subcommands, one file per resource under `commands/`, shared machinery under `lib/`, modular skills.

---

## CLI Command Structure

Generated CLIs use the resource-action pattern:

```
<api>-cli <resource> <action> [flags]
```

### Standard Actions

| HTTP Method | Action | Notes |
|-------------|--------|-------|
| GET (collection) | `list` | Returns array |
| GET (single) | `get` | Requires `--id` |
| POST | `create` | |
| PUT/PATCH | `update` | Requires `--id` |
| DELETE | `delete` | Requires `--id` |

Non-CRUD endpoints use the API's own verb (`capture`, `verify`, `merge-upstream`).

### GraphQL-first APIs

Do not flatten GraphQL APIs into fake REST endpoints. Generated CLIs still use
`<resource> <action>`, but each action definition should declare
`kind: "graphql"` plus a GraphQL document:

```js
list: {
  kind: "graphql",
  path: "/graphql",
  description: "List products.",
  paginatePath: "products",
  query: `query Products($first: Int!, $after: String) { ... }`,
  flags: { first: { type: "string", description: "Page size" } },
  variables: (v) => ({ first: v.first ? Number(v.first) : 50, after: v.after }),
  project: (data) => data.products
}
```

Coverage paths use `/graphql#<resource>.<action>` or a provider-specific
variant such as `/graphql.json#<resource>.<action>` so the gate can still map
one generated action to one upstream operation. GraphQL-first CLIs should also
expose a raw `gql run` action and schema introspection helpers unless the API
forbids introspection.

### Nesting Depth

Cap at two levels: `<resource> <action>` or `<resource> <sub-resource> <action>`. Flatten anything deeper with flags.

### Resource Naming

API's own terminology, kebab-case for multi-word (`api-keys`, `pull-requests`). Don't rename to camelCase or PascalCase.

---

## Global Flags

Parsed before resource routing. Use a known-set filter — never `parseArgs({ strict: false })`.

| Flag | Default | Behavior |
|------|---------|----------|
| `--json` | true when piped | Structured JSON output |
| `--dry-run` | false | Show request without executing |
| `--help`, `-h` | false | Show usage |
| `--version`, `-v` | false | Print version |
| `--verbose` | false | Include request/response headers |
| `--all` | false | Auto-paginate |

Reference impl: [`examples/exemplar-cli/bin/exemplar-cli.mjs`](../examples/exemplar-cli/bin/exemplar-cli.mjs).

---

## Per-Command Flags

| Source | Flag style |
|--------|-----------|
| Path params | `--id`, `--repo` (required) |
| Query params | Optional flags |
| Body fields | Individual flags |
| Raw body | `--body <json>` escape hatch |
| Upload | `--file <path>` (multipart) |
| Binary download | `--output <path>` |
| Idempotency | `--idempotency-key <key>` (when API supports it) |
| Concurrency | `--if-match <etag>` (when API supports it) |

For GraphQL actions, the dispatcher automatically exposes `--body <json>` as
raw GraphQL variables. Resource flags should still exist for common workflows,
but `--body` remains the escape hatch for full input objects and newly-added
schema fields.

### Action-def annotations for upstream API quirks

Two optional keys on an action def let `bin/<api>-cli.mjs` handle common
quirks without per-resource glue:

- **`queryFlags: ["foreignId"]`** — flag names that ride on the URL query
  string instead of the JSON body. Use for "convert from X" `POST` creates
  whose docs list the parent FK as a **query parameter**, not a body field
  (e.g. `POST /creditnotes ?invoice_id=` on Zoho). The body equivalent is
  silently dropped on these APIs and the resulting record has no
  structural link to the source. Verify with `--dry-run`: the URL must
  contain `?<flag>=<value>` and the body must NOT.

- **`brokenListFilters: ["customerId"]`** — list-action filters the
  upstream API silently ignores (HTTP 200 with the unfiltered list). Runtime
  drops them from the wire, fetches the full list via cursor pagination,
  filters client-side (case-insensitive equals OR substring), and writes
  a one-line `note: …` to stderr. Detect via probe: pass `FAKE-NONEXISTENT`
  and compare row count against the unfiltered baseline.

Substrate lives in `examples/exemplar-cli/lib/quirks.mjs` (helpers:
`pickQueryFlags`, `stripQueryFlags`, `pickBrokenFilters`, `clientFilter`)
and is unit-tested in `test/quirks.test.mjs`. The exemplar's own resources
do NOT pre-populate either annotation — the substrate is dormant unless a
generated CLI opts in. For a worked real-world opt-in, see
[`zoho-inventory-cli/commands/credit-notes.mjs`](https://github.com/codeyogi911/zoho-inventory-cli/blob/main/commands/credit-notes.mjs)
(`create.queryFlags = ["invoice_id", "ignore_auto_number_generation"]`)
and [`zoho-inventory-cli/commands/sales-returns.mjs`](https://github.com/codeyogi911/zoho-inventory-cli/blob/main/commands/sales-returns.mjs)
(`brokenListFilters: [...]`).
Contract: [`knowledge/query-flags-and-broken-list-filters.md`](../examples/exemplar-cli/knowledge/query-flags-and-broken-list-filters.md).

---

## Test Override (rigid contract)

**Every generated CLI honors `<API_NAME>_BASE_URL` env var to redirect requests to a mock server.** Default is the real API base URL. Without this, integration tests cannot reach the mock; the validation gate fails generation that omits this. SDK-backed CLIs must still honor the override, even if that means a plain-fetch fallback for tests because the SDK rejects localhost.

```js
const BASE_URL = process.env.EXEMPLAR_BASE_URL || "https://api.exemplar.test";
```

The env var name is `<API_NAME_UPPER_SNAKE>_BASE_URL` — same prefix used for the API key and other defaults.

---

## Mock Server Contract

`test/_mock-server.mjs` exports a single function:

```js
const server = await mockApi({
  "GET /items":      { status: 200, body: { items: [{ id: "1" }], nextCursor: null } },
  "GET /items/:id":  (req, params) => ({ status: 200, body: { id: params.id } }),
  "POST /items":     (req) => ({ status: 201, body: { id: "new", ...req.body } }),
  "GET /orders":     { status: 429, headers: { "retry-after": "30" } },
});
process.env.EXEMPLAR_BASE_URL = server.url;  // overrides default in CLI
// ...run CLI, then:
assert.equal(server.requests[0].headers.authorization, "Bearer test");
await server.close();
```

Determinism rules (must hold on Node 20 and 22):

- `mockApi` listens on `127.0.0.1:0` (kernel-assigned port) and resolves `{ url, requests, close }` only after `listening` fires.
- `server.url` is `http://127.0.0.1:<assigned-port>` with no trailing slash.
- Header keys in `server.requests[i].headers` are lowercased (Node default).
- Body parsing: JSON content-type → `JSON.parse(rawBody)`; other → raw string.
- `close()` returns a Promise that resolves only after all sockets are drained.
- Routes match `METHOD /path` exactly; `:param` placeholders extract path params; no regex.

Reference impl: [`examples/exemplar-cli/test/_mock-server.mjs`](../examples/exemplar-cli/test/_mock-server.mjs).

---

## Dry-Run Output

`--dry-run` prints the request that *would* be sent without sending it. The dry-run JSON dump MUST NOT contain credential-shaped values.

Rules:
- The `Authorization`, `X-Api-Key`, `Proxy-Authorization`, `Cookie`, and `Set-Cookie` header keys are always replaced with `<redacted>`.
- Any header key matching `/(token|secret|key|cookie|auth|password)/i` is also replaced with `<redacted>`.
- The opt-in `--show-secrets` flag suppresses redaction. It exists for debugging only and is never the default — never document it in user-facing workflows.
- The `lib/api.mjs` reference impl shows the redaction pattern (see `redactHeaders`). The validation gate spawns `<bin> <r> list --dry-run --json` and scans output for credential patterns; any leak is a hard-fail.

The redaction rule applies even to the body and URL: if the API encodes credentials in the URL (`?token=...`) or body, redact those fields too.

---

## Auth (OAuth-refresh)

For APIs that use refresh-token grant (Zoho, Google, Notion, GitHub Apps, Slack, Stripe Connect, …), set `auth.scheme: "oauth-refresh"` in `.clify.json` and rely on the exemplar's built-in `oauth-refresh` branch in `lib/auth.mjs`. **Never re-author the OAuth logic.** The exemplar handles refresh, expiry, and the precedence rules below; the LLM only substitutes API-specific constants:

```js
const TOKEN_URL = "https://accounts.<provider>/oauth/v2/token";
const REFRESH_ENV = "<API>_REFRESH_TOKEN";
const CLIENT_ID_ENV = "<API>_CLIENT_ID";
const CLIENT_SECRET_ENV = "<API>_CLIENT_SECRET";
const NO_CACHE_ENV = "<API>_NO_CACHE";
const OAUTH_WIRE_PREFIX = "Bearer";  // some APIs override (e.g. "Zoho-oauthtoken")
```

`.clify.json` declares the matching wiring fields (the validator hard-fails their absence under `oauth-refresh`):

```json
"auth": {
  "scheme": "oauth-refresh",
  "envVar": "<API>_API_KEY",
  "tokenUrl": "https://accounts.<provider>/oauth/v2/token",
  "refreshEnvVar": "<API>_REFRESH_TOKEN",
  "clientIdEnvVar": "<API>_CLIENT_ID",
  "clientSecretEnvVar": "<API>_CLIENT_SECRET",
  "validationCommand": "<resource> <action>"
}
```

### Precedence (exemplar enforces — DO NOT diverge)

When `applyAuth` is called under `oauth-refresh`:

1. `process.env[<API>_API_KEY]` — pre-minted access token. Wins over everything.
2. Env refresh creds (`<API>_REFRESH_TOKEN` + `<API>_CLIENT_ID` + `<API>_CLIENT_SECRET`) → mint via `TOKEN_URL`. Env always trumps cache.
3. Cached access token from `~/.config/<api>-cli/credentials.json` — **only** if the cache's `refreshTokenHash` matches the current source's refresh token. Account-switch protection: if a previous run cached a token under refresh-A and the current env has refresh-B, the cache is invalidated rather than reused.
4. Stored refresh creds → mint.
5. Legacy stored static `token` (from `<bin> login --token`).
6. Fail with `auth_missing` (NOT `auth_invalid`).

### NO_CACHE

`<API>_NO_CACHE=1` (or `=true`) skips writing `credentials.json` after a successful refresh. Required for ephemeral CI runs and account-switching flows where on-disk cache is undesired. The exemplar reads this env var inside the OAuth branch — generated CLIs must preserve the behaviour.

### Status-mutation actions: canonical naming

Every endpoint matching `POST /<r>/:id/status/<state>` MUST map to action `mark-<state>`. No exceptions, no per-resource variation. The validator hard-fails on `void` / `confirm` / `<state>` (bare verb) when the path matches the status-mutation pattern.

| Path | Action |
|------|--------|
| `POST /invoices/:id/status/sent` | `mark-sent` |
| `POST /invoices/:id/status/void` | `mark-void` |
| `POST /sales-orders/:id/status/confirmed` | `mark-confirmed` |

---

## README Structure (generated repos)

Every generated repo's `README.md` MUST have these two sections, in order, before any other:

1. **`## Install`** — git clone, `npm install`, `npm link`, smoke check (`<bin> --version`).
2. **`## Authenticate`** — env-var path AND `<bin> login` path. Scheme-aware: static schemes show `--token`; `oauth-refresh` shows the three OAuth flags and the env-var triplet.

After those two, the existing `## Layout` / `## Use` / `## Test` sections follow. Reference: [`examples/exemplar-cli/README.md`](../examples/exemplar-cli/README.md). The validator scans heading lines and hard-fails if either section is absent.

---

## Structured Error Output

```json
{
  "type": "error",
  "code": "rate_limited",
  "message": "Rate limited. Retry after 30s.",
  "retryable": true,
  "retryAfter": 30
}
```

| Code | Retryable | HTTP | Meaning |
|------|-----------|------|---------|
| `auth_missing` | no | — | No API key in `.env` |
| `auth_invalid` | no | 401 | Key rejected |
| `validation_error` | no | 400, 422 | Bad request |
| `not_found` | no | 404 | Doesn't exist |
| `forbidden` | no | 403 | Insufficient permissions |
| `conflict` | no | 409 | State conflict |
| `rate_limited` | yes | 429 | Too many requests |
| `server_error` | yes | 5xx | API server error |
| `network_error` | yes | — | Connection failed |
| `timeout` | yes | — | Request exceeded timeout |

Rules:
- `retryAfter` is optional on any retryable error; populate from `Retry-After` header when present.
- CLI never retries — retry logic lives in the SKILL.md wrapper.
- Human-readable errors go to stderr; exit code is always 1 for errors.

---

## `.clify.json` Shape

Root metadata, written by the scaffold skill, read by the validator and sync tooling.

```json
{
  "apiName": "exemplar",
  "docsUrl": "https://docs.exemplar.test/api/v1",
  "crawledUrls": ["https://docs.exemplar.test/api/v1"],
  "contentHash": "sha256:abc...",
  "generatedAt": "2026-04-26T00:00:00Z",
  "clifyVersion": "0.4.0",
  "nodeMinVersion": "20",
  "auth": {
    "envVar": "EXEMPLAR_API_KEY",
    "scheme": "bearer",
    "validationCommand": "items list"
  },
  "defaults": [],
  "nuances": {
    "pagination": "cursor",
    "rateLimits": true,
    "authScopes": false,
    "deprecated": [],
    "idempotency": ["items.create", "orders.create"],
    "multiPart": ["orders.upload"],
    "conditional": ["items.update"],
    "businessRules": 1
  },
  "coverage": {
    "totalParsed": 11,
    "totalIncluded": 11,
    "totalDropped": 0
  }
}
```

`auth.scheme` ∈ `bearer | api-key-header | basic | none | oauth-refresh`. `auth` is required (use `none` scheme for auth-free APIs); `defaults` defaults to `[]`. For `oauth-refresh`, see the **Auth (OAuth-refresh)** section above for the additional required wiring fields (`tokenUrl`, `refreshEnvVar`, `clientIdEnvVar`, `clientSecretEnvVar`).

### Sync Behavior

**Preserved across sync:** `.clify.json` (only `generatedAt`/`contentHash` updated), `knowledge/`, `.env`.
**Regenerated on sync:** everything else.

---

## Coverage Report Contract

`coverage.json` at repo root, written at generation time.

```json
{
  "parsedAt": "2026-04-26T00:00:00Z",
  "totalParsed": 47,
  "totalIncluded": 41,
  "totalDropped": 6,
  "endpoints": [
    { "method": "GET",  "path": "/users",      "resource": "users",  "action": "list",   "included": true },
    { "method": "POST", "path": "/users/bulk", "resource": null,     "action": null,     "included": false, "dropped": true, "reason": "user-excluded-step-7" }
  ]
}
```

Allowed drop reasons: `user-excluded-step-7`, `deprecated-in-docs`, `beta-flagged`, `internal-only`, `nesting-depth-cap`, `webhook-not-cli-shaped`, `streaming-not-cli-shaped`, `sibling-asymmetry-confirmed` (use only when an API genuinely lacks a sub-action that ≥3 sibling resources expose; see family-consistency rule).

Validation gate fails if any entry has `included: false` without `dropped: true` + a valid `reason`. (Mapping correctness — one endpoint to N actions, merged endpoints — is out of scope for v0.2.)

---

## Nuance Detection

Run after endpoint parsing. Each detected nuance produces a corresponding artifact. **Hard-fail** nuances (gate fails on missing artifact) and **soft-warn** nuances (gate warns, doesn't fail) are split:

### Hard-fail (4)

| Nuance | Detection signal | Required artifact |
|---|---|---|
| **Pagination** | `cursor`/`next_page_token`/`page`/`offset`/`Link: rel=next` in responses | `test/integration.test.mjs` includes a multi-page test exercising the strategy; `.clify.json` `nuances.pagination` set to `cursor \| page \| offset \| link-header` |
| **Idempotency keys** | `Idempotency-Key` header documented | Mutating endpoints accept `--idempotency-key`; integration test asserts header is sent |
| **Multipart uploads** | `multipart/form-data` content type | `--file <path>` flag wired; integration test posts a fixture file |
| **Deprecated endpoints** | `deprecated: true` in OpenAPI, "deprecated" in prose | `knowledge/deprecated-<resource>.md` with replacement OR exclusion in `coverage.json` with reason `deprecated-in-docs` |

### Soft-warn (downgraded for v0.2 — too prose-heavy to hard-fail)

| Nuance | Detection signal | Suggested artifact |
|---|---|---|
| Rate limits | `X-RateLimit-*` headers, "rate limit" prose | `knowledge/rate-limit.md` |
| Auth scopes | OAuth scopes, "requires X permission" | `knowledge/auth-scopes.md` |
| Conditional requests | `If-Match` / `ETag` documented | `--if-match` flag + concurrency note |
| Enum constraints | OpenAPI `enum:`, "must be one of" | per-action flag description includes allowed values |
| Units / formats | "amounts in cents", "ISO-8601" | `knowledge/<topic>.md` `type: business-rule` |
| Sequencing | "must X before Y" | `knowledge/<topic>.md` `type: business-rule` |
| Plan/tier limits | "free tier", "available on plan X" | `knowledge/plan-limits.md` |
| GraphQL-first API | schema docs, queries/mutations, Relay connections | `nuances.graphqlFirst=true`, GraphQL action defs, raw `gql` + `introspect` helpers |
| Official Node SDK/API client available | docs provide/recommend an npm package, SDK handles auth/version/session/transport details | Prefer thin wrapper over the package; `nuances.officialSdk=true`, dependency in `package.json`, `knowledge/why-official-sdk.md`, mock fallback preserved |
| Cost-based throttling | GraphQL cost extensions, leaky bucket prose | `knowledge/cost-based-throttling.md` |
| Global IDs | `gid://`, opaque IDs, node IDs | `knowledge/gid-format.md` |
| Staged upload flow | pre-signed upload target plus finalize mutation | `knowledge/staged-uploads.md`, `multiPart` nuance, postProcess flow |

Detection heuristics for each row are documented inline in [`references/validation-gate.md`](validation-gate.md).

---

## .env Rules

- Read from REPO ROOT only.
- Use `node:fs` — no dotenv library.
- Don't override existing env vars (shell wins).
- Strip surrounding quotes; skip blank lines and `#` comments.
- `.env` is gitignored; `.env.example` documents required keys with placeholder values.
- Auth env var: `<API_NAME>_API_KEY` (uppercase, underscores).
- Test override env var: `<API_NAME>_BASE_URL` (see Test Override above).

---

## Setup Convention

Setup lives in the generated SKILL.md — no CLI binary changes. The LLM follows API-specific instructions to collect credentials, validate auth, detect defaults.

### `.env.example` Annotations

| Tag | Meaning |
|-----|---------|
| `@required` | Setup must collect this |
| `@optional` | Improves UX but not strictly needed |
| `@how-to-get <url>` | Where to obtain |
| `@format <pattern>` | Expected format |
| `@validation-command <res> <act>` | CLI command exercising this credential |
| `@detect-command <res> <act>` | Lists possible values |

Reference: [`examples/exemplar-cli/.env.example`](../examples/exemplar-cli/.env.example).

### Placeholder Detection

Values matching `your_*_here` / `*_your_*_here` (case-insensitive), empty string, or the exact value from `.env.example` mean "not set".

---

## Knowledge File Schema

Live in `knowledge/` in the generated repo:

```yaml
---
type: gotcha | pattern | shortcut | quirk | business-rule
command: "posts list"        # optional
applies-to: ["posts.create"] # optional, business-rule
learned: 2026-04-26
source: docs | runtime
confidence: high | medium | low
---

Free-form markdown body.
```

Generated SKILL.md preamble must include: **"Before running any command, read every file in `knowledge/`."** Validation gate checks this line is present.

---

## CLI Source Conventions

- Node.js ESM (`.mjs`)
- `"type": "module"`, `"engines": { "node": ">=20" }`
- **Zero external npm dependencies by default.** Exception: prefer a provider official or clearly recommended Node SDK/API client when it handles meaningful API complexity: auth sessions, API-version headers, pagination, retries, serialization, GraphQL helpers, staged uploads, or provider-specific signing. Record official/recommended packages as `nuances.officialSdk=true`, explain the choice in `knowledge/why-official-sdk.md`, keep dependencies minimal, and preserve mockable tests through `<API>_BASE_URL`.
- Native `fetch`, `node:util` `parseArgs`, `node:fs`, `node:path`, `node:crypto`, `node:http`

### Code Structure

The exemplar shape (preferred — every newly generated CLI inherits it):

```
bin/<api>-cli.mjs           thin dispatcher
lib/api.mjs                 apiRequest + cursor pagination iterator
lib/auth.mjs                pluggable auth (bearer | api-key-header | basic | none | oauth-refresh)
lib/output.mjs              output() + errorOut()
lib/config.mjs              ~/.config/<api>-cli/credentials.json store (used by login)
lib/env.mjs                 .env loader (zero-dep)
lib/args.mjs                splitGlobal + parseArgs adapters
lib/help.mjs                help-text generators (read the registry)
commands/<resource>.mjs     one file per resource, default-exports { name, actions, buildPayload? }
commands/login.mjs          token persistence + --status (only when scheme ≠ none)
test/smoke.test.mjs         smoke tests
test/integration.test.mjs   mock-server-driven integration tests
test/auth.test.mjs          bearer/api-key wiring + login --status
test/_mock-server.mjs       mock-server helper
test/_helpers.mjs           run/runJson child-process harness
```

`lib/api.mjs` also exports `graphqlRequest` and `paginateGraphql`; generated
GraphQL CLIs should use those helpers instead of writing a second HTTP stack.
If a Node SDK/API client is selected, keep the CLI as a thin wrapper: command
handlers parse flags and shape inputs, a small adapter owns the provider
client, and output/error normalization remains in clify code. Keep dry-run
output, structured errors, and localhost overrides intact.

Legacy single-file shape (still passes the gate, but new generation uses the split above):

```
bin/<api>-cli.mjs           everything in one file
```

Resource handlers are plain objects (not classes). One `apiRequest()` handles auth, dry-run, verbose, error mapping. Version read from package.json.

### Hierarchical subcommands

Every command is one of:

- `<api>-cli <resource> <action> [flags]` — the default shape
- `<api>-cli login [--token <t>] [--status]` — auth management (when scheme ≠ none)

Resources, actions, and the registry that maps them to method/path/flags (REST)
or kind/query/variables (GraphQL) all live under `commands/<resource>.mjs`. The
bin file imports each, builds a single `REGISTRY` object, and dispatches.

### Pluggable auth

`lib/auth.mjs` exports `applyAuth(headers)`. The function:

1. Reads `process.env.<API>_API_KEY` (or stored credential from `lib/config.mjs`).
2. Branches on `SCHEME` — one of `bearer | api-key-header | basic | none | oauth-refresh`.
3. Mutates the `headers` map with the right header.
4. Returns `{ ok, reason }` so `apiRequest` can fail fast with `auth_missing`.

Adding a new scheme is a registry edit — branch on `SCHEME`, set the header, done. Don't fork `apiRequest`.

For `oauth-refresh`, the exemplar's `applyAuth` is async (it may await a refresh-token mint). `apiRequest` already `await`s it. See the **Auth (OAuth-refresh)** section earlier in this file for the precedence rules and the `<API>_NO_CACHE` env var.

### Agent skill (umbrella layout)

Generated repos ship **one public skill directory**: `skills/<api-name>-cli/` with:

| Path | Purpose |
|---|---|
| `SKILL.md` | Triggers, setup, workflow — must mention every resource and `knowledge/` (typically via `references/knowledge/`). **The validation gate resolves this file first.** |
| `references/auth.md` | Auth setup, login, troubleshooting |
| `references/resources.md` | Resource × action × HTTP mapping |
| `references/knowledge/` | Bundled copy of repo-root `knowledge/` for standalone skill installs |
| `references/knowledge-authoring.md` | Optional — how to extend knowledge |

`.claude-plugin/plugin.json` MUST set `"skills": ["./skills/<api-name>-cli"]` exactly. Do not publish sibling shard skills such as `<api>-auth`, `<api>-resources`, `<api>-knowledge`, or `<api>-workflow`; put that material under `references/` inside the umbrella skill. Put aliases and alternate API names in the umbrella skill description/triggers, not in duplicate sibling skill directories. Hidden implementation folders such as `skills/.internal/` are allowed only if they are not referenced by the plugin manifest and are not user-facing skills.

The validator fails generated repos with multiple public `skills/*/SKILL.md` directories or non-canonical `plugin.json.skills` wiring.

### Three-level help

`--help` → resources & actions. `<resource> --help` → actions. `<resource> <action> --help` → per-action flags with required/optional + descriptions.

Generated from the resource registry — agents can call `<cli> <r> <a> --help` to learn flags without reading SKILL.md.

---

## Smoke Test Requirements

Verify CLI structure, NOT API responses. Pass with no `.env` present.

| Test | What it verifies |
|------|------------------|
| `--version` | Prints version from package.json |
| `--help` | Lists all resources |
| `<resource> --help` | Lists actions per resource |
| `<resource> <action> --help` | Per-action flags with descriptions |
| Auth missing | Returns `auth_missing` error (when scheme ≠ none) |
| `--dry-run` | Doesn't make real requests |
| Unknown resource | Returns `validation_error` |
| Unknown action | Returns `validation_error` listing available actions |
| Required flag missing | Returns `validation_error` |
| No hardcoded secrets | Source scan for API key patterns |
| Resource coverage | Every resource & action reachable |

`node:test`. Helpers `run(...args)`, `runJson(...args)`. Strip API key from env in helper. 5s timeout.

Reference: [`examples/exemplar-cli/test/smoke.test.mjs`](../examples/exemplar-cli/test/smoke.test.mjs).

---

## Integration Test Requirements

For each resource, exercise every declared action against `_mock-server.mjs`:

- `list` → returns array; multi-page test if pagination detected
- `get` → returns single object; 404 → `not_found`
- `create` → echoes payload; 422 → `validation_error`
- `update` → mutates; 404 → `not_found`
- `delete` → 204
- Rate-limit path: 429 with `Retry-After` → `rate_limited` with `retryAfter`
- Auth path (when scheme ≠ none): missing key → `auth_missing`; bad key → `auth_invalid`
- Network down: dial unreachable port → `network_error`

Reference: [`examples/exemplar-cli/test/integration.test.mjs`](../examples/exemplar-cli/test/integration.test.mjs).

---

## CI Workflow

`.github/workflows/test.yml` in every generated repo:

- Triggers: push, pull_request
- Matrix: Node 20, 22
- Step: `npm test` (runs both smoke and integration)

Reference: [`examples/exemplar-cli/.github/workflows/test.yml`](../examples/exemplar-cli/.github/workflows/test.yml).

---

## Generated Repo Structure

```
<api-name>-cli/
├── bin/<api-name>-cli.mjs
├── lib/                              # api, auth, output, config, env, args, help
├── commands/                         # one file per resource + login
├── skills/
│   └── <api-name>-cli/
│       ├── SKILL.md                  # primary; validate looks here first
│       └── references/               # auth.md, resources.md, knowledge/, …
├── scripts/
│   └── sync-skill-knowledge.mjs      # copies knowledge/ → skills/.../references/knowledge/
├── knowledge/                        # source of truth; synced into the skill bundle
├── test/
│   ├── smoke.test.mjs
│   ├── integration.test.mjs
│   ├── auth.test.mjs
│   ├── _helpers.mjs
│   └── _mock-server.mjs
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── .github/workflows/test.yml
├── .clify.json
├── coverage.json
├── package.json
├── .env.example
├── .gitignore
├── AGENTS.md
├── README.md
└── LICENSE
```

---

## package.json for Generated Repos

```json
{
  "name": "<api-name>-cli",
  "version": "0.1.0",
  "description": "CLI for the <API Name> API. Generated by clify.",
  "type": "module",
  "bin": { "<api-name>-cli": "./bin/<api-name>-cli.mjs" },
  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test test/*.test.mjs" },
  "license": "MIT"
}
```

No dependencies by default. Add a dependency only for a selected SDK/API client
or test/runtime package that is explicitly justified in `knowledge/`.

---

## Plugin Files (`.claude-plugin/`)

`package.json` is authoritative for `name`, `version`, `description`. `plugin.json` and `marketplace.json` must match exactly. `engines` lives only in `package.json`.

### plugin.json

```json
{
  "name": "<api-name>-cli",
  "version": "0.1.0",
  "description": "CLI for the <API Name> API. Generated by clify.",
  "author": { "name": "<user>" },
  "license": "MIT",
  "skills": "./skills",
  "capabilities": ["network"]
}
```

### marketplace.json

```json
{
  "name": "<api-name>-cli",
  "description": "CLI for the <API Name> API. Generated by clify.",
  "version": "0.1.0",
  "author": { "name": "<user>" },
  "source": "./"
}
```

The validator checks: every required field present; `name`/`version`/`description` match across all three manifests; every `skills[].source` path resolves.
