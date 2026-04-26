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

export function showResourceHelp(resource, registry) {
  const actions = registry[resource];
  let out = `${CLI} ${resource}\n\nActions:\n`;
  for (const [name, def] of Object.entries(actions)) {
    out += `  ${name.padEnd(10)} ${def.method} ${def.path}\n`;
  }
  out += `\nUse '${CLI} ${resource} <action> --help' for flags.\n`;
  return out;
}

export function showActionHelp(resource, action, registry) {
  const def = registry[resource][action];
  let out = `${CLI} ${resource} ${action}\n\n${def.method} ${def.path}\n\n`;
  if (def.description) out += `${def.description}\n\n`;
  out += `Flags:\n`;
  const entries = Object.entries(def.flags);
  if (entries.length === 0) out += `  (none)\n`;
  for (const [name, spec] of entries) {
    const req = spec.required ? "required" : "optional";
    const desc = spec.description || "";
    out += `  --${name.padEnd(20)} ${spec.type.padEnd(8)} ${req.padEnd(8)} ${desc}\n`;
  }
  return out;
}
