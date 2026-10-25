---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

Generated games that start offline can still buy once the network returns. `createStarterGuestSignIn` (`src/platform/guestIdentity.ts`) retries a failed boot sign-in in the background (5 s, 15 s, 1 min, then every 5 min, and at once on the `online` event) and once more before each purchase or Restore Purchases tap. Until it succeeds the run uses session-gated game services (`src/platform/sessionGatedServices.ts`): purchases sign in first and are refused before any store sheet opens when that fails (`failed` with the retryable diagnostic `STARTER_SESSION_REQUIRED`, so the game action coordinator stays usable), rewarded ads stay off, and the purchase, restore, and notification services come up for the server player (never the platform's local placeholder) as soon as a sign-in succeeds. The Restore Purchases control then says it could not reach the game server and stays tappable as a retry (new `needs-connection` outcome), and the no-identity message reads "Restoring purchases needs a game server session".
