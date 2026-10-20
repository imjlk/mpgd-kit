---
npm/@mpgd/adapter-capacitor: patch (Fixed)
---

The Capacitor notifications provider no longer treats a swipe-dismiss as an open, waits for Android notification channels before `register()` returns a token, omits `advertising` from Android remote purposes until an FCM message can carry the opt-out action, confirms an iOS local reminder is pending before answering `scheduled`, and drops already-fired Android one-shots from `listLocal`. A settings change that the last permission read missed is corrected on the next token. iOS provisional or ephemeral authorization, when a shell reports it, stays promptable, and Android notifications turned off in settings read as blocked.
