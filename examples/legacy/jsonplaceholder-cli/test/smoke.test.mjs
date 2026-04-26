import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, runJson, REPO_ROOT } from "./_helpers.mjs";

const RESOURCES = ["posts", "comments", "albums", "photos", "todos", "users"];
const ACTIONS = ["list", "get", "create", "update", "delete"];

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
});

test("<resource> --help lists all actions", async () => {
  for (const res of RESOURCES) {
    const r = await run([res, "--help"]);
    assert.equal(r.exitCode, 0, `${res} --help failed: ${r.stderr}`);
    for (const a of ACTIONS) assert.match(r.stdout, new RegExp(`\\b${a}\\b`));
  }
});

test("<resource> <action> --help shows flag table", async () => {
  const r = await run(["posts", "create", "--help"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Flags:/);
  assert.match(r.stdout, /--title/);
});

test("unknown resource → validation_error", async () => {
  const r = await runJson(["nope", "list"]);
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "validation_error");
});

test("unknown action → validation_error listing available", async () => {
  const r = await runJson(["posts", "frobnicate"]);
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "validation_error");
  assert.match(r.errJson.message, /list|get|create|update|delete/);
});

test("required flag missing → validation_error (no crash)", async () => {
  const r = await runJson(["posts", "get"]);
  assert.equal(r.exitCode, 1);
  assert.equal(r.errJson.code, "validation_error");
  assert.match(r.errJson.message, /--id/);
});

test("--dry-run does not make network requests", async () => {
  const r = await runJson(["posts", "list", "--dry-run"], {
    env: { JSONPLACEHOLDER_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.json.__dryRun, true);
  assert.equal(r.json.method, "GET");
});

test("source has no hardcoded secrets", () => {
  const src = readFileSync(join(REPO_ROOT, "bin/jsonplaceholder-cli.mjs"), "utf8");
  const PATTERNS = [/sk_live_[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9_\-]{30,}/, /xoxb-[A-Za-z0-9-]{20,}/];
  for (const p of PATTERNS) assert.ok(!p.test(src), `secret pattern ${p} matched`);
});

test("every resource × action is reachable via --help", async () => {
  for (const res of RESOURCES) {
    for (const a of ACTIONS) {
      const r = await run([res, a, "--help"]);
      assert.equal(r.exitCode, 0, `${res} ${a} --help failed`);
    }
  }
});
