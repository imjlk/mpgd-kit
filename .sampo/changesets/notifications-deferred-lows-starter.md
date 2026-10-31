---
npm/@mpgd/cli: patch (Fixed)
---

The notifications starter's Worker backend (`src/platform/notificationBackend.ts`) reports a registry that names a provider for the game's target but lists no entry for it that the game can read. The game-services client now leaves out an entry it cannot read rather than failing the whole registry, so the starter's `loadRegistryEntry` throws for that case: the runtime reports it through `onError` and runs without the comparison until the next start. Before, an entry missing from the list was taken as no entry, without a report. A target the Worker does not serve still loads no entry.
