# exemplar-cli authentication

Manage credentials for `exemplar-cli`. The Exemplar API uses bearer-token auth.

## Where the token lives

`exemplar-cli` reads its token in this order:

1. `EXEMPLAR_API_KEY` from the environment (or `.env`).
2. The `token` field of `~/.config/exemplar-cli/credentials.json`, written by `exemplar-cli login`.

If neither is set, every command fails with `auth_missing`.

## Login

```
exemplar-cli login --token <value>
```

Stores the token at `~/.config/exemplar-cli/credentials.json` (mode 0600).

```
exemplar-cli login --status --json
```

Reports `{ scheme, envVar, fromEnv, fromConfig, authenticated }` so you can see which source is providing auth.

## Errors and remediation

| Code | HTTP | Likely cause | Action |
|---|---|---|---|
| `auth_missing` | — | No env var set, no stored credentials | Set `EXEMPLAR_API_KEY` or run `login` |
| `auth_invalid` | 401 | Token rejected by server | Reissue from the dashboard, run `login` again |
| `forbidden` | 403 | Token valid but lacks the required scope | Check the dashboard's scope settings |

The CLI does not retry auth errors. If `auth_invalid` is intermittent, the token has likely been rotated and a new one needs to be obtained.

## Anti-patterns

- ❌ Don't paste tokens into source files. The validation gate scans for them.
- ❌ Don't share `~/.config/exemplar-cli/credentials.json` between machines — re-run `login` per machine.
