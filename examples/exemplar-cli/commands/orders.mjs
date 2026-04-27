// `orders` resource: list, get, create (idempotency + convert-from-cart),
// upload (multipart).
//
// Demonstrates two annotations the runtime understands:
//
//   queryFlags          — flag names that ride on the URL query string
//                         instead of the JSON body. Use this whenever the
//                         upstream API documents a "convert from X" mode
//                         that takes the parent FK as ?fk=... Putting the
//                         FK in the body is silently dropped on these APIs
//                         (Zoho's POST /creditnotes ?invoice_id= is the
//                         canonical example), and the resulting record has
//                         no structural link back to the source.
//
//   brokenListFilters   — list-action filters the upstream API silently
//                         ignores (returns HTTP 200 with the unfiltered
//                         list). Runtime drops them from the wire and
//                         falls back to a client-side filter on the full
//                         list, with a one-line stderr note. Verify by
//                         passing a clearly-fake value: if the row count
//                         matches the unfiltered baseline, the filter is
//                         broken upstream.
const COMMON_BODY_FLAGS = {
  body: { type: "string", description: "Raw JSON body (overrides individual flags)" },
  customerId: { type: "string", description: "Customer placing the order" },
  notes: { type: "string", description: "Free-form order notes" },
};

export default {
  name: "orders",
  actions: {
    list: {
      method: "GET",
      path: "/orders",
      description: "List orders.",
      flags: {
        cursor: { type: "string", description: "Pagination cursor" },
        status: { type: "string", description: "Filter by status (pending|paid|cancelled)" },
        customerId: { type: "string", description: "Filter by customer (BROKEN upstream — runtime falls back to client-side filter)" },
      },
      // `customerId` is exposed for ergonomics but the upstream API silently
      // ignores it — see brokenListFilters note at top of file.
      brokenListFilters: ["customerId"],
    },
    get: {
      method: "GET",
      path: "/orders/:id",
      description: "Fetch a single order by id.",
      flags: {
        id: { type: "string", required: true, description: "Order id" },
      },
    },
    create: {
      method: "POST",
      path: "/orders",
      description: "Create an order. Pass --idempotency-key to make the request safe to retry. Pass --cartId to convert an existing cart into an order (the upstream API expects ?cartId= as a URL query parameter — body cartId is silently dropped).",
      flags: {
        ...COMMON_BODY_FLAGS,
        "idempotency-key": { type: "string", description: "Idempotency-Key header (optional but recommended)" },
        cartId: { type: "string", description: "Source cart id — passed as ?cartId= URL query (convert-from-cart mode); body form is silently dropped" },
      },
      // Routes --cartId onto the URL; runtime strips it from the body.
      queryFlags: ["cartId"],
    },
    upload: {
      method: "POST",
      path: "/orders/:id/upload",
      description: "Attach a file (receipt, packing slip) to an order via multipart/form-data.",
      flags: {
        id: { type: "string", required: true, description: "Order id" },
        file: { type: "string", required: true, description: "Path to the file to attach" },
      },
    },
  },
  buildPayload(values) {
    const out = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      if (k === "id" || k === "body" || k === "cursor" || k === "status" || k === "file") continue;
      if (k === "idempotency-key") continue;
      // `cartId` is a queryFlag (see actions.create.queryFlags) — bin/
      // already stripped it before calling buildPayload, but keep this
      // guard so callers using buildPayload directly don't leak it.
      if (k === "cartId") continue;
      // `customerId` filter is also handled at the bin layer for list, but
      // for create/update the field is a real body field and we keep it.
      out[k] = v;
    }
    return out;
  },
};
