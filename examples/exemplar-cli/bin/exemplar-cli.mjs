#!/usr/bin/env node
// exemplar-cli — Hand-crafted stencil for the clify scaffolder.
//
// The entry is intentionally thin. Resource definitions live under commands/,
// shared HTTP and auth machinery under lib/. The scaffolder copies this whole
// tree, mechanically renames `exemplar` → `<api>`, and an LLM substitutes the
// resource registry to match the target API.
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../lib/env.mjs";
import { splitGlobal, hasHelp, toParseArgs, checkRequired } from "../lib/args.mjs";
import { output, errorOut } from "../lib/output.mjs";
import { apiRequest, paginate } from "../lib/api.mjs";
import { showRootHelp, showResourceHelp, showActionHelp } from "../lib/help.mjs";
import { pickQueryFlags, stripQueryFlags, pickBrokenFilters, clientFilter } from "../lib/quirks.mjs";

import items from "../commands/items.mjs";
import itemVariants from "../commands/item-variants.mjs";
import orders from "../commands/orders.mjs";
import { loginFlags, runLogin } from "../commands/login.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

loadEnv(REPO_ROOT);

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

// Resource registry. Each command file default-exports
// { name, actions, buildPayload? }. The bin assembles the lookup table here.
const COMMANDS = [items, itemVariants, orders];
const REGISTRY = Object.fromEntries(COMMANDS.map((c) => [c.name, c.actions]));
const PAYLOAD_BUILDERS = Object.fromEntries(COMMANDS.map((c) => [c.name, c.buildPayload || (() => ({}))]));

function interpolatePath(template, values) {
  let path = template;
  for (const m of template.matchAll(/:([a-zA-Z_]+)/g)) {
    const k = m[1];
    const v = values[k];
    if (v === undefined) errorOut("validation_error", `Missing path parameter --${k}`);
    path = path.replace(`:${k}`, encodeURIComponent(String(v)));
  }
  return path;
}

// Action defs may opt into two upstream-API-quirk handlers (see lib/quirks.mjs):
//   queryFlags: ["foreignId"]         — routed onto the URL query, not body.
//                                       For "convert-from-X" creates whose FK
//                                       is a query parameter (Zoho example:
//                                       POST /creditnotes ?invoice_id=).
//   brokenListFilters: ["customerId"] — list filters the upstream API silently
//                                       ignores. Runtime drops, full-list,
//                                       client-side filter, stderr note.
async function runResourceAction(resourceArg, actionArg, remaining, global, rest) {
  const def = REGISTRY[resourceArg][actionArg];

  if (hasHelp(rest)) {
    process.stdout.write(showActionHelp(resourceArg, actionArg, REGISTRY));
    return;
  }

  let parsed;
  try {
    parsed = parseArgs({ args: remaining, options: toParseArgs(def.flags), strict: true, allowPositionals: false });
  } catch (err) {
    errorOut("validation_error", err.message);
  }

  const missing = checkRequired(parsed.values, def.flags);
  if (missing.length) errorOut("validation_error", `Missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`);

  const path = interpolatePath(def.path, parsed.values);
  const buildPayload = PAYLOAD_BUILDERS[resourceArg];

  let body;
  if (def.method !== "GET" && def.method !== "DELETE" && !parsed.values.file) {
    if (parsed.values.body) {
      try { body = JSON.parse(parsed.values.body); }
      catch { errorOut("validation_error", "--body must be valid JSON"); }
    } else {
      body = buildPayload(stripQueryFlags(parsed.values, def));
    }
  }

  // Detect upstream-broken list filters: drop from the wire, full-list pull,
  // client-side filter, and stderr note so the user knows what happened.
  const brokenFilters = actionArg === "list" ? pickBrokenFilters(parsed.values, def) : {};
  const hasBrokenFilters = Object.keys(brokenFilters).length > 0;
  if (hasBrokenFilters) {
    for (const k of Object.keys(brokenFilters)) parsed.values[k] = undefined;
    if (!global.dry_run) {
      process.stderr.write(
        `note: ${resourceArg}.list filter(s) ${Object.keys(brokenFilters).map((k) => `--${k}`).join(", ")} are silently ignored upstream — fetching full list and filtering client-side.\n`,
      );
    }
  }

  // Cursor pagination via --all on list-like actions, or implicitly when a
  // broken filter forces the full-list fallback.
  if ((global.all || hasBrokenFilters) && actionArg === "list") {
    const collected = [];
    const query = {};
    if (parsed.values.cursor) query.cursor = parsed.values.cursor;
    if (parsed.values.limit) query.limit = parsed.values.limit;
    if (parsed.values.status) query.status = parsed.values.status;
    for await (const item of paginate({ method: def.method, path, query, version: VERSION, dryRun: !!global.dry_run, verbose: !!global.verbose, showSecrets: !!global.show_secrets })) {
      collected.push(item);
    }
    const filtered = hasBrokenFilters ? clientFilter(collected, brokenFilters) : collected;
    output(filtered, !!global.json);
    return;
  }

  // Build query for list-like actions (non-paginating path) and for any
  // declared queryFlags on non-GET actions (e.g. convert-from-X creates).
  let query;
  if (def.method === "GET" && actionArg !== "get") {
    query = {};
    for (const [k, v] of Object.entries(parsed.values)) {
      if (v !== undefined && k !== "id") query[k] = v;
    }
  } else {
    query = pickQueryFlags(parsed.values, def);
  }

  const result = await apiRequest({
    method: def.method,
    path,
    query,
    body,
    file: parsed.values.file,
    idempotencyKey: parsed.values["idempotency-key"],
    ifMatch: parsed.values["if-match"],
    dryRun: !!global.dry_run,
    verbose: !!global.verbose,
    showSecrets: !!global.show_secrets,
    version: VERSION,
  });

  output(result, !!global.json);
}

async function main() {
  const argv = process.argv.slice(2);
  const { global, rest } = splitGlobal(argv);

  if (global.version) { process.stdout.write(VERSION + "\n"); return; }

  const positional = rest.filter((a) => a !== "--help" && a !== "-h");
  if (positional.length === 0) { process.stdout.write(showRootHelp(VERSION, REGISTRY)); return; }

  // Login is dispatched ahead of resource lookup.
  if (positional[0] === "login") {
    if (hasHelp(rest)) {
      let out = `exemplar-cli login\n\nFlags:\n`;
      for (const [name, spec] of Object.entries(loginFlags)) {
        out += `  --${name.padEnd(10)} ${spec.type.padEnd(8)} ${spec.description}\n`;
      }
      process.stdout.write(out);
      return;
    }
    let parsed;
    try { parsed = parseArgs({ args: positional.slice(1), options: toParseArgs(loginFlags), strict: true, allowPositionals: false }); }
    catch (err) { errorOut("validation_error", err.message); }
    await runLogin(parsed.values, !!global.json);
    return;
  }

  const [resourceArg, actionArg, ...remaining] = positional;

  if (!REGISTRY[resourceArg]) {
    const available = Object.keys(REGISTRY).concat(["login"]).join(", ");
    errorOut("validation_error", `Unknown resource: ${resourceArg}. Available: ${available}`);
  }

  if (!actionArg) {
    process.stdout.write(showResourceHelp(resourceArg, REGISTRY));
    return;
  }

  if (!REGISTRY[resourceArg][actionArg]) {
    const available = Object.keys(REGISTRY[resourceArg]).join(", ");
    errorOut("validation_error", `Unknown action: ${actionArg} on ${resourceArg}. Available: ${available}`);
  }

  await runResourceAction(resourceArg, actionArg, remaining, global, rest);
}

main().catch((err) => {
  errorOut("network_error", err.message || String(err));
});
