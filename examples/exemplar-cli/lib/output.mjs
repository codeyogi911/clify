// Centralized output + structured-error formatter.
// `output()` chooses JSON when --json is requested or when stdout is piped.
// `errorOut()` writes JSON to stderr (when piped or forced via env) and exits 1.
export const isPiped = !process.stdout.isTTY;

export function output(data, jsonRequested) {
  const wantJson = jsonRequested || isPiped;
  if (wantJson) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else if (data === null || data === undefined) {
    process.stdout.write("\n");
  } else if (typeof data === "string") {
    process.stdout.write(data + "\n");
  } else if (Array.isArray(data) || typeof data === "object") {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(String(data) + "\n");
  }
}

export function errorOut(code, message, opts = {}) {
  const obj = { type: "error", code, message, retryable: !!opts.retryable };
  if (opts.retryAfter !== undefined) obj.retryAfter = opts.retryAfter;
  if (opts.details) obj.details = opts.details;
  if (process.env.__EXEMPLAR_FORCE_JSON_ERR === "1" || isPiped) {
    process.stderr.write(JSON.stringify(obj) + "\n");
  } else {
    process.stderr.write(`error[${code}]: ${message}\n`);
  }
  process.exit(1);
}
