---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

Account deletion in generated games and on their legal site.

- The Phaser lobby and the lite template show "Delete account" while a server-backed session is signed in (App Store guideline 5.1.1(v), Google Play's account deletion requirement). The first tap explains in English and Korean what is erased and what is kept (purchase records for five years, without the player id) and that purchases are not refunded; only "Delete permanently" deletes. The device then forgets the guest session's secure credentials and the purchase journal (kept when the deletion is only inferred from a refused session after a lost answer), runs steps registered with `onStarterAccountDeleted` (the notifications overlay unregisters its runtime there), and reloads the game (`src/platform/deleteAccount.ts`).
- `mpgd legal build` and `check` build an optional `legal/delete-account.html` into `/delete-account/`, print where to enter its URL in Play Console (Data safety), warn while it is missing or has `[REPLACE: …]` markers, and treat an output left without its source as stale. The starter ships the page, and its privacy policy, support, and terms pages link it.
