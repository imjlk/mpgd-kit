---
npm/@mpgd/game-services: patch (Fixed)
---

`createGameServicesNotificationsClient().getProviders()` leaves out a provider entry it cannot read (a malformed one, or one a Worker shaped differently) and returns the others, instead of failing the whole registry with `NOTIFICATIONS_CONFIGURATION_REQUIRED`. A registry that is not `{ protocolVersion, providers, targets }` still fails as a whole. A target whose provider has no entry left finds none, so callers that load a runtime's registry entry should report that case rather than read it as a target the Worker does not serve. Error text built from a thrown value whose getter, `toString`, or `Proxy` trap throws now reads `a failure that cannot be read` instead of throwing.
