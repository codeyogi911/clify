# Findings from Fix Coffee Zoho-inventory rollout — 2026-04-26

Context: Generated `zoho-inventory-cli` via clify, then wired it into Fix Coffee replacing a docs-only skill. Six issues required hand-tweaking the generated repo before it worked. This document is the punch list to bring clify's "first-shot" output up to a state that needs zero post-generation patches.

Findings ordered by severity. Each has: **Symptom** / **Root cause** / **Fix sketch** / **Where**.

---

## 1. `bin/<api>-cli.mjs` is not executable after generation [BLOCKER]

**Symptom**: After `npm install && npm link`, `<api>-cli --version` fails with `permission denied`. Manual `chmod +x bin/<api>-cli.mjs` is required.

**Root cause**: The exemplar at `examples/exemplar-cli/bin/exemplar-cli.mjs` is mode `644`. Git preserves file modes, so the exemplar shipping at `644` means every generated CLI inherits `644`. `npm link` doesn't fix the source file's mode — it only symlinks. (`scaffold-init.mjs` does not call `chmodSync` either — verified by grep.)

**Fix sketch**:
1. Set the exemplar's bin file to `0755` in git: `git update-index --chmod=+x examples/exemplar-cli/bin/exemplar-cli.mjs`.
2. In `lib/scaffold-init.mjs`, after copying files, add `fs.chmodSync(targetBinPath, 0o755)` to belt-and-suspender it (in case the user creates a generated CLI on a filesystem that doesn't preserve modes — e.g. unzipping a tarball).
3. Validation gate: add a check in `lib/validate.mjs` — `fs.statSync(binPath).mode & 0o111` must be non-zero. Add a smoke test to the exemplar that runs `child_process.execSync(binPath + ' --version')` (currently uses `node binPath` which bypasses the exec bit).

**Where**: `examples/exemplar-cli/bin/exemplar-cli.mjs` (mode), `lib/scaffold-init.mjs` (chmod), `lib/validate.mjs` + `examples/exemplar-cli/test/smoke.test.mjs` (regression test).

---

## 2. `--dry-run` prints the live access token to stdout [SECURITY]

**Symptom**: `<api>-cli <r> <a> --dry-run --json` returns:
```json
{
  "__dryRun": true,
  "url": "...",
  "headers": { "authorization": "Bearer <real-50-char-token>" },
  ...
}
```
Anyone who pipes dry-run to a log/PR/screenshot leaks the token. Bit me when verifying the Zoho rollout — caught it before sharing, but not before it landed in shell history.

**Root cause**: `examples/exemplar-cli/lib/api.mjs` line 41 dumps the full `reqHeaders` map including the Authorization header that `applyAuth` populated.

**Fix sketch**:
1. In the exemplar's `apiRequest`, before returning the dry-run object, redact known auth header keys (`authorization`, `x-api-key`, `proxy-authorization`, anything matching `/(token|secret|key|cookie)/i`). Replace with `<redacted>` or the first 8 chars + ellipsis.
2. Add an opt-in `--show-secrets` flag that disables redaction (for debugging — never default).
3. Conventions doc: add a hard rule "dry-run output must not contain credential-shaped values".
4. Smoke test: dry-run output scanned with the same secret-pattern regexes that the "no hardcoded secrets" smoke test already uses (`test/smoke.test.mjs:77-80` — extend it).

**Where**: `examples/exemplar-cli/lib/api.mjs`, `references/conventions.md` (new rule under "Structured Error Output" or a new "Dry-Run" section), `examples/exemplar-cli/test/smoke.test.mjs`.

---

## 3. OAuth-refresh auth is not in the exemplar — LLM hand-rolls it inconsistently [HIGH]

**Symptom**: The Zoho CLI's generated `lib/auth.mjs` had a precedence bug: when env had a fresh `ZOHO_INVENTORY_REFRESH_TOKEN` but `~/.config/<api>-cli/credentials.json` had a still-valid cached `accessToken` from a prior run, the cached token was returned even though it belonged to a different account/scope. Manifested as `auth_invalid` (HTTP 401) on a request that should have succeeded with the env creds.

**Root cause**: The exemplar's `lib/auth.mjs` only models 4 schemes — `bearer`, `api-key-header`, `basic`, `none` — none of which involve token refresh. For OAuth-refresh APIs (Zoho, Google, Notion, GitHub Apps, etc.) the LLM extends `auth.mjs` during the substitute phase, writing a fair bit of custom code: refresh-token grant, expiry tracking, cache, fallback. Easy to introduce subtle precedence bugs because there's no ground truth.

**Fix sketch**:
1. Add a second exemplar — `examples/exemplar-oauth-cli/` — that models OAuth-refresh end-to-end:
   - `lib/auth.mjs` with: env access-token wins → env refresh-token + client → cached access-token (only if its `refreshTokenHash` matches the current env's hash) → stored refresh-token → fail.
   - `lib/config.mjs` storing `{ refreshToken, clientId, clientSecret, accessToken, expiresAt, refreshTokenHash }` with mode 0600.
   - `commands/login.mjs` accepting `--refresh-token --client-id --client-secret` and persisting to config.
   - `test/auth.test.mjs` covering: env wins over stored when creds disagree; expired access-token triggers refresh; refresh-token failure surfaces `auth_missing` not `auth_invalid`.
2. The skill (LLM phase) chooses between the two exemplars based on detected auth scheme. `references/scaffold-pipeline.md` adds an "auth-exemplar selection" step.
3. Add to `evals/cases/`: at least one OAuth case (Zoho, GitHub) that runs the new exemplar's auth tests against the generated repo.

**Where**: new `examples/exemplar-oauth-cli/` (mirror exemplar-cli structure), `references/scaffold-pipeline.md`, `evals/cases/zoho-inventory.json` (already exists — extend rubric to require oauth-refresh test pass), new `evals/cases/github-apps.json` or similar.

---

## 4. Inconsistent endpoint coverage across sibling resources [HIGH]

**Symptom**: For Zoho Inventory, `/comments` endpoints generated for `invoices`, `credit-notes`, `vendor-credits`, `retainer-invoices`, `tasks` (4-action set including update-comment for some), but NOT for `sales-orders` (zero comment actions) and `contacts` got only `list-comments` (missing add/delete). All these resources have `/comments` in the Zoho API. Status mutations also inconsistent: `sales-orders` uses `mark-confirmed`/`mark-void` (verb prefix), `credit-notes` uses bare `void`, `invoices` uses `mark-sent`/`void` (mixed).

**Root cause**: Two distinct issues:
- **Coverage**: the docs parser walks the API reference page-by-page and scrapes endpoints, but the `/salesorders/:id/comments` page is structured differently from `/invoices/:id/comments` (probably a different docs template, table of contents level, or section heading). The parser misses it. Same for `contacts` — only one of three comment endpoints captured.
- **Naming**: when a status-mutation endpoint is detected (`POST /<r>/:id/status/<state>`), the action verb derivation isn't deterministic — sometimes "mark-<state>", sometimes bare "<state>". Different code paths, no canonical rule.

**Fix sketch**:
1. **Coverage**: after parsing endpoints, run a **family-consistency check**. Group resources that share a common `/comments` (or `/attachments`, `/refunds`, etc.) sub-path. If 4 of 5 siblings have the comment endpoints and one doesn't, surface in the consult phase: "I detected `/comments` on invoices, credit-notes, vendor-credits, retainer-invoices, tasks but NOT on sales-orders and partial coverage on contacts. Include them?" Default: yes (auto-include with a `coverage.json` reason `family-consistency-inferred` and `confidence: medium`).
2. **Naming canonicalisation**: in the parser, status-mutation endpoints (`POST /<r>/:id/status/<state>`) ALWAYS map to action `mark-<state>`. No exceptions. Apply uniformly across resources within one CLI. Add a smoke test: every generated `commands/<r>.mjs` that has a status-path endpoint uses the `mark-` prefix consistently.
3. Validation gate: warn (not fail) when sibling resources have asymmetric sub-action coverage.

**Where**: `references/scaffold-pipeline.md` (parse phase — add family-consistency step), the LLM substitute phase (canonical naming rule), `lib/validate.mjs` (the warning), conventions.md (document the rule).

---

## 5. Generated README has no install instructions [MEDIUM]

**Symptom**: The published `codeyogi911/zoho-inventory-clify` README ([fetched 2026-04-26](https://github.com/codeyogi911/zoho-inventory-clify)) had no install or `npm link` steps. A new user cloning the repo for the first time has to figure out the npm-link flow themselves — and the chmod step (#1).

**Root cause**: The README template generated by clify focuses on the API surface, not the project's lifecycle. Setup info is scattered across SKILL.md, .env.example, and the binary's `--help`.

**Fix sketch**: Standardise the generated README to start with:
```markdown
## Install

git clone <repo>
cd <api-name>-cli
npm install
npm link
chmod +x bin/<api-name>-cli.mjs   # (until #1 lands)
<api-name>-cli --version

## Authenticate

# either env vars (recommended for CI / cloud agents):
<env-vars from .env.example>

# or persistent config:
<api-name>-cli login --<scheme-specific-flags>
```

Plus a "Day-to-day" section auto-generated from `coverage.json`'s top 5 resources. `validate.mjs` checks that the generated README has both "Install" and "Authenticate" sections (heading scan).

**Where**: skill phase (README template), `lib/validate.mjs` (heading check), conventions.md.

---

## 6. Stored credentials cache lives at `~/.config/<api>-cli/` and is silent [LOW]

**Symptom**: Even when env-only auth is used, the auto-refresh writes a `credentials.json` to `~/.config/<api>-cli/`. In Fix Coffee's setup we explicitly avoid `<api>-cli login`, but the cache still appears as a side effect. If a previous process refreshed for account A and the next for account B, the old cache can collide (related to #3).

**Root cause**: The `saveCredentials` call in the generated OAuth `auth.mjs` is unconditional after a successful refresh. There's no env-only mode that says "don't persist".

**Fix sketch**:
1. Add env var `<API>_NO_CACHE=1` (or equivalent) that disables disk persistence — the LLM-phase auth file should respect it. Document in the OAuth exemplar's auth.mjs.
2. Bake into `references/conventions.md` § Auth: "if `NO_CACHE` is set, treat the run as stateless — do not read or write `~/.config/`."
3. Cleaner: when env OAuth creds are present, only cache an access token under a subdirectory keyed by hash of the refresh token (e.g. `~/.config/<api>-cli/<sha8(refresh)>.json`), so account switches never collide.

**Where**: OAuth exemplar (#3), conventions.md.

---

## Suggested triage order

1. **#1 (chmod) + #2 (dry-run redaction)** — both small, both shipped to every generated CLI today. Land together as one PR.
2. **#4 (family-consistency coverage)** — biggest impact for downstream (every Zoho CLI user would have hit the missing comment actions). Medium-sized work in the parser; high-value smoke test.
3. **#3 (OAuth exemplar)** — biggest behavioural improvement for OAuth-refresh APIs (Zoho, Google, Notion, GitHub Apps, Slack, Stripe Connect, etc.). Larger work — a full second exemplar — but it removes the "LLM hand-rolls auth" risk for the most common non-trivial auth scheme.
4. **#5 (README template)** — copy/paste from this doc once #1 + #3 land (since the install steps depend on those).
5. **#6 (NO_CACHE)** — only matters in unusual flows; can wait.

## Out of scope (intentionally)

- The 18 endpoints dropped with `user-excluded-step-7` in the published version were user error during consult, not a clify bug. The published one was a partial / opt-out generation. The fresh full-coverage regen worked.
- The `Zoho-oauthtoken` (vs `Bearer`) wire-prefix quirk was correctly handled by clify in the regen — no fix needed there.

## Reference: what we had to patch in `~/Repos/zoho-inventory-cli/`

- `chmod +x bin/zoho-inventory-cli.mjs` (issue #1)
- Added `add-comment` / `list-comments` / `delete-comment` actions to `commands/sales-orders.mjs` and `scripts/gen-resources.mjs` (issue #4)
- Cleared a stale `~/.config/zoho-inventory-cli/credentials.json` left over from clify's setup pass (workaround for #3)

That's it — the dry-run-token-leak (#2) and the auth-precedence bug (#3) are still in the generated repo; they only manifested at use-time, not install-time. Worth fixing upstream so future generations don't carry them.
