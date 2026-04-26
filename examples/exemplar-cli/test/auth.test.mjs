// Auth-specific paths: bearer token wiring, login --status reflection,
// 401 mapping. Splits out of integration.test.mjs to keep responsibilities
// per-file (mirrors agents-cli's per-feature test layout).
import test from "node:test";
import assert from "node:assert/strict";
import { mockApi } from "./_mock-server.mjs";
import { run, runJson } from "./_helpers.mjs";

test("Authorization: Bearer header is sent when EXEMPLAR_API_KEY is set", async () => {
  const server = await mockApi({ "GET /items": { status: 200, body: { items: [], nextCursor: null } } });
  try {
    await runJson(["items", "list"], { env: { EXEMPLAR_API_KEY: "shh-secret-token", EXEMPLAR_BASE_URL: server.url } });
    assert.equal(server.requests[0].headers.authorization, "Bearer shh-secret-token");
  } finally { await server.close(); }
});

test("401 → auth_invalid", async () => {
  const server = await mockApi({ "GET /items": { status: 401, body: { message: "bad token" } } });
  try {
    const r = await runJson(["items", "list"], { env: { EXEMPLAR_API_KEY: "wrong", EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "auth_invalid");
    assert.equal(r.errJson.retryable, false);
  } finally { await server.close(); }
});

test("403 → forbidden", async () => {
  const server = await mockApi({ "GET /items": { status: 403, body: { message: "no scope" } } });
  try {
    const r = await runJson(["items", "list"], { env: { EXEMPLAR_API_KEY: "scoped", EXEMPLAR_BASE_URL: server.url } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "forbidden");
  } finally { await server.close(); }
});

test("login --status reports auth source", async () => {
  const r = await runJson(["login", "--status"], { env: { EXEMPLAR_API_KEY: "live" } });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.json.authenticated, true);
  assert.equal(r.json.fromEnv, true);
  assert.equal(r.json.scheme, "bearer");
});
