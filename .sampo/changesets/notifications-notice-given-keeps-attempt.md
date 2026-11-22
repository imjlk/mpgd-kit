---
npm/@mpgd/platform: patch (Changed)
---

A conformance vector, `notice-given-keeps-attempt`, joins the notifications contract that backends run with `@mpgd/platform/notifications-conformance`. A consent notice's push is answered `ambiguous`, and the game then gives the notice in the game: the replay is dropped without a provider call, but the attempt stays counted toward the provider limits until a day after it. The vector checks a rule the RFC already states for kept attempts under the reserved `notice:` prefix, which `@mpgd/game-services/notifications` and the reference backend already follow, so a backend that follows the RFC needs no change. It does not assert how a backend reports the dropped replay. The suite now has 60 vectors.
