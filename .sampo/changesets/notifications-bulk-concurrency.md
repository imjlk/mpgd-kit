---
npm/@mpgd/game-services: minor (Added)
---

`deliverBulk` takes a `concurrency` option (8 by default): the recipients of a batch whose ledger and gate work runs at once, for a host whose store batches the calls made side by side (the game-services Worker on D1). Single provider calls stay at most 8 at a time, and each runs the gate again as it starts: a recipient whose gate inputs grew older than 30 seconds while it waited answers `not-sent` and is replayed later. The call's time budget (`budgetMs`) now also stops a further round of a player's device rows: the devices left stay queued, and the scheduler sends them.
