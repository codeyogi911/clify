#!/usr/bin/env node
// clify — top-level CLI for the codegen plugin.
// Verbs that do deterministic work: validate, scaffold-init, sync-check.
// Verb that delegates to LLM: scaffold (informational, points to /clify-scaffold skill).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../lib/validate.mjs";
import { scaffoldInit } from "../lib/scaffold-init.mjs";
import { syncCheck } from "../lib/sync-check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

const HELP = `clify ${VERSION}
Generate, validate, and sync agent-friendly CLIs from API documentation.

Usage:
  clify validate <dir>                 Run the validation gate (deterministic, no LLM)
  clify scaffold-init <api-name>       Copy the exemplar to <api-name>-cli/ and rename
                                       (use --target <dir> to choose parent directory)
  clify sync-check <dir>               Re-fetch docs, hash, print diff summary
  clify scaffold <url>                 (LLM step) Use /clify-scaffold <url> in Claude Code
  clify --version
  clify --help

The validate, scaffold-init, and sync-check verbs are pure JS and reproducible across
agent vendors. The scaffold verb is informational — full scaffold needs LLM judgment
and runs as the /clify-scaffold skill in Claude Code.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(VERSION + "\n");
    return;
  }

  const verb = args[0];
  const rest = args.slice(1);

  switch (verb) {
    case "validate": return await runValidate(rest);
    case "scaffold-init": return runScaffoldInit(rest);
    case "sync-check": return await runSyncCheck(rest);
    case "scaffold":   return runScaffoldInfo(rest);
    default:
      process.stderr.write(`error: unknown verb '${verb}'\n\n${HELP}`);
      process.exit(2);
  }
}

async function runValidate(args) {
  const dir = args.find((a) => !a.startsWith("-"));
  const json = args.includes("--json");
  const skipTests = args.includes("--skip-tests");
  if (!dir) { process.stderr.write("Usage: clify validate <dir> [--json] [--skip-tests]\n"); process.exit(2); }
  const report = await validate(dir, { skipTests });
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(report));
  }
  process.exit(report.ok ? 0 : 1);
}

function formatReport(r) {
  const lines = [];
  lines.push(`clify validate ${r.dir}`);
  lines.push(`  ${r.summary.passed}/${r.summary.total} passed, ${r.summary.failed} failed, ${r.summary.warnings} warnings`);
  const byCat = {};
  for (const res of r.results) (byCat[res.category] ??= []).push(res);
  const cats = Object.keys(byCat).sort();
  for (const cat of cats) {
    const items = byCat[cat];
    const failed = items.filter((i) => !i.ok);
    const status = failed.length === 0 ? "✓" : "✗";
    lines.push(`\n[${status}] ${cat} (${items.length - failed.length}/${items.length})`);
    for (const f of failed) {
      lines.push(`    FAIL  ${f.name}` + (f.error ? `  — ${f.error}` : ""));
      if (f.missing) lines.push(`          missing: ${JSON.stringify(f.missing)}`);
      if (f.failures) for (const x of f.failures) lines.push(`          ${x}`);
      if (f.issues) for (const x of f.issues) lines.push(`          ${JSON.stringify(x)}`);
      if (f.offenders) for (const x of f.offenders) lines.push(`          secret '${x.pattern}' in ${x.file}`);
    }
  }
  if (r.warnings.length) {
    lines.push("\nwarnings:");
    for (const w of r.warnings) lines.push(`  ! ${w}`);
  }
  lines.push("");
  return lines.join("\n");
}

function runScaffoldInit(args) {
  const positional = args.filter((a) => !a.startsWith("-"));
  const apiName = positional[0];
  let target = process.cwd();
  for (let i = 0; i < args.length; i++) if (args[i] === "--target" && args[i + 1]) target = args[++i];
  const json = args.includes("--json");
  if (!apiName) { process.stderr.write("Usage: clify scaffold-init <api-name> [--target <dir>] [--json]\n"); process.exit(2); }
  try {
    const result = scaffoldInit({ apiName, target });
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else process.stdout.write(`scaffolded ${result.apiName} → ${result.dir}\n`);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

async function runSyncCheck(args) {
  const dir = args.find((a) => !a.startsWith("-"));
  const json = args.includes("--json");
  if (!dir) { process.stderr.write("Usage: clify sync-check <dir> [--json]\n"); process.exit(2); }
  try {
    const result = await syncCheck(dir);
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      process.stdout.write(`api: ${result.apiName}\n`);
      process.stdout.write(`docs: ${result.docsUrl}\n`);
      process.stdout.write(`old:  ${result.oldHash}\n`);
      process.stdout.write(`new:  ${result.newHash}\n`);
      process.stdout.write(`changed: ${result.changed}\n`);
    }
    process.exit(result.changed ? 1 : 0);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
}

function runScaffoldInfo(args) {
  const url = args.find((a) => !a.startsWith("-")) || "<url>";
  process.stdout.write(`Full scaffolding needs LLM judgment (parsing free-form docs, deciding endpoint→action mapping).\nRun in Claude Code:  /clify-scaffold ${url}\n\nThe scaffold skill calls 'clify scaffold-init' and 'clify validate' as deterministic\nsub-steps, but the parsing and substitution phases are LLM-driven.\n`);
}

main().catch((err) => {
  process.stderr.write(`error: ${err.stack || err.message}\n`);
  process.exit(2);
});
