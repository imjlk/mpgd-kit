# Lite Starter Brief

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

Run `pnpm dev`, `pnpm check`, `pnpm build`, and `pnpm accept`.
Devvit inline and expanded entries both use the lite renderer. Keep optional engines behind explicit dynamic import boundaries and verify the inline budget.
Production commerce and ads remain unavailable until authenticated backend, issued IDs, durable stores, and real-platform acceptance are configured.
