# exemplar-cli

A hand-crafted, fictional CLI used as the **stencil** for the [clify](https://github.com/codeyogi911/clify) scaffolder.

`exemplar-cli` is structurally inspired by [google/agents-cli](https://github.com/google/agents-cli):

- Hierarchical subcommands (`<resource> <action>`).
- One file per resource under `commands/`.
- Shared HTTP, auth, output, and config layers under `lib/`.
- A first-class `login` command with `--status`.
- One umbrella agent skill under `skills/<cli>/` with `references/` (auth, resources, bundled `knowledge/` copy).
- Fully tested against an in-repo mock server — no network needed for `npm test`.

The "Exemplar API" is fictional. The clify scaffolder copies this whole tree, mechanically renames `exemplar` / `EXEMPLAR` / `Exemplar` to the target API's name, and an LLM substitutes the resource registry, knowledge files, and tests to match.

## Install

```
git clone <this-repo>
cd exemplar-cli
npm install
npm link               # exposes `exemplar-cli` on your PATH
exemplar-cli --version
```

No npm dependencies — the install step exists only to register the bin via `npm link`. After that, `exemplar-cli --help` should print the resource list.

## Authenticate

The CLI accepts credentials from environment variables (preferred for CI / cloud agents) **or** a persistent config file.

### Env vars (recommended)

For static-bearer / api-key / basic schemes:

```
export EXEMPLAR_API_KEY=<your-token>
exemplar-cli items list
```

For the `oauth-refresh` scheme (the CLI mints a short-lived access token from the refresh creds, caches it, and re-mints on expiry):

```
export EXEMPLAR_REFRESH_TOKEN=<your-refresh-token>
export EXEMPLAR_CLIENT_ID=<your-client-id>
export EXEMPLAR_CLIENT_SECRET=<your-client-secret>
# Optional: skip on-disk cache (account-switching / ephemeral CI):
# export EXEMPLAR_NO_CACHE=1
exemplar-cli items list
```

### Persistent config

Static schemes:

```
exemplar-cli login --token <your-token>
```

OAuth-refresh:

```
exemplar-cli login \
  --refresh-token <r> \
  --client-id <id> \
  --client-secret <s>
```

Either form persists to `~/.config/exemplar-cli/credentials.json` (mode 0600). Run `exemplar-cli login --status` to see which source is active.

See [`.env.example`](./.env.example) for the full annotated env-var list.

## Layout

```
exemplar-cli/
├── bin/exemplar-cli.mjs          thin dispatcher
├── lib/
│   ├── api.mjs                   apiRequest + REST/GraphQL pagination helpers
│   ├── auth.mjs                  pluggable auth (bearer | api-key-header | basic | none | oauth-refresh)
│   ├── config.mjs                ~/.config/exemplar-cli/credentials.json
│   ├── env.mjs                   .env loader
│   ├── args.mjs                  splitGlobal, parseArgs adapters
│   ├── help.mjs                  --help generators
│   └── output.mjs                output, errorOut
├── commands/
│   ├── items.mjs                 list/get/create/update/delete (+ idempotency, if-match)
│   ├── item-variants.mjs         sub-resource of items
│   ├── orders.mjs                list/get/create/upload (multipart)
│   └── login.mjs                 token + OAuth-refresh persistence + --status
├── skills/exemplar-cli/          umbrella SKILL + references/
├── scripts/sync-skill-knowledge.mjs   copies repo knowledge/ → skill bundle
├── knowledge/                    business rules + patterns (source of truth)
├── test/
│   ├── _helpers.mjs              spawn-CLI helper
│   ├── _mock-server.mjs          zero-dep HTTP mock
│   ├── smoke.test.mjs            structural tests
│   ├── integration.test.mjs      mock-driven CRUD + pagination + multipart
│   ├── graphql.test.mjs          GraphQL request + connection pagination substrate
│   └── auth.test.mjs             bearer + OAuth-refresh wiring + login --status
├── .clify.json                   metadata read by the validator
├── coverage.json                 every endpoint, included or dropped
├── .env.example                  all auth env vars (static + OAuth)
└── .github/workflows/test.yml    Node 20 + 22 CI
```

## Use

```
EXEMPLAR_API_KEY=test exemplar-cli items list --all
exemplar-cli items create --name Widget --sku W-001 --price 9.99 --idempotency-key "$(uuidgen)"
exemplar-cli orders upload --id ord-1 --file ./receipt.pdf
```

`--dry-run` prints the request without sending. Auth headers are redacted by default; pass `--show-secrets` to disable redaction (debug only).

## Test

```
npm test
```

Runs smoke (no network), integration (against `test/_mock-server.mjs`), and auth tests on the current Node version. CI runs the same on Node 20 and 22.

## Why a fictional API

Real APIs come with real quirks, real auth flows, and real onboarding requirements. A stencil tied to one real API would teach the scaffolder that API's idiosyncrasies as universal patterns. By staying fictional, this exemplar keeps the structural lessons (how resources are split into files, how auth is pluggable, how pagination is library-level) free of any API's specific shape.
