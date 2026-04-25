# Agent Instructions

You are working with `jsonplaceholder-cli`, a thin CLI over the JSONPlaceholder REST API.

## Before you act

1. Read every file in `knowledge/` — they contain API quirks, business rules, and patterns.
2. Use `jsonplaceholder-cli --help` and `jsonplaceholder-cli <resource> <action> --help` to learn flags. The help output is generated from the resource registry, so it is always accurate.

## Conventions

- All commands follow `<resource> <action> [flags]`.
- Errors are JSON-shaped on stderr with exit code 1. The `code` field tells you whether to retry (`retryable: true`) and how long to wait (`retryAfter` seconds).
- The CLI does not retry on its own — that is your job.
- Set `JSONPLACEHOLDER_BASE_URL` to point the CLI at a mock server during testing.

## Writes do not persist

JSONPlaceholder's `POST`, `PUT`, `PATCH`, and `DELETE` endpoints all return successful responses, but no data is actually written. The response includes a fabricated `id`. Do not chain `create` → `get` against JSONPlaceholder — the second call will 404. See `knowledge/writes-do-not-persist.md`.

## Testing

```
npm test
```

runs both smoke tests (no network) and integration tests (against the bundled mock at `test/_mock-server.mjs`). CI runs the same on Node 20 and 22.
