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

## Seven-phase pipeline

### 1. Fetch & detect

`WebFetch` the URL. If the body is OpenAPI/Swagger (JSON or YAML with `openapi:` or `swagger:` key), parse directly — fast path. Otherwise treat as HTML/Markdown and crawl up to depth 2 with `WebFetch`, deduping normalized URLs and rate-limiting at 1s. If the page is JS-rendered with empty content, ask for an OpenAPI URL instead via `AskUserQuestion`.

### 2. Parse & group

Extract method, path, params, request/response shapes. Group endpoints by first path segment as a resource. Apply CRUD verb mapping from `conventions.md`; keep the API's own verbs for non-CRUD endpoints. Cap nesting at two levels — flatten sub-resources into hyphenated top-level resource names (`item-variants`, not `items variants`).

**Family-consistency** (HARD-FAIL in validator): after grouping, check sub-path tails (`/comments`, `/attachments`, `/refunds`, `/tags`, `/notes`, `/metadata`). If ≥3 sibling resources expose the same sub-path, every sibling must either include it or be explicitly dropped with `reason: "sibling-asymmetry-confirmed"` in `coverage.json`.

**Status-mutation canonical naming** (HARD-FAIL): every `POST /<r>/:id/status/<state>` endpoint maps to action `mark-<state>`. No exceptions, no per-resource variation.

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

> **Two opt-in action-def annotations available this phase** (substrate: `examples/exemplar-cli/lib/quirks.mjs` + bin runtime; contract: [`knowledge/query-flags-and-broken-list-filters.md`](../../examples/exemplar-cli/knowledge/query-flags-and-broken-list-filters.md)). The exemplar itself doesn't pre-populate either — they're dormant until a generated `commands/<resource>.mjs` opts in.
>
> - **`queryFlags: [...]`** — opt in for any `POST` create whose docs list a foreign-key as a **URL query parameter** instead of a body field (e.g. Zoho's `POST /creditnotes ?invoice_id=`, `POST /salesreturns ?salesorder_id=`, `POST /vendorcredits ?bill_id=`). The body equivalent is silently dropped on these APIs and the resulting record has no FK to the source. Detect these in Phase 2 by reading the docs' "Query Parameters" table for every `POST` — anything that names a sibling-resource id goes here.
>
> - **`brokenListFilters: [...]`** — opt in for any `GET …/list` filter the upstream API silently ignores (HTTP 200, full unfiltered list). Detect via probe: compare row count from `--<filter> FAKE-NONEXISTENT-XYZ` against unfiltered baseline. Equal counts → broken. The runtime drops the filter from the wire, fetches the full list, filters client-side, and prints a stderr note.
>
> Do NOT declare a filter in `flags` without checking it works against a live endpoint or against the docs. Pre-v0.5 generations guessed `listFilters` from naming convention; that produced CLIs that lied to users (filter passed → CLI shows help → API ignores it → user gets unfiltered results with no warning). The Fix Coffee Zoho rollout's `refund_cleanup_audit.py` mis-classified every SO as having returns until this was caught.

- `commands/<resource>.mjs` — replace the exemplar's items/orders/item-variants with the parsed resources. One file per resource. Each default-exports `{ name, actions, buildPayload? }`.
- `bin/<api-name>-cli.mjs` — update the imports and `COMMANDS` array to reflect the new resource set; everything else stays.
- `lib/auth.mjs` — set `SCHEME` and `ENV_VAR`. The exemplar implements all five schemes (`bearer | api-key-header | basic | none | oauth-refresh`). For `oauth-refresh`, set `TOKEN_URL`, `REFRESH_ENV`, `CLIENT_ID_ENV`, `CLIENT_SECRET_ENV`, `NO_CACHE_ENV`, and `OAUTH_WIRE_PREFIX` only — DO NOT modify `refreshAccessToken`, `resolveOAuthToken`, `applyAuth`, or `authStatus`. Replace the exemplar's `__EXEMPLAR_DEV_SCHEME` env-fallback line with a hardcoded `const SCHEME = "<chosen>";`.
- `lib/api.mjs` — generally unchanged. The dry-run secret redaction (`redactHeaders`) is a contract; never delete it. `--show-secrets` is the only opt-out.
- `lib/config.mjs` — replace the `__EXEMPLAR_DEV_CONFIG_DIR` env-fallback line with a hardcoded `const CONFIG_DIR = join(homedir(), ".config", "<api>-cli");`.
- `.clify.json` — fill `auth`, `defaults`, `nuances`, `coverage`, `contentHash` from the parsed spec. For `oauth-refresh`, also set `auth.{tokenUrl, refreshEnvVar, clientIdEnvVar, clientSecretEnvVar}` (validator hard-fails their absence).
- `.env.example` — set `@required` / `@how-to-get` annotations on the auth var (skip for `scheme: none`). For `oauth-refresh`, uncomment the OAuth triplet and the `<API>_NO_CACHE` line; remove the static `<API>_API_KEY` block (or leave it commented as the pre-minted-token path).
- `skills/<api-name>-cli-workflow/SKILL.md` — Triggers, Quick Reference, Common Workflows. Keep the modular layout intact (workflow, auth, resources, knowledge skills).
- `test/integration.test.mjs` — rewrite per-resource fixtures. Add nuance tests as required (multi-page for pagination, idempotency-key header assertion, FormData for multipart).
- `coverage.json` + `knowledge/<short-topic>.md` files for any business rules surfaced in step 2.
- `README.md` — lead with `## Install` and `## Authenticate` (validator hard-fails if missing); the existing Layout / Use / Test sections follow.
- `AGENTS.md` — re-author the resource list and workflows.

See `references/scaffold-pipeline.md` for the file-by-file checklist.

### 6. Validate & simplify

```
clify validate ./<api-name>-cli
```

All gate categories must pass — including the hard-fail checks added in v0.4: bin exec-bit, dry-run secret redaction, family-consistency, status-verb canonical, README structural, OAuth-refresh wiring. Up to **3 fix-and-retry attempts**. If still failing, surface the failed check names verbatim and stop — never declare done with failures. Then run `/simplify` over the changed files (collapse duplicated patterns, remove dead code).

### 7. Verify (subagent pass) & ship

After the validation gate passes, spawn an `Explore` subagent with the checklist prompt from `references/scaffold-pipeline.md` (Phase 7). The subagent audits things the validator can't easily check — bin exec-bit at runtime, dry-run output not leaking under a real spawn, OAuth `TOKEN_URL` actually substituted (not the exemplar default), no hand-rolled OAuth function bodies, family-consistency re-grouping. The subagent reports `{ ok, items: [...], blockers: [...] }`. 

- All PASS → ship: report a summary (API name, resources × actions, dropped endpoints with reasons, declared nuances, knowledge files, gate result, verification result, repo path, next steps).
- Any FAIL → loop back to Phase 5 (fix), then re-run Phase 6 + Phase 7. Up to 2 retries. After that, surface verbatim and stop.

Never declare done while either the gate or the verification subagent has unresolved failures.

---

## Anti-patterns

- Don't write the CLI from scratch — copy the exemplar via `scaffold-init`.
- Don't skip validation — the gate is the contract.
- Don't skip the Phase 7 verification subagent — it catches what the gate can't.
- Don't mark a generated repo "done" while validation OR verification is failing.
- Don't silently drop endpoints — every drop needs a reason in `coverage.json`.
- Don't break sibling-resource symmetry — if 3+ siblings have `/comments`, every sibling either has them too or is dropped with `reason: "sibling-asymmetry-confirmed"`.
- Don't hand-roll the OAuth refresh logic in `lib/auth.mjs`. Substitute the constants only. The exemplar's precedence (env wins, hash-checked cache, NO_CACHE opt-out) is the source of truth.
- Don't delete the `redactHeaders` call in `lib/api.mjs` — dry-run output must not leak credentials. The gate scans dry-run output and will hard-fail on a leak.
- Don't write nuance prose into `knowledge/` if `.clify.json.nuances.*` isn't set; the gate cross-references them.
- Don't put auth tokens in source. The gate scans for them and will flag real-shaped tokens.
- Don't declare list-filter flags you haven't verified work upstream. Either probe them (FAKE-value vs baseline row counts) or omit them. If they're documented but silently ignored, declare them in `brokenListFilters` so the runtime falls back to a client-side filter; never silently expose a flag that lies.
- Don't route a foreign-key into the body when the upstream docs list it as a query parameter on a `POST` create. Use `queryFlags` so the runtime puts it on the URL — most "convert from X" modes work ONLY via the query string and silently no-op via the body.

## Edge cases

- **API has no auth** → `auth.scheme: "none"`, leave `auth.envVar` set to `<API>_API_KEY` for shape consistency, skip the `@required` annotation. The gate accepts this.
- **API uses OAuth-refresh** (Zoho, Google, Notion, GitHub Apps, Slack, Stripe Connect, …) → `auth.scheme: "oauth-refresh"`. Substitute `TOKEN_URL` + the env-var prefix constants only — never edit the OAuth function bodies.
- **API uses cookie auth** → not supported; ask for a session-token alternative or stop with a clear message.
- **API only documented as a curl tutorial** → ask for an OpenAPI URL or to confirm the resource set by hand.
- **Resource has 12 actions** → flatten with sub-resources or hyphenated action names; do not exceed the two-level nesting cap.
- **OAuth provider needs region/datacenter routing** (e.g. Zoho's `accounts.zoho.<dc>`) → wrap `TOKEN_URL` in a small helper that reads a `<API>_DC` env var. This is the only API-specific extension allowed inside `lib/auth.mjs` for `oauth-refresh`.

## Validate-only / sync-only

If you only need to check an existing repo, run `clify validate <dir>` directly — no skill needed. If you need to detect upstream doc drift, run `clify sync-check <dir>` directly. Both are deterministic binary verbs that don't require this skill.
