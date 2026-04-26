---
type: business-rule
source: docs
extracted: 2026-04-26
confidence: high
applies-to: ["posts.create", "posts.update", "posts.delete", "comments.create", "comments.update", "comments.delete", "albums.create", "albums.update", "albums.delete", "photos.create", "photos.update", "photos.delete", "todos.create", "todos.update", "todos.delete", "users.create", "users.update", "users.delete"]
---

JSONPlaceholder is a read-only sandbox. Mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) return successful responses but **do not persist any data on the server**.

Practical consequences:

- A `posts create` returns `id: 101` (always), but `posts get --id 101` will 404.
- Concurrent `create` calls all "succeed" — there is no race condition because nothing is stored.
- Useful for: agent integration tests, CLI demos, prototyping.
- Not useful for: anything that requires read-after-write consistency.

If you need a real persistent backend with the same shape, run JSONPlaceholder locally via `json-server` or use a different demo API.
