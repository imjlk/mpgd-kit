---
npm/@mpgd/adapter-verse8: minor
---

Commerce v2, PR C2: the Agent8 commerce service writes the server-push ledger
grant the backend lookup reads.

`createVerse8Agent8CommerceService` accepts `ledger?: GameServicesStore`,
`ledgerTarget?` (default `verse8`), and `resolvePlayerId?`. With a ledger,
every `$onItemPurchased` grant is also recorded there through
`createServerPushLedgerGrant` from `@mpgd/game-services` (target `verse8`,
store `verse8`, the purchase id as the platform transaction id, the event's
`quantity` scaling the grant and recorded in the payload, key
`store:verse8:<purchaseId>`, and `ledgerDeploymentTarget` when the backend
binds `verse8` to a deployment target), after the Agent8 user state committed
and idempotently on redelivery, so a verify request carrying
`verse8.agent8-event.v1` evidence answers `granted` once the event ran and
`pending` before it. Without a ledger the service is unchanged.
