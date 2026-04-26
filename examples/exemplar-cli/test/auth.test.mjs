// Auth-specific paths: bearer wiring, login --status reflection, 401 mapping,
// and OAuth-refresh precedence (env > cache-with-matching-hash > stored,
// expired-cache triggers refresh, NO_CACHE skips persistence).
//
// Splits out of integration.test.mjs to keep responsibilities per-file
// (mirrors agents-cli's per-feature test layout).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockApi } from "./_mock-server.mjs";
import { run, runJson } from "./_helpers.mjs";

// === bearer scheme (default) =================================================

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

test("dry-run output redacts the Bearer token", async () => {
  const r = await runJson(["items", "list", "--dry-run"], {
    env: { EXEMPLAR_API_KEY: "supersecrettoken12345abcdef", EXEMPLAR_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.json.headers.authorization, "<redacted>");
  // sanity: the token must not appear anywhere in the dry-run output
  assert.ok(!JSON.stringify(r.json).includes("supersecrettoken12345abcdef"));
});

test("--show-secrets disables redaction", async () => {
  const r = await runJson(["items", "list", "--dry-run", "--show-secrets"], {
    env: { EXEMPLAR_API_KEY: "visibletoken", EXEMPLAR_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.json.headers.authorization, "Bearer visibletoken");
});

// === OAuth-refresh scheme ====================================================
// All tests in this block flip the scheme via __EXEMPLAR_DEV_SCHEME and
// redirect the credential store to a per-test tmp dir via __EXEMPLAR_DEV_CONFIG_DIR.
// The exemplar's substitute-phase comment in lib/auth.mjs / lib/config.mjs
// notes that generated CLIs replace these constants with hardcoded values.

function mkTmp() {
  const dir = mkdtempSync(join(tmpdir(), "exemplar-cli-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readCreds(dir) {
  const p = join(dir, "credentials.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeCreds(dir, obj) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credentials.json"), JSON.stringify(obj));
}

test("oauth-refresh: env access token wins (no cache read, no refresh)", async () => {
  const tmp = mkTmp();
  // Pre-populate a cached access token; the env var should win regardless.
  writeCreds(tmp.dir, { accessToken: "should-not-be-used", expiresAt: Date.now() + 60000, savedAt: "x" });
  const api = await mockApi({ "GET /items": { status: 200, body: { items: [], nextCursor: null } } });
  try {
    await runJson(["items", "list"], {
      env: {
        EXEMPLAR_API_KEY: "env-access-wins",
        EXEMPLAR_BASE_URL: api.url,
        __EXEMPLAR_DEV_SCHEME: "oauth-refresh",
        __EXEMPLAR_DEV_CONFIG_DIR: tmp.dir,
      },
    });
    assert.equal(api.requests[0].headers.authorization, "Bearer env-access-wins");
  } finally { await api.close(); tmp.cleanup(); }
});

test("oauth-refresh: env refresh creds mint a new access token via TOKEN_URL", async () => {
  const tmp = mkTmp();
  let refreshHits = 0;
  const oauth = await mockApi({
    "POST /oauth/token": (req) => {
      refreshHits++;
      assert.equal(req.query.refresh_token, "env-refresh");
      assert.equal(req.query.client_id, "env-client");
      assert.equal(req.query.client_secret, "env-secret");
      assert.equal(req.query.grant_type, "refresh_token");
      return { status: 200, body: { access_token: "minted-from-env", expires_in: 3600 } };
    },
  });
  const api = await mockApi({ "GET /items": { status: 200, body: { items: [], nextCursor: null } } });
  try {
    await runJson(["items", "list"], {
      env: {
        EXEMPLAR_REFRESH_TOKEN: "env-refresh",
        EXEMPLAR_CLIENT_ID: "env-client",
        EXEMPLAR_CLIENT_SECRET: "env-secret",
        EXEMPLAR_TOKEN_URL: `${oauth.url}/oauth/token`,
        EXEMPLAR_BASE_URL: api.url,
        __EXEMPLAR_DEV_SCHEME: "oauth-refresh",
        __EXEMPLAR_DEV_CONFIG_DIR: tmp.dir,
      },
    });
    assert.equal(refreshHits, 1, "refresh endpoint should have been hit exactly once");
    assert.equal(api.requests[0].headers.authorization, "Bearer minted-from-env");
    const stored = readCreds(tmp.dir);
    assert.equal(stored.accessToken, "minted-from-env");
    assert.equal(typeof stored.refreshTokenHash, "string");
  } finally { await oauth.close(); await api.close(); tmp.cleanup(); }
});

test("oauth-refresh: cache reused only if refreshTokenHash matches current source", async () => {
  const tmp = mkTmp();
  // Cache was minted from a different refresh token (account A).
  writeCreds(tmp.dir, {
    refreshToken: "old-account-refresh",
    clientId: "env-client",
    clientSecret: "env-secret",
    accessToken: "stale-from-account-A",
    expiresAt: Date.now() + 60_000,
    refreshTokenHash: "deadbeefdeadbeef", // intentionally wrong hash
    savedAt: "x",
  });
  let refreshHits = 0;
  const oauth = await mockApi({
    "POST /oauth/token": () => {
      refreshHits++;
      return { status: 200, body: { access_token: "fresh-for-account-B", expires_in: 3600 } };
    },
  });
  const api = await mockApi({ "GET /items": { status: 200, body: { items: [], nextCursor: null } } });
  try {
    await runJson(["items", "list"], {
      env: {
        EXEMPLAR_REFRESH_TOKEN: "new-account-refresh", // hash will not match stored one
        EXEMPLAR_CLIENT_ID: "env-client",
        EXEMPLAR_CLIENT_SECRET: "env-secret",
        EXEMPLAR_TOKEN_URL: `${oauth.url}/oauth/token`,
        EXEMPLAR_BASE_URL: api.url,
        __EXEMPLAR_DEV_SCHEME: "oauth-refresh",
        __EXEMPLAR_DEV_CONFIG_DIR: tmp.dir,
      },
    });
    assert.equal(refreshHits, 1, "should have re-minted because hash mismatched");
    assert.equal(api.requests[0].headers.authorization, "Bearer fresh-for-account-B");
  } finally { await oauth.close(); await api.close(); tmp.cleanup(); }
});

test("oauth-refresh: expired cache triggers re-mint", async () => {
  const tmp = mkTmp();
  writeCreds(tmp.dir, {
    refreshToken: "stable-refresh",
    clientId: "c", clientSecret: "s",
    accessToken: "expired-token",
    expiresAt: Date.now() - 1000, // already expired
    refreshTokenHash: null, // will not match either way
    savedAt: "x",
  });
  let refreshHits = 0;
  const oauth = await mockApi({
    "POST /oauth/token": () => {
      refreshHits++;
      return { status: 200, body: { access_token: "freshly-minted", expires_in: 3600 } };
    },
  });
  const api = await mockApi({ "GET /items": { status: 200, body: { items: [], nextCursor: null } } });
  try {
    await runJson(["items", "list"], {
      env: {
        EXEMPLAR_REFRESH_TOKEN: "stable-refresh",
        EXEMPLAR_CLIENT_ID: "c",
        EXEMPLAR_CLIENT_SECRET: "s",
        EXEMPLAR_TOKEN_URL: `${oauth.url}/oauth/token`,
        EXEMPLAR_BASE_URL: api.url,
        __EXEMPLAR_DEV_SCHEME: "oauth-refresh",
        __EXEMPLAR_DEV_CONFIG_DIR: tmp.dir,
      },
    });
    assert.equal(refreshHits, 1);
    assert.equal(api.requests[0].headers.authorization, "Bearer freshly-minted");
  } finally { await oauth.close(); await api.close(); tmp.cleanup(); }
});

test("oauth-refresh: refresh failure surfaces auth_missing (not auth_invalid)", async () => {
  const tmp = mkTmp();
  const oauth = await mockApi({
    "POST /oauth/token": { status: 400, body: { error: "invalid_grant" } },
  });
  try {
    const r = await runJson(["items", "list"], {
      env: {
        EXEMPLAR_REFRESH_TOKEN: "bad-refresh",
        EXEMPLAR_CLIENT_ID: "c",
        EXEMPLAR_CLIENT_SECRET: "s",
        EXEMPLAR_TOKEN_URL: `${oauth.url}/oauth/token`,
        EXEMPLAR_BASE_URL: "http://127.0.0.1:1", // never reached
        __EXEMPLAR_DEV_SCHEME: "oauth-refresh",
        __EXEMPLAR_DEV_CONFIG_DIR: tmp.dir,
      },
    });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "auth_missing", `expected auth_missing, got ${r.errJson?.code}`);
    assert.match(r.errJson.message, /oauth refresh failed/i);
  } finally { await oauth.close(); tmp.cleanup(); }
});

test("oauth-refresh: NO_CACHE=1 skips writing credentials.json", async () => {
  const tmp = mkTmp();
  const oauth = await mockApi({
    "POST /oauth/token": { status: 200, body: { access_token: "no-persist-me", expires_in: 3600 } },
  });
  const api = await mockApi({ "GET /items": { status: 200, body: { items: [], nextCursor: null } } });
  try {
    await runJson(["items", "list"], {
      env: {
        EXEMPLAR_REFRESH_TOKEN: "r", EXEMPLAR_CLIENT_ID: "c", EXEMPLAR_CLIENT_SECRET: "s",
        EXEMPLAR_NO_CACHE: "1",
        EXEMPLAR_TOKEN_URL: `${oauth.url}/oauth/token`,
        EXEMPLAR_BASE_URL: api.url,
        __EXEMPLAR_DEV_SCHEME: "oauth-refresh",
        __EXEMPLAR_DEV_CONFIG_DIR: tmp.dir,
      },
    });
    assert.equal(api.requests[0].headers.authorization, "Bearer no-persist-me");
    assert.equal(readCreds(tmp.dir), null, "credentials.json must not be written when NO_CACHE=1");
  } finally { await oauth.close(); await api.close(); tmp.cleanup(); }
});

test("oauth-refresh: login persists OAuth creds with refreshTokenHash", async () => {
  const tmp = mkTmp();
  const r = await runJson(
    ["login", "--refresh-token", "rt", "--client-id", "ci", "--client-secret", "cs"],
    { env: { __EXEMPLAR_DEV_SCHEME: "oauth-refresh", __EXEMPLAR_DEV_CONFIG_DIR: tmp.dir } },
  );
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.mode, "oauth-refresh");
    const stored = readCreds(tmp.dir);
    assert.equal(stored.refreshToken, "rt");
    assert.equal(stored.clientId, "ci");
    assert.equal(stored.clientSecret, "cs");
    assert.equal(typeof stored.refreshTokenHash, "string");
    assert.equal(stored.accessToken, undefined);
  } finally { tmp.cleanup(); }
});

test("login rejects mixed --token + OAuth flags", async () => {
  const tmp = mkTmp();
  const r = await runJson(
    ["login", "--token", "x", "--refresh-token", "y"],
    { env: { __EXEMPLAR_DEV_CONFIG_DIR: tmp.dir } },
  );
  try {
    assert.equal(r.exitCode, 1);
    assert.equal(r.errJson.code, "validation_error");
    assert.match(r.errJson.message, /not both/i);
  } finally { tmp.cleanup(); }
});
