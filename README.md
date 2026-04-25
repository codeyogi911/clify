<h1 align="center">clify</h1>

<p align="center">
  <strong>Paste a URL. Get a tested, A+ grade CLI.</strong>
</p>

<p align="center">
  A Claude Code plugin that generates Node.js CLIs from API documentation by copying a hand-crafted exemplar, mechanically substituting API-specific content, and verifying with a deterministic validation gate. Inspired by <a href="https://github.com/google/agents-cli">google/agents-cli</a>.
</p>

<p align="center">
  <a href="https://github.com/codeyogi911/clify/blob/main/LICENSE"><img src="https://img.shields.io/github/license/codeyogi911/clify?style=flat" alt="License"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Claude_Code-plugin-blueviolet?style=flat" alt="Claude Code plugin"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat" alt="Node 20+">
</p>

---

## Why

MCPs are heavy; CLIs are the natural fit for agents. clify produces CLIs that are:

- **Tested by default.** Every generated repo ships with smoke + integration tests and CI on Node 20 & 22.
- **Verifiable.** A deterministic validation gate (`clify validate`) checks 8 categories — manifest consistency, coverage bookkeeping, structural reachability, declared nuances, secrets, CI, and tests.
- **Reproducible.** The deterministic phases (copy + rename + validate) are pure JS — same pass/fail for any agent.
- **Honest.** Endpoints that get dropped require an explicit reason in `coverage.json`. No silent omissions.

## Architecture

clify is **a binary + skills**, on the same model as `google/agents-cli`:

| Layer | What it does | What runs it |
|---|---|---|
| **Skills** | Fetch docs, parse free-form HTML/Markdown, consult the user on tradeoffs, rewrite per-API content. | LLM (Claude/Codex) |
| **`bin/clify.mjs`** | `clify validate <dir>` — full validation gate. `clify scaffold-init <api-name>` — copy exemplar + rename. `clify sync-check <dir>` — re-fetch docs, hash diff. | Pure JS, no LLM |

Anything verifiable by code goes in the binary. Anything requiring judgment stays in skills. The binary is what makes verification reproducible across agent vendors.

## Install

In a Claude Code session:

```
/plugin install codeyogi911/clify
```

Or clone and link:

```
git clone https://github.com/codeyogi911/clify
cd clify
npm install
npm link  # makes `clify` available as a CLI
```

## Use

Inside Claude Code:

```
/clify-scaffold https://docs.example.com/api
```

The skill walks the 13-step pipeline (fetch → parse → consult → **ask where to put it** → init → substitute → validate → simplify → report). The generated CLI is **its own project**, in its own directory, with its own `git init` — by default a sibling of your current directory, but the skill asks before creating files. Output is `<chosen-parent>/<api-name>-cli/`, never nested inside the calling repo unless you explicitly ask for that.

You can also call the binary verbs directly:

```
clify validate ./my-api-cli              # check a generated repo
clify scaffold-init demo-api --target .  # copy exemplar + rename only
clify sync-check ./my-api-cli            # detect upstream doc drift
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

The exemplar at [`examples/jsonplaceholder-cli/`](examples/jsonplaceholder-cli/) is the canonical A+ implementation. Run the gate against it:

```
node bin/clify.mjs validate examples/jsonplaceholder-cli
```

## Testing

```
npm test                  # clify unit tests + deliberate-break tests
npm run validate-exemplar # run the gate against the bundled exemplar
```

The clify CI workflow (`.github/workflows/test.yml`) runs both, plus the exemplar's own test suite, on Node 20 and 22.

## Repo layout

```
clify/
├── bin/clify.mjs                 top-level binary (verbs)
├── lib/
│   ├── validate.mjs              validation gate impl
│   ├── scaffold-init.mjs         file-copy + rename
│   └── sync-check.mjs            hash-diff
├── skills/
│   ├── clify-scaffold/SKILL.md   the 13-step generation pipeline
│   ├── clify-validate/SKILL.md   wraps `clify validate`
│   └── clify-sync/SKILL.md       wraps `clify sync-check` + regeneration
├── examples/jsonplaceholder-cli/ canonical A+ exemplar
├── references/
│   ├── conventions.md            contracts every generated CLI honors
│   └── validation-gate.md        every check the gate enforces
├── test/clify.test.mjs           unit + deliberate-break tests
└── .github/workflows/test.yml    CI (Node 20, 22)
```

## License

MIT — see [LICENSE](LICENSE).
