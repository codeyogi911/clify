---
name: exemplar-cli
description: >-
  Drives workflows on the fictional Exemplar REST API via exemplar-cli (items, item-variants, orders, multipart uploads, cursor pagination, idempotency). Use when listing or mutating those resources, debugging auth, or explaining API quirks documented under references/knowledge/.
---

# exemplar-cli

Thin CLI over the (fictional) [Exemplar API](https://docs.exemplar.test/api/v1). This repo is the **clify exemplar stencil** — patterns here propagate to generated CLIs.

**Resources:** `items`, `item-variants`, `orders`. The `login` command is separate from resource dispatch.

Before **mutations or non-trivial reads**, read every file in `references/knowledge/`.

## Setup

- Token: `EXEMPLAR_API_KEY` **or** `exemplar-cli login --token <value>` (stored under `~/.config/exemplar-cli/credentials.json`).
- Check: `exemplar-cli login --status --json`.
- Tests / mocks: `EXEMPLAR_BASE_URL=http://127.0.0.1:<port>`.

Auth details and error codes: [references/auth.md](references/auth.md).

## Quick reference

| Resource | Actions | Notes |
|---|---|---|
| `items` | list, get, create, update, delete | `--all` paginates; `--idempotency-key` on create; `--if-match` on update |
| `item-variants` | list, create | `--itemId` required |
| `orders` | list, get, create, upload | `--idempotency-key` on create; `upload` uses multipart `--file` |

Full tables and paths: [references/resources.md](references/resources.md).

Per-action flags: `exemplar-cli <resource> <action> --help`.

## Global flags

`--json`, `--dry-run`, `--verbose`, `--all`, `--version`, `--help`.

## Workflow

1. Auth unclear → [references/auth.md](references/auth.md).
2. Before substantive work → read all of `references/knowledge/`.
3. Adding durable nuance → follow [references/knowledge-authoring.md](references/knowledge-authoring.md) **and** align `.clify.json` nuances when applicable.

## Examples

```bash
exemplar-cli items create --name "Widget" --sku "W-001" --price "19.99" --idempotency-key "$(uuidgen)"
exemplar-cli items list --all --json | jq '. | length'
exemplar-cli orders upload --id ord-42 --file ./receipt.pdf
```

The CLI does **not** auto-retry; retry policy belongs to the caller.

## Maintainers

Refresh bundled knowledge copies:

```bash
npm run sync:skill-knowledge
```

Edit `references/auth.md` and `references/resources.md` when behaviour changes.
