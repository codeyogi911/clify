# clify — repo-level rules for Claude Code

## Bumping the clify version (rule)

clify carries its version in **three places** that all have to be updated
together. Updating only `package.json` leaves the Claude plugin loader
showing the stale version (Claude reads `.claude-plugin/plugin.json`, not
`package.json`):

1. `package.json` — `version` field
2. `.claude-plugin/plugin.json` — `version` field
3. `.claude-plugin/marketplace.json` — `plugins[0].version` field

Whenever you bump any of these, bump all three to the same value.

`npm run check-versions` (also chained into `npm test`) cross-checks them
and fails the build on drift; never disable that check.

If a generated CLI you've just scaffolded (e.g. `zoho-inventory-cli`) also
declares a `clifyVersion` pointer in its `.clify.json`, update that too —
the validator's drift check is per-CLI, but the gen-meta script there
hard-codes the version string.

## Plugin reload after a bump

`.claude-plugin/plugin.json` is read by Claude Code at plugin load time.
If a user reports "still showing the old version after a push," they need
to refresh the plugin (re-install / `claude plugin reload`) — the version
file alone doesn't auto-refresh.
