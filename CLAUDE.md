# clify — repo-level rules for Claude Code / Codex

## Bumping the clify version (rule)

clify carries its version in **four places** that all have to be updated
together. Updating only `package.json` leaves plugin loaders showing the
stale version (Claude reads `.claude-plugin/plugin.json`; Codex reads
`.codex-plugin/plugin.json`; neither reads `package.json` for plugin load):

1. `package.json` — `version` field
2. `.claude-plugin/plugin.json` — `version` field
3. `.claude-plugin/marketplace.json` — `plugins[0].version` field
4. `.codex-plugin/plugin.json` — `version` field

Whenever you bump any of these, bump all four to the same value.

`npm run check-versions` (also chained into `npm test`) cross-checks them
and fails the build on drift; never disable that check.

If a generated CLI you've just scaffolded (e.g. `zoho-inventory-cli`) also
declares a `clifyVersion` pointer in its `.clify.json`, update that too —
the validator's drift check is per-CLI, but the gen-meta script there
hard-codes the version string.

## Plugin reload after a bump

`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` are read by
their respective plugin loaders at plugin load time.
If a user reports "still showing the old version after a push," they need
to refresh the plugin (re-install / `claude plugin reload` / Codex plugin
reload) — the version file alone doesn't auto-refresh.
