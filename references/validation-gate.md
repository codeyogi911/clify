# Validation Gate

`clify validate <dir>` runs the gate as pure JS. The implementation lives in [`lib/validate.mjs`](../lib/validate.mjs); this doc explains the contract.

The gate has **eight categories**. A category passes when all its checks pass. The gate as a whole passes when every category passes; warnings never fail the gate.

```
clify validate ./<api-name>-cli         # human-readable
clify validate ./<api-name>-cli --json  # JSON report
```

Exit code: 0 on pass, 1 on any failure. The scaffold skill calls this at step 11 and surfaces named failures back to the LLM, which gets up to 3 fix-and-retry attempts before stopping.

---

## 1. manifest

| Check | Pass criterion |
|---|---|
| `package.json` present | File exists at root |
| `package.json` shape | `name`, `version`, `description`, `type: "module"`, `engines.node >= 20`, `bin` object, `scripts.test` |
| `.claude-plugin/plugin.json` present | File exists |
| `.claude-plugin/plugin.json` shape | `name`, `version`, `description`, `skills`, `capabilities` |
| One umbrella skill | `plugin.json.skills` is exactly `["./skills/<package-name>"]` |
| No public skill shards | `skills/` has no public sibling `SKILL.md` dirs besides `skills/<package-name>/` |
| Skill paths resolve | `plugin.json.skills` (string path or array of paths per Claude Code schema) resolves to directories each containing a `SKILL.md` |
| Skill frontmatter | Each SKILL.md begins with `---` and contains `name:` + `description:` |
| `.claude-plugin/marketplace.json` present | File exists |
| `.claude-plugin/marketplace.json` shape | `name`, `version`, `description`, `source` |
| Cross-manifest match | `name`, `version`, `description` match across `package.json` ↔ `plugin.json` ↔ `marketplace.json` |
| `.clify.json` present + valid | Required fields: `apiName`, `docsUrl`, `contentHash`, `generatedAt`, `clifyVersion`, `auth` (with `envVar`, `scheme ∈ {bearer,api-key-header,basic,none,oauth-refresh}`, `validationCommand`) |
| `.env.example` present | If `auth.scheme ≠ none`, must include `@required` and `@how-to-get` annotations on the auth var |
| BASE_URL override | CLI source references `<API_NAME>_BASE_URL` env var |
| `bin` path resolves | The path in `package.json` `bin` exists |

## 2. coverage

| Check | Pass criterion |
|---|---|
| `coverage.json` present + parseable | |
| Required fields | `totalParsed`, `totalIncluded`, `totalDropped`, `endpoints` |
| Per-endpoint shape | Each entry has `method`, `path`. Included entries have `resource` + `action`. Dropped entries have `dropped: true` + `reason ∈ {user-excluded-step-7, deprecated-in-docs, beta-flagged, internal-only, nesting-depth-cap, webhook-not-cli-shaped, streaming-not-cli-shaped, sibling-asymmetry-confirmed}` |
| Counts match | `totalIncluded` and `totalDropped` match what's in `endpoints[]` |
| No silent drops | `included: false` always paired with `dropped: true` + a valid reason |

> **Out of scope for v0.2:** the gate does not validate endpoint-to-action mapping correctness (one endpoint to N actions, merged endpoints). Mapping is LLM judgment captured in `coverage.json` and reviewed by the user at step 7 of the scaffold pipeline.

## 3. structural

| Check | Pass criterion |
|---|---|
| `--help` lists every resource | Every included resource appears in root `--help` output |
| Resource `--help` lists every action | For each resource, `<cli> <resource> --help` lists every action declared for it |
| SKILL.md references every resource | Primary skill at `skills/<pkg>/SKILL.md` (preferred) mentions every included resource |
| SKILL.md mentions `knowledge/` | Body instructs reading bundled notes; `references/knowledge/` counts (substring match) |

## 4. nuances

The hard-fail set is intentionally small: core transport signals plus declared substrate promises. Soft signals produce **warnings** — visible in the report but never failing the gate. The full table is in [`conventions.md`](conventions.md#nuance-detection).

### Hard-fail signals

| `.clify.json` field | Signal in docs | Required artifact |
|---|---|---|
| `nuances.pagination` set to `cursor \| page \| offset \| link-header` | `cursor`, `next_page_token`, `page`, `offset`, `Link: rel=next` in responses | `test/integration.test.mjs` includes a multi-page test exercising the strategy |
| `nuances.idempotency` non-empty | `Idempotency-Key` header documented | CLI source contains `idempotency-key`; integration test asserts the header is sent |
| `nuances.multiPart` non-empty | `multipart/form-data` content type | CLI source contains `FormData`/`multipart`; integration test posts a file via `--file` |
| `nuances.deprecated` non-empty | `deprecated: true` in OpenAPI; "deprecated" prose | Either a `knowledge/deprecated-*.md` file or a `coverage.json` entry with `reason: deprecated-in-docs` |
| `nuances.businessRules > 0` | Prose-mined rules (units, sequencing, tier limits) | At least one `knowledge/*.md` with `type: business-rule` frontmatter |
| `nuances.graphqlFirst === true` | GraphQL schema/docs | Command source contains `kind: "graphql"` action defs and `coverage.json` uses `/graphql#resource.action` or `/graphql.json#resource.action` paths |
| `nuances.officialSdk === true` | Official/recommended Node SDK/API client selected | `package.json` declares a dependency and `knowledge/why-official-sdk.md` explains why the CLI wraps it |

### Soft-warn signals

`rateLimits`, `authScopes`, `conditional`, enums, units, sequencing, plan/tier limits, missing optional GraphQL raw/introspection helpers — see [`conventions.md`](conventions.md#nuance-detection). These are emitted to `warnings[]` in the report.

### Detection heuristics (used by the scaffold skill, not the gate)

The scaffold skill is the one that *populates* `nuances`. The gate just verifies that whatever was claimed has a corresponding artifact. Heuristics:

- **pagination** — search response schemas for `cursor`/`nextPageToken`/`next_cursor` (cursor); `page`/`per_page`/`pageSize` (page); `offset`/`limit` only (offset); `Link` header with `rel="next"` (link-header).
- **rate limits** — response headers matching `^x-ratelimit` or prose containing "rate limit"/"requests per".
- **auth scopes** — OpenAPI `securitySchemes` with `flows` containing `scopes`, or prose mentioning "requires X permission/scope".
- **deprecated** — OpenAPI `deprecated: true`, or `<s>` / strikethrough / "deprecated" prose adjacent to an endpoint.
- **idempotency** — header `Idempotency-Key` documented on at least one mutating endpoint.
- **multipart** — request body `content` with `multipart/form-data`.
- **conditional** — `If-Match`, `If-None-Match`, or `ETag` documented.
- **enums** — OpenAPI `enum:`, "must be one of" prose.
- **business-rule** — prose pattern-matched on units ("amounts in cents", "weights in grams"), formats ("ISO-8601", "epoch seconds", "starts with `cus_`"), defaults ("if X is omitted, defaults to Y"), sequencing ("must X before Y"), plan/tier ("free tier", "available on plan X").
- **graphqlFirst** — docs present a schema, queries/mutations, Relay connections, or a single GraphQL endpoint.
- **officialSdk** — docs require/recommend a Node SDK/API client, or the package owns auth/session/API-version/transport behaviour that is risky to reimplement.

## 5. secrets

Regex scan over all `.mjs`, `.js`, `.json`, `.md`, `.yml`, and `.env.example` files. Patterns:

- Stripe live keys: `sk_live_[A-Za-z0-9]{20,}`
- GitHub PATs: `ghp_…`, `github_pat_…`
- Slack bot: `xoxb-…`
- AWS access key: `AKIA[0-9A-Z]{16}`
- OpenAI key: `sk-[A-Za-z0-9]{32,}`
- Bearer literal: `Bearer\s+[A-Za-z0-9_\-]{30,}`

A match in any file fails the gate.

## 6. ci

| Check | Pass criterion |
|---|---|
| `.github/workflows/test.yml` present | |
| Runs `npm test` | The YAML body contains `npm test` |
| Uses `setup-node` | The YAML body uses `actions/setup-node` |

YAML is checked as plain text — no parser dependency.

## 7. tests

`npm test` runs in the repo and exits 0. (The exemplar's smoke + integration suites both run under one `node --test test/*.test.mjs` script.) Disabled with `--skip-tests` for fast manifest-only iteration.

## 8. (reserved)

The implementation tracks a separate `warnings[]` channel that surfaces soft-warn nuances and other advisory findings. Warnings never block the gate.

---

## Adding a new check

1. Add the check to the appropriate category function in `lib/validate.mjs`.
2. Push to `ctx.results` with `pass(category, name, details)` or `fail(category, name, details)`.
3. Add a deliberate-break test to `test/clify.test.mjs` that breaks one input and asserts the failure surfaces.
4. Document the row in this file.

The implementation is the source of truth — when this doc and `lib/validate.mjs` disagree, the implementation wins. Update this doc to match.
