// `items` resource: list (cursor pagination), get, create (idempotency), update, delete.
//
// Each command file default-exports a registry entry consumed by bin/exemplar-cli.mjs:
//   { name, actions, buildPayload?(values) }
// `actions[name]` shape: { method, path, description, flags }.
// The dispatcher reads `flags` to build parseArgs options, interpolates `:placeholder`
// tokens in `path` from those flags, and sends the body for non-GET/DELETE methods.
const COMMON_BODY_FLAGS = {
  body: { type: "string", description: "Raw JSON body (overrides individual flags)" },
  name: { type: "string", description: "Item name" },
  sku: { type: "string", description: "Stock keeping unit identifier" },
  price: { type: "string", description: "Unit price as decimal string (e.g. \"19.99\")" },
};

export default {
  name: "items",
  actions: {
    list: {
      method: "GET",
      path: "/items",
      description: "List items. Pass --all to auto-paginate.",
      flags: {
        cursor: { type: "string", description: "Pagination cursor from a previous response" },
        limit: { type: "string", description: "Page size (server caps at 100)" },
      },
    },
    get: {
      method: "GET",
      path: "/items/:id",
      description: "Fetch a single item by id.",
      flags: {
        id: { type: "string", required: true, description: "Item id" },
      },
    },
    create: {
      method: "POST",
      path: "/items",
      description: "Create an item. Pass --idempotency-key to make the request safe to retry.",
      flags: {
        ...COMMON_BODY_FLAGS,
        "idempotency-key": { type: "string", description: "Idempotency-Key header (optional but recommended)" },
      },
    },
    update: {
      method: "PATCH",
      path: "/items/:id",
      description: "Update an item.",
      flags: {
        id: { type: "string", required: true, description: "Item id" },
        ...COMMON_BODY_FLAGS,
        "if-match": { type: "string", description: "ETag for optimistic concurrency (optional)" },
      },
    },
    delete: {
      method: "DELETE",
      path: "/items/:id",
      description: "Delete an item.",
      flags: {
        id: { type: "string", required: true, description: "Item id" },
      },
    },
  },
  buildPayload(values) {
    const out = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      if (k === "id" || k === "body" || k === "cursor" || k === "limit") continue;
      if (k === "idempotency-key" || k === "if-match") continue;
      if (k === "price") out.price = String(v);
      else out[k] = v;
    }
    return out;
  },
};
