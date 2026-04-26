---
type: pattern
source: docs
extracted: 2026-04-26
confidence: high
applies-to: ["items.create", "orders.create"]
---

The Exemplar API honors the `Idempotency-Key` header on `POST /items` and `POST /orders`. Pass it via `--idempotency-key <value>`.

Server semantics:

- A repeated key with the *same* body returns the original response (status, headers, body) without re-processing.
- A repeated key with a *different* body returns `422 validation_error` with `code: "idempotency_key_reuse"`. The CLI maps this to its standard `validation_error`; check `details.code` to disambiguate.
- Keys expire after 24 hours of last use.

Recommended values: a UUIDv4 per logical operation. Do not reuse keys across distinct operations even if their payloads are identical — that defeats the safety net for a future bug fix that changes payload shape.

When the CLI encounters a `network_error` or `timeout` on a `create`, retrying the same command with the same `--idempotency-key` is safe.
