---
npm/@mpgd/game-services: patch (Fixed)
---

The commerce reconciler finishes a consumable the store reports revoked (refunded while it was still unfinished) once the backend has answered for it without a standing grant: its record is `revoked` (the ledger reversed the grant, read through `getPurchaseLedgerStatus`) or `rejected` (the backend refused it, for example `APP_STORE_TRANSACTION_REVOKED`). It calls `finishTransaction` with `revoked: true`, only on a `client`-finish provider that declares `acceptsRevokedFinish`, once per session (a transport failure is asked again after the retry interval). Nothing is granted, re-granted, or verified, and the terminal record is not rewritten. While the grant stands the transaction stays unfinished, as before. A revoked report is now matched only to this player's record of the same transaction, so it no longer reads the account binding or open attempts.
