---
npm/@mpgd/cli: patch
npm/@mpgd/adapter-devvit: patch
---

Bound per-player cloud-save keys in generated Devvit targets. The `phaser-game` template now ships `apps/target-devvit/src/server/bridge.ts`, mirroring the kit wrapper: `storage.save` tracks each player's distinct keys in a `<game-name>:save-keys:<user>` hash, enforces `maxStorageKeysPerPlayer` inside a WATCH/MULTI/EXEC transaction, and rejects saves past the cap with `DEVVIT_STORAGE_KEY_LIMIT`, so one authenticated Reddit account can no longer exhaust the installation's shared Redis quota.

Detect aborted Devvit Redis transactions correctly. `@devvit/redis` `TxClient.exec()` never resolves `null` for a WATCH conflict; it returns an empty array. The template bridge and the kit wrapper now treat an EXEC result with fewer entries than the queued commands as contention and retry instead of reporting an unwritten save as persisted. `createDevvitRedisPostOperationStore` applies the same rule: in addition to `null`, any EXEC result shorter than the number of queued mutations is retried as contention.
