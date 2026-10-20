---
npm/@mpgd/adapter-devvit: patch
---

Harden Devvit notifications v2. History reads use `hGetAll` instead of allowlisted `hMGet`, so a send still plans when that command is disabled. A length or content `enqueue` refusal is `rejected` with reason `configuration` once, instead of an ambiguous replay. Transient Redis errors (the 20-transaction cap, the 5-second timeout, and other transient failures) retry inside the store's attempt budget. A refused opt-in or opt-out re-reads `isOptedIn` and returns the observed state, so a duplicate concurrent call is not a permanent configuration error. `devvitNotificationSessionFromContext` builds the session from the request context; `devvitNotificationSession` remains.
