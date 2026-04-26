---
name: exemplar-cli-resources
description: Quick reference for every Exemplar API resource × action exposed by exemplar-cli. Use when the user asks "what does the items API support?" or needs the precise flag set for a specific endpoint.
allowed-tools:
  - Bash
  - Read
---

# exemplar-cli-resources

Resource × action quick reference. When in doubt, prefer `exemplar-cli <resource> <action> --help` — the help text is generated from the same registry and never drifts.

## items

| Action | Method | Path | Required flags | Notable optional |
|---|---|---|---|---|
| list   | GET    | /items          | — | `--cursor`, `--limit`, global `--all` |
| get    | GET    | /items/:id      | `--id` | — |
| create | POST   | /items          | — | `--name`, `--sku`, `--price`, `--idempotency-key`, `--body` |
| update | PATCH  | /items/:id      | `--id` | `--name`, `--sku`, `--price`, `--if-match`, `--body` |
| delete | DELETE | /items/:id      | `--id` | — |

## item-variants (sub-resource of items)

| Action | Method | Path | Required flags | Notable optional |
|---|---|---|---|---|
| list   | GET  | /items/:itemId/variants | `--itemId` | `--cursor` |
| create | POST | /items/:itemId/variants | `--itemId` | `--sku`, `--size`, `--color`, `--body` |

## orders

| Action | Method | Path | Required flags | Notable optional |
|---|---|---|---|---|
| list   | GET  | /orders            | — | `--cursor`, `--status`, global `--all` |
| get    | GET  | /orders/:id        | `--id` | — |
| create | POST | /orders            | — | `--customerId`, `--notes`, `--idempotency-key`, `--body` |
| upload | POST | /orders/:id/upload | `--id`, `--file` | — |

## Patterns shared across resources

- **Cursor pagination** — `list` actions accept `--cursor`. Combined with `--all`, the CLI walks pages until `nextCursor` is null.
- **Idempotency** — `create` actions accept `--idempotency-key`. The server treats repeated keys as the same request.
- **Conditional update** — `items update` accepts `--if-match <etag>` and returns `409 conflict` if the ETag doesn't match.
- **Multipart upload** — `orders upload` accepts `--file <path>` and posts `multipart/form-data`.

## Raw JSON escape hatch

Every `create`/`update` action accepts `--body '<json>'` to send a raw JSON payload instead of individual flags. Useful when the spec gains a new field before the CLI is regenerated.
