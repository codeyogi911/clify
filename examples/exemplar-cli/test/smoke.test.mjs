// Structural tests for exemplar-cli — no network, no auth, no surprises.
// Verifies CLI shape: --version, --help breadth, error semantics, --dry-run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { run, runJson, REPO_ROOT, CLI } from "./_helpers.mjs";

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

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9_\-]{30,}/,
  /xoxb-[A-Za-z0-9-]{20,}/,
];

test("source has no hardcoded secrets", () => {
  const src = readFileSync(join(REPO_ROOT, "bin/exemplar-cli.mjs"), "utf8");
  for (const p of SECRET_PATTERNS) assert.ok(!p.test(src), `secret pattern ${p} matched`);
});

test("dry-run output does not leak credential-shaped values", async () => {
  // Use a token that matches the Bearer-literal pattern (≥30 chars). Without
  // redaction, this would surface as `Bearer <token>` in the dry-run JSON.
  const r = await runJson(["items", "list", "--dry-run"], {
    env: {
      EXEMPLAR_API_KEY: "abcdef0123456789abcdef0123456789abcdef",
      EXEMPLAR_BASE_URL: "http://127.0.0.1:1",
    },
  });
  assert.equal(r.exitCode, 0, r.stderr);
  const dump = JSON.stringify(r.json);
  for (const p of SECRET_PATTERNS) assert.ok(!p.test(dump), `dry-run leaked pattern ${p}`);
  assert.equal(r.json.headers.authorization, "<redacted>");
});

test("bin file is executable (exec-bit set)", () => {
  const mode = statSync(CLI).mode;
  assert.ok(mode & 0o111, `bin file mode ${mode.toString(8)} is missing the exec bit`);
  // Also assert that the OS can launch it directly without `node` prefix.
  // This catches the failure mode where mode bits exist on disk but the
  // shebang or interpreter path is broken.
  const out = execFileSync(CLI, ["--version"], { encoding: "utf8", env: { ...process.env, EXEMPLAR_API_KEY: "x" } });
  assert.match(out.trim(), /^\d+\.\d+\.\d+/);
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
