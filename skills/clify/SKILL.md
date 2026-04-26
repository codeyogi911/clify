---
name: clify
description: Generate an A+ Node.js CLI repo from an API documentation URL. Triggers include "/clify <url>", "generate a CLI for this API", or providing API docs and asking for an agent-friendly wrapper. Works by copying the bundled exemplar (`examples/exemplar-cli/`, structurally inspired by google/agents-cli) and mechanically substituting API-specific content, then running the validation gate.
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

# clify

Generate a self-updating CLI repo from an API documentation URL. Output is installable as a Claude Code plugin or standalone Node CLI.

The strategy is **copy exemplar + mechanically substitute** — quality comes from the exemplar (which is hand-crafted, tested, and validated by the gate). Your job is the smaller, more verifiable transformation of API-specific content.

## Triggers

- `/clify <url>`, `/clify-scaffold <url>`
- "Generate a CLI for this API" / "Wrap this API as an agent CLI"
- User provides an API docs URL and asks for a wrapper

## Read these first

1. [`references/conventions.md`](../../references/conventions.md) — every contract you must honor.
2. [`references/validation-gate.md`](../../references/validation-gate.md) — what the gate enforces. The gate is the source of truth for "done."
3. [`references/scaffold-pipeline.md`](../../references/scaffold-pipeline.md) — the per-phase detail expanding the six steps below.
4. [`examples/exemplar-cli/`](../../examples/exemplar-cli/) — the canonical stencil. Section ordering, helper signatures, code structure, and skills layout must match it.

## Six-phase pipeline

### 1. Fetch & detect

`WebFetch` the URL. If the body is OpenAPI/Swagger (JSON or YAML with `openapi:` or `swagger:` key), parse directly — fast path. Otherwise treat as HTML/Markdown and crawl up to depth 2 with `WebFetch`, deduping normalized URLs and rate-limiting at 1s. If the page is JS-rendered with empty content, ask for an OpenAPI URL instead via `AskUserQuestion`.

### 2. Parse & group

Extract method, path, params, request/response shapes. Group endpoints by first path segment as a resource. Apply CRUD verb mapping from `conventions.md`; keep the API's own verbs for non-CRUD endpoints. Cap nesting at two levels — flatten sub-resources into hyphenated top-level resource names (`item-variants`, not `items variants`).

Detect nuances inline: pagination (cursor / page / offset / link-header), idempotency keys, multipart uploads, deprecated endpoints, rate limits, auth scopes, conditional requests, business rules. Each detected nuance maps to a `.clify.json.nuances.*` field plus an artifact (test, knowledge file, CLI flag).

### 3. Consult

Use `AskUserQuestion` for unresolved tradeoffs — resource grouping, ambiguous verbs, what to drop. Also ask **where** the new repo should live (default: parent of cwd, sibling of the current directory). Record dropped endpoints with one of the allowed reasons in `references/validation-gate.md` — never silently drop.

### 4. Init from exemplar

```
clify scaffold-init <api-name> --target <chosen-parent-dir>
```

This is the **deterministic copy + rename phase** — never do it by hand. It copies `examples/exemplar-cli/` to `<chosen-parent-dir>/<api-name>-cli/` and rewrites `exemplar` → `<api-name>`, `EXEMPLAR` → `<API_NAME>`, `Exemplar` → `<API Title>`.

Then `git init` the new repo and commit the unmodified scaffold so the next phase's edits show up as a clean diff.

### 5. Substitute

Edit only what changes per API. Preserve helper signatures (`apiRequest`, `output`, `errorOut`, `splitGlobal`, `toParseArgs`, `checkRequired`, help generators) verbatim from the exemplar. Per-file substitutions:

- `commands/<resource>.mjs` — replace the exemplar's items/orders/item-variants with the parsed resources. One file per resource. Each default-exports `{ name, actions, buildPayload? }`.
- `bin/<api-name>-cli.mjs` — update the imports and `COMMANDS` array to reflect the new resource set; everything else stays.
- `lib/auth.mjs` — set `SCHEME` and `ENV_VAR`. Branch in `applyAuth` to the right header shape.
- `.clify.json` — fill `auth`, `defaults`, `nuances`, `coverage`, `contentHash` from the parsed spec.
- `.env.example` — set `@required` / `@how-to-get` annotations on the auth var (skip for `scheme: none`).
- `skills/<api-name>-cli-workflow/SKILL.md` — Triggers, Quick Reference, Common Workflows. Keep the modular layout intact (workflow, auth, resources, knowledge skills).
- `test/integration.test.mjs` — rewrite per-resource fixtures. Add nuance tests as required (multi-page for pagination, idempotency-key header assertion, FormData for multipart).
- `coverage.json` + `knowledge/<short-topic>.md` files for any business rules surfaced in step 2.
- `README.md` and `AGENTS.md` — re-author the resource list and workflows.

See `references/scaffold-pipeline.md` for the file-by-file checklist.

### 6. Validate, simplify, report

```
clify validate ./<api-name>-cli
```

All eight categories must pass. Up to **3 fix-and-retry attempts**. If still failing, surface the failed check names verbatim and stop — never declare done with failures. Then run `/simplify` over the changed files (collapse duplicated patterns, remove dead code) and report a summary: API name, resources × actions count, dropped endpoints with reasons, declared nuances, knowledge files, gate result, and the path to the generated repo.

---

## Anti-patterns

- Don't write the CLI from scratch — copy the exemplar via `scaffold-init`.
- Don't skip validation — the gate is the contract.
- Don't mark a generated repo "done" while validation is failing.
- Don't silently drop endpoints — every drop needs a reason in `coverage.json`.
- Don't write nuance prose into `knowledge/` if `.clify.json.nuances.*` isn't set; the gate cross-references them.
- Don't put auth tokens in source. The gate scans for them and will flag real-shaped tokens.

## Edge cases

- **API has no auth** → `auth.scheme: "none"`, leave `auth.envVar` set to `<API>_API_KEY` for shape consistency, skip the `@required` annotation. The gate accepts this.
- **API uses cookie auth** → not supported; ask for a session-token alternative or stop with a clear message.
- **API only documented as a curl tutorial** → ask for an OpenAPI URL or to confirm the resource set by hand.
- **Resource has 12 actions** → flatten with sub-resources or hyphenated action names; do not exceed the two-level nesting cap.

## Validate-only / sync-only

If you only need to check an existing repo, run `clify validate <dir>` directly — no skill needed. If you need to detect upstream doc drift, run `clify sync-check <dir>` directly. Both are deterministic binary verbs that don't require this skill.
