# clify evals

Eval harness for the clify scaffolder. Each case file describes a real API and a set of expected attributes; the harness grades a candidate generated repo against those expectations.

## Layout

```
evals/
├── cases/                 one .json per real API
│   └── zoho-inventory.json
├── grade.mjs              deterministic graders (file presence, .clify.json fields)
├── run.mjs                harness entry — loads case, runs validate + graders
└── README.md              this file
```

## Run a case

The harness assumes the candidate repo already exists (you've run the scaffolder). Pass its path via `--repo`, or let it default to `./<case-name>-cli/` relative to your cwd.

```
clify eval zoho-inventory                          # default candidate path
clify eval zoho-inventory --repo ../zoho-cli       # explicit candidate
clify eval zoho-inventory --json                   # machine-readable
clify eval zoho-inventory --skip-tests             # skip running candidate's npm test
```

Or directly:

```
node evals/run.mjs zoho-inventory --repo /path/to/zoho-inventory-cli
```

## What the harness checks

1. **Validation gate** — runs `clify validate <candidate>`. Every category must pass. The case file's `expected.must_pass_validation_gate: true` makes this a hard requirement.
2. **Deterministic graders** (`grade.mjs`):
   - `auth_scheme` matches `expected.auth_scheme` (or one of `auth_scheme_fallbacks`).
   - Resource count ≥ `expected.resources_min`.
   - Every `expected.must_include_nuances` is declared in `.clify.json.nuances`.
   - Every `expected.must_have_knowledge_files` exists under `knowledge/`.
3. **Structural similarity** to the exemplar — *placeholder*. Today this returns `null` (skipped). The plan is to score files-present, helper-signatures-match, and modular-skills-layout against the exemplar via an LLM-as-judge sibling session. Until that's wired, the deterministic graders carry the load.

## Adding cases

Create `evals/cases/<name>.json`:

```json
{
  "name": "<name>",
  "url": "<docs URL>",
  "description": "Why this API is interesting as an eval target.",
  "expected": {
    "auth_scheme": "bearer",
    "resources_min": 5,
    "must_include_nuances": ["pagination"],
    "must_have_knowledge_files": [],
    "must_pass_validation_gate": true,
    "structural_similarity_to_exemplar": 0.85
  }
}
```

## Why Zoho Inventory is the inaugural case

It exercises every nuance the scaffolder is supposed to handle:

- **OAuth refresh** — multiple scopes, refresh_token grant against `accounts.zoho.<region>`. Forces the scaffolder to either model OAuth as `bearer` (with refresh in `login.mjs`) or extend the auth schemes.
- **Multi-region routing** — `.com`, `.eu`, `.in`, `.com.au`, `.ca` each have their own accounts host *and* API host. Forces the scaffolder to handle a `<API>_REGION` env var feeding `BASE_URL` resolution.
- **Offset pagination** — `page_context` with `has_more_page`. Different from the cursor pattern the exemplar demonstrates; tests whether the scaffolder generalizes pagination.
- **Multipart uploads** — image attachments on items.
- **Composite resources** — composite items (assemblies that bundle other items).
- **Plan-tier rate limits** — different free/paid limits.

If the scaffolder produces a passing CLI for Zoho Inventory from its docs URL alone, it has demonstrated the agents-cli quality bar.
