---
npm/@mpgd/adapter-ait: patch
npm/@mpgd/cli: patch
---

Harden the Apps in Toss host bridge: reject game `storage.save`/`storage.load` keys under the adapter-reserved `mpgd:ait:` prefix so game code cannot forge completed purchase or promotion markers, bound the client-supplied rewarded-ad `idempotencyKey` to 1-256 visible characters and document it as evidence the backend reward authority must verify, restrict `fetchAitAuthority` to `https:` resources (plain `http:` only for `localhost`/`127.0.0.1`) while accepting only a string, a URL-like object (string `href`, recognized by shape so a cross-realm `URL` is covered), or a same-realm `Request`, and forwarding only the validated representation to the transport (the resolved `href` string, or the `Request` instance after its `url` validated), and cap launch-intent `puzzleId`/`challengeToken` values and nested `queryParams` size and entry count.

The `@mpgd/cli` `phaser-game` template now selects the self-completing `aitSandbox` gateway only for a non-production build whose `BUILD_ID` is exactly `ait-sandbox` (the value `pnpm dev:ait` sets); every other AIT build, including other debug builds, uses the production `ait` gateway so purchases and rewards cannot be granted without the backend.
