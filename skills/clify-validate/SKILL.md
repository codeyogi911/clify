---
name: clify-validate
description: Run the clify validation gate against a generated CLI repo and report failures by category. Use when the user says "/clify-validate", "validate this repo", or after generation/modification of a clify-shaped CLI to confirm it still meets A+ standards.
allowed-tools:
  - Bash
  - Read
---

# clify-validate

Run the validation gate (eight categories: manifest, coverage, structural, nuances, secrets, ci, tests, plus advisory warnings) against a generated CLI repo. Report failures grouped by category. Never claim "valid" while any check is failing.

The gate is implemented in [`lib/validate.mjs`](../../lib/validate.mjs) and documented in [`references/validation-gate.md`](../../references/validation-gate.md).

## Triggers

- `/clify-validate <dir>`
- "Validate this CLI"
- After editing a clify-shaped repo, before committing

## Workflow

1. Run the gate with structured output:

   ```
   clify validate <dir> --json
   ```

2. Parse the JSON report:
   - `summary.failed > 0` → at least one check failed
   - `warnings[]` → soft-warn nuances, never fail the gate

3. Group failures by `results[].category`. Quote the failure `name` and any `error` / `missing` / `failures` / `issues` / `offenders` field.

4. Fix the underlying issue. Common patterns:

   | Category | Likely cause |
   |---|---|
   | manifest | `package.json` ↔ `plugin.json` ↔ `marketplace.json` desync, or `bin` path renamed without updating the manifest. |
   | coverage | An endpoint was dropped without `dropped: true` + a valid `reason`. |
   | structural | A resource or action exists in the registry but isn't in `--help` output (or vice versa). |
   | nuances | A nuance was declared in `.clify.json` but the artifact (test, knowledge file, CLI flag) is missing. |
   | secrets | A real-shaped API key is hardcoded in a source file. |
   | ci | `.github/workflows/test.yml` missing or doesn't invoke `npm test`. |
   | tests | The repo's `npm test` script failed — read `stderrTail`. |

5. Re-run `clify validate <dir>`. Loop until 0 failures, capped at 3 attempts. If still failing, surface the failed check names verbatim and stop.

## Anti-patterns

- ❌ Don't claim a repo passes when warnings exist but you didn't read them — the user may want to act on warnings.
- ❌ Don't bypass a check by editing `lib/validate.mjs`. The check is there for a reason; fix the input.
- ❌ Don't run `clify validate` on a non-generated repo and expect it to pass.

## Quick reference

```
clify validate <dir>          # human-readable
clify validate <dir> --json   # machine-parseable
clify validate <dir> --skip-tests  # manifests only, fast
```

Exit code: 0 on full pass, 1 on any failure.
