---
name: clify-sync
description: Re-fetch the docs for a generated clify CLI, detect upstream drift via content hash, and regenerate the resource registry, integration tests, and SKILL.md if the docs have changed. Preserves knowledge/, .env, and immutable .clify.json fields. Use when the user says "/clify-sync <dir>", "sync this CLI", or asks if a generated CLI is up to date.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - WebFetch
---

# clify-sync

Re-fetch upstream docs and detect drift for a generated clify CLI. If the content hash has changed, regenerate the parts that derive from docs (CLI source, integration tests, SKILL.md sections, coverage). Preserve user-managed state (`knowledge/`, `.env`, `.clify.json` apiName + docsUrl).

## Triggers

- `/clify-sync <dir>`
- "Sync this CLI" / "Is this CLI up to date with the docs?"

## Workflow

### 1. Read state

```
cat <dir>/.clify.json
```

Note `apiName`, `docsUrl`, `crawledUrls`, `contentHash`, `clifyVersion`.

### 2. Hash check (binary verb)

```
clify sync-check <dir> --json
```

Re-fetches every URL in `crawledUrls`, recomputes the SHA-256, and reports `{ changed: bool, oldHash, newHash, fetched[] }`. This is **advisory only** — it does not regenerate.

If `changed: false`, exit with "no upstream changes since last generation".

### 3. Re-parse + re-detect

If `changed: true`:
- Re-fetch the docs (the `sync-check` already fetched once; re-use the bodies if convenient).
- Re-parse endpoints (step 4 of the scaffold pipeline).
- Re-detect nuances (step 5).
- Re-extract business knowledge (step 6) — but **do not** overwrite existing `knowledge/*.md` files; queue suggested additions.

### 4. Regenerate docs-derived files

- `bin/<api-name>-cli.mjs` — resource registry only (preserve helpers).
- `test/integration.test.mjs` — fixtures + nuance tests.
- `skills/<api-name>/SKILL.md` — Triggers, Quick Reference, Common Workflows.
- `coverage.json` — full rewrite.
- `.clify.json` — update `contentHash`, `generatedAt`, `nuances`, `coverage`. Keep `apiName`, `docsUrl`, `auth`.

**Do NOT touch:** `knowledge/`, `.env`, `package.json` `name`/`version` (user controls bumping), `LICENSE`, `README.md` (unless the user opts in).

### 5. Validate

```
clify validate <dir>
```

Same loop as the scaffold skill: up to 3 fix attempts.

### 6. Knowledge review

For every file in `knowledge/`, check if `applies-to:` references resources/actions still in the new registry. If not, flag for the user (don't auto-delete).

### 7. Report

Summarize:
- old vs new hash
- endpoints added / removed / unchanged
- knowledge files flagged for review
- nuances changes
- validation gate result

## Anti-patterns

- ❌ Don't overwrite `knowledge/`, `.env`, or user-edited README content.
- ❌ Don't auto-bump `package.json` version — the user owns that.
- ❌ Don't run regeneration without first checking if the hash actually changed.
- ❌ Don't claim sync is "complete" if the validation gate fails on the regenerated repo.
