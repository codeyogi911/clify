// Eval harness. Each case file describes (a) a docs URL the scaffolder
// should turn into a CLI, and (b) a set of expected attributes.
//
// What this harness does today:
//   1. Reads the case file.
//   2. Looks up the candidate repo (default: ./<case-name>-cli/ relative to
//      where the harness is invoked, or via --repo <path>).
//   3. Runs `clify validate` against it, then runs the deterministic graders
//      from grade.mjs against the same repo.
//   4. Prints a report.
//
// What it does NOT do today: drive the scaffolder end-to-end (that requires a
// Claude Code session). Plug that in later by spawning `claude code` with
// the case URL and waiting for the resulting repo path.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../lib/validate.mjs";
import { gradeDeterministic, gradeStructuralSimilarity } from "./grade.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, "cases");
const EXEMPLAR_DIR = resolve(__dirname, "../examples/exemplar-cli");

export async function runEval({ caseName, repoDir, skipTests = false }) {
  const casePath = caseName.endsWith(".json") ? resolve(caseName) : join(CASES_DIR, `${caseName}.json`);
  if (!existsSync(casePath)) throw new Error(`Case file not found: ${casePath}`);
  const caseSpec = JSON.parse(readFileSync(casePath, "utf8"));

  const candidate = repoDir ? resolve(repoDir) : resolve(`./${caseSpec.name}-cli`);
  if (!existsSync(candidate)) {
    return {
      case: caseSpec.name,
      candidate,
      ok: false,
      stages: { validation: { ok: false, error: `Candidate repo not found at ${candidate}. Run the scaffolder first or pass --repo <path>.` } },
    };
  }

  const validation = await validate(candidate, { skipTests });
  const deterministic = gradeDeterministic(candidate, caseSpec.expected || {});
  const structural = await gradeStructuralSimilarity(candidate, EXEMPLAR_DIR, caseSpec.expected?.structural_similarity_to_exemplar);

  const ok = (caseSpec.expected?.must_pass_validation_gate ? validation.ok : true) && deterministic.ok && (structural === null || structural.ok);

  return {
    case: caseSpec.name,
    candidate,
    ok,
    stages: {
      validation: { ok: validation.ok, summary: validation.summary, failed: validation.results.filter((r) => !r.ok) },
      deterministic,
      structural: structural ?? { skipped: true, reason: "LLM-as-judge not yet wired; deterministic graders only" },
    },
  };
}

export function listCases() {
  const cases = [];
  for (const file of (function* () {
    const fs = require("node:fs");
    for (const f of fs.readdirSync(CASES_DIR)) if (f.endsWith(".json")) yield f;
  })()) cases.push(file.replace(/\.json$/, ""));
  return cases;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const caseName = args.find((a) => !a.startsWith("-"));
  if (!caseName) {
    process.stderr.write("Usage: node evals/run.mjs <case> [--repo <path>] [--skip-tests] [--json]\n");
    process.exit(2);
  }
  let repoDir;
  for (let i = 0; i < args.length; i++) if (args[i] === "--repo" && args[i + 1]) repoDir = args[++i];
  const skipTests = args.includes("--skip-tests");
  const json = args.includes("--json");
  runEval({ caseName, repoDir, skipTests })
    .then((report) => {
      if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      else process.stdout.write(formatReport(report));
      process.exit(report.ok ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`error: ${err.stack || err.message}\n`);
      process.exit(2);
    });
}

export function formatReport(r) {
  const lines = [`eval: ${r.case}`, `  candidate: ${r.candidate}`, `  ok: ${r.ok}`];
  if (r.stages.validation) {
    const v = r.stages.validation;
    if (v.error) lines.push(`  validation: SKIPPED — ${v.error}`);
    else lines.push(`  validation: ${v.ok ? "PASS" : "FAIL"} (${v.summary?.passed ?? "?"}/${v.summary?.total ?? "?"})`);
    if (v.failed?.length) for (const f of v.failed) lines.push(`    ✗ ${f.category}/${f.name}`);
  }
  if (r.stages.deterministic) {
    const d = r.stages.deterministic;
    lines.push(`  deterministic: ${d.ok ? "PASS" : "FAIL"} (${d.passed}/${d.passed + d.failed})`);
    for (const f of d.findings) {
      const mark = f.ok ? "✓" : "✗";
      lines.push(`    ${mark} ${f.name}${f.detail ? `  — ${f.detail}` : ""}`);
    }
  }
  if (r.stages.structural) {
    const s = r.stages.structural;
    if (s.skipped) lines.push(`  structural: SKIPPED — ${s.reason}`);
    else lines.push(`  structural: ${s.ok ? "PASS" : "FAIL"} (score ${s.score})`);
  }
  lines.push("");
  return lines.join("\n");
}
