// Unit tests for the upstream-API-quirk helpers in lib/quirks.mjs.
// These cover the contract regardless of which concrete resources opt
// into the annotations — generated CLIs that declare queryFlags or
// brokenListFilters on any action get the same routing and fallback.
import test from "node:test";
import assert from "node:assert/strict";
import {
  pickQueryFlags,
  stripQueryFlags,
  pickBrokenFilters,
  clientFilter,
} from "../lib/quirks.mjs";

test("pickQueryFlags returns only the declared keys, dropping undefined/empty", () => {
  const def = { queryFlags: ["foreignId", "mode"] };
  const values = { foreignId: "FK-1", mode: "", customerId: "C-9", notes: "n" };
  assert.deepEqual(pickQueryFlags(values, def), { foreignId: "FK-1" });
});

test("pickQueryFlags returns undefined when no queryFlags declared or none populated", () => {
  assert.equal(pickQueryFlags({ foo: "bar" }, {}), undefined);
  assert.equal(pickQueryFlags({}, { queryFlags: ["x"] }), undefined);
});

test("stripQueryFlags removes the declared keys from a copy without mutating input", () => {
  const def = { queryFlags: ["foreignId"] };
  const values = { foreignId: "FK-1", customerId: "C-9" };
  const stripped = stripQueryFlags(values, def);
  assert.deepEqual(stripped, { customerId: "C-9" });
  assert.deepEqual(values, { foreignId: "FK-1", customerId: "C-9" }, "input must not mutate");
});

test("stripQueryFlags is a no-op when no queryFlags declared", () => {
  assert.deepEqual(stripQueryFlags({ a: 1, b: 2 }, {}), { a: 1, b: 2 });
});

test("pickBrokenFilters returns the declared filters that were populated (legacy string form)", () => {
  const def = { brokenListFilters: ["customerId", "tag"] };
  assert.deepEqual(
    pickBrokenFilters({ customerId: "C-9", tag: "", other: "x" }, def),
    { customerId: { value: "C-9", match: "equals" } },
  );
  assert.deepEqual(pickBrokenFilters({}, def), {});
  assert.deepEqual(pickBrokenFilters({ a: 1 }, {}), {});
});

test("pickBrokenFilters honors per-filter match mode (v0.6+ object form)", () => {
  const def = {
    brokenListFilters: [
      { name: "customer_name_startswith", match: "startswith" },
      { name: "reference_number_contains", match: "contains" },
      { name: "filter_by", match: "equals" },
    ],
  };
  assert.deepEqual(
    pickBrokenFilters(
      { customer_name_startswith: "Ac", reference_number_contains: "INV", filter_by: "Shipped" },
      def,
    ),
    {
      customer_name_startswith: { value: "Ac", match: "startswith" },
      reference_number_contains: { value: "INV", match: "contains" },
      filter_by: { value: "Shipped", match: "equals" },
    },
  );
});

test("clientFilter (legacy string-value shape): case-insensitive equals OR substring", () => {
  const items = [
    { id: "1", customerId: "ACME-CO", region: "us-west" },
    { id: "2", customerId: "acme-co", region: "us-east" },
    { id: "3", customerId: "OTHER", region: "us-west" },
  ];
  assert.deepEqual(clientFilter(items, { customerId: "acme-co" }).map((r) => r.id), ["1", "2"]);
  assert.deepEqual(clientFilter(items, { customerId: "ACME" }).map((r) => r.id), ["1", "2"]);
  assert.deepEqual(clientFilter(items, { customerId: "ACME", region: "us-west" }).map((r) => r.id), ["1"]);
});

test("clientFilter (v0.6+ object shape) honors per-filter match modes", () => {
  const items = [
    { id: "1", customer_name: "Acme Industries", reference_number: "INV-001", filter_by: "Shipped" },
    { id: "2", customer_name: "Acme Goods",      reference_number: "INV-002", filter_by: "NotShipped" },
    { id: "3", customer_name: "Other Co",        reference_number: "PO-077",  filter_by: "Shipped" },
  ];
  // startswith: "Ac" matches both Acme rows but not Other Co.
  assert.deepEqual(
    clientFilter(items, { customer_name: { value: "Ac", match: "startswith" } }).map((r) => r.id),
    ["1", "2"],
  );
  // contains: "INV" matches the two with INV reference numbers.
  assert.deepEqual(
    clientFilter(items, { reference_number: { value: "INV", match: "contains" } }).map((r) => r.id),
    ["1", "2"],
  );
  // equals: only an exact case-insensitive match — "Shipped" must NOT match "NotShipped".
  assert.deepEqual(
    clientFilter(items, { filter_by: { value: "Shipped", match: "equals" } }).map((r) => r.id),
    ["1", "3"],
  );
  // Multi-filter is AND across mixed match modes.
  assert.deepEqual(
    clientFilter(items, {
      customer_name: { value: "Acme", match: "startswith" },
      filter_by: { value: "Shipped", match: "equals" },
    }).map((r) => r.id),
    ["1"],
  );
});

test("clientFilter is a no-op when no filters provided", () => {
  const items = [{ id: "1" }, { id: "2" }];
  assert.equal(clientFilter(items, {}), items);
});

test("clientFilter rejects rows whose target field is missing or null", () => {
  const items = [{ id: "1" }, { id: "2", customerId: null }, { id: "3", customerId: "X" }];
  assert.deepEqual(clientFilter(items, { customerId: "X" }).map((r) => r.id), ["3"]);
});
