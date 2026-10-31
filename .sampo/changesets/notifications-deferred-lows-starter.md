---
npm/@mpgd/cli: patch (Fixed)
---

The notifications starter's Worker backend (`src/platform/notificationBackend.ts`) reports a registry entry for the game's target that the game cannot read. The game-services client now leaves such an entry out of the registry and lists it in `unreadable`; the starter's `loadRegistryEntry` throws for the target's provider when it is listed there (or when an unreadable entry has no id, since it may be the target's), naming the issue. The runtime reports it through `onError` and runs without the comparison until the next start. A target the Worker does not serve, or a provider the registry does not list at all, still loads no entry.
