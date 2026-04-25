// clify sync-check: re-fetch docs, recompute content hash, print diff summary.
// Pure advisory — does NOT regenerate. The sync skill consumes this output.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export async function syncCheck(repoDir, { fetcher = globalThis.fetch } = {}) {
  const dir = resolve(repoDir);
  const cfgPath = join(dir, ".clify.json");
  if (!existsSync(cfgPath)) throw new Error(`.clify.json not found in ${dir}`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

  const urls = cfg.crawledUrls?.length ? cfg.crawledUrls : (cfg.docsUrl ? [cfg.docsUrl] : []);
  if (urls.length === 0) throw new Error(".clify.json has neither docsUrl nor crawledUrls");

  const fetchedAt = new Date().toISOString();
  const parts = [];
  const fetched = [];
  for (const url of urls) {
    let body = "", status = 0, error;
    try {
      const res = await fetcher(url, { headers: { "user-agent": `clify-sync-check/${cfg.clifyVersion || "0"}` } });
      status = res.status;
      body = await res.text();
    } catch (err) { error = err.message; }
    fetched.push({ url, status, bytes: body.length, error });
    if (body) parts.push(body);
  }

  const newHash = "sha256:" + createHash("sha256").update(parts.join("\n---\n")).digest("hex");
  const oldHash = cfg.contentHash || null;
  const changed = oldHash !== newHash;

  return {
    apiName: cfg.apiName,
    docsUrl: cfg.docsUrl,
    fetchedAt,
    oldHash,
    newHash,
    changed,
    fetched,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write("Usage: clify sync-check <dir>\n"); process.exit(1); }
  syncCheck(dir).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.changed ? 1 : 0);
  }).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  });
}
