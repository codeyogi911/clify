import test from "node:test";
import assert from "node:assert/strict";
import { mockApi } from "./_mock-server.mjs";
import { run, runJson } from "./_helpers.mjs";

const RESOURCES = ["posts", "comments", "albums", "photos", "todos", "users"];

async function withMock(routes, fn) {
  const server = await mockApi(routes);
  try { await fn(server); } finally { await server.close(); }
}

// ---------- per-resource CRUD coverage ----------

for (const res of RESOURCES) {
  test(`${res} list returns array`, async () => {
    await withMock({ [`GET /${res}`]: { status: 200, body: [{ id: 1 }, { id: 2 }] } }, async (server) => {
      const r = await runJson([res, "list"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(Array.isArray(r.json));
      assert.equal(r.json.length, 2);
      assert.equal(server.requests[0].method, "GET");
      assert.equal(server.requests[0].path, `/${res}`);
    });
  });

  test(`${res} get returns single`, async () => {
    await withMock({
      [`GET /${res}/:id`]: (req, params) => ({ status: 200, body: { id: Number(params.id), foo: "bar" } }),
    }, async (server) => {
      const r = await runJson([res, "get", "--id", "7"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.json.id, 7);
      assert.equal(server.requests[0].path, `/${res}/7`);
    });
  });

  test(`${res} create echoes payload`, async () => {
    await withMock({
      [`POST /${res}`]: (req) => ({ status: 201, body: { id: 101, ...req.body } }),
    }, async (server) => {
      const args = [res, "create", "--body", JSON.stringify({ probe: "value" })];
      const r = await runJson(args, { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.json.id, 101);
      assert.equal(r.json.probe, "value");
      assert.equal(server.requests[0].method, "POST");
      assert.deepEqual(server.requests[0].body, { probe: "value" });
    });
  });

  test(`${res} update mutates`, async () => {
    await withMock({
      [`PUT /${res}/:id`]: (req, params) => ({ status: 200, body: { id: Number(params.id), ...req.body } }),
    }, async (server) => {
      const args = [res, "update", "--id", "3", "--body", JSON.stringify({ patch: 1 })];
      const r = await runJson(args, { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.json.id, 3);
      assert.equal(r.json.patch, 1);
    });
  });

  test(`${res} delete returns null body`, async () => {
    await withMock({
      [`DELETE /${res}/:id`]: { status: 200, body: {} },
    }, async (server) => {
      const r = await runJson([res, "delete", "--id", "9"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(server.requests[0].method, "DELETE");
      assert.equal(server.requests[0].path, `/${res}/9`);
    });
  });
}

// ---------- error paths ----------

test("404 → not_found", async () => {
  await withMock({ "GET /posts/:id": { status: 404, body: { message: "nope" } } }, async (server) => {
    const r = await runJson(["posts", "get", "--id", "999"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "not_found");
    assert.equal(r.errJson.retryable, false);
  });
});

test("422 → validation_error with details", async () => {
  await withMock({ "POST /posts": { status: 422, body: { message: "bad", errors: ["title required"] } } }, async (server) => {
    const r = await runJson(["posts", "create", "--body", "{}"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "validation_error");
    assert.ok(r.errJson.details);
  });
});

test("429 with Retry-After → rate_limited + retryAfter", async () => {
  await withMock({ "GET /posts": { status: 429, headers: { "retry-after": "30" }, body: { message: "slow down" } } }, async (server) => {
    const r = await runJson(["posts", "list"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "rate_limited");
    assert.equal(r.errJson.retryable, true);
    assert.equal(r.errJson.retryAfter, 30);
  });
});

test("500 → server_error retryable", async () => {
  await withMock({ "GET /posts": { status: 500, body: { message: "boom" } } }, async (server) => {
    const r = await runJson(["posts", "list"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "server_error");
    assert.equal(r.errJson.retryable, true);
  });
});

test("network down → network_error", async () => {
  // Allocate a port then close immediately to guarantee nothing listens.
  const server = await mockApi({});
  const url = server.url;
  await server.close();
  const r = await runJson(["posts", "list"], { env: { JSONPLACEHOLDER_BASE_URL: url } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "network_error");
  assert.equal(r.errJson.retryable, true);
});

test("BASE_URL override is honored", async () => {
  await withMock({ "GET /posts": { status: 200, body: [] } }, async (server) => {
    const r = await runJson(["posts", "list"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
    assert.equal(r.exitCode, 0);
    assert.equal(server.requests.length, 1);
  });
});

test("user-agent header is sent", async () => {
  await withMock({ "GET /posts": { status: 200, body: [] } }, async (server) => {
    await runJson(["posts", "list"], { env: { JSONPLACEHOLDER_BASE_URL: server.url } });
    assert.match(server.requests[0].headers["user-agent"], /jsonplaceholder-cli\//);
  });
});
