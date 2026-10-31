---
npm/@mpgd/platform: minor (Added)
---

The notifications policy gate takes the copy a server-side resolver chose for a recipient (`resolvedCopy`, a `NotificationResolvedCopy`). Where the content comes from copy (neither a mapping's own title and body nor a host template, as the new `notificationContentSource` reports), `{ copy }` is rendered as catalog copy is, placeholders and the Korean advertising rendering included, and `{}` answers the new `unavailable: copy-missing` reason (gate step 9), so a send is never made with empty text. Without `resolvedCopy` the gate behaves as before. `notificationNoticeTextIssues` checks one notice text by the `notices.copy` rules. The conformance vector schema lists `copy-missing`; a consumer that validates delivery outcomes against a closed reason list should accept it.
