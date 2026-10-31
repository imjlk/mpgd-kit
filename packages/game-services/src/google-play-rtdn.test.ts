import assert from 'node:assert/strict';

import { findEntitlementRevocationsChunked } from './commerce-ledger.js';
import { createGooglePlayProductVerificationId } from './google-play-purchase.js';
import {
  createGoogleIdTokenSigningKeys,
  decodeGooglePlayDeveloperNotificationPush,
  googleIdTokenJwksUrl,
  GoogleIdTokenKeysUnavailableError,
  googlePlayDeveloperNotificationHttpStatus,
  handleGooglePlayDeveloperNotification,
  verifyGooglePubSubPushToken,
  type GoogleIdTokenSigningKeys,
} from './google-play-rtdn.js';
import {
  sweepGooglePlayVoidedPurchases,
  type GooglePlayVoidedPurchase,
  type GooglePlayVoidedPurchasesClient,
} from './google-play-store-server.js';
import { createInMemoryGameServicesStore, type GameServicesStore } from './server.js';

const packageName = 'com.example.game';
const audience = 'https://game-services.example.com/google-play/rtdn';
const serviceAccountEmail = 'rtdn-push@example-project.iam.gserviceaccount.com';
const nowMs = Date.parse('2026-10-31T00:00:00.000Z');
const nowSeconds = Math.floor(nowMs / 1000);

const googleKey = await generateSigningKey('google-key-1');
const otherKey = await generateSigningKey('google-key-1');
const keys = fakeKeys({ 'google-key-1': googleKey.publicJwk });

// --- Push token verification ---------------------------------------------------
{
  const goodClaims = {
    iss: 'https://accounts.google.com',
    aud: audience,
    azp: '113774264463038321964',
    sub: '113774264463038321964',
    email: serviceAccountEmail,
    email_verified: true,
    iat: nowSeconds - 60,
    exp: nowSeconds + 3540,
  };
  const verify = (authorization: string | null, overrides: { now?: number } = {}) =>
    verifyGooglePubSubPushToken({
      authorization,
      audience,
      serviceAccountEmail,
      keys,
      signal: new AbortController().signal,
      now: () => overrides.now ?? nowMs,
    });
  const bearer = async (claims: Record<string, unknown>, key = googleKey, header = {}) =>
    `Bearer ${await signJwt(key, claims, header)}`;

  assert.deepEqual(await verify(await bearer(goodClaims)), { status: 'verified' });
  assert.deepEqual(
    await verify(await bearer({ ...goodClaims, iss: 'accounts.google.com' })),
    { status: 'verified' },
    'both Google issuer spellings are accepted',
  );
  assert.deepEqual(
    await verify(await bearer({ ...goodClaims, email: serviceAccountEmail.toUpperCase() })),
    { status: 'verified' },
    'the email compares without case',
  );
  const reasonOf = async (authorization: string | null, now?: number) => {
    const result = await verify(authorization, now === undefined ? {} : { now });
    return result.status === 'rejected' ? result.reason : 'verified';
  };
  assert.equal(await reasonOf(null), 'GOOGLE_PUBSUB_PUSH_TOKEN_MISSING');
  assert.equal(await reasonOf('Basic abc'), 'GOOGLE_PUBSUB_PUSH_TOKEN_MALFORMED');
  assert.equal(await reasonOf('Bearer a.b'), 'GOOGLE_PUBSUB_PUSH_TOKEN_MALFORMED');
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, aud: 'https://elsewhere.example.com' })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_AUDIENCE',
  );
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, iss: 'https://evil.example.com' })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_ISSUER',
  );
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, email: 'someone-else@example.iam.gserviceaccount.com' })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_EMAIL',
    'a token Google minted for another service account is refused',
  );
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, email_verified: false })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_EMAIL_UNVERIFIED',
  );
  assert.equal(
    await reasonOf(await bearer(goodClaims), (goodClaims.exp + 61) * 1000),
    'GOOGLE_PUBSUB_PUSH_TOKEN_EXPIRED',
  );
  assert.equal(
    await reasonOf(await bearer(goodClaims), (goodClaims.exp + 30) * 1000),
    'verified',
    'within the clock skew',
  );
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, iat: nowSeconds + 600 })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_NOT_YET_VALID',
  );
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, exp: undefined })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_EXPIRED',
  );
  assert.equal(
    await reasonOf(await bearer(goodClaims, otherKey)),
    'GOOGLE_PUBSUB_PUSH_TOKEN_SIGNATURE_INVALID',
    'a token signed by another key under the same kid',
  );
  const signed = await signJwt(googleKey, goodClaims);
  const [header, , signature] = signed.split('.');
  const forgedClaims = base64Url(JSON.stringify({ ...goodClaims, email: 'x@example.com' }));
  assert.equal(
    await reasonOf(`Bearer ${header}.${forgedClaims}.${signature}`),
    'GOOGLE_PUBSUB_PUSH_TOKEN_SIGNATURE_INVALID',
    'changed claims break the signature',
  );
  assert.equal(
    await reasonOf(await bearer(goodClaims, googleKey, { kid: 'rotated-away' })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_KEY_UNKNOWN',
  );
  assert.equal(
    await reasonOf(await bearer(goodClaims, googleKey, { alg: 'none' })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_ALGORITHM',
  );
  assert.equal(
    await reasonOf(await bearer(goodClaims, googleKey, { alg: 'HS256' })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_ALGORITHM',
  );
  assert.equal(
    await reasonOf(await bearer(goodClaims, googleKey, { kid: undefined })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_ALGORITHM',
    'a token without a key id',
  );
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, aud: ['https://other.example.com', audience] })),
    'verified',
    'an audience list naming the subscription audience',
  );
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, iat: undefined })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_NOT_YET_VALID',
    'a token without iat',
  );
  assert.equal(
    await reasonOf(await bearer({ ...goodClaims, email: 42 })),
    'GOOGLE_PUBSUB_PUSH_TOKEN_EMAIL',
  );
  await assert.rejects(
    verifyGooglePubSubPushToken({
      authorization: await bearer(goodClaims),
      audience: ' ',
      serviceAccountEmail,
      keys,
      signal: new AbortController().signal,
    }),
    TypeError,
    'an unconfigured audience fails closed',
  );
  await assert.rejects(
    verifyGooglePubSubPushToken({
      authorization: await bearer(goodClaims),
      audience,
      serviceAccountEmail: '',
      keys,
      signal: new AbortController().signal,
    }),
    TypeError,
    'an unconfigured service account fails closed',
  );
  await assert.rejects(
    verifyGooglePubSubPushToken({
      authorization: await bearer(goodClaims),
      audience,
      serviceAccountEmail,
      keys: {
        async getSigningKey() {
          throw new GoogleIdTokenKeysUnavailableError('down');
        },
      },
      signal: new AbortController().signal,
    }),
    GoogleIdTokenKeysUnavailableError,
    'a key outage is not a rejection',
  );
}

// --- Google's key endpoint -----------------------------------------------------
{
  let clock = 0;
  const requests: string[] = [];
  let reply: () => Response = () =>
    Response.json(
      {
        keys: [
          { ...googleKey.publicJwk, kid: 'google-key-1', use: 'sig', alg: 'RS256' },
          { kty: 'EC', kid: 'ec-key', crv: 'P-256', x: 'x', y: 'y' },
        ],
      },
      { headers: { 'cache-control': 'public, max-age=20000, must-revalidate' } },
    );
  const source = createGoogleIdTokenSigningKeys({
    now: () => clock,
    fetch: async (url) => {
      requests.push(String(url));
      return reply();
    },
  });
  const signal = new AbortController().signal;
  assert.equal(
    (await source.getSigningKey({ kid: 'google-key-1', signal }))?.n,
    googleKey.publicJwk.n,
  );
  assert.deepEqual(requests, [googleIdTokenJwksUrl]);
  assert.equal(
    await source.getSigningKey({ kid: 'ec-key', signal }),
    undefined,
    'non-RSA keys are skipped',
  );
  assert.equal(requests.length, 1, 'an unknown kid within a minute of a fetch is not refetched');
  clock = 61_000;
  await source.getSigningKey({ kid: 'rotated-in', signal });
  assert.equal(requests.length, 2, 'an unknown kid refreshes the keys after a minute');
  clock = 61_000 + 19_999_000;
  await source.getSigningKey({ kid: 'google-key-1', signal });
  assert.equal(requests.length, 2, 'cached for max-age');
  clock = 61_000 + 20_001_000;
  reply = () => new Response('unavailable', { status: 503 });
  assert.equal(
    (await source.getSigningKey({ kid: 'google-key-1', signal }))?.n,
    googleKey.publicJwk.n,
    'a key fetched before still verifies during an outage',
  );
  const fetchesAtOutage = requests.length;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      source.getSigningKey({ kid: `forged-${attempt}`, signal }),
      GoogleIdTokenKeysUnavailableError,
      'an unknown kid during an outage is unavailable',
    );
    assert.equal(
      (await source.getSigningKey({ kid: 'google-key-1', signal }))?.n,
      googleKey.publicJwk.n,
    );
  }
  assert.equal(requests.length, fetchesAtOutage, 'a failed fetch is not retried within a minute');
  clock += 60_000;
  reply = () => Response.json({ keys: [{ ...googleKey.publicJwk, kid: 'rotated-in' }] });
  assert.equal(
    (await source.getSigningKey({ kid: 'rotated-in', signal }))?.n,
    googleKey.publicJwk.n,
    'a minute later the keys are fetched again',
  );
  assert.equal(requests.length, fetchesAtOutage + 1);
  const cold = createGoogleIdTokenSigningKeys({
    now: () => clock,
    fetch: async () => {
      requests.push('cold');
      throw new TypeError('network down');
    },
  });
  const coldBefore = requests.length;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      cold.getSigningKey({ kid: 'google-key-1', signal }),
      GoogleIdTokenKeysUnavailableError,
    );
  }
  assert.equal(requests.length, coldBefore + 1, 'nor without any keys held');
  const empty = createGoogleIdTokenSigningKeys({
    fetch: async () => Response.json({ keys: [] }),
  });
  await assert.rejects(
    empty.getSigningKey({ kid: 'any', signal }),
    GoogleIdTokenKeysUnavailableError,
  );
}

// --- Envelope decoding ---------------------------------------------------------
{
  const decoded = decodeGooglePlayDeveloperNotificationPush(
    push({
      version: '1.0',
      packageName,
      eventTimeMillis: '1761868800000',
      testNotification: { version: '1.0' },
    }),
  );
  assert.equal(decoded.status, 'decoded');
  assert.equal(decoded.status === 'decoded' && decoded.messageId, 'message-1');
  assert.equal(
    decoded.status === 'decoded' && decoded.notification.eventTimeMillis,
    1_761_868_800_000,
    'an int64 string is read as a number',
  );
  const epoch = decodeGooglePlayDeveloperNotificationPush(
    push({ packageName, eventTimeMillis: 0, testNotification: {} }),
  );
  assert.equal(
    epoch.status === 'decoded' && epoch.notification.eventTimeMillis,
    undefined,
    'an event time at the epoch is dropped',
  );
  assert.deepEqual(decodeGooglePlayDeveloperNotificationPush({}), {
    status: 'rejected',
    reason: 'GOOGLE_PLAY_RTDN_ENVELOPE_INVALID',
  });
  assert.deepEqual(
    decodeGooglePlayDeveloperNotificationPush({ message: { data: '%%%', messageId: 'm' } }),
    { status: 'rejected', reason: 'GOOGLE_PLAY_RTDN_NOTIFICATION_INVALID', messageId: 'm' },
  );
  assert.deepEqual(
    decodeGooglePlayDeveloperNotificationPush({
      message: { data: btoa('not json'), messageId: 'm' },
    }),
    { status: 'rejected', reason: 'GOOGLE_PLAY_RTDN_NOTIFICATION_INVALID', messageId: 'm' },
  );
  const unwrapped = decodeGooglePlayDeveloperNotificationPush(
    { version: '1.0', packageName, eventTimeMillis: '1761868800000', testNotification: {} },
    { messageId: 'header-id' },
  );
  assert.equal(unwrapped.status, 'decoded', 'an unwrapped push is the notification itself');
  assert.equal(unwrapped.messageId, 'header-id');
  assert.equal(
    decodeGooglePlayDeveloperNotificationPush({ packageName, testNotification: {} }).status,
    'decoded',
    'without the metadata header too',
  );
  assert.equal(
    decodeGooglePlayDeveloperNotificationPush(
      { packageName, testNotification: {} },
      { messageId: 'bad id with spaces' },
    ).messageId,
    undefined,
    'a header that is not a message id is dropped',
  );
  assert.equal(
    decodeGooglePlayDeveloperNotificationPush({ message: 'x', packageName }).status,
    'rejected',
    'a body with a message field is never read as unwrapped',
  );
}

// --- Notifications against the ledger -------------------------------------------
{
  const store = createInMemoryGameServicesStore();
  const grant = await grantToken(store, 'voided-token');
  // The Voided Purchases API as the sweep reads it: entries by token, with
  // the time Google recorded each void (the API filters on that).
  const listed = new Map<string, GooglePlayVoidedPurchase & { readonly recordedAt: number }>();
  const lookups: { startTimeMillis: number; endTimeMillis: number; pageToken?: string }[] = [];
  let apiDown = false;
  let pad = 0;
  const voidedPurchases: GooglePlayVoidedPurchasesClient = {
    async listVoidedPurchases(input) {
      lookups.push({
        startTimeMillis: input.startTimeMillis,
        endTimeMillis: input.endTimeMillis,
        ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
      });
      if (apiDown) {
        throw new Error('Google Play Publisher request failed (HTTP 429).');
      }
      const inWindow = [...listed.values()]
        .filter((entry) =>
          input.startTimeMillis <= entry.recordedAt && entry.recordedAt <= input.endTimeMillis,
        )
        .map(({ recordedAt: _recordedAt, ...entry }) => entry);
      // `pad` other voids fill the first page, so the match is on the second.
      const filler = Array.from({ length: pad }, (_, index) => ({ purchaseToken: `other-${index}` }));
      return input.pageToken === undefined && pad > 0
        ? { voidedPurchases: filler, nextPageToken: 'page-2' }
        : { voidedPurchases: inWindow };
    },
  };
  const list = (purchaseToken: string, extra: Partial<GooglePlayVoidedPurchase> = {}) => {
    listed.set(purchaseToken, {
      purchaseToken,
      orderId: `GPA.${purchaseToken}`,
      voidedTimeMillis: String(nowMs - 60_000),
      voidedSource: 1,
      voidedReason: 7,
      recordedAt: nowMs - 30_000,
      ...extra,
    });
  };
  const handle = (
    notification: Record<string, unknown>,
    options: { readonly now?: number; readonly body?: unknown; readonly messageId?: string } = {},
  ) =>
    handleGooglePlayDeveloperNotification({
      store,
      packageName,
      voidedPurchases,
      body: options.body ?? push({
        version: '1.0',
        packageName,
        eventTimeMillis: String(nowMs - 5_000),
        ...notification,
      }),
      ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
      signal: new AbortController().signal,
      now: () => new Date(options.now ?? nowMs).toISOString(),
    });
  const voided = (purchaseToken: string, extra: Record<string, unknown> = {}) => ({
    voidedPurchaseNotification: {
      purchaseToken,
      orderId: `GPA.${purchaseToken}`,
      productType: 2,
      refundType: 1,
      ...extra,
    },
  });

  // A push alone never revokes: the void must be listed by Google.
  const forged = await handle(voided('voided-token'));
  assert.deepEqual(forged, {
    status: 'retry',
    reason: 'GOOGLE_PLAY_RTDN_VOID_NOT_LISTED',
    messageId: 'message-1',
    orderId: 'GPA.voided-token',
  });
  assert.equal(googlePlayDeveloperNotificationHttpStatus(forged), 503);
  assert.equal((await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId])).length, 0);
  assert.deepEqual(
    lookups.at(-1),
    { startTimeMillis: nowMs - 5_000 - 15 * 60_000, endTimeMillis: nowMs },
    'one lookup in a window around the event time, up to now',
  );
  const notListedLate = await handle(voided('voided-token'), { now: nowMs + 3_600_000 });
  assert.equal(notListedLate.status, 'ignored', 'past the bound a void not listed is acknowledged');

  list('voided-token');
  const revoked = await handle(voided('voided-token'));
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.status === 'revoked' && revoked.alreadyProcessed, false);
  assert.equal(revoked.status === 'revoked' && revoked.orderId, 'GPA.voided-token');
  assert.equal(googlePlayDeveloperNotificationHttpStatus(revoked), 200);
  const [revocation] = await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId]);
  assert.equal(revocation?.reason, 'chargeback', 'the listed voidedReason (7) is kept');
  assert.equal(
    revocation?.revokedAt,
    new Date(nowMs - 60_000).toISOString(),
    'at voidedTimeMillis',
  );
  assert.equal(revocation?.payload.googlePlayVoidedSource, 1);
  assert.equal(revocation?.payload.googlePlayVoidedReason, 7);
  assert.equal(revocation?.payload.googlePlayOrderId, 'GPA.voided-token');

  const again = await handle(voided('voided-token'));
  assert.equal(
    again.status === 'revoked' && again.alreadyProcessed,
    true,
    'a redelivery is idempotent',
  );
  assert.equal(
    again.status === 'revoked' && again.ledgerEntryId,
    revoked.status === 'revoked' && revoked.ledgerEntryId,
  );

  // The sweep reads the same void later: the RTDN entry answers it.
  const sweep = await sweepGooglePlayVoidedPurchases({
    client: voidedPurchases,
    store,
    packageName,
    startTimeMillis: nowMs - 3_600_000,
    endTimeMillis: nowMs,
    signal: new AbortController().signal,
    now: () => new Date(nowMs).toISOString(),
  });
  assert.equal(sweep.revoked, 0);
  assert.equal(sweep.alreadyProcessed, 1, 'a sweep after the RTDN is a no-op');
  const [afterSweep, ...extra] = await findEntitlementRevocationsChunked(store, [
    grant.ledgerEntryId,
  ]);
  assert.equal(extra.length, 0);
  assert.deepEqual(afterSweep, revocation, 'the entry is the one the sweep would have written');

  // A lookup failure (quota, outage) is redelivered, never revoked unconfirmed.
  apiDown = true;
  const down = await handle(voided('voided-token'));
  assert.equal(down.status, 'retry');
  assert.equal(down.status === 'retry' && down.reason, 'GOOGLE_PLAY_RTDN_VOIDED_LOOKUP_FAILED');
  apiDown = false;

  // Listed, but the grant is not on this ledger yet: redelivered for an hour.
  list('not-granted-yet');
  const unknown = await handle(voided('not-granted-yet'));
  assert.equal(unknown.status, 'retry');
  assert.equal(unknown.status === 'retry' && unknown.reason, 'GOOGLE_PLAY_RTDN_GRANT_NOT_FOUND');
  assert.equal(googlePlayDeveloperNotificationHttpStatus(unknown), 503);
  const late = await handle(voided('not-granted-yet'), { now: nowMs + 3_600_000 });
  assert.equal(late.status, 'ignored', 'then acknowledged');
  const noEventTime = await handle({}, { body: push({ packageName, ...voided('never-listed') }) });
  assert.equal(
    noEventTime.status,
    'ignored',
    'without an event time there is no bound: acknowledge',
  );
  const lateGrant = await grantToken(store, 'not-granted-yet');
  const redelivered = await handle(voided('not-granted-yet'));
  assert.equal(redelivered.status, 'revoked', 'the grant shows up while Pub/Sub redelivers');
  assert.equal(
    (await findEntitlementRevocationsChunked(store, [lateGrant.ledgerEntryId])).length,
    1,
  );

  // A busy window: the match on the second page is found.
  const paged = await grantToken(store, 'paged-token');
  list('paged-token');
  pad = 1000;
  const lookupsBefore = lookups.length;
  assert.equal((await handle(voided('paged-token'))).status, 'revoked');
  assert.equal(lookups.length - lookupsBefore, 2, 'two pages, two queries');
  assert.equal(lookups.at(-1)?.pageToken, 'page-2');
  pad = 0;
  assert.equal((await findEntitlementRevocationsChunked(store, [paged.ledgerEntryId])).length, 1);

  // An unwrapped push (payload unwrapping): the notification is the body.
  const unwrappedGrant = await grantToken(store, 'unwrapped-token');
  list('unwrapped-token');
  const unwrapped = await handle(
    {},
    {
      body: {
        version: '1.0',
        packageName,
        eventTimeMillis: String(nowMs - 5_000),
        ...voided('unwrapped-token'),
      },
      messageId: 'header-message-9',
    },
  );
  assert.equal(unwrapped.status, 'revoked');
  assert.equal(unwrapped.messageId, 'header-message-9', 'the id comes from the header');
  assert.equal(
    (await findEntitlementRevocationsChunked(store, [unwrappedGrant.ledgerEntryId])).length,
    1,
  );

  const reasonOf = async (notification: Record<string, unknown>) => {
    const outcome = await handle(notification);
    assert.equal(googlePlayDeveloperNotificationHttpStatus(outcome), 200, JSON.stringify(outcome));
    return 'reason' in outcome ? outcome.reason : outcome.status;
  };
  const kept = await grantToken(store, 'kept-token');
  list('kept-token');
  const lookupsBeforeIgnored = lookups.length;
  assert.equal(
    await reasonOf(voided('kept-token', { refundType: 2 })),
    'GOOGLE_PLAY_RTDN_PARTIAL_REFUND',
    'a quantity-based partial refund keeps the grant, as the sweep does',
  );
  assert.equal(
    await reasonOf(voided('kept-token', { productType: 1 })),
    'GOOGLE_PLAY_RTDN_SUBSCRIPTION_VOIDED',
  );
  assert.equal(
    await reasonOf(voided('kept-token', { productType: 9 })),
    'GOOGLE_PLAY_RTDN_PRODUCT_TYPE_UNKNOWN',
  );
  assert.equal(
    await reasonOf(voided('kept-token', { refundType: 9 })),
    'GOOGLE_PLAY_RTDN_REFUND_TYPE_UNKNOWN',
  );
  assert.equal(await reasonOf({ testNotification: { version: '1.0' } }), 'GOOGLE_PLAY_RTDN_TEST');
  assert.equal(
    await reasonOf({
      subscriptionNotification: { version: '1.0', notificationType: 4, purchaseToken: 'sub-token' },
    }),
    'GOOGLE_PLAY_RTDN_SUBSCRIPTION',
  );
  assert.equal(
    await reasonOf({
      oneTimeProductNotification: { version: '1.0', notificationType: 1, purchaseToken: 'kept-token', sku: 'coins' },
    }),
    'GOOGLE_PLAY_RTDN_ONE_TIME_PRODUCT',
  );
  assert.equal(
    await reasonOf({ pendingRefundReviewNotification: { purchaseToken: 'kept-token' } }),
    'GOOGLE_PLAY_RTDN_KIND_UNHANDLED',
  );
  assert.equal(
    await reasonOf({ voidedPurchaseNotification: { orderId: 'GPA.no-token', productType: 2 } }),
    'GOOGLE_PLAY_RTDN_PURCHASE_TOKEN_MISSING',
  );
  const foreign = await handle(
    {},
    {
      body: push({ packageName: 'com.other.game', ...voided('kept-token') }),
    },
  );
  assert.deepEqual(foreign, {
    status: 'ignored',
    reason: 'GOOGLE_PLAY_RTDN_PACKAGE_MISMATCH',
    messageId: 'message-1',
  });
  assert.equal(lookups.length, lookupsBeforeIgnored, 'nothing ignored spends API quota');
  assert.equal((await findEntitlementRevocationsChunked(store, [kept.ledgerEntryId])).length, 0);
  const malformed = await handle({}, { body: { message: {} } });
  assert.equal(malformed.status, 'rejected');
  assert.equal(
    googlePlayDeveloperNotificationHttpStatus(malformed),
    200,
    'malformed is acknowledged',
  );
  await assert.rejects(
    handleGooglePlayDeveloperNotification({
      store,
      packageName,
      voidedPurchases,
      body: {},
      signal: new AbortController().signal,
      unmatchedVoidRetryMs: -1,
    }),
    RangeError,
  );

  // The sweep first, the RTDN second: the RTDN answers the sweep's entry.
  listed.delete('kept-token');
  const swept = await grantToken(store, 'swept-token');
  list('swept-token', { voidedReason: 1 });
  const sweptFirst = await sweepGooglePlayVoidedPurchases({
    client: voidedPurchases,
    store,
    packageName,
    startTimeMillis: nowMs - 3_600_000,
    endTimeMillis: nowMs,
    signal: new AbortController().signal,
    now: () => new Date(nowMs).toISOString(),
  });
  assert.equal(sweptFirst.revoked, 1);
  const rtdnSecond = await handle(voided('swept-token'));
  assert.equal(rtdnSecond.status === 'revoked' && rtdnSecond.alreadyProcessed, true);
  assert.equal((await findEntitlementRevocationsChunked(store, [swept.ledgerEntryId])).length, 1);

  // A far-future event time: the lookup window still ends at now.
  const lookupsBeforeFuture = lookups.length;
  await handle(
    {},
    {
      body: push({
        packageName,
        eventTimeMillis: String(nowMs + 86_400_000),
        ...voided('kept-token'),
      }),
    },
  );
  assert.deepEqual(lookups.slice(lookupsBeforeFuture), [
    { startTimeMillis: nowMs - 15 * 60_000, endTimeMillis: nowMs },
  ]);
}

console.log('Google Play RTDN tests passed.');

function push(notification: Record<string, unknown>) {
  return {
    message: {
      attributes: {},
      data: btoa(JSON.stringify(notification)),
      messageId: 'message-1',
      publishTime: '2026-10-31T00:00:00.000Z',
    },
    subscription: 'projects/example-project/subscriptions/play-rtdn',
  };
}

async function grantToken(store: GameServicesStore, purchaseToken: string) {
  return store.recordEntitlementGrant({
    source: 'purchase',
    playerId: 'player-1',
    grantId: 'COINS_100',
    idempotencyKey: `checkout-${purchaseToken}`,
    grantedAt: '2026-10-20T00:00:00.000Z',
    evidenceVerificationId: await createGooglePlayProductVerificationId(packageName, purchaseToken),
    payload: { target: 'android', store: 'google-play' },
  });
}

function fakeKeys(published: Record<string, JsonWebKey>): GoogleIdTokenSigningKeys {
  return {
    async getSigningKey({ kid }) {
      return published[kid];
    },
  };
}

async function generateSigningKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, publicJwk };
}

async function signJwt(
  key: { readonly kid: string; readonly privateKey: CryptoKey },
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const encodedHeader = base64Url(
    JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header }),
  );
  const encodedClaims = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  return `${encodedHeader}.${encodedClaims}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
