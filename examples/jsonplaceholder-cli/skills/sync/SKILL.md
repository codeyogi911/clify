---
name: sync
description: Re-fetch JSONPlaceholder docs, detect upstream drift, and regenerate the CLI's resources/actions if the docs hash has changed. Preserves knowledge/, .env, and .clify.json apiName/docsUrl.
allowed-tools:
  - Bash
  - Read
  - Write
  - WebFetch
---

# JSONPlaceholder CLI Sync Skill

Re-fetch the API docs and detect drift. If the upstream content hash has changed, regenerate the resource registry, integration tests, and SKILL.md while preserving `knowledge/`, `.env`, and the immutable parts of `.clify.json`.

## Triggers

- User says `/sync` or "sync this CLI"
- User asks "is this CLI up to date with the docs?"

## Workflow

1. Read `.clify.json` to get `docsUrl` and `contentHash`.
2. Run `clify sync-check ./` — recomputes the hash and prints diff summary.
3. If hash matches, exit with "no changes".
4. If hash differs:
   - Re-fetch all `crawledUrls`.
   - Re-parse endpoints and re-detect nuances.
   - Regenerate `bin/<api>-cli.mjs`, `test/integration.test.mjs`, `coverage.json`, and the resource sections of SKILL.md.
   - **Do not** touch `knowledge/`, `.env`, or the user-edited parts of `.clify.json` (`apiName`, `docsUrl`).
5. Run `clify validate ./`. If any check fails, surface the failures to the user.
6. Review files in `knowledge/`: any that reference removed endpoints should be flagged for the user.
7. Update `.clify.json` `contentHash` and `generatedAt`.

For JSONPlaceholder specifically, sync is rarely needed — the API has been stable for years.
