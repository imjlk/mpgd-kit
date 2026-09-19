---
npm/@mpgd/phaser-assets: minor
---

Add `delivery.subscribe(listener)` as the single observation surface for
pack delivery: listeners receive prepare and files-delivery read events
with an operation correlation id, per-operation sequencing, observed
phases (planning, downloading, decoding-and-verifying, one terminal of
prepared/completed, failed, cancelled or disposed) and strictly measured
progress — network-delivered body bytes against the manifest's declared
size, and verified entry counts and byte totals. Observation is
containment-safe: throwing or rejecting listeners never change delivery
results, unsubscription is idempotent, terminals fire exactly once per
operation, and late events from superseded operations are dropped.

`PhaserPackDeliveryError` gains an optional additive `details` field
(stage, operationId, pack/asset identity, httpStatus,
decoderStatus/decoderCode, expectedBytes/receivedBytes) captured at the
failing execution point — no message parsing, no URL or response data.
`readCappedDeliveryBody` accepts an optional `onBodyBytes` observation
hook. Existing codes, constructor calls and behavior are unchanged.
