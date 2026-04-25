---
name: clify-scaffold
description: Generate an A+ Node.js CLI repo from an API documentation URL. Use when the user says "/clify-scaffold <url>", "/clify <url>", "generate a CLI for this API", or provides API docs and asks for an agent-friendly wrapper. Works by copying the bundled JSONPlaceholder exemplar and mechanically substituting API-specific content, then running the validation gate.
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - WebFetch
  - WebSearch
  - AskUserQuestion
---

# clify-scaffold

Generate a self-updating CLI repo from an API documentation URL. Output is installable as a Claude Code plugin, Codex agent, or standalone Node CLI.

The strategy is **copy exemplar + mechanically substitute**, not "write from scratch." Quality comes from the exemplar (which is hand-crafted, tested, validated) — your job is the smaller, more verifiable transformation of API-specific content.

## Triggers

- `/clify-scaffold <url>`, `/clify <url>`
- "Generate a CLI for this API"
- User provides an API docs URL and asks for a wrapper

## Read these first

1. [`references/conventions.md`](../../references/conventions.md) — every contract you must honor.
2. [`references/validation-gate.md`](../../references/validation-gate.md) — every check the gate enforces. The gate is the source of truth for "done."
3. [`examples/jsonplaceholder-cli/`](../../examples/jsonplaceholder-cli/) — the canonical exemplar. Section ordering, helper signatures, and code structure must match it.

## Pipeline (13 steps)

### 1. Fetch the docs

`WebFetch <url>` for the user-provided URL.

### 2. Detect format

- **OpenAPI/Swagger** (JSON or YAML with `openapi` or `swagger` key) → parse directly. Skip crawling.
- **HTML / Markdown** → proceed to step 3.

### 3. Crawl (HTML/Markdown only)

Identify links to more API doc pages (skip nav, marketing, changelog). Fetch up to depth 2, dedupe by normalized URL, rate-limit at 1s between fetches. If the page is JS-rendered with empty content, ask the user for an OpenAPI URL instead.

### 4. Parse endpoints

Extract method, path, params, request/response shapes. Group by first path segment as resource. Apply standard verb mapping from `conventions.md` (CRUD); use the API's own verb for non-CRUD endpoints.

### 5. Detect nuances

Scan spec + prose for the nuances table in [`references/validation-gate.md`](../../references/validation-gate.md#nuances). Populate the `.clify.json` `nuances` map. **Hard-fail nuances** (pagination, idempotency, multipart, deprecated) require corresponding artifacts; **soft-warn nuances** are advisory.

### 6. Extract business knowledge

Second prose pass for non-endpoint rules (units, formats, defaults, sequencing, plan limits, identifier formats). Each rule queues a `knowledge/<short-topic>.md` file with `type: business-rule` frontmatter. See `examples/jsonplaceholder-cli/knowledge/writes-do-not-persist.md` for the shape.

### 7. Consult and recommend

Present findings to the user with opinionated recommendations. Use `AskUserQuestion` for unresolved tradeoffs (resource grouping, ambiguous verbs, what to drop). Record dropped endpoints with one of the allowed reasons (`user-excluded-step-7`, `deprecated-in-docs`, etc.) — never silently drop.

### 8. Init repo from exemplar (binary verb)

```
clify scaffold-init <api-name> --target <parent-dir>
```

This is the **deterministic copy + rename phase** — never do it by hand. Copies `examples/jsonplaceholder-cli/` to `<parent-dir>/<api-name>-cli/` and rewrites `jsonplaceholder` → `<api-name>`, `JSONPLACEHOLDER` → `<API_NAME>`, `JSONPlaceholder` → `<API Title>` everywhere.

### 9. Substitute API-specific content

Edit only what changes per API; preserve section ordering and helper signatures from the exemplar.

- `bin/<api-name>-cli.mjs`: replace the resource registry with the parsed endpoints. Keep `loadEnv`, `apiRequest`, `output`, `errorOut`, `splitGlobal`, `toParseArgs`, `checkRequired`, `showRootHelp`, `showResourceHelp`, `showActionHelp`, `main` exactly as in the exemplar. Body builders (`buildPayload`, `bodyFlagsFor`) get rewritten per API.
- Auth: set `auth.scheme` and add the auth header in `apiRequest` (`Authorization: Bearer ...`, `X-API-Key: ...`, etc.). For `scheme: none`, leave the helper untouched.
- `test/integration.test.mjs`: rewrite per-resource fixtures to match target API shapes; add nuance tests as required by §5.
- `skills/<api-name>/SKILL.md`: rewrite Triggers, Quick Reference table, Common Workflows, Error Handling notes. Leave structure intact.
- `.env.example`: set the auth env var with `@required`/`@how-to-get` annotations (skip for `scheme: none`).
- `.clify.json`: fill `auth`, `defaults`, `nuances`, `coverage`, `contentHash` from the parsed spec.
- `README.md`, `AGENTS.md`: regenerate examples that mention specific resources.

### 10. Write coverage + knowledge artifacts

Emit `coverage.json` with every parsed endpoint marked `included: true` or `dropped: true` + reason. Write knowledge files queued in step 6.

### 11. Validate (binary verb)

```
clify validate ./<api-name>-cli
```

All eight categories must pass. Per-failure remediation:

- **manifest** — fix the named field; cross-manifest mismatches usually mean `package.json` was edited but `plugin.json` wasn't.
- **coverage** — every `included: false` needs `dropped: true` + a valid `reason`.
- **structural** — a resource or action you generated isn't reachable; check the registry vs the help-text generator.
- **nuances** — declared a hard-fail nuance but didn't add the artifact. Either add it or set the nuance to empty.
- **secrets** — a real key pattern leaked; remove it.
- **ci** — `.github/workflows/test.yml` missing or doesn't run `npm test`.
- **tests** — exemplar smoke/integration tests fail because of a typo in the renamed registry. Read the test output and fix the source.

Up to **3 fix-and-retry attempts**. On still-failing, surface the failed check names to the user and stop — do not declare done with failures.

### 12. Simplify

Run `/simplify` over the changed files. Remove dead code, collapse duplicated patterns, but never break a contract from `conventions.md`.

### 13. Report

Summarize to the user: API name, resources × actions count, dropped endpoints with reasons, declared nuances, knowledge files written, validation gate result. Include the path to the generated repo and `cd <repo> && npm test` as the next step.

## Anti-patterns

- ❌ Don't write the CLI from scratch — copy the exemplar via `scaffold-init`.
- ❌ Don't skip validation — the gate is the contract.
- ❌ Don't mark a generated repo "done" while validation is failing.
- ❌ Don't silently drop endpoints — every drop needs a reason in `coverage.json`.
- ❌ Don't write nuance prose into `knowledge/` if the corresponding `.clify.json.nuances.*` field isn't set; the gate cross-references them.
- ❌ Don't put auth tokens in source. The gate scans for them and will flag real-shaped tokens.

## Edge cases

- **API has no auth** → `auth.scheme: "none"`, leave `auth.envVar` set to `<API>_API_KEY` for shape consistency, skip the `@required` annotation in `.env.example`. The gate accepts this.
- **API uses cookie auth** → not supported in v0.2; ask the user for a session-token alternative or stop with a clear message.
- **API only documented as a curl tutorial** (no spec, no structured docs) → ask the user for an OpenAPI URL or to confirm the resources by hand.
- **Resource has 12 actions** → flatten with sub-resources or hyphenated action names; do not exceed the two-level nesting cap.
