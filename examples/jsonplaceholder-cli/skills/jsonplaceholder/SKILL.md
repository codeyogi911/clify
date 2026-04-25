---
name: jsonplaceholder
description: Wrap the JSONPlaceholder REST API. Use when the user says "/jsonplaceholder", asks to query posts/comments/albums/photos/todos/users on JSONPlaceholder, or wants to test agent CLI flows against a free, no-auth API.
allowed-tools:
  - Bash
  - Read
  - Write
---

# JSONPlaceholder CLI Skill

Wrap the [JSONPlaceholder](https://jsonplaceholder.typicode.com) REST API via `jsonplaceholder-cli`. JSONPlaceholder is a public, auth-free API used for prototyping and demos — writes (`create`, `update`, `delete`) return successful responses but **do not actually persist**.

**Before running any command, read every file in `knowledge/`.**

## Triggers

- User says `/jsonplaceholder`
- User asks to list/get/create/update/delete posts, comments, albums, photos, todos, or users on JSONPlaceholder
- User wants a quick CLI to demo agent ↔ API flows

## Setup

JSONPlaceholder requires no credentials. The CLI works out of the box. The only optional configuration is `JSONPLACEHOLDER_BASE_URL` (used by integration tests to point at a mock server).

To verify the CLI is working:

```
jsonplaceholder-cli posts list
```

This should return an array of 100 posts.

## Quick Reference

| Resource | Actions | Notes |
|---|---|---|
| `posts` | list, get, create, update, delete | 100 posts, fields: title, body, userId |
| `comments` | list, get, create, update, delete | tied to posts via `postId` |
| `albums` | list, get, create, update, delete | tied to users via `userId` |
| `photos` | list, get, create, update, delete | tied to albums via `albumId` |
| `todos` | list, get, create, update, delete | tied to users via `userId`; has `completed` boolean |
| `users` | list, get, create, update, delete | 10 users |

All actions follow the resource-action pattern. Use `jsonplaceholder-cli <resource> <action> --help` to see flags.

## Global Flags

- `--json` — force JSON output (auto when stdout is piped)
- `--dry-run` — print request without sending
- `--verbose` — print response status & headers to stderr
- `--all` — auto-paginate (no-op here; JSONPlaceholder returns all results in one page)
- `--version`, `-v`
- `--help`, `-h`

## Error Handling

The CLI emits structured JSON errors to stderr with exit code 1.

| Code | Meaning | Retryable |
|---|---|---|
| `validation_error` | Bad input (missing flag, unknown resource, 4xx body) | no |
| `not_found` | Resource id doesn't exist | no |
| `rate_limited` | 429 from upstream (rare for JSONPlaceholder) | yes — honor `retryAfter` |
| `server_error` | 5xx from upstream | yes |
| `network_error` | Connection failed | yes |
| `timeout` | Request exceeded timeout | yes |

The CLI never retries — retry policy lives here in the skill.

## Knowledge System

Read every file in `knowledge/` before issuing commands. Knowledge files capture API quirks, business rules, and patterns learned at runtime. After a non-trivial command sequence, append new findings as `knowledge/<short-topic>.md` with frontmatter `type:` set to `gotcha`, `pattern`, `shortcut`, `quirk`, or `business-rule`.

## Common Workflows

### 1. Get a post and its comments

```
jsonplaceholder-cli posts get --id 1
jsonplaceholder-cli comments list --json | jq '[.[] | select(.postId == 1)]'
```

### 2. Create a post (echo-only — JSONPlaceholder does not persist)

```
jsonplaceholder-cli posts create \
  --title "Hello" \
  --body_text "World" \
  --userId 1
```

The response includes `id: 101` but you cannot fetch it back.

### 3. Smoke-test the CLI itself

```
cd jsonplaceholder-cli && npm test
```

Runs both smoke tests (no network) and integration tests (against the bundled mock server).
