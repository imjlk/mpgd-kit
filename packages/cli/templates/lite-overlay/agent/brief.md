# __GAME_TITLE__ Brief

Build a Canvas2D game using `@mpgd/lite-shell` and the mpgd platform boundary.
Read `AGENTS.md`, the agent manifest, and the `use-mpgd-kit` router before editing.

- Deterministic rules and state belong in `src/game/state.ts`.
- Rendering and input belong in `src/lite/tapGame.ts`; mounting belongs in `src/runtime/createGame.ts`.
- Use `PlatformGateway` for identity, storage, commerce, ads, lifecycle, and host presentation.
- Keep SDK calls in adapters or target wrappers and use backend ledger APIs before durable grants.
- Create one `createGamePlatformRuntime` during bootstrap. Bind audio through `bindGameAudio` with the game-owned execution scope.
- Keep recovery above renderer lifetimes; reconcile existing operations on startup and resume without opening SDK UI.
- Rewarded v2 needs an application-owned durable encrypted journal. An in-memory store is not recovery evidence.
- Reserve safe-area geometry once and preserve feed scrolling and browser touch gestures.
- Set `VITE_MPGD_IDENTITY_URL` to the guest identity Worker: `src/platform/guestIdentity.ts` signs in a server-issued guest during bootstrap and calls `setStarterServerSession` with `createGuestServerSession`, and store purchases bind to that server player. A game with its own identity service calls `setStarterServerSession` before the game services are created instead. In a game created with `--providers notifications`, `VITE_MPGD_DEV_NOTIFICATION_SESSION` on the Vite dev server in the `development` mode is a local-only development session for notifications (`src/platform/developmentServerSession.ts`); it never reaches a build, commerce, or a deployed Worker.

Run `pnpm dev`, `pnpm check`, `pnpm build`, and `pnpm accept`.
Devvit inline and expanded entries both use the lite renderer. Keep optional engines behind explicit dynamic import boundaries and verify the inline budget.
Production commerce and ads remain unavailable until authenticated backend, issued IDs, durable stores, and real-platform acceptance are configured.
