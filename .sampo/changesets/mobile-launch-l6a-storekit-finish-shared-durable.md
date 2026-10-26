---
npm/@mpgd/capacitor-storekit: patch (Fixed)
---

`finishTransaction` finishes a durable still unfinished under another `appAccountToken` once this player's grant is journaled, instead of refusing it forever. This happens after a crash between an earlier guest's grant and its finish followed by a reinstall (or with a native build that omits `unfinished`): the restore was shared to the new guest, but its record stayed `finishing` and was retried on every pass. The transaction is finished with its own token, read from the native list, so the native token match is unchanged. Finishing a durable takes nothing from any player: StoreKit keeps it in `Transaction.currentEntitlements`, where the earlier guest's own read still finds it. Consumables of another token, transactions bound to no token, and SKUs the catalog does not declare durable are still never finished.
