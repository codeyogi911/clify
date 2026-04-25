import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const CLI = resolve(REPO_ROOT, "bin/jsonplaceholder-cli.mjs");

export function run(args = [], { env = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolveRun) => {
    const cleanEnv = { ...process.env, ...env };
    delete cleanEnv.JSONPLACEHOLDER_API_KEY;
    if (env.JSONPLACEHOLDER_API_KEY !== undefined) cleanEnv.JSONPLACEHOLDER_API_KEY = env.JSONPLACEHOLDER_API_KEY;
    cleanEnv.__JSONPLACEHOLDER_FORCE_JSON_ERR = "1";
    const child = spawn(process.execPath, [CLI, ...args], { env: cleanEnv });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolveRun({ stdout, stderr, exitCode: code ?? 0 }); });
  });
}

export async function runJson(args = [], opts = {}) {
  const r = await run([...args, "--json"], opts);
  let parsed = null;
  if (r.stdout.trim()) { try { parsed = JSON.parse(r.stdout); } catch {} }
  let parsedErr = null;
  if (r.stderr.trim()) { try { parsedErr = JSON.parse(r.stderr.trim().split("\n").pop()); } catch {} }
  return { ...r, json: parsed, errJson: parsedErr };
}
