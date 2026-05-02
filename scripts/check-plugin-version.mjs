#!/usr/bin/env node
// Asserts the three places clify carries its version stay in sync:
//   - package.json                   (npm publish + npm-side consumers)
//   - .claude-plugin/plugin.json     (Claude Code plugin loader)
//   - .claude-plugin/marketplace.json (the local marketplace listing)
//   - .codex-plugin/plugin.json      (Codex plugin loader)
//
// Run via `npm test`; fails the build if any pair drifts. Without this
// plugin loaders silently keep showing the stale version.
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(REPO, rel), "utf8"));
}

const pkg = readJson("package.json");
const plugin = readJson(".claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const codexPlugin = readJson(".codex-plugin/plugin.json");

const pkgV = pkg.version;
const pluginV = plugin.version;
const marketV = marketplace.plugins?.[0]?.version;
const codexPluginV = codexPlugin.version;

const drift = [];
if (pkgV !== pluginV) drift.push(`package.json (${pkgV}) vs .claude-plugin/plugin.json (${pluginV})`);
if (pluginV !== marketV) drift.push(`.claude-plugin/plugin.json (${pluginV}) vs .claude-plugin/marketplace.json plugins[0] (${marketV})`);
if (pkgV !== codexPluginV) drift.push(`package.json (${pkgV}) vs .codex-plugin/plugin.json (${codexPluginV})`);

if (drift.length) {
  process.stderr.write(`ERROR: clify version drift detected:\n  - ${drift.join("\n  - ")}\n`);
  process.stderr.write(`Update all three to the same value when bumping the version.\n`);
  process.exit(1);
}

process.stdout.write(`ok plugin version ${pkgV} consistent across package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json, .codex-plugin/plugin.json\n`);
