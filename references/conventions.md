# clify Conventions

Rules and contracts for generated CLI repos. Rigid contracts (error format, `.clify.json` shape, env var override) **must** be followed exactly. Flexible guidance (command structure, nesting) should be adapted to the API.

The hand-crafted exemplar at [`examples/jsonplaceholder-cli/`](../examples/jsonplaceholder-cli/) is the canonical implementation of every rule below. When a contract here is ambiguous, the exemplar wins.

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

Reference impl: [`examples/jsonplaceholder-cli/bin/jsonplaceholder-cli.mjs`](../examples/jsonplaceholder-cli/bin/jsonplaceholder-cli.mjs).

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

---

## Test Override (rigid contract)

**Every generated CLI honors `<API_NAME>_BASE_URL` env var to redirect requests to a mock server.** Default is the real API base URL. Without this, integration tests cannot reach the mock; the validation gate fails generation that omits this.

```js
const BASE_URL = process.env.JSONPLACEHOLDER_BASE_URL || "https://jsonplaceholder.typicode.com";
```

The env var name is `<API_NAME_UPPER_SNAKE>_BASE_URL` — same prefix used for the API key and other defaults.

---

## Mock Server Contract

`test/_mock-server.mjs` exports a single function:

```js
const server = await mockApi({
  "GET /posts":      { status: 200, body: [{ id: 1, title: "x" }] },
  "GET /posts/:id":  (req, params) => ({ status: 200, body: { id: Number(params.id) } }),
  "POST /posts":     (req) => ({ status: 201, body: { id: 101, ...req.body } }),
  "GET /rate":       { status: 429, headers: { "retry-after": "30" } },
});
process.env.JSONPLACEHOLDER_BASE_URL = server.url;  // overrides default in CLI
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

Reference impl: [`examples/jsonplaceholder-cli/test/_mock-server.mjs`](../examples/jsonplaceholder-cli/test/_mock-server.mjs).

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
  "apiName": "jsonplaceholder",
  "docsUrl": "https://jsonplaceholder.typicode.com",
  "crawledUrls": ["https://jsonplaceholder.typicode.com/guide/"],
  "contentHash": "sha256:abc...",
  "generatedAt": "2026-04-26T00:00:00Z",
  "clifyVersion": "0.2.0",
  "nodeMinVersion": "20",
  "auth": {
    "envVar": "JSONPLACEHOLDER_API_KEY",
    "scheme": "none",
    "validationCommand": "posts list"
  },
  "defaults": [],
  "nuances": {
    "pagination": null,
    "rateLimits": false,
    "authScopes": false,
    "deprecated": [],
    "idempotency": [],
    "multiPart": [],
    "conditional": [],
    "businessRules": 0
  },
  "coverage": {
    "totalParsed": 6,
    "totalIncluded": 6,
    "totalDropped": 0
  }
}
```

`auth.scheme` ∈ `bearer | api-key-header | basic | none`. `auth` is required (use `none` scheme for auth-free APIs); `defaults` defaults to `[]`.

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

Allowed drop reasons: `user-excluded-step-7`, `deprecated-in-docs`, `beta-flagged`, `internal-only`, `nesting-depth-cap`, `webhook-not-cli-shaped`, `streaming-not-cli-shaped`.

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

Reference: [`examples/jsonplaceholder-cli/.env.example`](../examples/jsonplaceholder-cli/.env.example).

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
- **Zero external npm dependencies**
- Native `fetch`, `node:util` `parseArgs`, `node:fs`, `node:path`, `node:crypto`, `node:http`

### Code Structure

```
bin/<api>-cli.mjs        single-file CLI, all resources
test/smoke.test.mjs      smoke tests
test/integration.test.mjs mock-server-driven integration tests
test/_mock-server.mjs    mock-server helper
```

Resource handlers are plain objects (not classes). One `apiRequest()` handles auth, dry-run, verbose, error mapping. Version read from package.json.

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

Reference: [`examples/jsonplaceholder-cli/test/smoke.test.mjs`](../examples/jsonplaceholder-cli/test/smoke.test.mjs).

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

Reference: [`examples/jsonplaceholder-cli/test/integration.test.mjs`](../examples/jsonplaceholder-cli/test/integration.test.mjs).

---

## CI Workflow

`.github/workflows/test.yml` in every generated repo:

- Triggers: push, pull_request
- Matrix: Node 20, 22
- Step: `npm test` (runs both smoke and integration)

Reference: [`examples/jsonplaceholder-cli/.github/workflows/test.yml`](../examples/jsonplaceholder-cli/.github/workflows/test.yml).

---

## Generated Repo Structure

```
<api-name>-cli/
├── bin/<api-name>-cli.mjs
├── skills/
│   ├── <api-name>/SKILL.md
│   └── sync/SKILL.md
├── knowledge/                # initially has .gitkeep + any business-rules extracted
├── test/
│   ├── smoke.test.mjs
│   ├── integration.test.mjs
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

No dependencies. No devDependencies.

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
  "skills": [
    { "name": "<api-name>", "source": "skills/<api-name>/SKILL.md" },
    { "name": "sync",       "source": "skills/sync/SKILL.md" }
  ],
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
