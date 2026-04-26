// Global flag splitter + per-action arg-spec helpers.
export const GLOBAL_FLAGS = new Set(["--json", "--dry-run", "--version", "-v", "--verbose", "--all"]);

export function splitGlobal(argv) {
  const global = {};
  const rest = [];
  for (const arg of argv) {
    if (GLOBAL_FLAGS.has(arg)) {
      const key = arg.replace(/^--?/, "").replace(/-/g, "_");
      global[key] = true;
      if (arg === "-v") global.version = true;
      if (arg === "--dry-run") global.dry_run = true;
    } else {
      rest.push(arg);
    }
  }
  return { global, rest };
}

export function hasHelp(args) {
  return args.includes("--help") || args.includes("-h");
}

export function toParseArgs(flagSpec) {
  const options = {};
  for (const [name, spec] of Object.entries(flagSpec)) {
    options[name] = { type: spec.type === "boolean" ? "boolean" : "string" };
  }
  return options;
}

export function checkRequired(values, flagSpec) {
  const missing = [];
  for (const [name, spec] of Object.entries(flagSpec)) {
    if (spec.required && (values[name] === undefined || values[name] === "")) missing.push(name);
  }
  return missing;
}
