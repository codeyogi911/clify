// clify scaffold-init: deterministic exemplar copy + rename phase.
// Used by the LLM-driven scaffold skill at step 8 of its pipeline.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const EXEMPLAR_DIR = join(REPO_ROOT, "examples/exemplar-cli");

const FROM = "exemplar";
const FROM_UPPER = "EXEMPLAR";
const FROM_TITLE = "Exemplar";

const TEXT_EXTENSIONS = new Set(["mjs", "js", "json", "md", "yml", "yaml", "txt", "example", "gitkeep", "gitignore"]);

function isTextFile(name) {
  if (name === ".env.example") return true;
  if (name === ".gitignore") return true;
  if (name === ".gitkeep") return true;
  if (name === "LICENSE") return true;
  const ext = name.split(".").pop();
  return TEXT_EXTENSIONS.has(ext);
}

export function scaffoldInit({ apiName, target = process.cwd(), exemplarDir = EXEMPLAR_DIR }) {
  if (!apiName) throw new Error("apiName required");
  if (!/^[a-z][a-z0-9-]*$/.test(apiName)) throw new Error(`apiName must match /^[a-z][a-z0-9-]*$/, got: ${apiName}`);

  const upper = apiName.toUpperCase().replace(/-/g, "_");
  const title = apiName.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
  const destRoot = resolve(target, `${apiName}-cli`);

  if (existsSync(destRoot)) throw new Error(`Destination already exists: ${destRoot}`);

  copyTree(exemplarDir, destRoot, apiName, upper, title);

  return { dir: destRoot, apiName, apiNameUpper: upper, apiNameTitle: title };
}

function copyTree(src, dst, apiName, upper, title) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const renamedName = renameToken(entry.name, apiName);
    const dstPath = join(dst, renamedName);
    if (entry.isDirectory()) {
      copyTree(srcPath, dstPath, apiName, upper, title);
    } else if (entry.isFile()) {
      if (isTextFile(entry.name)) {
        const text = readFileSync(srcPath, "utf8");
        writeFileSync(dstPath, substitute(text, apiName, upper, title));
      } else {
        copyFileSync(srcPath, dstPath);
      }
    }
  }
}

function renameToken(name, apiName) {
  if (name === FROM) return apiName;
  return name.replaceAll(FROM, apiName);
}

export function substitute(text, apiName, upper, title) {
  // Order matters: do the most specific (case-sensitive title) first, then upper, then lower.
  return text
    .replaceAll(FROM_UPPER, upper)
    .replaceAll(FROM_TITLE, title)
    .replaceAll(FROM, apiName);
}

// CLI entry when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const apiName = args[0];
  let target = process.cwd();
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) { target = args[++i]; }
  }
  if (!apiName || apiName.startsWith("-")) {
    process.stderr.write("Usage: clify scaffold-init <api-name> [--target <dir>]\n");
    process.exit(1);
  }
  try {
    const result = scaffoldInit({ apiName, target });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}
