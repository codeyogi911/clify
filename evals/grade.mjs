// Deterministic graders for an eval case. The LLM-as-judge portion is
// a separate plug-in (currently a no-op placeholder) that scores
// structural_similarity_to_exemplar; everything below this line is
// purely file-system + JSON inspection.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function gradeDeterministic(repoDir, expected) {
  const findings = [];
  const ok = (name, detail) => findings.push({ name, ok: true, detail });
  const ko = (name, detail) => findings.push({ name, ok: false, detail });

  const clifyPath = join(repoDir, ".clify.json");
  if (!existsSync(clifyPath)) {
    ko("clify.json present", clifyPath);
    return summarize(findings);
  }
  const cfg = JSON.parse(readFileSync(clifyPath, "utf8"));

  // auth scheme
  const allowedSchemes = [expected.auth_scheme, ...(expected.auth_scheme_fallbacks || [])];
  if (allowedSchemes.includes(cfg.auth?.scheme)) {
    ok("auth scheme", `scheme=${cfg.auth.scheme}`);
  } else {
    ko("auth scheme", `expected one of ${JSON.stringify(allowedSchemes)}, got ${cfg.auth?.scheme}`);
  }

  // resources count
  const cov = readJson(join(repoDir, "coverage.json"));
  if (!cov) {
    ko("coverage.json present", "missing");
  } else {
    const resources = new Set(cov.endpoints.filter((e) => e.included).map((e) => e.resource));
    if (resources.size >= expected.resources_min) ok("resources count", `${resources.size} ≥ ${expected.resources_min}`);
    else ko("resources count", `${resources.size} < ${expected.resources_min}`);
  }

  // declared nuances
  const declaredNuances = new Set(
    Object.entries(cfg.nuances || {})
      .filter(([_, v]) => v && (Array.isArray(v) ? v.length : true))
      .map(([k]) => k)
      .map((k) => k === "multiPart" ? "multipart" : k)
      .map((k) => k === "rateLimits" ? "rate-limit" : k)
  );
  for (const n of expected.must_include_nuances || []) {
    if (declaredNuances.has(n)) ok(`nuance: ${n}`, "declared");
    else ko(`nuance: ${n}`, `not in .clify.json.nuances (${[...declaredNuances].join(", ")})`);
  }

  // knowledge files
  const knowledgeDir = join(repoDir, "knowledge");
  const knowledgeFiles = existsSync(knowledgeDir) ? readdirSync(knowledgeDir).map((f) => f.replace(/\.md$/, "")) : [];
  for (const k of expected.must_have_knowledge_files || []) {
    if (knowledgeFiles.includes(k)) ok(`knowledge: ${k}`, "present");
    else ko(`knowledge: ${k}`, `expected knowledge/${k}.md, found: ${knowledgeFiles.join(", ") || "(none)"}`);
  }

  return summarize(findings);
}

// Placeholder for the LLM-as-judge step. Scoring structural similarity
// against the exemplar requires a sibling Claude session; that's out of
// scope for the deterministic harness. For now this returns null (skipped),
// and the caller treats null as "manual review pending".
export async function gradeStructuralSimilarity(_repoDir, _exemplarDir, _threshold) {
  return null;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function summarize(findings) {
  const passed = findings.filter((f) => f.ok).length;
  const failed = findings.filter((f) => !f.ok).length;
  return { findings, passed, failed, ok: failed === 0 };
}
