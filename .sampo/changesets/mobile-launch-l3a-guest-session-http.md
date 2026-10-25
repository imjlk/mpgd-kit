---
npm/@mpgd/game-services: minor (Added)
---

Guest sessions over HTTP. `createGuestSessionHttpBackend({ baseUrl })` from `@mpgd/game-services/guest-session` is a `GuestSessionBackend` over the routes in `guestIdentityHttpRoutes` (`/identity/v1/guest`, `/identity/v1/refresh`, `/identity/v1/revoke`, `/identity/v1/bind-account`), which the reference identity Worker serves: `https:` only (or `http:` on a local development host), no redirects, a 15-second timeout. A refresh token the identity service refuses for good throws `GuestSessionRejectedError`, and the coordinator now reports it as the new `GUEST_SESSION_REJECTED` code instead of `GUEST_SESSION_BACKEND_FAILED`, so a game can log out and start a new guest instead of retrying a dead token.
