---
npm/@mpgd/platform: patch (Fixed)
---

The notifications runtime (`@mpgd/platform/notifications-runtime`) asks the backend for the player's consent records once per call: `getPermission`, `requestPermission`, and a `permission-changed` event reuse their own read for the records they then write and, for `getPermission`, for the local reminder sweep, unless the runtime recorded something since. When the host fails a batch `cancelLocal`, the runtime now cancels each key alone, so one reminder the host cannot cancel no longer keeps the others pending; the first key that still fails is thrown. When the backend's records cannot be read during a local reminder sweep, the reminders whose permission the host reports as not granted are still cancelled, and the read's error is thrown after.
