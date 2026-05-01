---
type: business-rule
source: docs
extracted: 2026-04-26
confidence: high
applies-to: ["orders.create"]
---

An order's `lineItems[].itemId` must reference an existing item *and* every line item's `variantId` (when present) must belong to that parent item. The server returns `409 conflict` if a line item references an item that has been deleted between when the client built the order and when it submits — there is no "soft-delete reuse" path.

Practical consequences:

- After deleting an item, do not retry an in-flight order that referenced it. Re-validate the cart.
- Composite orders (orders that bundle multiple items into a kit) are not yet supported via the public API; ask the user if the docs mention "composite items" — that's a Zoho-specific concept that does not apply here.
- The CLI's `--idempotency-key` does not protect against this conflict; idempotency only guards against duplicate POSTs of the same payload, not against state drift between client and server.
