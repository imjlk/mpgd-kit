---
npm/@mpgd/game-services: minor (Changed)
---

The commerce reconciler finishes a consumable the store reports revoked (refunded while it was still unfinished), with `revoked: true`, only on a `client`-finish provider that declares `acceptsRevokedFinish`, once per session (a transport failure is asked again after the retry interval):
- once this player's record holds the backend's answer for the refund: `revoked` (the ledger reversed the grant, read through `getPurchaseLedgerStatus`; the finish names the reversed grant), or `rejected` with `APP_STORE_TRANSACTION_REVOKED` or `LEDGER_GRANT_REVERSED` (no ledger entry). A refusal for any other reason keeps the transaction unfinished;
- at once, without a verify and without journaling anything, when this player holds no record of it and the store binds it to this player's own account (the reconciler's `accountBinding` must read and match). Verifying it could grant from a signed transaction saved before the refund.

A refusal is reported and not counted as asked, so the next report asks again. A refund notice of a consumable whose record already finished is not noted, and a revoked report is never attached to an open attempt (it may be another purchase in flight, such as an Ask to Buy). Every such finish is reported with a new `revoked-finish` reconciler event. Nothing is granted, re-granted, or verified, and no record is rewritten. While the grant stands the transaction stays unfinished, as before. A revoked report is now matched only to this player's record of the same transaction, so it no longer reads open attempts. `commerceRevokedRejectionReasons` lists the refusals that answer for a refund.

`CommerceReconcilerEvent` gains the `revoked-finish` variant, which carries no `record`: a subscriber that reads `event.record` after excluding only `failure` must also exclude `revoked-finish`.
