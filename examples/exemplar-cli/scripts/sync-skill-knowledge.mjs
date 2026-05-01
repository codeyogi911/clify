// Copy repo-root knowledge/ into the published skill bundle (standalone skill install).
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const knowledgeSource = path.join(repoRoot, "knowledge");
const knowledgeTarget = path.join(repoRoot, "skills", "exemplar-cli", "references", "knowledge");

await mkdir(path.dirname(knowledgeTarget), { recursive: true });
await rm(knowledgeTarget, { recursive: true, force: true });
await cp(knowledgeSource, knowledgeTarget, { recursive: true });
