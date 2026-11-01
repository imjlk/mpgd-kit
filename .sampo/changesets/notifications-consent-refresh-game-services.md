---
npm/@mpgd/game-services: minor (Changed)
---

The notifications service follows the deployment's consent refresh policy (RFC "Consent refresh"). Under the Korean rules advertising to a player whose advertising re-confirmation is past its `dueBy` unrecorded now answers `suppressed: reconfirmation-overdue` until the game records the notice (`recordNoticeShown`) or the player consents anew, and an overdue night re-confirmation holds night-time advertising only; other sends are unaffected. A deployment outside `kr` that sets `consentRefresh` gets its re-confirmations listed, recorded, pushed from `pushLeadDays` (never without it), and paused by the same rules, without the result notices only the Korean rules require. An advertising check reads the player's notices given only when a re-confirmation could be overdue, once per invocation. Outside `kr`, a refresh's `notices.copy` needs only the `reconfirmation.*` texts.
