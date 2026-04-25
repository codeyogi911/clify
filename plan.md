# clify — Realign for A+ Codegen

## Context

clify today is a Claude Code plugin with one skill (`/clify <url>`) that turns API docs into a CLI repo. It works, but the generation strategy is **"LLM reads commented skeletons, then writes ~90% of the CLI from scratch and adapts patterns"** — which means 90% of the surface is novel each run, and quality varies.

The user wants:
- **MCPs are heavy → CLIs are best for agents**: keep the codegen path (no runtime-dispatch idea).
- **A+ grade output in one go**: every generated CLI should be production-quality, verified, tested.
- **Aggressive realignment**: keep what's salvageable; throw the rest. Take inspiration from `google/agents-cli` (verb-based binary + per-domain skills + agent-centric design).
- **No benchmark for now**.

The fix is to switch from "skeleton + adapt" to **"copy exemplar + mechanically substitute"**. The LLM's job becomes a smaller, more verifiable transformation, and we ship a real, working, tested exemplar in the repo as the source of truth.

## What clify Is (binary + skills, agents-cli model)

clify is a Claude Code plugin that ships **both** runtime code and skills, on the same model as `google/agents-cli`:

- **Skills** do the LLM-judgment work: fetch docs, parse free-form HTML/Markdown for endpoints and business rules, consult the user on tradeoffs, rewrite per-API content in the generated SKILL.md and README. These are what install and guide Claude/Codex/other agents.
- **A small Node binary (`bin/clify.mjs`)** does the deterministic work: `clify validate <dir>` runs the full validation gate as pure JS (no LLM); `clify sync` does hash-diff and manifest updates; `clify scaffold-init <api-name>` does the file-copy + rename phase of scaffolding so the LLM never gets the boring substitutions wrong.

Split rule: anything verifiable by code goes in the binary; anything requiring judgment stays in skills. The binary is what makes verification reproducible — same pass/fail for agent and human.

## Target Shape

### clify repo (this repo)

```
clify/
├── bin/clify.mjs                       NEW — top-level CLI shim (verbs)
├── skills/
│   ├── clify-scaffold/SKILL.md         REWRITE of skills/clify/SKILL.md, copy-exemplar based
│   ├── clify-sync/SKILL.md             NEW — re-fetch docs, diff hash, regenerate, revalidate
│   └── clify-validate/SKILL.md         NEW — run validation gate against any generated repo
├── examples/
│   └── jsonplaceholder-cli/            NEW — full hand-crafted A+ exemplar (see below)
├── references/                         (moved from skills/clify/references/)
│   ├── conventions.md                  EDIT — point at exemplar, add validation-gate + mock-server contracts
│   ├── exemplar-walkthrough.md         NEW — line-by-line guide to the exemplar
│   └── validation-gate.md              NEW — exhaustive list of A+ checks (each enforceable)
├── .github/workflows/test.yml          NEW — runs exemplar tests on every push
├── .claude-plugin/plugin.json          EDIT — register the three new skills, add capabilities
├── package.json                        EDIT — add `bin`, `test` script
└── README.md                           REWRITE around exemplar+verbs story
```

**Throw out:** `skills/clify/SKILL.md`, `skills/clify/references/cli-skeleton.mjs`, `skills/clify/references/smoke-test-skeleton.mjs`, `skills/clify/references/skill-skeleton.md`, the `skills/clify/` directory.

**Salvage** (move/edit, don't rewrite from scratch): error taxonomy, `.env` loader pattern, three-level help, knowledge system schema, setup `@tag` annotations, `.clify.json` shape, plugin/marketplace manifest schemas, resource-action conventions. All currently in `skills/clify/references/conventions.md` — move to top-level `references/conventions.md` and edit to point at exemplar code instead of comment-stub skeletons.

### Generated CLI shape (output of `clify scaffold <url>`)

Identical layout to `examples/jsonplaceholder-cli/`. The generator copies the exemplar, then mechanically substitutes API-specific bits. New files vs current generator:

- `test/integration.test.mjs` — mocked HTTP server tests covering every resource-action's request shape and response handling.
- `test/_mock-server.mjs` — zero-dep `node:http` mock the integration tests use.
- `.github/workflows/test.yml` — CI runs `npm test` on every push.

## Pieces to Build

### 1. Exemplar: `examples/jsonplaceholder-cli/`

Hand-craft a complete A+ CLI for [JSONPlaceholder](https://jsonplaceholder.typicode.com) — public, free, no auth, 6 resources with full CRUD. Means CI can run the real API path without secrets.

Must include:
- `bin/jsonplaceholder-cli.mjs` — single-file CLI, every contract from `references/conventions.md` honored.
- `skills/jsonplaceholder/SKILL.md` — Triggers, Setup (auth-only-no-defaults variant since JSONPlaceholder has no auth), Quick Reference table for all 6 resources, Global Flags, Error Handling, Knowledge System pointer, Common Workflows (3 worked examples).
- `skills/sync/SKILL.md` — sync workflow.
- `test/smoke.test.mjs` — every required smoke test from conventions.md.
- `test/integration.test.mjs` — for each resource: list returns array, get returns single, create echoes payload, update mutates, delete returns 204; plus error cases (404, 422, 429, 500, network down).
- `test/_mock-server.mjs` — `mockApi(routes)` helper returning `{ url, close() }`. Routes can be static `{status, body}` or function `(req) => {status, body}`. Asserts on requests captured via `server.requests`.
- `.github/workflows/test.yml` — `node --test` on Node 20 and 22.
- `.claude-plugin/{plugin.json, marketplace.json}` — schema-valid.
- `AGENTS.md`, `.clify.json`, `package.json`, `.env.example`, `.gitignore`, `README.md`, `LICENSE`, `knowledge/.gitkeep`.

Acceptance: `cd examples/jsonplaceholder-cli && npm test` passes; `node bin/jsonplaceholder-cli.mjs posts list` hits real JSONPlaceholder and returns data.

### 2. Mock HTTP server contract: `_mock-server.mjs`

Zero-dep `node:http`. The shape every generated CLI inherits:

```js
const server = await mockApi({
  "GET /posts":      { status: 200, body: [{ id: 1, title: "x" }] },
  "GET /posts/:id":  (req, params) => ({ status: 200, body: { id: Number(params.id) } }),
  "POST /posts":     (req) => ({ status: 201, body: { id: 101, ...req.body } }),
  "GET /rate":       { status: 429, headers: { "retry-after": "30" } },
});
process.env.JSONPLACEHOLDER_BASE_URL = server.url;  // CLI honors override
// ...run CLI...
assert.equal(server.requests[0].headers.authorization, "Bearer test");
await server.close();
```

CLI must read `BASE_URL` from env if set (override the hardcoded default) — this is a new convention to add, otherwise integration tests can't reach the mock. Document in conventions.md as "Test override: every generated CLI honors `<API>_BASE_URL` env var to redirect requests; default is the real API base URL."

### 3. Validation gate: `references/validation-gate.md` + `skills/clify-validate/`

Every check enforceable as a script (lives in `skills/clify-validate/lib/validate.mjs`, callable via `clify validate <dir>`). Seven categories:

| Category | Examples |
|---|---|
| **Manifest** | `package.json`/`plugin.json`/`marketplace.json` name+version+description match; every `skills[].source` resolves; `engines.node >= 20`. |
| **Smoke tests** | `npm test` exits 0; all required smoke categories present (every row of the smoke-test table in conventions.md). |
| **Integration tests** | Auth path tested with mock; every resource has at least one integration test per declared action. |
| **Structural coverage** | Every resource and action in registry appears in `--help` and resource `--help`; every action mentioned in SKILL.md Quick Reference; every error code referenced in SKILL.md Error Handling. |
| **API-surface coverage** *(new)* | `coverage.json` exists; for every entry, either `included: true` or has explicit `dropped: true` with `reason`; included count matches CLI registry size; surface coverage % logged. Gate fails on silent drops. |
| **Nuance artifacts** *(new)* | For each flag in `.clify.json` `nuances` map, the corresponding artifact exists (see Nuance Detection below). |
| **Business knowledge** *(new)* | If `docs.charCount > 5000` and `knowledge/` is empty (excluding `.gitkeep`), gate warns (not fails). If `.clify.json` `nuances.businessRules > 0`, gate fails when no `knowledge/*.md` with `type: business-rule` exists. |
| **Secrets** | regex scan source for real key formats (`sk_live_`, `ghp_`, `Bearer [A-Za-z0-9_\-]{20,}`, etc.); fail if found. |
| **CI** | `.github/workflows/test.yml` exists, parses as YAML, runs `npm test`. |
| **Schema** | `.clify.json` matches schema; `.env.example` has `@required`+`@how-to-get` on auth var; `auth.validationCommand` and every `defaults[].detectCommand` resolves to a real resource-action. |

`skills/clify-validate/SKILL.md` runs the gate, reports failures by category. The scaffold skill calls `clify validate ./<api-name>-cli` at Step 7. If any check fails, generator fixes and re-runs (cap 3); on still-failing, surface failing check names to user — never declare done with failures.

#### Coverage report contract: `coverage.json`

Written by the scaffold skill at generation time, lives at the root of the generated repo.

```json
{
  "parsedAt": "2026-04-25T12:00:00Z",
  "totalParsed": 47,
  "totalIncluded": 41,
  "totalDropped": 6,
  "endpoints": [
    { "method": "GET",  "path": "/users",       "resource": "users",  "action": "list",   "included": true },
    { "method": "POST", "path": "/users/bulk",  "resource": null,     "action": null,     "included": false, "dropped": true, "reason": "user-excluded-step-5" },
    { "method": "GET",  "path": "/legacy/...",  "resource": null,     "action": null,     "included": false, "dropped": true, "reason": "deprecated-in-docs" }
  ]
}
```

Validation gate fails if any entry has `included: false` without `dropped: true` + `reason`. Allowed reasons: `user-excluded-step-5`, `deprecated-in-docs`, `beta-flagged`, `internal-only`, `nesting-depth-cap`, `webhook-not-cli-shaped`, `streaming-not-cli-shaped`.

#### Nuance Detection (new Step 4.5 in scaffold pipeline)

After parsing endpoints (Step 4), scan the spec + prose for nuance categories. Each detected nuance must produce a corresponding artifact, enforced by the gate:

| Nuance | Detection signal | Required artifact |
|---|---|---|
| **Pagination style** | `cursor`/`next_page_token`/`page`/`offset`/`Link: rel=next` in responses | `test/integration.test.mjs` includes a multi-page test exercising the strategy; `.clify.json` `nuances.pagination` set to one of `cursor|page|offset|link-header` |
| **Rate limits** | `X-RateLimit-*` headers, "rate limit" / "requests per" prose | `knowledge/rate-limit.md` with documented limits, retry strategy, and which commands are most expensive |
| **Auth scopes / permissions** | OAuth scopes list, "requires X permission" prose | `knowledge/auth-scopes.md` mapping each command to required scope(s) |
| **Deprecated endpoints** | `deprecated: true` in OpenAPI, "deprecated" in prose | `knowledge/deprecated-<resource>.md` with replacement guidance OR exclusion in coverage report with reason `deprecated-in-docs` |
| **Idempotency keys** | `Idempotency-Key` header documented | Mutating endpoints accept `--idempotency-key`; integration test asserts header is sent |
| **Multi-part uploads** | `multipart/form-data` content type | `--file <path>` flag wired; integration test posts a fixture file |
| **Conditional requests** | `If-Match` / `If-None-Match` / `ETag` documented | `--if-match` flag on relevant actions; knowledge note explaining concurrency model |
| **Enum constraints** | `enum:` in OpenAPI, "must be one of" prose | per-action flag description includes allowed values; integration test for invalid value returns `validation_error` |
| **Units / formats** | "amounts in cents", "ISO-8601", "UUIDs" prose | `knowledge/<topic>.md` with `type: business-rule` |
| **Sequencing constraints** | "must X before Y" prose | `knowledge/<topic>.md` with `type: business-rule` |
| **Plan/tier limits** | "free tier", "available on plan X" prose | `knowledge/plan-limits.md` |

`.clify.json` records the nuance map:

```json
"nuances": {
  "pagination": "cursor",
  "rateLimits": true,
  "authScopes": true,
  "deprecated": ["legacyEndpoint"],
  "idempotency": ["payments.create", "transfers.create"],
  "multiPart": ["files.upload"],
  "conditional": [],
  "businessRules": 4
}
```

#### Business knowledge extraction (Step 4.6)

Second prose pass specifically for non-endpoint rules. Look for:
- Units ("amounts are in cents", "weights in grams")
- Time zones / formats ("ISO-8601 UTC", "epoch seconds")
- Default behaviors ("if `status` is omitted, defaults to `active`")
- Sequencing ("must verify before send", "create draft, then publish")
- Plan/quota rules ("100 messages/day on free tier")
- Error message conventions ("4xx body always has `errors[]`")
- Identifier formats ("starts with `cus_`", "32-char hex")

Each extracted rule becomes `knowledge/<short-topic>.md`:

```yaml
---
type: business-rule
source: docs
extracted: 2026-04-25
confidence: high
applies-to: ["charges.create", "refunds.create"]
---
Amount fields are in the smallest currency unit (cents for USD).
Pass 500 to charge $5.00, not 5.
```

The generated SKILL.md must include in its preamble: "Before running any command, read every file in `knowledge/`." This is already stated in the current skill skeleton — it will be reinforced and the gate will check the line is present.

### 4. Scaffold skill rewrite: `skills/clify-scaffold/SKILL.md`

Pipeline (steps 1–3 keep current logic — re-use prose from existing SKILL.md):

1. **Fetch** the docs URL.
2. **Detect** format (OpenAPI direct-parse vs HTML/Markdown crawl).
3. **Crawl** if needed (depth 2, rate-limited).
4. **Parse endpoints** — extract method, path, params, request/response shapes; group into resources.
5. **Detect nuances** *(new)* — run the nuance scan from §3 above; populate `nuances` map.
6. **Extract business knowledge** *(new)* — prose-mine for non-endpoint rules; queue knowledge files to write.
7. **Consult and recommend** — present findings (endpoints, nuances, extracted rules) with opinionated recommendations; resolve gaps with `AskUserQuestion`. User approves or overrides.
8. **Init repo from exemplar** — call `clify scaffold-init <api-name>` (binary verb): copies `examples/jsonplaceholder-cli/` to `./<api-name>-cli/` and does mechanical renames (file paths, package name, plugin name, env var name placeholder). LLM never does this part.
9. **Substitute API-specific content** — the LLM rewrites:
   - Resource handlers in `bin/<api-name>-cli.mjs` from parsed spec — keep section ordering, helpers (`apiRequest`, `paginated`, `output`, `errorOut`, `checkRequired`, `toParseArgs`, `showHelp`, `main`), and global-flag separation untouched.
   - Auth (env var name final value, header scheme, validation command).
   - `test/integration.test.mjs` fixtures matching target API shapes; nuance tests per §3 table.
   - SKILL.md sections that reference resources (Triggers, Quick Reference, Common Workflows, Error Handling notes).
   - `.env.example`, `.clify.json` (auth+defaults+nuances+coverage stats), `README.md` examples, `AGENTS.md`.
10. **Write coverage + knowledge artifacts** — emit `coverage.json` from steps 4+7; write `knowledge/*.md` files queued in step 6.
11. **Validate** — invoke `clify validate ./<api-name>-cli/` (binary, no LLM). All seven gate categories must pass. Up to 3 fix-and-retry attempts.
12. **Simplify** — keep `/simplify` invocation.
13. **Report**.

### 5. Sync skill: `skills/clify-sync/SKILL.md`

Concept already exists in current SKILL.md Step 7; promote to dedicated skill. Workflow: read `.clify.json` → re-fetch docs → hash → diff against `contentHash` → regenerate changed parts (resources/actions only — never overwrite `knowledge/` or `.env`) → rerun validation gate → review knowledge files for staleness.

### 6. Top-level binary: `bin/clify.mjs`

Real CLI, not just a shim. Lives at `bin/clify.mjs`, registered in `package.json` `bin` field so `npx clify` works. Verbs:

- `clify scaffold-init <api-name> [--target <dir>]` — deterministic file-copy + rename phase. Copies `examples/jsonplaceholder-cli/` to `<dir>/<api-name>-cli/`, renames files, substitutes `jsonplaceholder` → `<api-name>` and `JSONPLACEHOLDER` → `<API_NAME>` everywhere. LLM-driven scaffold skill calls this at step 8 of its pipeline.
- `clify validate <dir>` — runs the full validation gate as pure JS, exits 0/1 with structured JSON report. Used by the scaffold skill (step 11), the sync skill, and CI.
- `clify sync-check <dir>` — re-fetches `docsUrl` from `.clify.json`, recomputes `contentHash`, prints diff summary. Sync skill uses this; LLM decides what to regenerate.
- `clify scaffold <url>` — informational; prints "run `/clify-scaffold <url>` in Claude Code — generation needs LLM judgment".
- `clify --version`, `clify --help`.

`validate` and `scaffold-init` are the workhorses; both fully deterministic, both testable, both reproducible across agent vendors.

### 7. Conventions update: `references/conventions.md`

Edits, not a rewrite:
- Replace skeleton references with `examples/jsonplaceholder-cli/<file>` references.
- Add **Test Override** subsection: every generated CLI honors `<API>_BASE_URL` env var.
- Add **Mock Server Contract** section linking to `examples/jsonplaceholder-cli/test/_mock-server.mjs`.
- Add **Validation Gate** section linking to `references/validation-gate.md`.
- Add **CI Workflow** section: `.github/workflows/test.yml` matrix (Node 20, 22), runs `npm test`.

### 8. README rewrite

Lead with: "Paste a URL. Get a tested, A+ grade CLI." Show the exemplar as proof. Include a section "What 'A+' means" pointing at validation-gate.md.

## Files to Modify / Create / Delete

**Create (new):**
- `bin/clify.mjs` (verbs: `validate`, `scaffold-init`, `sync-check`, `scaffold` info, `--version`, `--help`)
- `lib/validate.mjs` — validation gate impl, called from binary; also re-exported for skill use
- `lib/scaffold-init.mjs` — file-copy + rename impl
- `lib/sync-check.mjs` — hash-diff impl
- `test/clify.test.mjs` — unit tests for the three lib modules
- `skills/clify-scaffold/SKILL.md`
- `skills/clify-sync/SKILL.md`
- `skills/clify-validate/SKILL.md`
- `examples/jsonplaceholder-cli/` (full repo, ~16 files: prior 14 plus `coverage.json` and one or more `knowledge/*.md` business-rule examples)
- `references/conventions.md` (move from `skills/clify/references/conventions.md`)
- `references/exemplar-walkthrough.md`
- `references/validation-gate.md` (incl. coverage + nuance + knowledge layers)
- `references/nuance-detection.md` (the table from §3 expanded with detection heuristics)
- `.github/workflows/test.yml`

**Modify:**
- `.claude-plugin/plugin.json` — add `skills`, `capabilities`
- `package.json` — add `bin`, `test` script
- `README.md` — full rewrite

**Delete:**
- `skills/clify/SKILL.md`
- `skills/clify/references/cli-skeleton.mjs`
- `skills/clify/references/smoke-test-skeleton.mjs`
- `skills/clify/references/skill-skeleton.md`
- `skills/clify/references/conventions.md` (after move)
- `skills/clify/` directory

## Build Order

1. **Conventions move + edits first** — `references/conventions.md` is the contract every other piece needs. Move from `skills/clify/references/` to top-level `references/`, add new sections (Test Override, Mock Server, Validation Gate, Coverage Report, Nuance Detection, Knowledge Extraction, CI).
2. **Nuance detection reference** — `references/nuance-detection.md` with detection heuristics per category.
3. **Exemplar `jsonplaceholder-cli`** — hand-craft, including `_mock-server.mjs`, integration tests, `coverage.json`, and at least 2 `knowledge/*.md` files (one business-rule, one pattern). Largest single piece (~16 files). Defines the shape every other piece depends on. JSONPlaceholder is auth-free, so the auth-scopes/rate-limit nuances will be empty in the exemplar — that's fine; the second exemplar (post-plan) will exercise those.
4. **Validator impl** — `lib/validate.mjs` with all seven categories. Bootstrap by running against the exemplar until it passes cleanly. Then add deliberate-break tests in `test/clify.test.mjs`.
5. **scaffold-init impl** — `lib/scaffold-init.mjs`. Tested by round-tripping the exemplar.
6. **sync-check impl** — `lib/sync-check.mjs`.
7. **`bin/clify.mjs`** — wire all verbs.
8. **`references/validation-gate.md`** — written from `lib/validate.mjs` (impl is the source of truth; doc explains).
9. **`.github/workflows/test.yml`** — runs `npm test` for clify (which validates the exemplar) and for the exemplar (smoke + integration). Matrix Node 20, 22.
10. **Skill rewrites** — `clify-scaffold/SKILL.md` (the heaviest, with the new 13-step pipeline and explicit invocations of binary verbs), `clify-sync/SKILL.md`, `clify-validate/SKILL.md`.
11. **`references/exemplar-walkthrough.md`** — line-by-line guide, written last after exemplar is final.
12. **README + plugin.json + package.json** updates.
13. **Delete old `skills/clify/`** tree.

## Verification

End-to-end checks before declaring done:

1. **Exemplar self-test** — `cd examples/jsonplaceholder-cli && npm test` exits 0. Both smoke and integration suites green.
2. **Exemplar live** — `node examples/jsonplaceholder-cli/bin/jsonplaceholder-cli.mjs posts list` returns real data from JSONPlaceholder. (Network test, run manually.)
3. **Validation gate green on exemplar** — `node bin/clify.mjs validate examples/jsonplaceholder-cli` exits 0 with all seven categories passing (incl. coverage report, nuance artifacts, knowledge files).
4. **Validation gate fails on broken exemplar** — manually break one thing per category (remove a help line; mismatch version; drop an endpoint from `coverage.json`; delete a nuance test; remove `knowledge/`); confirm gate fails with the named check. Restore.
5. **`scaffold-init` round-trip** — `node bin/clify.mjs scaffold-init demo --target /tmp` produces a working repo; `cd /tmp/demo-cli && npm test` passes (it's the exemplar with renames only).
6. **clify CI** — `.github/workflows/test.yml` runs `npm test` on Node 20 and 22; passes on push to branch.
7. **Skill discovery** — `plugin.json` lists three skills; each `source` path resolves; each SKILL.md has frontmatter `name`+`description`+`allowed-tools`.
8. **End-to-end scaffold (manual smoke)** — in a fresh Claude Code session, run `/clify-scaffold https://jsonplaceholder.typicode.com`. Expect output equivalent to `examples/jsonplaceholder-cli/`. All generated tests pass; `clify validate` green.
9. **End-to-end scaffold against an authenticated API (manual stretch)** — pick a small public API with auth (e.g. The Movie DB). Generated CLI should pass validation gate, smoke tests, and integration tests; nuance artifacts present for any rate-limit / pagination / auth-scope detected; at least one `knowledge/*.md` business rule extracted from the docs.

## Out of Scope

- Runtime-driven dispatcher (Idea 1 dropped, per user).
- Benchmark harness (skipped, per user).
- Multiple exemplars (one is enough; auth-bearing exemplar like Calendly is a follow-up).
- TypeScript / typed agent SDK (zero-dep constraint stays).
- npm publish automation.
