import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createGooglePlayProductVerificationId,
  createGooglePlayPublisherClient,
  findEntitlementRevocationsChunked,
  GoogleIdTokenKeysUnavailableError,
  type GoogleIdTokenSigningKeys,
  type GooglePlayVoidedPurchase,
  type GooglePlayVoidedPurchasesClient,
} from '@mpgd/game-services';
import { Miniflare } from 'miniflare';

import { createD1GameServicesStore } from './d1Store.js';
import { createGooglePlayRtdnFetchHandler, googlePlayRtdnPath } from './googlePlayRtdnRoute.js';
import { createWorkerFetchHandler, type GameServicesWorkerEnv } from './handler.js';
import { runScheduledStoreServer } from './storeServerCron.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'google-play-rtdn' },
});

const baseUrl = 'https://game-services-worker.test';
const packageName = 'com.example.game';
const audience = `${baseUrl}${googlePlayRtdnPath}`;
const serviceAccountEmail = 'play-rtdn-push@example-project.iam.gserviceaccount.com';

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  for (const migration of [
    '0001_game_services.sql',
    '0004_entitlement_evidence.sql',
    '0006_entitlement_revocations.sql',
    '0009_store_server.sql',
  ]) {
    await applyMigration(db, migration);
  }
  const store = createD1GameServicesStore(db);
  const signingKey = await generateSigningKey('push-key');
  let keysDown = false;
  const keys: GoogleIdTokenSigningKeys = {
    async getSigningKey({ kid }) {
      if (keysDown) {
        throw new GoogleIdTokenKeysUnavailableError('Google ID token keys returned HTTP 503.');
      }
      return kid === signingKey.kid ? signingKey.publicJwk : undefined;
    },
  };
  const nowMs = Date.now();
  // The Voided Purchases API the sweep and the RTDN route share: what Google
  // lists, by when it recorded each void.
  const listed = new Map<string, GooglePlayVoidedPurchase & { readonly recordedAt: number }>();
  let apiDown = false;
  let lookups = 0;
  const voidedPurchases: GooglePlayVoidedPurchasesClient = {
    async listVoidedPurchases(input) {
      lookups += 1;
      if (apiDown) {
        throw new Error('Google Play Publisher request failed (HTTP 429).');
      }
      return {
        voidedPurchases: [...listed.values()]
          .filter((entry) =>
            input.startTimeMillis <= entry.recordedAt && entry.recordedAt <= input.endTimeMillis,
          )
          .map(({ recordedAt: _recordedAt, ...entry }) => entry),
      };
    },
  };
  const list = (purchaseToken: string, voidedReason = 1) => {
    listed.set(purchaseToken, {
      purchaseToken,
      orderId: `GPA.${purchaseToken}`,
      voidedTimeMillis: String(nowMs - 1_500),
      voidedSource: 0,
      voidedReason,
      recordedAt: nowMs - 1_000,
    });
  };
  const rtdnFetch = createGooglePlayRtdnFetchHandler({
    store,
    packageName,
    audience,
    serviceAccountEmail,
    keys,
    voidedPurchases,
    now: () => nowMs,
  });
  const token = (claims: Record<string, unknown> = {}) =>
    signJwt(signingKey, {
      iss: 'https://accounts.google.com',
      aud: audience,
      sub: '100000000000000000001',
      email: serviceAccountEmail,
      email_verified: true,
      iat: Math.floor(nowMs / 1000) - 10,
      exp: Math.floor(nowMs / 1000) + 3590,
      ...claims,
    });
  const post = async (
    notification: Record<string, unknown> | string,
    options: {
      readonly authorization?: string | null;
      readonly method?: string;
      /** Payload unwrapping with "write metadata": the notification is the body. */
      readonly unwrappedMessageId?: string;
    } = {},
  ) => {
    const authorization = options.authorization === undefined
      ? `Bearer ${await token()}`
      : options.authorization;
    const developerNotification = typeof notification === 'string'
      ? undefined
      : {
          version: '1.0',
          packageName,
          eventTimeMillis: String(nowMs - 2_000),
          ...notification,
        };
    const body = typeof notification === 'string'
      ? notification
      : options.unwrappedMessageId !== undefined
        ? JSON.stringify(developerNotification)
        : JSON.stringify({
            message: {
              data: btoa(
                JSON.stringify({
                  version: '1.0',
                  packageName,
                  eventTimeMillis: String(nowMs - 2_000),
                  ...notification,
                }),
              ),
              messageId: `message-${Math.random()}`,
              publishTime: new Date(nowMs).toISOString(),
            },
            subscription: 'projects/example-project/subscriptions/play-rtdn',
          });
    const response = await rtdnFetch(
      new Request(`${baseUrl}${googlePlayRtdnPath}`, {
        method: options.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === null ? {} : { authorization }),
          ...(options.unwrappedMessageId === undefined
            ? {}
            : { 'x-goog-pubsub-message-id': options.unwrappedMessageId }),
        },
        ...(options.method === 'GET' ? {} : { body }),
      }),
    );
    assert.ok(response !== undefined, 'the route is mounted');
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const voided = (purchaseToken: string, extra: Record<string, unknown> = {}) => ({
    voidedPurchaseNotification: {
      purchaseToken,
      orderId: 'GPA.claimed-by-push',
      productType: 2,
      refundType: 1,
      ...extra,
    },
  });
  const grantToken = async (purchaseToken: string, playerId = 'play-player') =>
    store.recordEntitlementGrant({
      source: 'purchase',
      playerId,
      grantId: 'COINS_100',
      idempotencyKey: `checkout-${purchaseToken}`,
      grantedAt: new Date(nowMs - 86_400_000).toISOString(),
      evidenceVerificationId: await createGooglePlayProductVerificationId(packageName, purchaseToken),
      payload: { target: 'android', store: 'google-play', googlePlayPackageName: packageName },
    });

  // --- Authentication ---------------------------------------------------------
  const unauthenticated = [
    await post(voided('auth-token'), { authorization: null }),
    await post(voided('auth-token'), { authorization: `Bearer ${await token({ aud: 'https://other.example.com' })}` }),
    await post(voided('auth-token'), { authorization: `Bearer ${await token({ email: 'other@example.iam.gserviceaccount.com' })}` }),
    await post(voided('auth-token'), { authorization: `Bearer ${await token({ iss: 'https://evil.example.com' })}` }),
    await post(voided('auth-token'), { authorization: `Bearer ${await token({ exp: Math.floor(nowMs / 1000) - 600 })}` }),
    await post(voided('auth-token'), { authorization: `Bearer ${(await token()).slice(0, -6)}AAAAAA` }),
  ];
  for (const response of unauthenticated) {
    assert.equal(response.status, 401, 'an unauthenticated push is not acknowledged');
    assert.deepEqual(response.body, { error: 'UNAUTHENTICATED' });
  }
  keysDown = true;
  assert.equal(
    (await post(voided('auth-token'))).status,
    503,
    'a Google key outage is redelivered',
  );
  keysDown = false;
  assert.equal((await post(voided('auth-token'), { method: 'GET' })).status, 405);

  // --- A voided purchase revokes the D1 grant -------------------------------------
  const grant = await grantToken('refunded-token');
  const unconfirmed = await post(voided('refunded-token'));
  assert.equal(unconfirmed.status, 503, 'a push Google does not list yet is redelivered');
  assert.equal(unconfirmed.body.reason, 'GOOGLE_PLAY_RTDN_VOID_NOT_LISTED');
  assert.equal(
    (await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId])).length,
    0,
    'a push alone never revokes',
  );
  apiDown = true;
  const lookupFailed = await post(voided('refunded-token'));
  assert.equal(lookupFailed.status, 503, 'a Voided Purchases API failure is redelivered');
  assert.equal(lookupFailed.body.reason, 'GOOGLE_PLAY_RTDN_VOIDED_LOOKUP_FAILED');
  apiDown = false;
  list('refunded-token', 7);
  const first = await post(voided('refunded-token'));
  assert.equal(first.status, 200, 'a revocation is acknowledged');
  assert.equal(first.body.status, 'revoked');
  assert.equal(first.body.alreadyProcessed, false);
  const revocations = await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId]);
  assert.equal(revocations.length, 1, 'the D1 ledger holds the revoke entry');
  assert.equal(revocations[0]?.reason, 'chargeback', 'the listed voidedReason is recorded');
  assert.equal(revocations[0]?.revokedAt, new Date(nowMs - 1_500).toISOString());
  assert.equal(revocations[0]?.payload.googlePlayOrderId, 'GPA.refunded-token');
  assert.equal(
    first.body.orderId,
    'GPA.refunded-token',
    'the listed order id, not the push\u2019s',
  );
  assert.equal('orderId' in unconfirmed.body, false, 'an unconfirmed push names no order id');
  assert.equal(revocations[0]?.payload.googlePlayVoidedSource, 0);
  const duplicate = await post(voided('refunded-token'));
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.alreadyProcessed, true, 'a duplicate delivery is idempotent');
  assert.equal(duplicate.body.ledgerEntryId, first.body.ledgerEntryId);
  assert.equal((await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId])).length, 1);

  // --- The sweep then reads the same void: a no-op ----------------------------------
  {
    const report = await runScheduledStoreServer(
      { MPGD_STORE: 'd1', DB: db },
      { cron: '* * * * *' },
      {
        googlePlay: {
          packageName,
          voidedPurchases,
          finalizer: {
            async finalizePurchaseGrant() {
              throw new Error('no owed finalization in this test');
            },
          },
        },
        now: () => nowMs,
      },
    );
    assert.equal(report?.sweep?.complete, true);
    assert.equal(report?.sweep?.revoked, 0, 'the sweep revokes nothing new');
    assert.equal(report?.sweep?.alreadyProcessed, 1, 'it finds the RTDN revocation');
    assert.equal((await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId])).length, 1);
  }

  // --- A token the ledger does not know yet is redelivered, within a bound -------------
  list('in-flight-token');
  const unknown = await post(voided('in-flight-token'));
  assert.equal(unknown.status, 503, 'Pub/Sub redelivers while the grant may still be written');
  assert.equal(unknown.body.reason, 'GOOGLE_PLAY_RTDN_GRANT_NOT_FOUND');
  const inFlight = await grantToken('in-flight-token');
  const redelivered = await post(voided('in-flight-token'));
  assert.equal(redelivered.status, 200);
  assert.equal(
    redelivered.body.status,
    'revoked',
    'the redelivery revokes the grant written since',
  );
  assert.equal(
    (await findEntitlementRevocationsChunked(store, [inFlight.ledgerEntryId])).length,
    1,
  );
  const stale = await post({
    eventTimeMillis: String(nowMs - 2 * 3_600_000),
    ...voided('never-granted-token'),
  });
  assert.equal(stale.status, 200, 'a void older than the bound is acknowledged');
  assert.equal(stale.body.status, 'ignored');

  // --- A stuck token service answers 503 at the lookup deadline -------------------------
  {
    const stuckFetch = createGooglePlayRtdnFetchHandler({
      store,
      packageName,
      audience,
      serviceAccountEmail,
      keys,
      // The Worker's composition: the publisher client over a token service
      // binding that never answers (a binding call takes no signal).
      voidedPurchases: createGooglePlayPublisherClient({
        getAccessToken: () => new Promise<string>(() => undefined),
        fetch: async () => {
          throw new Error('no Play request without a token');
        },
      }),
      lookupTimeoutMs: 50,
      now: () => nowMs,
    });
    const started = Date.now();
    const stuck = await stuckFetch(
      new Request(`${baseUrl}${googlePlayRtdnPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
        body: JSON.stringify({
          message: {
            data: btoa(
              JSON.stringify({
                packageName,
                eventTimeMillis: String(nowMs - 2_000),
                ...voided('in-flight-token'),
              }),
            ),
            messageId: 'stuck-1',
          },
        }),
      }),
    );
    assert.equal(stuck?.status, 503, 'a stuck token service is redelivered, not held');
    assert.equal(
      (await stuck?.json() as { reason?: string }).reason,
      'GOOGLE_PLAY_RTDN_VOIDED_LOOKUP_FAILED',
    );
    assert.ok(Date.now() - started < 5_000, 'it answers at the lookup deadline');
  }

  // --- An unwrapped push (payload unwrapping) ------------------------------------------------
  const unwrappedGrant = await grantToken('unwrapped-token');
  list('unwrapped-token');
  const unwrapped = await post(voided('unwrapped-token'), { unwrappedMessageId: '1234567890' });
  assert.equal(unwrapped.status, 200);
  assert.equal(unwrapped.body.status, 'revoked', 'the notification as the body is read');
  assert.equal(unwrapped.body.messageId, '1234567890', 'with the message id header');
  assert.equal(
    (await findEntitlementRevocationsChunked(store, [unwrappedGrant.ledgerEntryId])).length,
    1,
  );

  // --- Everything else is acknowledged ---------------------------------------------------
  const kept = await grantToken('kept-token');
  list('kept-token');
  const lookupsBeforeIgnored = lookups;
  for (const notification of [
    { testNotification: { version: '1.0' } },
    {
      subscriptionNotification: { version: '1.0', notificationType: 3, purchaseToken: 'kept-token' },
    },
    {
      oneTimeProductNotification: {
        version: '1.0',
        notificationType: 2,
        purchaseToken: 'kept-token',
        sku: 'coins',
      },
    },
    voided('kept-token', { productType: 1 }),
    voided('kept-token', { refundType: 2 }),
    { packageName: 'com.other.game', ...voided('kept-token') },
  ]) {
    const response = await post(notification);
    assert.equal(response.status, 200, JSON.stringify(notification));
    assert.equal(response.body.status, 'ignored', JSON.stringify(response.body));
  }
  assert.equal((await findEntitlementRevocationsChunked(store, [kept.ledgerEntryId])).length, 0);
  assert.equal(lookups, lookupsBeforeIgnored, 'acknowledged kinds spend no API quota');
  for (const malformed of ['not json', JSON.stringify({ message: { data: '%%%' } }), '{}']) {
    const response = await post(malformed);
    assert.equal(response.status, 200, 'a malformed push is acknowledged, not redelivered forever');
    assert.equal(response.body.status, 'rejected');
  }
  const oversized = await post(JSON.stringify({ message: { data: 'A'.repeat(70_000) } }));
  assert.equal(oversized.status, 200);
  assert.equal(oversized.body.reason, 'GOOGLE_PLAY_RTDN_BODY_INVALID');

  // --- The Worker mounts the route from its settings ---------------------------------------
  {
    const request = () =>
      new Request(`${baseUrl}${googlePlayRtdnPath}`, { method: 'POST', body: '{}' });
    const off = createWorkerFetchHandler(
      { MPGD_STORE: 'd1', DB: db } satisfies GameServicesWorkerEnv,
    );
    assert.equal((await off(request())).status, 404, 'not mounted without the RTDN settings');
    const incomplete = createWorkerFetchHandler({
      MPGD_STORE: 'd1',
      DB: db,
      GAME_SERVICES_GOOGLE_PLAY_RTDN_AUDIENCE: audience,
    } satisfies GameServicesWorkerEnv);
    const refused = await incomplete(request());
    assert.equal(refused.status, 503, 'incomplete settings fail closed');
    assert.deepEqual(await refused.json(), { error: 'GOOGLE_PLAY_RTDN_NOT_CONFIGURED' });
    const noPackage = createWorkerFetchHandler({
      MPGD_STORE: 'd1',
      DB: db,
      GAME_SERVICES_GOOGLE_PLAY_RTDN_AUDIENCE: audience,
      GAME_SERVICES_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT: serviceAccountEmail,
    } satisfies GameServicesWorkerEnv);
    assert.equal(
      (await noPackage(request())).status,
      503,
      'the package name is required with them',
    );
    const noVoidedClient = createWorkerFetchHandler({
      MPGD_STORE: 'd1',
      DB: db,
      GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME: packageName,
      GAME_SERVICES_GOOGLE_PLAY_RTDN_AUDIENCE: audience,
      GAME_SERVICES_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT: serviceAccountEmail,
    } satisfies GameServicesWorkerEnv);
    const unconfirmable = await noVoidedClient(request());
    assert.equal(unconfirmable.status, 503, 'without the Voided Purchases client it fails closed');
    assert.deepEqual(await unconfirmable.json(), { error: 'GOOGLE_PLAY_RTDN_NOT_CONFIGURED' });
    const configured = createWorkerFetchHandler({
      MPGD_STORE: 'd1',
      DB: db,
      GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME: packageName,
      GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH: {
        async getAccessToken() {
          throw new Error('no Play call in this test');
        },
      },
      GAME_SERVICES_GOOGLE_PLAY_ACCOUNT_BINDING: {
        async resolveObfuscatedAccountId() {
          return null;
        },
      },
      GAME_SERVICES_GOOGLE_PLAY_RTDN_AUDIENCE: audience,
      GAME_SERVICES_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT: serviceAccountEmail,
    } satisfies GameServicesWorkerEnv);
    // No Authorization header: refused before Google's keys are fetched.
    assert.equal((await configured(request())).status, 401, 'the mounted route authenticates');
  }
} finally {
  await miniflare.dispose();
}

console.log('Google Play RTDN Worker tests passed.');

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
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
}

async function signJwt(
  key: { readonly kid: string; readonly privateKey: CryptoKey },
  claims: Record<string, unknown>,
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function applyMigration(db: D1Database, name: string): Promise<void> {
  const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  await db.exec(toD1ExecScript(migration));
}

function toD1ExecScript(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`)
    .join('\n');
}
