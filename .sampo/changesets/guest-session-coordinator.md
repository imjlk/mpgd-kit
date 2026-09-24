---
npm/@mpgd/game-services: minor
---

Add a guest session coordinator that stores refresh tokens only through a
dedicated secure credential port, serializes refresh and logout, rejects
principal changes, and delegates server issuance, revocation, and verified
account binding to an injected authoritative backend.
