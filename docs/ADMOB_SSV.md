# AdMob Server-Side Verification

`@mpgd/game-services/admob-ssv` provides an AdMob rewarded-ad server-side
verification boundary for Android and iOS backends. It verifies the ordered
query bytes after the same percent-decoding used by Google's official verifier,
binds the signed user, ad unit, logical placement, idempotency key, reward, and
timestamp to the pending claim, and emits a stable authority identity from
AdMob's `transaction_id`.

The verifier does not grant rewards. Its verified decision is passed to
`createGameServicesBackend()`, which records the catalog-owned reward through
the entitlement ledger and rejects reuse of an SSV transaction. Client SDK
reward callbacks remain evidence or UI signals only.

Google's current protocol requires `signature` and `key_id` to remain the final
parameters. The verification content is the ordered pre-signature query after
URI percent escapes are decoded exactly once; it must not be sorted or otherwise
rewritten. Public keys rotate and should not be cached for longer than 24
hours. Keep the
[official SSV guide](https://developers.google.com/admob/android/ssv) and
[AdMob verifier key feed](https://www.gstatic.com/admob/reward/verifier-keys.json)
as the protocol sources of truth.

## Backend wiring

The private `apps/game-services-worker` starter now has an opt-in D1-backed
receiver at `GET /admob/ssv/android` and `GET /admob/ssv/ios`. Configure
`MPGD_STORE=d1`, bind `DB`, apply migrations through
`0005_admob_ssv_callbacks.sql`, and set the matching
`MPGD_ADMOB_SSV_ANDROID_AD_UNIT` or `MPGD_ADMOB_SSV_IOS_AD_UNIT` to the signed
callback's ad-unit ID. Configure that HTTPS URL in the corresponding AdMob
rewarded-ad unit. The receiver fetches Google's current public key, uses the
existing verifier, and writes only verified callbacks. A repeated identical
callback returns success; a different transaction for the same pending
operation or the same transaction for another operation is rejected. A claim
before the callback remains pending, while later claims read the D1 record and
the public key captured with it. A temporary key-feed or D1 failure returns a
non-success response so the callback is not acknowledged as durable.
The accepted backend-owned ad-unit ID is stored with the verified callback,
so changing the configured ad unit does not orphan an already pending claim.
An existing target-specific verifier can still handle purchases; AdMob SSV
handles only rewarded-ad evidence for a configured target.
The Worker caps callback URLs at 8 KiB and signed identity fields at 256
characters. It caches the public Google key feed for five minutes per Worker
isolate; stored callbacks retain the exact key used at intake. The game
operator must schedule D1 retention cleanup after the claim window, for example
deleting rows with `received_at` older than 48 hours. This starter does not
silently purge unresolved callbacks or claim they were granted.

The Worker starter's sample placement and reward are not game production
configuration. Replace them with the game's reviewed catalog, authenticated
claim boundary, and real ad-unit values before enabling this route. Automated
tests use generated signatures and a mock key feed; they do not establish an
actual AdMob callback, device ad completion, or store-ready monetization.

For a different backend, provide two backend-owned ports:

- `AdMobSsvCallbackSource` returns the original HTTPS callback URL previously
  received from Google. Store the raw URL without parsing, sorting, decoding,
  or re-encoding its query string. Index it by an authenticated pending claim,
  not by arbitrary client input.
- `AdMobSsvPublicKeySource` returns the `AdMobSsvPublicKey` matching the
  callback's numeric `key_id`. Fetch and cache the official key feed in backend
  infrastructure, refresh it within Google's 24-hour limit, and import each
  base64 SPKI value with `importAdMobSsvPublicKey()`. The importer detects NIST
  Web Crypto keys and secp256k1 entries carried by Google's documented feed
  format.

Neither port embeds credentials or a deployment-specific endpoint in the kit:

```ts
import {
  createAdMobSsvEvidenceVerifier,
  importAdMobSsvPublicKey,
} from '@mpgd/game-services/admob-ssv';
import { createGameServicesBackend } from '@mpgd/game-services/server';

const evidenceVerifier = createAdMobSsvEvidenceVerifier({
  callbackSource: {
    async findCallback({ request, signal }) {
      return callbackRepository.findRawCallback({
        playerId: request.playerId,
        placementId: request.placementId,
        idempotencyKey: request.idempotencyKey,
        signal,
      });
    },
  },
  publicKeySource: {
    async getPublicKey({ keyId, signal }) {
      const base64Spki = await admobKeyCache.findBase64Spki({ keyId, signal });
      return base64Spki === undefined
        ? undefined
        : importAdMobSsvPublicKey(base64Spki);
    },
  },
});

const backend = createGameServicesBackend({
  catalog,
  placements,
  store,
  evidenceVerifier,
});
```

Before showing the rewarded ad, set both the authenticated player identifier
and custom data on the SDK's server-side verification options. Build custom data
with `encodeAdMobSsvCustomData()` using the same `playerId`, logical
`placementId`, and backend claim `idempotencyKey`. The callback is rejected if
any signed binding differs from the claim.

For a Capacitor 8 game, the opt-in
[`@mpgd/adapter-capacitor/admob` provider](../adapters/capacitor/README.md#opt-in-admob-rewarded-ads)
performs this binding during a fresh per-operation ad load. SDK reward and
dismissal callbacks do not grant currency locally; they only let the
game-services client request server verification. AdMob test ads do not send
real SSV callbacks, so their mock results must remain separate from live
callback and ledger evidence.

Catalog placement IDs normally use the SDK load form
`ca-app-pub-.../<ad-unit>`, while the signed callback contains the trailing
AdMob ad-unit identifier. The default verifier resolves that trailing segment.
Provide `resolveAdUnit` when a deployment uses another stable mapping; do not
accept the callback's value without comparing it to backend-owned config.

By default, `reward_item` maps to the catalog reward type, or to the catalog
currency name for currency rewards. If the AdMob console uses another stable
item name, provide `resolveRewardItem`; never select the catalog grant from the
callback's amount or item.

Callbacks older than 24 hours or more than five minutes in the future fail
closed by default. These bounds can be tightened for a deployment. Missing
callbacks remain pending so a client can retry after Google's server-to-server
delivery arrives. Invalid callbacks, keys, signatures, identities, rewards,
timestamps, and replayed transaction identities never reach a new ledger grant.

## Conformance

Run the deterministic ECDSA and ledger fixture in any backend runtime that
provides Web Crypto:

```sh
pnpm smoke:admob-ssv-conformance
```

The fixture covers a valid grant, delayed callback, decoded query behavior,
P-256 and secp256k1 keys, tampered signatures, unknown keys, signed identity
mismatch, timestamp boundaries, and a signed transaction replay under a
different claim. It contains only public test keys and fixed signed callbacks;
no private key, credential, or production identifier is included.
