// `item-variants` resource: a sub-resource of items, flattened to keep
// command nesting at two levels (per references/conventions.md). The parent
// id travels as `--itemId` and is interpolated into the path template.
const VARIANT_BODY_FLAGS = {
  body: { type: "string", description: "Raw JSON body (overrides individual flags)" },
  sku: { type: "string", description: "Variant SKU" },
  size: { type: "string", description: "Variant size (e.g. S, M, L)" },
  color: { type: "string", description: "Variant color" },
};

export default {
  name: "item-variants",
  actions: {
    list: {
      method: "GET",
      path: "/items/:itemId/variants",
      description: "List variants for an item.",
      flags: {
        itemId: { type: "string", required: true, description: "Parent item id" },
        cursor: { type: "string", description: "Pagination cursor" },
      },
    },
    create: {
      method: "POST",
      path: "/items/:itemId/variants",
      description: "Create a variant under an item.",
      flags: {
        itemId: { type: "string", required: true, description: "Parent item id" },
        ...VARIANT_BODY_FLAGS,
      },
    },
  },
  buildPayload(values) {
    const out = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      if (k === "itemId" || k === "body" || k === "cursor") continue;
      out[k] = v;
    }
    return out;
  },
};
