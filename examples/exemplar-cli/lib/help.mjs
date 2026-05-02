// Help text generators. Read the runtime resource registry so help is
// always in sync with whatever commands/ files are loaded.
const CLI = "exemplar-cli";

export function showRootHelp(version, registry) {
  let out = `${CLI} ${version}\nCLI for the Exemplar API.\n\nUsage:\n  ${CLI} <resource> <action> [flags]\n  ${CLI} login [--token <t>] [--status]\n\nGlobal flags:\n  --json           Force JSON output\n  --dry-run        Print request without sending (auth headers redacted)\n  --show-secrets   With --dry-run, show real auth headers (debug only)\n  --verbose        Print response status & headers to stderr\n  --all            Auto-paginate list actions\n  --version, -v    Print version\n  --help, -h       Show this help\n\nResources:\n`;
  for (const r of Object.keys(registry).sort()) {
    out += `  ${r.padEnd(18)} ${Object.keys(registry[r]).join(", ")}\n`;
  }
  out += `\nCommands:\n  login              Store an API token for the current user.\n\nUse '${CLI} <resource> --help' for actions, or '<resource> <action> --help' for flags.\n`;
  return out;
}

function describeAction(def) {
  if (def.kind === "graphql") return `GraphQL ${def.opType || "operation"}`;
  if (def.kind === "rest") return `${def.method} ${def.path}`;
  if (def.method && def.path) return `${def.method} ${def.path}`;
  return "(operation)";
}

function actionFlags(def) {
  const flags = def.flags || {};
  if (def.kind !== "graphql") return flags;
  return {
    body: { type: "string", description: "Raw GraphQL variables JSON (overrides individual flags)" },
    ...flags,
  };
}

export function showResourceHelp(resource, registry) {
  const actions = registry[resource];
  let out = `${CLI} ${resource}\n\nActions:\n`;
  for (const [name, def] of Object.entries(actions)) {
    out += `  ${name.padEnd(10)} ${describeAction(def)}\n`;
  }
  out += `\nUse '${CLI} ${resource} <action> --help' for flags.\n`;
  return out;
}

export function showActionHelp(resource, action, registry) {
  const def = registry[resource][action];
  let out = `${CLI} ${resource} ${action}\n\n${describeAction(def)}\n\n`;
  if (def.description) out += `${def.description}\n\n`;
  out += `Flags:\n`;
  const entries = Object.entries(actionFlags(def));
  if (entries.length === 0) out += `  (none)\n`;
  for (const [name, spec] of entries) {
    const req = spec.required ? "required" : "optional";
    // Render enum values inline so users see allowed values without
    // bouncing to the docs: `--filter_by <All|NotShipped|Shipped>`.
    const flagLabel = Array.isArray(spec.enum) && spec.enum.length
      ? `--${name} <${spec.enum.join("|")}>`
      : `--${name}`;
    const desc = spec.description || "";
    out += `  ${flagLabel.padEnd(22)} ${spec.type.padEnd(8)} ${req.padEnd(8)} ${desc}\n`;
  }
  return out;
}
