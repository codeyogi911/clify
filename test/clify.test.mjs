import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validate } from "../lib/validate.mjs";
import { scaffoldInit, substitute } from "../lib/scaffold-init.mjs";
import { syncCheck } from "../lib/sync-check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const EXEMPLAR = join(REPO_ROOT, "examples/exemplar-cli");

function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), "clify-test-"));
  const dest = join(dir, "exemplar-cli");
  cpSync(EXEMPLAR, dest, { recursive: true });
  return { root: dir, repo: dest };
}

// ---------- baseline ----------

test("validate: clean exemplar passes (skip live tests for speed)", async () => {
  const r = await validate(EXEMPLAR, { skipTests: true });
  assert.equal(r.ok, true, JSON.stringify(r.results.filter((x) => !x.ok), null, 2));
});

// ---------- substitute helper ----------

test("substitute: handles upper/title/lower in correct order", () => {
  const text = "EXEMPLAR_API_KEY for Exemplar via exemplar-cli";
  const out = substitute(text, "demo-api", "DEMO_API", "Demo Api");
  assert.equal(out, "DEMO_API_API_KEY for Demo Api via demo-api-cli");
});

// ---------- scaffold-init ----------

test("scaffoldInit: produces a working renamed copy", () => {
  const tmp = mkdtempSync(join(tmpdir(), "clify-init-"));
  try {
    const result = scaffoldInit({ apiName: "movie-db", target: tmp });
    assert.match(result.dir, /movie-db-cli$/);
    const pkg = JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8"));
    assert.equal(pkg.name, "movie-db-cli");
    // bin file is renamed and rewritten
    const cli = readFileSync(join(result.dir, "bin/movie-db-cli.mjs"), "utf8");
    assert.match(cli, /movie-db-cli/);
    assert.ok(!cli.includes("exemplar"), "renamed bin should not contain literal 'exemplar'");
    // env var lookups in lib/ are substituted
    const auth = readFileSync(join(result.dir, "lib/auth.mjs"), "utf8");
    assert.match(auth, /MOVIE_DB_API_KEY/);
    const api = readFileSync(join(result.dir, "lib/api.mjs"), "utf8");
    assert.match(api, /MOVIE_DB_BASE_URL/);
    // modular skills directory is renamed too
    assert.ok(existsSync(join(result.dir, "skills/movie-db-cli-workflow/SKILL.md")));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("scaffoldInit: rejects bad apiName", () => {
  assert.throws(() => scaffoldInit({ apiName: "Movie_DB", target: tmpdir() }), /apiName must match/);
  assert.throws(() => scaffoldInit({ apiName: "" }), /apiName required/);
});

test("scaffoldInit: refuses to overwrite", () => {
  const tmp = mkdtempSync(join(tmpdir(), "clify-init-"));
  try {
    scaffoldInit({ apiName: "demo", target: tmp });
    assert.throws(() => scaffoldInit({ apiName: "demo", target: tmp }), /already exists/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- deliberate-break tests for validator ----------

test("validate: missing help-text resource → structural fail", async () => {
  const { root, repo } = freshCopy();
  try {
    // Strip 'orders' from the resource registry, but leave it in coverage.json.
    // The bin imports `orders` as a default export, so removing the import +
    // its registry entry cleanly removes the resource from --help.
    const binPath = join(repo, "bin/exemplar-cli.mjs");
    const src = readFileSync(binPath, "utf8");
    let broken = src.replace(/import orders from "\.\.\/commands\/orders\.mjs";\n/, "");
    broken = broken.replace(/, orders\]/, "]");
    writeFileSync(binPath, broken);
    const r = await validate(repo, { skipTests: true });
    const failures = r.results.filter((x) => !x.ok && x.category === "structural");
    assert.ok(failures.length >= 1, `expected structural failure when resource missing from --help; got results=${JSON.stringify(r.results.filter((x) => !x.ok), null, 2)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: package.json/plugin.json version mismatch → manifest fail", async () => {
  const { root, repo } = freshCopy();
  try {
    const ppath = join(repo, ".claude-plugin/plugin.json");
    const p = JSON.parse(readFileSync(ppath, "utf8"));
    p.version = "9.9.9";
    writeFileSync(ppath, JSON.stringify(p, null, 2));
    const r = await validate(repo, { skipTests: true });
    assert.ok(r.results.some((x) => !x.ok && /version mismatch/.test(x.name)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: silent drop in coverage.json → coverage fail", async () => {
  const { root, repo } = freshCopy();
  try {
    const cpath = join(repo, "coverage.json");
    const cov = JSON.parse(readFileSync(cpath, "utf8"));
    cov.endpoints.push({ method: "GET", path: "/secret", resource: null, action: null, included: false });
    cov.totalParsed += 1;
    writeFileSync(cpath, JSON.stringify(cov, null, 2));
    const r = await validate(repo, { skipTests: true });
    assert.ok(r.results.some((x) => !x.ok && x.category === "coverage"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: hardcoded secret → secrets fail", async () => {
  const { root, repo } = freshCopy();
  try {
    const path = join(repo, "bin/exemplar-cli.mjs");
    const src = readFileSync(path, "utf8");
    // Build the secret at runtime so this source file itself doesn't contain a
    // matchable Stripe-pattern literal (would trigger GitHub secret scanning).
    const probe = "sk_" + "live_" + "abcdefghijklmnopqrstuv1234";
    writeFileSync(path, src + `\n// const k = '${probe}';\n`);
    const r = await validate(repo, { skipTests: true });
    assert.ok(r.results.some((x) => !x.ok && x.category === "secrets"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: missing CI workflow → ci fail", async () => {
  const { root, repo } = freshCopy();
  try {
    rmSync(join(repo, ".github/workflows/test.yml"));
    const r = await validate(repo, { skipTests: true });
    assert.ok(r.results.some((x) => !x.ok && x.category === "ci"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: nuance declared without artifact → nuances fail", async () => {
  const { root, repo } = freshCopy();
  try {
    const cpath = join(repo, ".clify.json");
    const cfg = JSON.parse(readFileSync(cpath, "utf8"));
    // The exemplar already declares idempotency; flip multiPart to a non-existent
    // action and the nuance check should fail because no integration test posts a file
    // for that action. Easier: declare deprecated without an artifact.
    cfg.nuances.deprecated = ["items.archive"];
    writeFileSync(cpath, JSON.stringify(cfg, null, 2));
    const r = await validate(repo, { skipTests: true });
    assert.ok(r.results.some((x) => !x.ok && x.category === "nuances"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: SKILL.md missing knowledge/ preamble → structural fail", async () => {
  const { root, repo } = freshCopy();
  try {
    const path = join(repo, "skills/exemplar-cli-workflow/SKILL.md");
    const src = readFileSync(path, "utf8").replace(/knowledge\//g, "kb/");
    writeFileSync(path, src);
    const r = await validate(repo, { skipTests: true });
    assert.ok(r.results.some((x) => !x.ok && x.category === "structural" && /knowledge/.test(x.name)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: missing BASE_URL override → manifest fail", async () => {
  const { root, repo } = freshCopy();
  try {
    // BASE_URL lookup lives in lib/api.mjs in the new layout.
    const path = join(repo, "lib/api.mjs");
    const src = readFileSync(path, "utf8").replace(/EXEMPLAR_BASE_URL/g, "EXEMPLAR_URL");
    writeFileSync(path, src);
    const r = await validate(repo, { skipTests: true });
    assert.ok(r.results.some((x) => !x.ok && /BASE_URL/.test(x.name)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- filter-coverage (v0.6+) ----------

test("validate: filter-coverage passes when filterProbes covers list actions", async () => {
  const r = await validate(EXEMPLAR, { skipTests: true });
  // exemplar declares one filter (orders.status) and one matching probe
  assert.ok(
    r.results.some((x) => x.ok && /filter-coverage:.*individually probed/.test(x.name)),
    "expected filter-coverage pass",
  );
});

test("validate: list action with filter flags but no probes → coverage fail", async () => {
  const { root, repo } = freshCopy();
  try {
    // Strip the existing filterProbes from .clify.json so orders.status
    // (which is filter-shaped) becomes an unprobed declared filter.
    const cpath = join(repo, ".clify.json");
    const cfg = JSON.parse(readFileSync(cpath, "utf8"));
    delete cfg.filterProbes;
    writeFileSync(cpath, JSON.stringify(cfg, null, 2));
    const r = await validate(repo, { skipTests: true });
    assert.ok(
      r.results.some((x) => !x.ok && x.category === "coverage" && /filter-coverage/.test(x.name)),
      `expected filter-coverage failure; got results=${JSON.stringify(r.results.filter((x) => !x.ok), null, 2)}`,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: blanket-marked filters with no verified probes → coverage fail", async () => {
  const { root, repo } = freshCopy();
  try {
    // Mutate orders.list to declare every filter-shaped flag as broken
    // AND set the filterProbes to all 'broken' status — the v0.5
    // blanket-mark anti-pattern.
    const ordersPath = join(repo, "commands/orders.mjs");
    let src = readFileSync(ordersPath, "utf8");
    // Inject brokenListFilters: ["status"] at the ACTION level (after
    // the entire flags block, before the action's own closing brace).
    // The flags block ends with `\n      },\n` at indent 6.
    src = src.replace(
      /(\n      flags:\s*\{[\s\S]*?\n      \},)/,
      `$1\n      brokenListFilters: ["status"],`,
    );
    writeFileSync(ordersPath, src);

    const cpath = join(repo, ".clify.json");
    const cfg = JSON.parse(readFileSync(cpath, "utf8"));
    cfg.filterProbes = [
      { resource: "orders", filter: "status", baselineCount: 5, filteredCount: 5, status: "broken" },
    ];
    writeFileSync(cpath, JSON.stringify(cfg, null, 2));

    const r = await validate(repo, { skipTests: true });
    assert.ok(
      r.results.some((x) => !x.ok && x.category === "coverage" && /filter-coverage/.test(x.name) && /blanket-marked|every filter/.test(JSON.stringify(x))),
      `expected blanket-mark failure; got results=${JSON.stringify(r.results.filter((x) => !x.ok), null, 2)}`,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate: untested filterProbe surfaces as a warning, not a failure", async () => {
  const { root, repo } = freshCopy();
  try {
    const cpath = join(repo, ".clify.json");
    const cfg = JSON.parse(readFileSync(cpath, "utf8"));
    cfg.filterProbes = [
      { resource: "orders", filter: "status", baselineCount: 5, filteredCount: 5, status: "untested", note: "no test creds" },
    ];
    writeFileSync(cpath, JSON.stringify(cfg, null, 2));
    const r = await validate(repo, { skipTests: true });
    // No filter-coverage hard-fail.
    assert.ok(!r.results.some((x) => !x.ok && /filter-coverage/.test(x.name)),
      `untested probes should warn, not fail; got ${JSON.stringify(r.results.filter((x) => !x.ok), null, 2)}`);
    assert.ok(r.warnings.some((w) => /untested/.test(w)), `expected untested warning; got ${JSON.stringify(r.warnings)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- syncCheck ----------

test("syncCheck: detects identical content as unchanged", async () => {
  const { root, repo } = freshCopy();
  try {
    // Stub fetcher returns deterministic body; compute hash and write it into .clify.json.
    const fakeBody = "deterministic doc body";
    const cpath = join(repo, ".clify.json");
    const cfg = JSON.parse(readFileSync(cpath, "utf8"));
    cfg.crawledUrls = ["https://example.test/docs"];
    const { createHash } = await import("node:crypto");
    cfg.contentHash = "sha256:" + createHash("sha256").update(fakeBody).digest("hex");
    writeFileSync(cpath, JSON.stringify(cfg, null, 2));
    const stubFetch = async () => ({ status: 200, async text() { return fakeBody; } });
    const result = await syncCheck(repo, { fetcher: stubFetch });
    assert.equal(result.changed, false);
    assert.equal(result.oldHash, cfg.contentHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("syncCheck: detects drift", async () => {
  const { root, repo } = freshCopy();
  try {
    const cpath = join(repo, ".clify.json");
    const cfg = JSON.parse(readFileSync(cpath, "utf8"));
    cfg.crawledUrls = ["https://example.test/docs"];
    cfg.contentHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    writeFileSync(cpath, JSON.stringify(cfg, null, 2));
    const stubFetch = async () => ({ status: 200, async text() { return "new body"; } });
    const result = await syncCheck(repo, { fetcher: stubFetch });
    assert.equal(result.changed, true);
    assert.notEqual(result.oldHash, result.newHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
