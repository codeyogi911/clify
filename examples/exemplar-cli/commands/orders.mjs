// `orders` resource: list, get, create (idempotency), upload (multipart).
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
      },
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
      description: "Create an order. Pass --idempotency-key to make the request safe to retry.",
      flags: {
        ...COMMON_BODY_FLAGS,
        "idempotency-key": { type: "string", description: "Idempotency-Key header (optional but recommended)" },
      },
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
      out[k] = v;
    }
    return out;
  },
};
