// Integration tests against the bundled mock server. Exercises the full
// HTTP path: cursor pagination across two pages, idempotency-key headers,
// multipart upload, and the structured error map.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockApi } from "./_mock-server.mjs";
import { run, runJson } from "./_helpers.mjs";

const ENV = { EXEMPLAR_API_KEY: "test-token" };

async function withMock(routes, fn) {
  const server = await mockApi(routes);
  try { await fn(server); } finally { await server.close(); }
}

// ---------- items resource ----------

test("items list returns array", async () => {
  await withMock({
    "GET /items": { status: 200, body: { items: [{ id: "1" }, { id: "2" }], nextCursor: null } },
  }, async (server) => {
    const r = await runJson(["items", "list"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.items.length, 2);
    assert.equal(server.requests[0].method, "GET");
    assert.equal(server.requests[0].path, "/items");
  });
});

test("items list --all walks cursor pages and concatenates", async () => {
  await withMock({
    "GET /items": (req) => {
      const cursor = req.query.cursor;
      if (!cursor) return { status: 200, body: { items: [{ id: "1" }, { id: "2" }], nextCursor: "page-2" } };
      if (cursor === "page-2") return { status: 200, body: { items: [{ id: "3" }], nextCursor: null } };
      return { status: 400, body: { message: "unknown cursor" } };
    },
  }, async (server) => {
    const r = await runJson(["items", "list", "--all"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.length, 3);
    assert.deepEqual(r.json.map((i) => i.id), ["1", "2", "3"]);
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1].query.cursor, "page-2");
  });
});

test("items get interpolates id into path", async () => {
  await withMock({
    "GET /items/:id": (_req, params) => ({ status: 200, body: { id: params.id, name: "Widget" } }),
  }, async (server) => {
    const r = await runJson(["items", "get", "--id", "42"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.id, "42");
    assert.equal(server.requests[0].path, "/items/42");
  });
});

test("items create sends body and idempotency-key header", async () => {
  await withMock({
    "POST /items": (req) => ({ status: 201, body: { id: "new", ...req.body } }),
  }, async (server) => {
    const r = await runJson(
      ["items", "create", "--name", "Widget", "--sku", "W-001", "--price", "9.99", "--idempotency-key", "abc-123"],
      { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } }
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.id, "new");
    assert.equal(r.json.name, "Widget");
    assert.equal(server.requests[0].headers["idempotency-key"], "abc-123");
    assert.deepEqual(server.requests[0].body, { name: "Widget", sku: "W-001", price: "9.99" });
  });
});

test("items update sends if-match header for optimistic concurrency", async () => {
  await withMock({
    "PATCH /items/:id": (req, params) => ({ status: 200, body: { id: params.id, ...req.body } }),
  }, async (server) => {
    const r = await runJson(
      ["items", "update", "--id", "7", "--name", "Updated", "--if-match", "etag-xyz"],
      { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } }
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(server.requests[0].headers["if-match"], "etag-xyz");
    assert.equal(server.requests[0].body.name, "Updated");
  });
});

test("items delete returns null body", async () => {
  await withMock({
    "DELETE /items/:id": { status: 200, body: {} },
  }, async (server) => {
    const r = await runJson(["items", "delete", "--id", "9"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(server.requests[0].method, "DELETE");
    assert.equal(server.requests[0].path, "/items/9");
  });
});

// ---------- item-variants sub-resource ----------

test("item-variants list interpolates parent id", async () => {
  await withMock({
    "GET /items/:itemId/variants": (_req, params) => ({ status: 200, body: { items: [{ id: "v1", parent: params.itemId }], nextCursor: null } }),
  }, async (server) => {
    const r = await runJson(["item-variants", "list", "--itemId", "100"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(server.requests[0].path, "/items/100/variants");
    assert.equal(r.json.items[0].parent, "100");
  });
});

test("item-variants create sends body without itemId in payload", async () => {
  await withMock({
    "POST /items/:itemId/variants": (req, params) => ({ status: 201, body: { id: "v2", ...req.body, parent: params.itemId } }),
  }, async (server) => {
    const r = await runJson(
      ["item-variants", "create", "--itemId", "100", "--sku", "W-001-S", "--size", "S", "--color", "red"],
      { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } }
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(server.requests[0].body, { sku: "W-001-S", size: "S", color: "red" });
    assert.equal(server.requests[0].path, "/items/100/variants");
  });
});

// ---------- orders + multipart ----------

test("orders list filters by status query", async () => {
  await withMock({
    "GET /orders": (req) => ({ status: 200, body: { items: [{ id: "o1", status: req.query.status }], nextCursor: null } }),
  }, async (server) => {
    const r = await runJson(["orders", "list", "--status", "pending"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(server.requests[0].query.status, "pending");
  });
});

test("orders upload posts multipart/form-data with --file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exemplar-mp-"));
  const filePath = join(tmp, "receipt.txt");
  writeFileSync(filePath, "RECEIPT");
  try {
    await withMock({
      "POST /orders/:id/upload": (req, params) => ({ status: 200, body: { id: params.id, contentType: req.headers["content-type"], rawLen: req.raw.length } }),
    }, async (server) => {
      const r = await runJson(["orders", "upload", "--id", "ord-1", "--file", filePath], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.json.contentType, /multipart\/form-data/);
      assert.ok(r.json.rawLen > 0, "raw multipart body should be non-empty");
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- error paths ----------

test("404 → not_found", async () => {
  await withMock({ "GET /items/:id": { status: 404, body: { message: "nope" } } }, async (server) => {
    const r = await runJson(["items", "get", "--id", "999"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "not_found");
    assert.equal(r.errJson.retryable, false);
  });
});

test("422 → validation_error with details", async () => {
  await withMock({ "POST /items": { status: 422, body: { message: "bad", errors: ["name required"] } } }, async (server) => {
    const r = await runJson(["items", "create", "--name", ""], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "validation_error");
    assert.ok(r.errJson.details);
  });
});

test("429 with Retry-After → rate_limited + retryAfter", async () => {
  await withMock({ "GET /items": { status: 429, headers: { "retry-after": "30" }, body: { message: "slow down" } } }, async (server) => {
    const r = await runJson(["items", "list"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "rate_limited");
    assert.equal(r.errJson.retryable, true);
    assert.equal(r.errJson.retryAfter, 30);
  });
});

test("500 → server_error retryable", async () => {
  await withMock({ "GET /items": { status: 500, body: { message: "boom" } } }, async (server) => {
    const r = await runJson(["items", "list"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "server_error");
    assert.equal(r.errJson.retryable, true);
  });
});

test("network down → network_error", async () => {
  const server = await mockApi({});
  const url = server.url;
  await server.close();
  const r = await runJson(["items", "list"], { env: { ...ENV, EXEMPLAR_BASE_URL: url } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "network_error");
  assert.equal(r.errJson.retryable, true);
});

test("BASE_URL override is honored", async () => {
  await withMock({ "GET /items": { status: 200, body: { items: [], nextCursor: null } } }, async (server) => {
    const r = await runJson(["items", "list"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 0);
    assert.equal(server.requests.length, 1);
  });
});

test("user-agent header is sent", async () => {
  await withMock({ "GET /items": { status: 200, body: { items: [], nextCursor: null } } }, async (server) => {
    await runJson(["items", "list"], { env: { ...ENV, EXEMPLAR_BASE_URL: server.url } });
    assert.match(server.requests[0].headers["user-agent"], /exemplar-cli\//);
  });
});

