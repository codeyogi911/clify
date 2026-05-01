# Agent instructions for exemplar-cli

You are working with `exemplar-cli`, a thin CLI over the (fictional) Exemplar API. This is the **stencil** repo for the clify scaffolder — anything you do here should hold up as a pattern every generated CLI inherits.

## Before you act

1. Read every file in `knowledge/` — they capture API quirks and business rules.
2. Use `exemplar-cli --help`, `exemplar-cli <resource> --help`, and `exemplar-cli <resource> <action> --help`. Help is generated from the same registry the dispatcher reads, so it never drifts.
3. Run `exemplar-cli login --status --json` if a command surprises you with `auth_missing`.

## Conventions

- All resource commands follow `<resource> <action> [flags]`. The `login` command is dispatched separately.
- Errors are JSON on stderr with exit code 1. `code` tells you whether to retry (`retryable: true`) and how long (`retryAfter` seconds).
- The CLI never retries. That decision lives in the agent loop — see `skills/exemplar-cli/SKILL.md`.
- Set `EXEMPLAR_BASE_URL` to point at a mock server during testing.

## Idempotency

`POST /items` and `POST /orders` accept `--idempotency-key`. Generate one per logical operation (UUIDv4) and reuse it on retries to avoid duplicate writes. See `knowledge/idempotency-keys.md`.

## Pagination

Every `list` action returns `{ items, nextCursor }`. Use `--all` to walk pages or `--cursor <value>` to step manually. See `knowledge/cursor-pagination.md`.

## Testing

```
npm test
```

Runs smoke, integration, and auth tests against an in-repo mock server. CI runs the same on Node 20 and 22. No network required.
