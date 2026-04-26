---
type: pattern
source: docs
extracted: 2026-04-26
confidence: high
---

The Exemplar API enforces a per-token rate limit of 60 requests/minute. When you hit the cap:

- HTTP `429` with a `Retry-After` header (seconds).
- The CLI maps this to `code: "rate_limited", retryable: true, retryAfter: <seconds>`.
- The CLI does **not** auto-retry. Callers should sleep for `retryAfter` seconds and re-issue.

For batch workloads, prefer paginated reads (`--all` walks pages serially, which is below the cap) over parallelising the same endpoint. Bursting parallel requests across resources is fine — the cap is global per token, not per endpoint.
