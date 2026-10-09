# Pooled impact feedback

Capability: `feedback.impact.pool`. Kind: presentation.

Use `@mpgd/game-runtime/impact` for validated contacts, authored recipe catalogs
and ordered rule matching without importing Phaser. Use
`@mpgd/game-runtime/phaser/impact` for `PhaserImpactFeedbackPool`.
The renderer takes only contact scalars; damage, rewards and collision authority
remain in the simulation.

```ts
const feedback = new PhaserImpactFeedbackPool(scene, { capacity: 48 });
feedback.emit(contact, recipe);
feedback.update(scene.time.now);
// Shutdown/destroy automatically disposes the pool; destroy() is idempotent.
```

Config: capacity 1–1024 (default 48), maxSparksPerEffect 0–64 (default 6),
optional finite depth and rasterRings with an already registered texture and
recipe-to-frame mappings. Catalogs allow 256 recipes and 1024 rules. Higher
priority wins; authored order breaks ties. Inputs are copied at catalog/pool
construction. Construct once per scene; do not recreate for every contact.

Gotchas: emit and update must use the same nonnegative simulation clock.
Emit after authoritative collision resolution. Full pools recycle the next
slot and completely reset visible state. Sparks share one Graphics batch;
no GameObjects or tweens are created per hit, but Graphics rebuilds its command
buffer each active frame. The caller owns recipes, texture loading and memory
budgets; this helper does not certify device FPS. Frame strips contain 1–64
registered names and run on the effect clock. Scene teardown destroys owned
objects and detaches event listeners. Input devices have no role in this API.

Tests: `src/impact/index.test.ts`, `src/phaser/impact.test.ts`, headless and
packed consumer fixtures. Acceptance: `pnpm --dir packages/game-runtime test`;
visually playtest rings/spark variants with the application's authored recipes.
