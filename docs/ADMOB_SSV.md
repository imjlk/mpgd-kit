# AdMob Server-Side Verification

`@mpgd/game-services/admob-ssv` provides a Web Crypto based AdMob rewarded-ad
server-side verification boundary for Android and iOS backends. It verifies the
raw callback signature before decoding fields, binds the signed user, ad unit,
logical placement, idempotency key, reward, and timestamp to the pending claim,
and emits a stable authority identity from AdMob's `transaction_id`.

The verifier does not grant rewards. Its verified decision is passed to
`createGameServicesBackend()`, which records the catalog-owned reward through
the entitlement ledger and rejects reuse of an SSV transaction. Client SDK
reward callbacks remain evidence or UI signals only.

Google's current protocol requires the original ordered query content to remain
unchanged, with `signature` and `key_id` as the final parameters. Public keys
rotate and should not be cached for longer than 24 hours. Keep the
[official SSV guide](https://developers.google.com/admob/android/ssv) and
[AdMob verifier key feed](https://www.gstatic.com/admob/reward/verifier-keys.json)
as the protocol sources of truth.

## Backend wiring

Provide two backend-owned ports:

- `AdMobSsvCallbackSource` returns the original HTTPS callback URL previously
  received from Google. Store the raw URL without parsing, sorting, decoding,
  or re-encoding its query string. Index it by an authenticated pending claim,
  not by arbitrary client input.
- `AdMobSsvPublicKeySource` returns the `CryptoKey` matching the callback's
  numeric `key_id`. Fetch and cache the official key feed in backend
  infrastructure, refresh it within Google's 24-hour limit, and import each
  base64 SPKI value with `importAdMobSsvPublicKey()`.

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

The fixture covers a valid grant, delayed callback, tampered signature, unknown
key, signed identity mismatch, expired callback, and a signed transaction replay
under a different claim. It contains only a public test key and fixed signed
callbacks; no private key, credential, or production identifier is included.
