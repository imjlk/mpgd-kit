# Production Integration Roadmap

This repo already has the shared contracts, target feature availability, client
orchestration, backend ledger boundary, memory/D1 stores, and Worker starter.
Production integrations should now replace sample evidence with platform-specific
server verification.

The rule stays the same for every target: client SDK callbacks are evidence, not
authority. Purchases, ad rewards, and leaderboard records become game state only
after backend game services accept them.

## Shared Backend Input Shape

Current game-services inputs are intentionally small:

- purchase verification: target, player id, logical product id, platform
  transaction/token id, idempotency key, purchased timestamp
- rewarded ad claim: target, player id, logical placement id, optional platform
  impression id, idempotency key, completed timestamp
- leaderboard record: target, player id, leaderboard id, score, run id,
  submitted timestamp, optional platform submission id

These inputs should be extended per platform only where real verification needs
extra evidence such as package name, bundle id, signed transaction data, or SSV
query parameters.

## Google Play Billing

Expected flow:

1. Android adapter returns purchase token, product id, transaction/order id, and
   purchase state evidence.
2. Backend verifies the token with Google Play Developer APIs.
3. Backend checks product id, package name, purchase state, duplicate grants, and
   entitlement eligibility.
4. Backend records the ledger grant with an idempotency key.
5. Backend or trusted native path acknowledges non-consumables and consumes
   consumables after the grant is durable.
6. Client updates save state only after the backend response confirms the grant.

Contract additions to consider:

- `packageName`
- `purchaseToken`
- `orderId`
- `isConsumable`
- acknowledgement/consume result metadata

## StoreKit and App Store

Expected flow:

1. iOS adapter returns signed transaction evidence or transaction id.
2. Backend verifies the transaction through App Store Server API or signed
   transaction validation.
3. Backend checks bundle id, product id, transaction status, revocation/refund
   state, duplicate grants, and entitlement eligibility.
4. Backend records the ledger grant.
5. Client updates save state only after the backend accepts the grant.

Contract additions to consider:

- `bundleId`
- `signedTransactionInfo`
- `originalTransactionId`
- `environment`
- refund/revocation metadata

## AdMob Rewarded Ads

Expected flow:

1. Client shows rewarded ad and receives SDK completion evidence.
2. AdMob SSV callback reaches backend with placement/ad unit evidence and custom
   data that binds player, placement, run, and idempotency.
3. Backend verifies callback signature and replay protection.
4. Backend records the reward ledger entry.
5. Client polls, receives push, or submits a claim that resolves only after SSV
   evidence exists.

Contract additions to consider:

- `adUnitId`
- `ssvTransactionId`
- `ssvSignature`
- `ssvKeyId`
- custom data payload

## Apps in Toss

Expected flow:

1. Apps in Toss adapter returns IAP or ad callback evidence from the Toss runtime.
2. Partner backend verifies the Toss callback/order/ad reward state.
3. Backend checks Toss product/placement mapping, player identity, duplicate
   grants, and review-policy constraints.
4. Backend records the ledger entry.
5. Client updates save state only after backend acceptance.

Contract additions to consider:

- Toss app id
- Toss order/payment id
- Toss ad impression/reward id
- partner callback verification metadata

## Leaderboard

Expected flow:

1. Client submits score through platform leaderboard when available.
2. Backend records the score with target, player id, leaderboard id, run id, and
   idempotency.
3. Backend may run anti-cheat checks before accepting the record.
4. Platform submission id, if available, is stored as evidence.

Contract additions to consider:

- signed run summary
- anti-cheat verdict
- platform leaderboard id mapping
- platform submission id

## Suggested Implementation Order

1. Add platform-specific evidence types and golden fixtures.
2. Add verifier interfaces beside the backend ledger services.
3. Implement fake verifier tests for duplicate, pending, refunded, invalid, and
   replayed evidence cases.
4. Implement one real verifier at a time, starting with the release target for
   the first production game.
5. Add docs for required environment variables, platform console setup, and
   failure recovery.
