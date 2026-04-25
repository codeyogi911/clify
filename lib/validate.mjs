// clify validation gate — pure JS, no LLM.
// Categories (8): manifest, smoke, integration, structural, coverage, nuances, secrets, ci
// `nuances` is split: 4 hard-fail signals, the rest produce warnings.
// Schema/business-knowledge concerns are folded into the relevant categories above.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ALLOWED_DROP_REASONS = new Set([
  "user-excluded-step-7",
  "deprecated-in-docs",
  "beta-flagged",
  "internal-only",
  "nesting-depth-cap",
  "webhook-not-cli-shaped",
  "streaming-not-cli-shaped",
]);

const ALLOWED_AUTH_SCHEMES = new Set(["bearer", "api-key-header", "basic", "none"]);

const SECRET_PATTERNS = [
  { name: "stripe-live", re: /sk_live_[A-Za-z0-9]{20,}/ },
  { name: "github-token", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "github-fine-grained", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "slack-bot", re: /xoxb-[A-Za-z0-9-]{20,}/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "openai-key", re: /sk-[A-Za-z0-9]{32,}/ },
  { name: "bearer-literal", re: /Bearer\s+[A-Za-z0-9_\-]{30,}/ },
];

const HARD_NUANCES = ["pagination", "idempotency", "multipart", "deprecated"];

export async function validate(repoDir, options = {}) {
  const dir = resolve(repoDir);
  const ctx = { dir, results: [], warnings: [] };

  if (!existsSync(dir)) {
    ctx.results.push(fail("manifest", "directory does not exist", { dir }));
    return finish(ctx);
  }

  await checkManifests(ctx);
  await checkSchema(ctx);
  await checkSourceConventions(ctx);
  await checkSecrets(ctx);
  await checkCoverage(ctx);
  await checkStructural(ctx);
  await checkNuances(ctx);
  await checkCi(ctx);
  if (!options.skipTests) {
    await checkTests(ctx);
  }

  return finish(ctx);
}

function finish(ctx) {
  const failed = ctx.results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    dir: ctx.dir,
    summary: { total: ctx.results.length, passed: ctx.results.length - failed.length, failed: failed.length, warnings: ctx.warnings.length },
    results: ctx.results,
    warnings: ctx.warnings,
  };
}

function pass(category, name, details = {}) { return { category, name, ok: true, ...details }; }
function fail(category, name, details = {}) { return { category, name, ok: false, ...details }; }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { return { __err: err.message }; }
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

// ---------- 1. manifests ----------

async function checkManifests(ctx) {
  const pkgPath = join(ctx.dir, "package.json");
  const pluginPath = join(ctx.dir, ".claude-plugin/plugin.json");
  const marketplacePath = join(ctx.dir, ".claude-plugin/marketplace.json");

  if (!existsSync(pkgPath)) { ctx.results.push(fail("manifest", "package.json missing")); return; }
  const pkg = readJson(pkgPath);
  if (pkg.__err) { ctx.results.push(fail("manifest", "package.json parse", { error: pkg.__err })); return; }

  for (const k of ["name", "version", "description"]) {
    if (!pkg[k]) ctx.results.push(fail("manifest", `package.json missing ${k}`));
  }
  ctx.results.push(pkg.type === "module" ? pass("manifest", "package.json type=module") : fail("manifest", "package.json type must be module"));

  const engNode = pkg.engines?.node;
  if (!engNode) ctx.results.push(fail("manifest", "package.json engines.node missing"));
  else if (!/>=\s*2[0-9]/.test(engNode) && !/>=\s*[3-9][0-9]/.test(engNode)) ctx.results.push(fail("manifest", "package.json engines.node must be >=20", { engNode }));
  else ctx.results.push(pass("manifest", "package.json engines.node >=20"));

  if (!pkg.bin || typeof pkg.bin !== "object") ctx.results.push(fail("manifest", "package.json missing bin field"));
  else ctx.results.push(pass("manifest", "package.json bin present"));

  if (!pkg.scripts?.test) ctx.results.push(fail("manifest", "package.json scripts.test missing"));
  else ctx.results.push(pass("manifest", "package.json scripts.test present"));

  // plugin & marketplace
  let plugin, marketplace;
  if (existsSync(pluginPath)) {
    plugin = readJson(pluginPath);
    if (plugin.__err) ctx.results.push(fail("manifest", ".claude-plugin/plugin.json parse", { error: plugin.__err }));
  } else { ctx.results.push(fail("manifest", ".claude-plugin/plugin.json missing")); }

  if (existsSync(marketplacePath)) {
    marketplace = readJson(marketplacePath);
    if (marketplace.__err) ctx.results.push(fail("manifest", ".claude-plugin/marketplace.json parse", { error: marketplace.__err }));
  } else { ctx.results.push(fail("manifest", ".claude-plugin/marketplace.json missing")); }

  if (plugin && !plugin.__err) {
    for (const k of ["name", "version", "description", "skills", "capabilities"]) {
      if (plugin[k] === undefined) ctx.results.push(fail("manifest", `plugin.json missing ${k}`));
    }
    if (Array.isArray(plugin.skills)) {
      let resolved = true;
      for (const s of plugin.skills) {
        if (!s.source || !existsSync(join(ctx.dir, s.source))) {
          ctx.results.push(fail("manifest", `plugin.json skill source not found`, { source: s.source }));
          resolved = false;
        } else {
          // Each SKILL.md must have frontmatter name + description + allowed-tools
          const sm = readText(join(ctx.dir, s.source));
          if (!sm || !sm.startsWith("---\n")) ctx.results.push(fail("manifest", `${s.source} missing YAML frontmatter`));
          else {
            const fm = sm.slice(4, sm.indexOf("\n---", 4));
            for (const k of ["name:", "description:"]) {
              if (!fm.includes(k)) ctx.results.push(fail("manifest", `${s.source} frontmatter missing ${k}`));
            }
          }
        }
      }
      if (resolved) ctx.results.push(pass("manifest", "every plugin skill source resolves"));
    }

    if (pkg.name && plugin.name && pkg.name !== plugin.name) ctx.results.push(fail("manifest", "name mismatch package.json vs plugin.json", { pkg: pkg.name, plugin: plugin.name }));
    else if (pkg.name && plugin.name) ctx.results.push(pass("manifest", "name matches across pkg+plugin"));

    if (pkg.version && plugin.version && pkg.version !== plugin.version) ctx.results.push(fail("manifest", "version mismatch package.json vs plugin.json"));
    if (pkg.description && plugin.description && pkg.description !== plugin.description) ctx.results.push(fail("manifest", "description mismatch package.json vs plugin.json"));
  }

  if (marketplace && !marketplace.__err) {
    for (const k of ["name", "version", "description", "source"]) {
      if (marketplace[k] === undefined) ctx.results.push(fail("manifest", `marketplace.json missing ${k}`));
    }
    if (plugin && !plugin.__err) {
      if (marketplace.name !== plugin.name) ctx.results.push(fail("manifest", "name mismatch plugin.json vs marketplace.json"));
      if (marketplace.version !== plugin.version) ctx.results.push(fail("manifest", "version mismatch plugin.json vs marketplace.json"));
      if (marketplace.description !== plugin.description) ctx.results.push(fail("manifest", "description mismatch plugin.json vs marketplace.json"));
    }
  }
}

// ---------- 2. schema (.clify.json + .env.example) ----------

async function checkSchema(ctx) {
  const clifyPath = join(ctx.dir, ".clify.json");
  if (!existsSync(clifyPath)) { ctx.results.push(fail("manifest", ".clify.json missing")); return; }
  const cfg = readJson(clifyPath);
  if (cfg.__err) { ctx.results.push(fail("manifest", ".clify.json parse", { error: cfg.__err })); return; }

  for (const k of ["apiName", "docsUrl", "contentHash", "generatedAt", "clifyVersion", "auth"]) {
    if (cfg[k] === undefined) ctx.results.push(fail("manifest", `.clify.json missing ${k}`));
  }

  if (cfg.auth) {
    if (!ALLOWED_AUTH_SCHEMES.has(cfg.auth.scheme)) ctx.results.push(fail("manifest", `.clify.json auth.scheme invalid`, { scheme: cfg.auth.scheme }));
    else ctx.results.push(pass("manifest", ".clify.json auth.scheme valid"));
    if (!cfg.auth.envVar) ctx.results.push(fail("manifest", ".clify.json auth.envVar missing"));
    if (!cfg.auth.validationCommand) ctx.results.push(fail("manifest", ".clify.json auth.validationCommand missing"));
  }

  // .env.example annotations on auth var (skip when scheme=none)
  const envExPath = join(ctx.dir, ".env.example");
  if (!existsSync(envExPath)) ctx.results.push(fail("manifest", ".env.example missing"));
  else if (cfg.auth?.scheme && cfg.auth.scheme !== "none") {
    const text = readText(envExPath) || "";
    if (!text.includes("@required")) ctx.results.push(fail("manifest", ".env.example missing @required annotation on auth var"));
    if (!text.includes("@how-to-get")) ctx.results.push(fail("manifest", ".env.example missing @how-to-get annotation on auth var"));
  }
}

// ---------- 3. source conventions ----------

async function checkSourceConventions(ctx) {
  // Find the bin file from package.json bin field.
  const pkg = readJson(join(ctx.dir, "package.json"));
  if (pkg.__err) return;
  const binEntries = pkg.bin ? Object.values(pkg.bin) : [];
  if (binEntries.length === 0) return;
  const binPath = join(ctx.dir, binEntries[0]);
  const src = readText(binPath);
  if (!src) { ctx.results.push(fail("manifest", `bin file not found at ${binEntries[0]}`)); return; }

  // BASE_URL override
  const apiName = pkg.name.replace(/-cli$/, "").toUpperCase().replace(/-/g, "_");
  const baseEnv = `${apiName}_BASE_URL`;
  if (!src.includes(baseEnv)) ctx.results.push(fail("manifest", `CLI does not honor ${baseEnv} env override`));
  else ctx.results.push(pass("manifest", "CLI honors BASE_URL override"));

  // package.json bin path resolves
  if (existsSync(binPath)) ctx.results.push(pass("manifest", "package.json bin path resolves"));
  else ctx.results.push(fail("manifest", "package.json bin path does not resolve", { binPath }));
}

// ---------- 4. secrets ----------

async function checkSecrets(ctx) {
  const offenders = [];
  for (const file of walkSourceFiles(ctx.dir)) {
    const txt = readText(file);
    if (!txt) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(txt)) offenders.push({ file: relative(ctx.dir, file), pattern: name });
    }
  }
  if (offenders.length === 0) ctx.results.push(pass("secrets", "no hardcoded secrets"));
  else ctx.results.push(fail("secrets", "hardcoded secret patterns detected", { offenders }));
}

function walkSourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, acc);
    else if (/\.(mjs|js|json|md|yml|yaml|env\.example)$/.test(entry.name) || entry.name === ".env.example") acc.push(full);
  }
  return acc;
}

// ---------- 5. coverage ----------

async function checkCoverage(ctx) {
  const path = join(ctx.dir, "coverage.json");
  if (!existsSync(path)) { ctx.results.push(fail("coverage", "coverage.json missing")); return; }
  const cov = readJson(path);
  if (cov.__err) { ctx.results.push(fail("coverage", "coverage.json parse", { error: cov.__err })); return; }

  for (const k of ["totalParsed", "totalIncluded", "totalDropped", "endpoints"]) {
    if (cov[k] === undefined) { ctx.results.push(fail("coverage", `coverage.json missing ${k}`)); return; }
  }

  const issues = [];
  for (const [i, ep] of cov.endpoints.entries()) {
    if (!ep.method || !ep.path) issues.push({ i, reason: "missing method or path" });
    if (ep.included === false) {
      if (ep.dropped !== true) issues.push({ i, reason: "included:false without dropped:true" });
      else if (!ALLOWED_DROP_REASONS.has(ep.reason)) issues.push({ i, reason: `bad drop reason: ${ep.reason}` });
    } else if (ep.included === true) {
      if (!ep.resource || !ep.action) issues.push({ i, reason: "included endpoint missing resource/action" });
    }
  }
  const includedCount = cov.endpoints.filter((e) => e.included === true).length;
  const droppedCount = cov.endpoints.filter((e) => e.dropped === true).length;
  if (includedCount !== cov.totalIncluded) issues.push({ i: -1, reason: `totalIncluded mismatch: ${cov.totalIncluded} vs ${includedCount}` });
  if (droppedCount !== cov.totalDropped) issues.push({ i: -1, reason: `totalDropped mismatch: ${cov.totalDropped} vs ${droppedCount}` });

  if (issues.length === 0) ctx.results.push(pass("coverage", "coverage.json valid", { included: includedCount, dropped: droppedCount }));
  else ctx.results.push(fail("coverage", "coverage.json invalid", { issues }));
}

// ---------- 6. structural (resource registry vs help, SKILL.md, etc.) ----------

async function checkStructural(ctx) {
  const pkg = readJson(join(ctx.dir, "package.json"));
  if (pkg.__err) return;
  const binEntries = pkg.bin ? Object.values(pkg.bin) : [];
  if (binEntries.length === 0) return;
  const binPath = join(ctx.dir, binEntries[0]);
  const src = readText(binPath) || "";

  // help: --help should mention every resource
  const cov = readJson(join(ctx.dir, "coverage.json"));
  if (cov.__err) return;

  const helpResult = spawnSync(process.execPath, [binPath, "--help"], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  const helpOut = (helpResult.stdout || "") + (helpResult.stderr || "");
  const includedResources = new Set(cov.endpoints.filter((e) => e.included).map((e) => e.resource));
  const includedActions = new Map();
  for (const ep of cov.endpoints) {
    if (!ep.included) continue;
    if (!includedActions.has(ep.resource)) includedActions.set(ep.resource, new Set());
    includedActions.get(ep.resource).add(ep.action);
  }

  let missingFromRoot = [];
  for (const r of includedResources) if (!helpOut.includes(r)) missingFromRoot.push(r);
  if (missingFromRoot.length === 0) ctx.results.push(pass("structural", "every resource appears in --help"));
  else ctx.results.push(fail("structural", "resources missing from --help", { missing: missingFromRoot }));

  // each resource --help should mention every action
  let resourceHelpFailures = [];
  for (const r of includedResources) {
    const rh = spawnSync(process.execPath, [binPath, r, "--help"], { encoding: "utf8" });
    const out = (rh.stdout || "") + (rh.stderr || "");
    for (const a of includedActions.get(r) || []) {
      if (!out.includes(a)) resourceHelpFailures.push(`${r} --help missing action ${a}`);
    }
  }
  if (resourceHelpFailures.length === 0) ctx.results.push(pass("structural", "every action appears in resource --help"));
  else ctx.results.push(fail("structural", "actions missing from resource --help", { failures: resourceHelpFailures }));

  // SKILL.md mentions each resource
  if (pkg.bin) {
    const apiSlug = pkg.name.replace(/-cli$/, "");
    const skillPath = join(ctx.dir, `skills/${apiSlug}/SKILL.md`);
    if (!existsSync(skillPath)) {
      ctx.results.push(fail("structural", `skills/${apiSlug}/SKILL.md missing`));
    } else {
      const skill = readText(skillPath);
      const missing = [];
      for (const r of includedResources) if (!skill.includes(r)) missing.push(r);
      if (missing.length === 0) ctx.results.push(pass("structural", "SKILL.md references every resource"));
      else ctx.results.push(fail("structural", "SKILL.md missing resources", { missing }));

      // knowledge preamble
      if (skill.includes("knowledge/")) ctx.results.push(pass("structural", "SKILL.md mentions knowledge/"));
      else ctx.results.push(fail("structural", "SKILL.md must instruct agent to read knowledge/"));
    }
  }
}

// ---------- 7. nuances ----------

async function checkNuances(ctx) {
  const cfg = readJson(join(ctx.dir, ".clify.json"));
  if (cfg.__err) return;
  const nuances = cfg.nuances || {};
  const pkg = readJson(join(ctx.dir, "package.json"));
  const binEntries = pkg.bin ? Object.values(pkg.bin) : [];
  const src = binEntries.length ? (readText(join(ctx.dir, binEntries[0])) || "") : "";
  const integrationTest = readText(join(ctx.dir, "test/integration.test.mjs")) || "";

  // pagination
  if (nuances.pagination) {
    if (/page|cursor|next|offset|link-header/i.test(integrationTest) && /multi.*page|page.*[12]|cursor/i.test(integrationTest)) {
      ctx.results.push(pass("nuances", `pagination test present (${nuances.pagination})`));
    } else {
      ctx.results.push(fail("nuances", `pagination=${nuances.pagination} but no multi-page test detected`));
    }
  }

  // idempotency
  if (Array.isArray(nuances.idempotency) && nuances.idempotency.length > 0) {
    if (!src.includes("idempotency-key")) ctx.results.push(fail("nuances", "idempotency declared but --idempotency-key not wired in CLI"));
    else if (!/idempotency.key/i.test(integrationTest)) ctx.results.push(fail("nuances", "idempotency declared but no integration test asserts header"));
    else ctx.results.push(pass("nuances", "idempotency wiring + test present"));
  }

  // multipart
  if (Array.isArray(nuances.multiPart) && nuances.multiPart.length > 0) {
    if (!src.includes("FormData") && !src.includes("multipart")) ctx.results.push(fail("nuances", "multiPart declared but FormData/multipart not used"));
    else if (!/--file|FormData/.test(integrationTest)) ctx.results.push(fail("nuances", "multiPart declared but no integration test posts a file"));
    else ctx.results.push(pass("nuances", "multipart wiring + test present"));
  }

  // deprecated
  if (Array.isArray(nuances.deprecated) && nuances.deprecated.length > 0) {
    let satisfied = false;
    const cov = readJson(join(ctx.dir, "coverage.json"));
    if (!cov.__err) {
      const deprecated = cov.endpoints.filter((e) => e.dropped && e.reason === "deprecated-in-docs");
      if (deprecated.length > 0) satisfied = true;
    }
    const knowledgeDir = join(ctx.dir, "knowledge");
    if (existsSync(knowledgeDir)) {
      for (const f of readdirSync(knowledgeDir)) {
        if (f.startsWith("deprecated-")) { satisfied = true; break; }
      }
    }
    if (satisfied) ctx.results.push(pass("nuances", "deprecated endpoints documented"));
    else ctx.results.push(fail("nuances", "deprecated endpoints declared but no knowledge file or coverage entry"));
  }

  // soft warnings
  if (nuances.rateLimits && !existsSync(join(ctx.dir, "knowledge/rate-limit.md"))) ctx.warnings.push("rateLimits=true but no knowledge/rate-limit.md");
  if (nuances.authScopes && !existsSync(join(ctx.dir, "knowledge/auth-scopes.md"))) ctx.warnings.push("authScopes=true but no knowledge/auth-scopes.md");
  if (Array.isArray(nuances.conditional) && nuances.conditional.length > 0 && !src.includes("if-match")) {
    ctx.warnings.push("conditional declared but --if-match not wired");
  }

  // business rules
  if (typeof nuances.businessRules === "number" && nuances.businessRules > 0) {
    const knowledgeDir = join(ctx.dir, "knowledge");
    let businessRuleFiles = 0;
    if (existsSync(knowledgeDir)) {
      for (const f of readdirSync(knowledgeDir)) {
        if (!f.endsWith(".md")) continue;
        const txt = readText(join(knowledgeDir, f)) || "";
        if (/^type:\s*business-rule/m.test(txt)) businessRuleFiles++;
      }
    }
    if (businessRuleFiles >= 1) ctx.results.push(pass("nuances", `${businessRuleFiles} business-rule knowledge file(s) present`));
    else ctx.results.push(fail("nuances", "businessRules>0 but no knowledge/*.md with type: business-rule"));
  }

  // baseline pass when no nuances declared
  if (HARD_NUANCES.every((k) => !nuances[k] || (Array.isArray(nuances[k]) && nuances[k].length === 0))) {
    ctx.results.push(pass("nuances", "no hard-fail nuances declared"));
  }
}

// ---------- 8. CI ----------

async function checkCi(ctx) {
  const path = join(ctx.dir, ".github/workflows/test.yml");
  if (!existsSync(path)) { ctx.results.push(fail("ci", ".github/workflows/test.yml missing")); return; }
  const txt = readText(path) || "";
  if (!txt.includes("npm test")) { ctx.results.push(fail("ci", "test.yml does not run npm test")); return; }
  if (!txt.includes("setup-node")) { ctx.results.push(fail("ci", "test.yml does not use setup-node")); return; }
  ctx.results.push(pass("ci", ".github/workflows/test.yml valid"));
}

// ---------- 9. tests ----------

async function checkTests(ctx) {
  const smokePath = join(ctx.dir, "test/smoke.test.mjs");
  const integPath = join(ctx.dir, "test/integration.test.mjs");
  if (!existsSync(smokePath)) ctx.results.push(fail("smoke", "test/smoke.test.mjs missing"));
  if (!existsSync(integPath)) ctx.results.push(fail("integration", "test/integration.test.mjs missing"));
  if (!existsSync(smokePath) || !existsSync(integPath)) return;

  const r = spawnSync("npm", ["test"], { cwd: ctx.dir, encoding: "utf8", env: { ...process.env, CI: "1" } });
  if (r.status === 0) ctx.results.push(pass("tests", "npm test exit 0"));
  else ctx.results.push(fail("tests", "npm test failed", { code: r.status, stderrTail: (r.stderr || "").slice(-1500) }));
}
