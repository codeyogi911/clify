<h1 align="center">clify</h1>

<p align="center">
  <strong>Paste a URL. Get a tested, A+ grade CLI.</strong>
</p>

<p align="center">
  A Claude Code plugin that generates Node.js CLIs from API documentation by copying a hand-crafted exemplar, mechanically substituting API-specific content, and verifying with a deterministic validation gate. Structurally inspired by <a href="https://github.com/google/agents-cli">google/agents-cli</a>.
</p>

<p align="center">
  <a href="https://github.com/codeyogi911/clify/blob/main/LICENSE"><img src="https://img.shields.io/github/license/codeyogi911/clify?style=flat" alt="License"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Claude_Code-plugin-blueviolet?style=flat" alt="Claude Code plugin"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat" alt="Node 20+">
</p>

---

## Why

MCPs are heavy; CLIs are the natural fit for agents. clify produces CLIs that are:

- **Tested by default.** Every generated repo ships with smoke + integration + auth tests and CI on Node 20 & 22.
- **Verifiable.** A deterministic validation gate (`clify validate`) checks 8 categories — manifest consistency, coverage bookkeeping, structural reachability, declared nuances, secrets, CI, and tests.
- **Reproducible.** The deterministic phases (copy + rename + validate + grade) are pure JS — same pass/fail for any agent.
- **Honest.** Endpoints that get dropped require an explicit reason in `coverage.json`. No silent omissions.

## Architecture

clify is **a binary + one skill**:

| Layer | What it does | What runs it |
|---|---|---|
| **Skill (`clify`)** | Fetch docs, parse free-form HTML/Markdown, consult the user on tradeoffs, rewrite per-API content. | LLM (Claude) |
| **`bin/clify.mjs`** | `validate` — run the gate. `scaffold-init` — copy exemplar + rename. `sync-check` — re-fetch docs, hash diff. `eval` — grade against an `evals/cases/` file. | Pure JS, no LLM |

Anything verifiable by code goes in the binary. Anything requiring judgment stays in the skill. The binary is what makes verification reproducible across agent vendors. The earlier `clify-validate` and `clify-sync` skills are gone — they were thin wrappers around binary verbs an agent can call directly without a SKILL.md to read first.

## Install

In a Claude Code session:

```
/plugin install codeyogi911/clify
```

Then verify the install — `/skills` should list `clify` as available, and the binary should run:

```
clify --help
clify --version            # 0.4.0
```

Or clone and link for local development:

```
git clone https://github.com/codeyogi911/clify
cd clify
npm install
npm link                   # makes `clify` available globally
```

## Use

Inside Claude Code:

```
/clify https://docs.example.com/api
```

The skill walks seven phases (fetch & detect → parse & group → consult → init → substitute → validate & simplify → verify & ship). The generated CLI is **its own project**, in its own directory, with its own `git init` — by default a sibling of your current directory, but the skill asks before creating files. Output is `<chosen-parent>/<api-name>-cli/`, never nested inside the calling repo unless you explicitly ask for that.

You can also call the binary verbs directly:

```
clify validate ./my-api-cli              # check a generated repo
clify scaffold-init demo-api --target .  # copy exemplar + rename only
clify sync-check ./my-api-cli            # detect upstream doc drift
clify eval zoho-inventory --repo ./zoho-inventory-cli
clify --help
```

## What "A+" means

Every check in [`references/validation-gate.md`](references/validation-gate.md) passes:

- `package.json` ↔ `plugin.json` ↔ `marketplace.json` are consistent
- Every endpoint has `included: true` or `dropped: true` + a reason
- Every resource × action is reachable via `--help`
- Hard-fail nuances (pagination, idempotency, multipart, deprecated) have artifacts
- No real-shaped secrets in source
- CI runs `npm test` on Node 20 + 22
- `npm test` exits 0

The exemplar at [`examples/exemplar-cli/`](examples/exemplar-cli/) is the canonical A+ implementation — a fictional API designed to exercise every nuance the scaffolder must handle. Run the gate against it:

```
node bin/clify.mjs validate examples/exemplar-cli
```

## Evals

`evals/` holds graded test cases. Each case file describes a real API and the attributes the scaffolder must produce:

```
clify eval zoho-inventory --repo ./zoho-inventory-cli
```

The harness runs the validation gate plus deterministic graders (auth scheme, resource count, declared nuances, knowledge files). The LLM-as-judge structural similarity score is a placeholder — wired in a follow-up. See [`evals/README.md`](evals/README.md).

## Testing

```
npm test                  # clify unit + deliberate-break tests
npm run test:exemplar     # the exemplar's own smoke + integration + auth tests
npm run validate-exemplar # run the gate against the bundled exemplar
```

The clify CI workflow (`.github/workflows/test.yml`) runs both on Node 20 and 22.

## Repo layout

```
clify/
├── bin/clify.mjs                       top-level binary (verbs)
├── lib/
│   ├── validate.mjs                    validation gate impl
│   ├── scaffold-init.mjs               file-copy + rename
│   └── sync-check.mjs                  hash-diff
├── skills/clify/SKILL.md               the 7-phase generation pipeline (lean)
├── examples/
│   ├── exemplar-cli/                   canonical A+ stencil
│   └── legacy/jsonplaceholder-cli/     reference: simple-API single-skill shape
├── evals/
│   ├── cases/                          one .json per real API
│   ├── grade.mjs                       deterministic graders
│   └── run.mjs                         eval harness
├── references/
│   ├── conventions.md                  contracts every generated CLI honors
│   ├── validation-gate.md              every check the gate enforces
│   └── scaffold-pipeline.md            per-phase detail (loaded on demand)
├── test/clify.test.mjs                 unit + deliberate-break tests
└── .github/workflows/test.yml          CI (Node 20, 22)
```

## License

MIT — see [LICENSE](LICENSE).
