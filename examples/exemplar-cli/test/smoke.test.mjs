// Structural tests for exemplar-cli — no network, no auth, no surprises.
// Verifies CLI shape: --version, --help breadth, error semantics, --dry-run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, runJson, REPO_ROOT } from "./_helpers.mjs";

const RESOURCES = ["items", "item-variants", "orders"];
const ITEMS_ACTIONS = ["list", "get", "create", "update", "delete"];

test("--version prints package.json version", async () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const r = await run(["--version"]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("--help lists all resources", async () => {
  const r = await run(["--help"]);
  assert.equal(r.exitCode, 0);
  for (const res of RESOURCES) assert.match(r.stdout, new RegExp(`\\b${res}\\b`));
  assert.match(r.stdout, /\blogin\b/);
});

test("<resource> --help lists all actions", async () => {
  for (const a of ITEMS_ACTIONS) {
    const r = await run(["items", "--help"]);
    assert.equal(r.exitCode, 0, `items --help failed: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`\\b${a}\\b`));
  }
});

test("<resource> <action> --help shows flag table", async () => {
  const r = await run(["items", "create", "--help"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Flags:/);
  assert.match(r.stdout, /--name/);
  assert.match(r.stdout, /--idempotency-key/);
});

test("unknown resource → validation_error", async () => {
  const r = await runJson(["nope", "list"], { env: { EXEMPLAR_API_KEY: "test" } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "validation_error");
});

test("unknown action → validation_error listing available", async () => {
  const r = await runJson(["items", "frobnicate"], { env: { EXEMPLAR_API_KEY: "test" } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "validation_error");
  assert.match(r.errJson.message, /list|get|create|update|delete/);
});

test("required flag missing → validation_error (no crash)", async () => {
  const r = await runJson(["items", "get"], { env: { EXEMPLAR_API_KEY: "test" } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "validation_error");
  assert.match(r.errJson.message, /--id/);
});

test("auth missing → auth_missing", async () => {
  const r = await runJson(["items", "list"]);
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "auth_missing");
});

test("--dry-run does not make network requests", async () => {
  const r = await runJson(["items", "list", "--dry-run"], {
    env: { EXEMPLAR_API_KEY: "test", EXEMPLAR_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.json.__dryRun, true);
  assert.equal(r.json.method, "GET");
});

test("source has no hardcoded secrets", () => {
  const src = readFileSync(join(REPO_ROOT, "bin/exemplar-cli.mjs"), "utf8");
  const PATTERNS = [/sk_live_[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9_\-]{30,}/, /xoxb-[A-Za-z0-9-]{20,}/];
  for (const p of PATTERNS) assert.ok(!p.test(src), `secret pattern ${p} matched`);
});

test("every resource × action is reachable via --help", async () => {
  const ACTIONS_BY_RESOURCE = {
    items: ITEMS_ACTIONS,
    "item-variants": ["list", "create"],
    orders: ["list", "get", "create", "upload"],
  };
  for (const [res, actions] of Object.entries(ACTIONS_BY_RESOURCE)) {
    for (const a of actions) {
      const r = await run([res, a, "--help"]);
      assert.equal(r.exitCode, 0, `${res} ${a} --help failed: ${r.stderr}`);
    }
  }
});

test("login --help describes login flags", async () => {
  const r = await run(["login", "--help"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /--token/);
  assert.match(r.stdout, /--status/);
});
