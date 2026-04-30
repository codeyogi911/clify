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
  "sibling-asymmetry-confirmed",
]);

const ALLOWED_AUTH_SCHEMES = new Set(["bearer", "api-key-header", "basic", "none", "oauth-refresh"]);

// Sub-paths whose presence on ≥3 sibling resources implies the family-
// consistency rule: any sibling that exposes the same parent resource shape
// SHOULD also expose this sub-path. Status-mutation paths get their own
// canonical-naming rule (`mark-<state>`) handled in checkStatusVerbCanonical.
const FAMILY_SUBPATHS = ["comments", "attachments", "refunds", "tags", "notes", "metadata"];

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
  await checkDryRunRedaction(ctx);
  await checkCoverage(ctx);
  await checkFamilyConsistency(ctx);
  await checkStatusVerbCanonical(ctx);
  await checkFilterCoverage(ctx);
  await checkStructural(ctx);
  await checkReadme(ctx);
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

// Resolve plugin.json `skills` into absolute skill-directory paths. Per the
// Claude Code plugin schema, `skills` is either a string (path to a parent
// directory whose subfolders are skills) or an array of strings (each path
// is a skill directory). Returns:
//   []      — if `skills` is missing/empty (plugin has no skills, valid)
//   null    — if `skills` is malformed (caller should report a manifest fail)
//   [dirs]  — list of absolute skill directory paths
function resolveSkillDirs(repoDir, skills) {
  if (skills === undefined || skills === null) return [];
  if (typeof skills === "string") {
    const parent = join(repoDir, skills);
    if (!existsSync(parent)) return [];
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(parent, e.name));
  }
  if (Array.isArray(skills)) {
    if (skills.every((s) => typeof s === "string")) {
      return skills.map((s) => join(repoDir, s));
    }
    return null;
  }
  return null;
}

// Concatenate every CLI source file the validator should consider when
// checking for env var lookups, helper imports, or wiring strings.
// Old layout: just `bin/<api>-cli.mjs`. New layout adds `lib/*.mjs` and
// `commands/*.mjs`. Both are scanned together; either layout passes.
function readCliSources(repoDir, binRel) {
  const parts = [];
  const binPath = join(repoDir, binRel);
  if (existsSync(binPath)) parts.push(readText(binPath) || "");
  for (const sub of ["lib", "commands"]) {
    const subPath = join(repoDir, sub);
    if (!existsSync(subPath)) continue;
    for (const entry of readdirSync(subPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".mjs")) {
        parts.push(readText(join(subPath, entry.name)) || "");
      }
    }
  }
  return parts.join("\n");
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
    // Canonical Claude Code shape: skills is either a relative path to a
    // directory of skill subfolders, or an array of such paths. Each resolved
    // skill directory must contain a SKILL.md with name + description in YAML
    // frontmatter.
    const skillDirs = resolveSkillDirs(ctx.dir, plugin.skills);
    if (skillDirs === null) {
      ctx.results.push(fail("manifest", "plugin.json skills must be a string path or array of string paths", { got: plugin.skills }));
    } else if (skillDirs.length > 0) {
      let resolved = true;
      for (const d of skillDirs) {
        const skillFile = join(d, "SKILL.md");
        const rel = relative(ctx.dir, skillFile);
        if (!existsSync(skillFile)) {
          ctx.results.push(fail("manifest", `skill source not found`, { source: rel }));
          resolved = false;
          continue;
        }
        const sm = readText(skillFile);
        if (!sm || !sm.startsWith("---\n")) {
          ctx.results.push(fail("manifest", `${rel} missing YAML frontmatter`));
          continue;
        }
        const fm = sm.slice(4, sm.indexOf("\n---", 4));
        for (const k of ["name:", "description:"]) {
          if (!fm.includes(k)) ctx.results.push(fail("manifest", `${rel} frontmatter missing ${k}`));
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

    // OAuth-refresh wiring check: when scheme=oauth-refresh, the .clify.json
    // must declare the four OAuth-specific fields AND the CLI source must
    // reference each env var (the LLM is forbidden from mistyping prefixes).
    if (cfg.auth.scheme === "oauth-refresh") {
      const required = ["tokenUrl", "refreshEnvVar", "clientIdEnvVar", "clientSecretEnvVar"];
      const missing = required.filter((k) => !cfg.auth[k]);
      if (missing.length) {
        ctx.results.push(fail("manifest", `oauth-refresh requires .clify.json auth.{${missing.join(",")}}`));
      } else {
        ctx.results.push(pass("manifest", "oauth-refresh wiring fields present"));
        const pkgPath = join(ctx.dir, "package.json");
        const pkg = readJson(pkgPath);
        if (!pkg.__err && pkg.bin) {
          const binEntries = Object.values(pkg.bin);
          if (binEntries.length) {
            const cliSrc = readCliSources(ctx.dir, binEntries[0]);
            const envMissing = [cfg.auth.refreshEnvVar, cfg.auth.clientIdEnvVar, cfg.auth.clientSecretEnvVar].filter((v) => !cliSrc.includes(v));
            if (envMissing.length) ctx.results.push(fail("manifest", `oauth-refresh env vars not referenced in CLI source`, { missing: envMissing }));
            else ctx.results.push(pass("manifest", "oauth-refresh env vars wired in source"));
          }
        }
      }
    }
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
  if (!existsSync(binPath)) { ctx.results.push(fail("manifest", `bin file not found at ${binEntries[0]}`)); return; }

  // Exec-bit on bin file — without this `npm link` produces a CLI that fails
  // with `permission denied` on first invocation. Hard-fail.
  const mode = statSync(binPath).mode;
  if (!(mode & 0o111)) ctx.results.push(fail("manifest", `bin file is not executable (mode ${(mode & 0o777).toString(8)})`, { binPath: binEntries[0] }));
  else ctx.results.push(pass("manifest", "bin file has exec bit set"));

  // BASE_URL override — checked across bin + lib/ + commands/ since machinery
  // commonly lives in lib/api.mjs or similar.
  const cliSrc = readCliSources(ctx.dir, binEntries[0]);
  const apiName = pkg.name.replace(/-cli$/, "").toUpperCase().replace(/-/g, "_");
  const baseEnv = `${apiName}_BASE_URL`;
  if (!cliSrc.includes(baseEnv)) ctx.results.push(fail("manifest", `CLI does not honor ${baseEnv} env override`));
  else ctx.results.push(pass("manifest", "CLI honors BASE_URL override"));

  // package.json bin path resolves
  ctx.results.push(pass("manifest", "package.json bin path resolves"));
}

// ---------- 4b. dry-run secret redaction ----------

// Spawn the bin under --dry-run --json with a credential-shaped fake token
// in env, then scan stdout for the same credential patterns the secret-scan
// step uses. Catches the failure mode where lib/api.mjs returns the live
// auth header in its dry-run dump (the fix-coffee/zoho rollout finding #2).
async function checkDryRunRedaction(ctx) {
  const pkg = readJson(join(ctx.dir, "package.json"));
  if (pkg.__err) return;
  const binEntries = pkg.bin ? Object.values(pkg.bin) : [];
  if (binEntries.length === 0) return;
  const binPath = join(ctx.dir, binEntries[0]);
  if (!existsSync(binPath)) return;

  const cov = readJson(join(ctx.dir, "coverage.json"));
  if (cov.__err || !Array.isArray(cov.endpoints)) return;
  // Pick a list-shaped action so we don't need --id and friends.
  const probe = cov.endpoints.find((e) => e.included && e.action === "list");
  if (!probe) {
    // No list action — soft-skip rather than failing on shape we can't probe.
    return;
  }

  const apiPrefix = pkg.name.replace(/-cli$/, "").toUpperCase().replace(/-/g, "_");
  const env = {
    ...process.env,
    [`${apiPrefix}_API_KEY`]: "abcdef0123456789abcdef0123456789abcdef",
    [`${apiPrefix}_REFRESH_TOKEN`]: "abcdef0123456789abcdef0123456789abcdef",
    [`${apiPrefix}_CLIENT_ID`]: "client-id-shaped-abcdef0123456789abcdef",
    [`${apiPrefix}_CLIENT_SECRET`]: "client-secret-shaped-abcdef0123456789abcdef",
    [`${apiPrefix}_BASE_URL`]: "http://127.0.0.1:1",
    FORCE_COLOR: "0",
  };
  const r = spawnSync(process.execPath, [binPath, probe.resource, probe.action, "--dry-run", "--json"], { encoding: "utf8", env });
  const out = (r.stdout || "") + (r.stderr || "");
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(out)) {
      ctx.results.push(fail("secrets", `dry-run output leaks credential-shaped value`, { pattern: name, sample: out.slice(0, 400) }));
      return;
    }
  }
  ctx.results.push(pass("secrets", "dry-run output redacts credential-shaped values"));
}

// ---------- 5b. family-consistency ----------

// Group resources by sub-path tail (e.g. /comments). When ≥3 sibling
// resources expose the same sub-path and ≥1 sibling lacks it without an
// explicit dropped-with-reason entry, hard-fail. The LLM can opt out per
// sibling with reason "sibling-asymmetry-confirmed" in coverage.json.
async function checkFamilyConsistency(ctx) {
  const cov = readJson(join(ctx.dir, "coverage.json"));
  if (cov.__err || !Array.isArray(cov.endpoints)) return;

  // Collect, per sub-path, the set of resources that expose it (included),
  // and the set of resources that have ANY endpoint at all (the "sibling pool").
  const includedBySubPath = new Map(); // subpath -> Set<resource>
  const allResources = new Set();
  const droppedAsymmetry = new Map(); // `${resource}|${subpath}` -> true

  for (const ep of cov.endpoints) {
    if (!ep.path) continue;
    if (ep.included && ep.resource) allResources.add(ep.resource);
    if (ep.dropped && ep.reason === "sibling-asymmetry-confirmed" && ep.path) {
      // Path like /<r>/:id/<subpath> or /<r>/:id/<subpath>/:cid
      const parts = ep.path.split("/").filter(Boolean);
      const resource = parts[0];
      const subAt = parts.findIndex((p) => p.startsWith(":"));
      const sub = subAt >= 0 ? parts[subAt + 1] : null;
      if (resource && sub) droppedAsymmetry.set(`${resource}|${sub}`, true);
    }
    if (!ep.included) continue;

    const parts = ep.path.split("/").filter(Boolean);
    // Look for /<r>/:id/<subpath>(...) — resource is the first segment, sub
    // is the segment after the first :param.
    const resource = parts[0];
    const colonAt = parts.findIndex((p) => p.startsWith(":"));
    if (colonAt < 0 || colonAt >= parts.length - 1) continue;
    const sub = parts[colonAt + 1];
    if (!FAMILY_SUBPATHS.includes(sub)) continue;
    if (!includedBySubPath.has(sub)) includedBySubPath.set(sub, new Set());
    includedBySubPath.get(sub).add(resource);
  }

  const failures = [];
  for (const [sub, resources] of includedBySubPath) {
    if (resources.size < 3) continue; // not enough siblings to call it a family
    // For each resource that exists in the CLI but is NOT in the sub-set,
    // flag it unless coverage.json already drops it with the asymmetry reason.
    for (const r of allResources) {
      if (resources.has(r)) continue;
      if (droppedAsymmetry.get(`${r}|${sub}`)) continue;
      failures.push({ resource: r, subpath: sub, siblings: [...resources] });
    }
  }

  if (failures.length === 0) {
    ctx.results.push(pass("coverage", "family-consistency: all sibling sub-paths symmetric"));
  } else {
    ctx.results.push(fail("coverage", "family-consistency: sibling resources have asymmetric sub-action coverage", { failures }));
  }
}

// ---------- 5d. filter-coverage (per-flag probe enforcement) ----------

// Names that are pagination/sort/identity, not user-facing filters.
// Filter-shaped is "everything else" on a list action.
const NON_FILTER_FLAGS = new Set([
  "id",
  "page",
  "cursor",
  "limit",
  "offset",
  "per_page",
  "perPage",
  "page_size",
  "pageSize",
  "sort",
  "sort_column",
  "sort_order",
  "sortColumn",
  "sortOrder",
  "body",
  "file",
  "idempotency-key",
  "if-match",
]);

// Catch the v0.5 anti-pattern this repo's #5 issue is about:
// 1. List action with filter-shaped flags but ZERO filterProbes for the
//    resource → HARD-FAIL (Phase 5 skipped the probe step).
// 2. Every filter on a list action declared in brokenListFilters AND no
//    individual probes for that resource in filterProbes → HARD-FAIL
//    (the blanket-mark anti-pattern).
// 3. A filter with status:"untested" → WARN.
//
// Scans commands/*.mjs textually for the shape — the LLM-emitted source
// is always plain JS literal exports, so a regex pass is enough and we
// don't have to dynamically import a foreign repo's source.
async function checkFilterCoverage(ctx) {
  const cfg = readJson(join(ctx.dir, ".clify.json"));
  if (cfg.__err) return;
  const probes = Array.isArray(cfg.filterProbes) ? cfg.filterProbes : [];
  const probesByResource = new Map();
  for (const p of probes) {
    if (!p?.resource) continue;
    if (!probesByResource.has(p.resource)) probesByResource.set(p.resource, []);
    probesByResource.get(p.resource).push(p);
  }

  const commandsDir = join(ctx.dir, "commands");
  if (!existsSync(commandsDir)) return;

  let sawAnyListAction = false;
  const failures = [];

  for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const src = readText(join(commandsDir, entry.name)) || "";
    const resourceMatch = src.match(/name:\s*["']([^"']+)["']/);
    if (!resourceMatch) continue;
    const resource = resourceMatch[1];

    // Match each `<action>: { ... }` block where method:"GET" appears at
    // the top-level. We extract the list action's flags and brokenListFilters.
    // The block is balanced-brace-delimited; we scan with a small parser.
    for (const action of extractListActions(src)) {
      sawAnyListAction = true;
      // Filter-shaped = anything not in NON_FILTER_FLAGS and not a path
      // param (e.g. `itemId` in `/items/:itemId/variants` — that's a
      // parent-resource id, not a filter).
      const pathParamSet = new Set(action.pathParams || []);
      const filterFlags = action.flags.filter((f) => !NON_FILTER_FLAGS.has(f) && !pathParamSet.has(f));
      if (filterFlags.length === 0) continue;

      const resourceProbes = probesByResource.get(resource) || [];
      // Failure mode 1: filter-shaped flags exist but no probes for resource.
      if (resourceProbes.length === 0) {
        failures.push({
          resource,
          action: action.name,
          reason: "list action declares filter-shaped flags but .clify.json.filterProbes has zero entries for this resource (Phase 5 skipped the probe step)",
          filterFlags,
        });
        continue;
      }
      // Failure mode 2: every filter is in brokenListFilters AND the
      // probes for this resource are all 'broken' OR have no per-filter
      // detail — i.e. the LLM blanket-marked everything from one bad probe.
      const brokenSet = new Set(action.brokenListFilters);
      const everyFilterBroken = filterFlags.length > 0 && filterFlags.every((f) => brokenSet.has(f));
      if (everyFilterBroken) {
        const verifiedCount = resourceProbes.filter((p) => p.status === "verified").length;
        if (verifiedCount === 0) {
          failures.push({
            resource,
            action: action.name,
            reason: "every filter on this list action is in brokenListFilters and no probe in .clify.json.filterProbes verified ANY filter — looks like a blanket-mark from a single failed probe",
            filterFlags,
            brokenListFilters: action.brokenListFilters,
          });
          continue;
        }
      }

      // Warning mode: any filter listed as 'untested' for this resource.
      for (const p of resourceProbes) {
        if (p.status === "untested") {
          ctx.warnings.push(`filter-coverage: ${resource}.${p.filter} is untested at generation time${p.note ? ` (${p.note})` : ""}`);
        }
      }
    }
  }

  if (!sawAnyListAction) return; // nothing to enforce on this CLI
  if (failures.length === 0) {
    ctx.results.push(pass("coverage", "filter-coverage: every list action's filters are individually probed"));
  } else {
    ctx.results.push(fail("coverage", "filter-coverage: list actions blanket-marked filters or skipped probe step", { failures }));
  }
}

// Walk a commands/<resource>.mjs source and pull out list actions with
// their flag names and brokenListFilters.
//
// Strategy: find the top-level `actions: { ... }` block, then scan only
// its top-level keys (each is one action). For every action whose body
// has `method: "GET"`, treat it as a candidate list action — but skip
// single-resource GETs (action name "get", or path ends in `/:id`).
function extractListActions(src) {
  const actionsMatch = src.match(/actions\s*:\s*\{/);
  if (!actionsMatch) return [];
  const blockStart = src.indexOf("{", actionsMatch.index + actionsMatch[0].length - 1);
  const blockEnd = findMatchingBrace(src, blockStart);
  if (blockEnd < 0) return [];
  const block = src.slice(blockStart + 1, blockEnd);

  const actions = [];
  let depth = 0;
  let i = 0;
  while (i < block.length) {
    const ch = block[i];
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth--; i++; continue; }
    if (depth !== 0) { i++; continue; }
    const tail = block.slice(i);
    const km = tail.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))\s*:\s*\{/);
    if (!km) { i++; continue; }
    const actionName = km[1] || km[2] || km[3];
    const bodyStart = i + km[0].lastIndexOf("{");
    const bodyEnd = findMatchingBrace(block, bodyStart);
    if (bodyEnd < 0) { i += km[0].length; continue; }
    const body = block.slice(bodyStart + 1, bodyEnd);
    i = bodyEnd + 1;

    if (!/method\s*:\s*["']GET["']/.test(body)) continue;
    if (actionName === "get") continue;
    const pathMatch = body.match(/path\s*:\s*["']([^"']+)["']/);
    if (!pathMatch) continue;
    if (/\/:[^/]+\/?$/.test(pathMatch[1]) && actionName !== "list") continue;
    const pathParams = [...pathMatch[1].matchAll(/:([A-Za-z_][\w]*)/g)].map((m) => m[1]);

    actions.push({
      name: actionName,
      flags: extractFlagNames(body),
      pathParams,
      brokenListFilters: extractBrokenListFilters(body),
    });
  }
  return actions;
}

function findMatchingBrace(src, openAt) {
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function extractFlagNames(body) {
  const flagsMatch = body.match(/flags\s*:\s*\{/);
  if (!flagsMatch) return [];
  const start = body.indexOf("{", flagsMatch.index + flagsMatch[0].length - 1);
  const end = findMatchingBrace(body, start);
  if (end < 0) return [];
  const flagsBody = body.slice(start + 1, end);
  // Each top-level key in flagsBody is a flag. Match `"name": {` or `name: {`.
  const names = [];
  // Track nesting so we only catch top-level keys.
  let depth = 0;
  let i = 0;
  while (i < flagsBody.length) {
    const ch = flagsBody[i];
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth--; i++; continue; }
    if (depth !== 0) { i++; continue; }
    // At depth 0: try to match an identifier/quoted-string followed by ':'
    const tail = flagsBody.slice(i);
    const km = tail.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))\s*:/);
    if (km) {
      names.push(km[1] || km[2] || km[3]);
      i += km[0].length;
      // skip whitespace and `{` to enter the value
      while (i < flagsBody.length && /\s/.test(flagsBody[i])) i++;
      if (flagsBody[i] === "{") {
        const valEnd = findMatchingBrace(flagsBody, i);
        if (valEnd > 0) i = valEnd + 1;
        else i++;
      }
      continue;
    }
    i++;
  }
  return names;
}

function extractBrokenListFilters(body) {
  const m = body.match(/brokenListFilters\s*:\s*\[([^\]]*)\]/);
  if (!m) return [];
  const inside = m[1];
  // Either a flat list of strings, or objects like `{ name: "...", match: "..." }`.
  const out = [];
  for (const tok of inside.split(",")) {
    const t = tok.trim();
    if (!t) continue;
    const strMatch = t.match(/^["']([^"']+)["']$/);
    if (strMatch) { out.push(strMatch[1]); continue; }
    const objMatch = t.match(/name\s*:\s*["']([^"']+)["']/);
    if (objMatch) { out.push(objMatch[1]); continue; }
  }
  return out;
}

// ---------- 5c. status-verb canonicalisation ----------

// Every endpoint matching POST /<r>/:id/status/<state> must map to action
// `mark-<state>`. Catches mixed naming (e.g. one resource using `void` and
// another using `mark-void` for the same shape).
async function checkStatusVerbCanonical(ctx) {
  const cov = readJson(join(ctx.dir, "coverage.json"));
  if (cov.__err || !Array.isArray(cov.endpoints)) return;
  const offenders = [];
  for (const ep of cov.endpoints) {
    if (!ep.included || ep.method !== "POST" || !ep.path || !ep.action) continue;
    // Match /<r>/:id/status/<state>  (state is the last segment)
    const m = ep.path.match(/^\/([^/]+)\/:[^/]+\/status\/([^/]+)\/?$/);
    if (!m) continue;
    const expected = `mark-${m[2]}`;
    if (ep.action !== expected) offenders.push({ path: ep.path, action: ep.action, expected });
  }
  if (offenders.length === 0) ctx.results.push(pass("coverage", "status-mutation actions use canonical mark-<state> naming"));
  else ctx.results.push(fail("coverage", "status-mutation actions must use canonical mark-<state> naming", { offenders }));
}

// ---------- 6b. README structural sections ----------

// The generated README must lead with Install + Authenticate so a new user
// cloning the repo knows how to get from `git clone` to `<bin> --version`
// without reading SKILL.md.
async function checkReadme(ctx) {
  const path = join(ctx.dir, "README.md");
  if (!existsSync(path)) { ctx.results.push(fail("structural", "README.md missing")); return; }
  const txt = readText(path) || "";
  const headings = [...txt.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim().toLowerCase());
  const missing = [];
  if (!headings.some((h) => h.startsWith("install"))) missing.push("## Install");
  if (!headings.some((h) => h.startsWith("authenticate") || h.startsWith("auth"))) missing.push("## Authenticate");
  if (missing.length === 0) ctx.results.push(pass("structural", "README.md has Install + Authenticate sections"));
  else ctx.results.push(fail("structural", `README.md missing required section(s)`, { missing }));
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

  // Primary skill must mention every resource and the knowledge dir.
  // Modular layout (preferred): skills/<pkg.name>-workflow/SKILL.md.
  // Legacy single-skill layout: skills/<api-slug>/SKILL.md.
  if (pkg.bin) {
    const apiSlug = pkg.name.replace(/-cli$/, "");
    const modularPath = join(ctx.dir, `skills/${pkg.name}-workflow/SKILL.md`);
    const legacyPath = join(ctx.dir, `skills/${apiSlug}/SKILL.md`);
    let skillPath = null;
    if (existsSync(modularPath)) skillPath = modularPath;
    else if (existsSync(legacyPath)) skillPath = legacyPath;

    if (!skillPath) {
      ctx.results.push(fail("structural", `primary SKILL.md missing (looked at skills/${pkg.name}-workflow/ and skills/${apiSlug}/)`));
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
  // Search across bin + lib/ + commands/ — wiring like FormData and
  // idempotency-key headers commonly lives in lib/api.mjs.
  const src = binEntries.length ? readCliSources(ctx.dir, binEntries[0]) : "";
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
