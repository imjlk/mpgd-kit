import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { ProductCatalog } from '@mpgd/catalog';
import type {
  CommercePurchaseOperationRecord,
  MonetizationOperationRecord,
} from '@mpgd/game-services';
import type { IdentitySession, PlatformGateway, StorageAdapter } from '@mpgd/platform';

import {
  resolvePlayBillingAccountBinding,
  resolveStarterCommercePlayerId,
  resolveStoreKitAppAccountToken,
  setStarterCommerceServerPlayer,
} from './commerceAccountBinding';
import {
  purchaseKindOf,
  resolveStarterCommerceProducts,
  resolveStarterStoreProducts,
} from './commerceProducts';
import {
  createStorageMonetizationOperationStore,
  defaultMonetizationJournalKey,
} from './monetizationJournal';

// The kit catalog the starter bundles by default (Vite aliases a game-owned one).
const productCatalog = JSON.parse(
  readFileSync(new URL('../../../../packages/catalog/catalog.json', import.meta.url), 'utf8'),
) as ProductCatalog;

// Catalog to store products: `platformProductIds[target]` is the only SKU source.
assert.deepEqual(resolveStarterStoreProducts(productCatalog, 'android'), [
  { logicalId: 'COINS_100', storeSku: 'coins_100', kind: 'consumable' },
  { logicalId: 'COINS_500', storeSku: 'coins_500', kind: 'consumable' },
  { logicalId: 'REMOVE_ADS', storeSku: 'remove_ads', kind: 'durable' },
]);
assert.deepEqual(
  resolveStarterStoreProducts(productCatalog, 'microsoft-store').map((product) => product.logicalId),
  ['COINS_100', 'COINS_500'],
  'a product without an id for the target is not sold there',
);
assert.deepEqual(resolveStarterStoreProducts(productCatalog, 'web-preview'), []);
assert.deepEqual(resolveStarterCommerceProducts(productCatalog, 'microsoft-store'), [
  { logicalId: 'COINS_100', kind: 'consumable', storeSku: 'coins_100' },
  { logicalId: 'COINS_500', kind: 'consumable', storeSku: 'coins_500' },
  { logicalId: 'REMOVE_ADS', kind: 'durable' },
]);
assert.equal(purchaseKindOf('subscription'), 'subscription');
assert.throws(() => purchaseKindOf('bundle' as never), /Unknown catalog product type/u);

// Account binding: derived from the authenticated player id, never from a guest.
const gatewayFor = (
  playerId: string | undefined,
  fails = false,
  session: Partial<IdentitySession> = {
    identityLevel: 'authenticated',
    trustLevel: 'server-verified',
  },
) =>
  ({
    identity: {
      async getSession() {
        if (fails) {
          throw new Error('identity unavailable');
        }
        return { ...session, ...(playerId === undefined ? {} : { playerId }) };
      },
    },
  }) as unknown as Pick<PlatformGateway, 'identity'>;
assert.equal(await resolveStarterCommercePlayerId(gatewayFor('  ')), undefined);
assert.equal(await resolveStarterCommercePlayerId(gatewayFor('p1', true)), undefined);
// The native shell's default session is platform-anonymous and local: it binds nothing.
for (const nativeDefault of [
  { identityLevel: 'platform-anonymous', trustLevel: 'local' },
  { identityLevel: 'guest', trustLevel: 'local' },
  { identityLevel: 'authenticated', trustLevel: 'local' },
] as const) {
  assert.equal(
    await resolvePlayBillingAccountBinding(gatewayFor('android-local-player', false, nativeDefault)),
    undefined,
    `${nativeDefault.identityLevel}/${nativeDefault.trustLevel} binds nothing`,
  );
  await assert.rejects(
    resolveStoreKitAppAccountToken(gatewayFor('ios-local-player', false, nativeDefault)),
    /server session/u,
  );
}
assert.equal(
  await resolveStarterCommercePlayerId(gatewayFor('p1', false, {
    identityLevel: 'authenticated',
    trustLevel: 'platform-asserted',
  })),
  'p1',
);
assert.equal(await resolvePlayBillingAccountBinding(gatewayFor(undefined)), undefined);
const binding = await resolvePlayBillingAccountBinding(gatewayFor('player-1'));
assert.equal(binding?.kind, 'obfuscated-account-id');
assert.match(binding?.value ?? '', /^[0-9a-f]{64}$/u);
assert.deepEqual(await resolvePlayBillingAccountBinding(gatewayFor('player-1')), binding);
assert.notDeepEqual(await resolvePlayBillingAccountBinding(gatewayFor('player-2')), binding);
const token = await resolveStoreKitAppAccountToken(gatewayFor('player-1'));
assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
// The same digest as the Play binding, with the RFC 4122 version and variant bits set.
const tokenHex = token.replaceAll('-', '');
const digestHex = (binding?.value ?? '').slice(0, 32);
assert.equal(tokenHex.slice(0, 12), digestHex.slice(0, 12));
assert.equal(tokenHex.slice(13, 16), digestHex.slice(13, 16));
assert.equal(
  Number.parseInt(tokenHex[16] ?? '', 16),
  (Number.parseInt(digestHex[16] ?? '', 16) & 0x3) | 0x8,
);
assert.equal(tokenHex.slice(17), digestHex.slice(17));
await assert.rejects(resolveStoreKitAppAccountToken(gatewayFor(undefined)), /server session/u);

// A game's server session (guestIdentity.ts in a generated game) replaces the platform session.
setStarterCommerceServerPlayer(() => 'p_server-player');
assert.equal(
  await resolveStarterCommercePlayerId(gatewayFor('ios-local-player', false, { identityLevel: 'guest', trustLevel: 'local' })),
  'p_server-player',
);
assert.deepEqual(
  await resolvePlayBillingAccountBinding(gatewayFor('ios-local-player')),
  await (async () => {
    setStarterCommerceServerPlayer(undefined);
    const expected = await resolvePlayBillingAccountBinding(gatewayFor('p_server-player'));
    setStarterCommerceServerPlayer(() => 'p_server-player');
    return expected;
  })(),
);
// Signed out of the server session, nothing binds, not even an authenticated platform player.
setStarterCommerceServerPlayer(() => undefined);
assert.equal(await resolveStarterCommercePlayerId(gatewayFor('player-1')), undefined);
await assert.rejects(
  resolveStoreKitAppAccountToken(gatewayFor('player-1')),
  /VITE_MPGD_IDENTITY_URL/u,
);
setStarterCommerceServerPlayer(undefined);
assert.equal(await resolveStarterCommercePlayerId(gatewayFor('player-1')), 'player-1');

// The durable journal over platform storage.
function createMemoryStorage() {
  const values = new Map<string, unknown>();
  let saves = 0;
  const storage: StorageAdapter = {
    async load({ key }) {
      return values.has(key) ? { value: structuredClone(values.get(key)) } : null;
    },
    async save({ key, value }) {
      saves += 1;
      values.set(key, structuredClone(value));
    },
  };
  return { storage, values, saves: () => saves };
}

let clock = Date.parse('2026-10-12T00:00:00.000Z');
const now = () => clock;
const purchaseRecord = (
  input: Partial<CommercePurchaseOperationRecord> & { readonly key: string },
): CommercePurchaseOperationRecord => ({
  kind: 'commerce-purchase',
  playerId: 'player-1',
  target: 'android',
  deploymentTarget: 'android',
  revision: 0,
  idempotencyKey: input.key,
  store: 'google-play',
  logicalId: 'COINS_100',
  productKind: 'consumable',
  origin: 'game',
  state: 'requested',
  updatedAt: new Date(clock).toISOString(),
  ...input,
}) as CommercePurchaseOperationRecord;
const withTransaction = (
  record: CommercePurchaseOperationRecord,
  transactionId: string,
): CommercePurchaseOperationRecord => ({
  ...record,
  purchase: { transactionId } as CommercePurchaseOperationRecord['purchase'],
}) as CommercePurchaseOperationRecord;

{
  const memory = createMemoryStorage();
  const journal = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  const first = purchaseRecord({ key: 'op-1' });
  assert.deepEqual(await journal.reserve(first), { created: true, record: first });
  const again = await journal.reserve(
    { ...first, logicalId: 'COINS_500' } as MonetizationOperationRecord,
  );
  assert.equal(again.created, false, 'a reserved key answers the existing record');
  assert.equal((again.record as CommercePurchaseOperationRecord).logicalId, 'COINS_100');
  const read = await journal.read('op-1');
  assert.deepEqual(read, first);
  (read as { state: string }).state = 'tampered';
  assert.equal((await journal.read('op-1') as CommercePurchaseOperationRecord).state, 'requested');
  assert.equal(await journal.read('missing'), undefined);

  // Compare-and-swap: the expected revision, the next revision, fixed identity.
  const launched = { ...first, revision: 1, state: 'launched' } as CommercePurchaseOperationRecord;
  await assert.rejects(journal.replace(1, launched), /Stale or conflicting/u);
  await assert.rejects(journal.replace(0, { ...launched, revision: 2 }), /Stale or conflicting/u);
  await assert.rejects(
    journal.replace(0, { ...launched, playerId: 'player-2' }),
    /Stale or conflicting/u,
  );
  await assert.rejects(journal.replace(0, { ...launched, target: 'ios' }), /Stale or conflicting/u);
  await assert.rejects(
    journal.replace(0, { ...launched, deploymentTarget: 'ios' }),
    /Stale or conflicting/u,
  );
  await assert.rejects(
    journal.replace(0, { ...launched, key: 'missing' }),
    /Stale or conflicting/u,
  );
  // Two writers with the same expected revision: exactly one wins.
  const raced = await Promise.allSettled([
    journal.replace(0, launched),
    journal.replace(0, { ...launched, state: 'cancelled' } as CommercePurchaseOperationRecord),
  ]);
  assert.deepEqual(
    raced.map((result) => result.status),
    ['fulfilled', 'rejected'],
  );
  assert.equal((await journal.read('op-1') as CommercePurchaseOperationRecord).state, 'launched');

  // Recoverable, granted, and transaction lookups are scoped to the player.
  const granted = withTransaction(
    purchaseRecord({ key: 'op-2', state: 'granted', ledgerEntryId: 'ledger-2' }),
    'GPA.2',
  );
  const finished = withTransaction(
    purchaseRecord({ key: 'op-3', state: 'finished', ledgerEntryId: 'ledger-3' }),
    'GPA.3',
  );
  const otherPlayer = purchaseRecord({ key: 'op-4', playerId: 'player-2' });
  for (const record of [granted, finished, otherPlayer]) {
    await journal.reserve(record);
  }
  assert.deepEqual((await journal.listRecoverable('player-1')).map((record) => record.key).sort(), [
    'op-1',
    'op-2',
  ]);
  assert.deepEqual((await journal.listGranted?.('player-1'))?.map((record) => record.key).sort(), [
    'op-2',
    'op-3',
  ]);
  const lookup = {
    playerId: 'player-1',
    target: 'android',
    deploymentTarget: 'android',
    store: 'google-play',
    transactionId: 'GPA.3',
  };
  assert.equal((await journal.findByTransaction?.(lookup))?.key, 'op-3');
  assert.equal(await journal.findByTransaction?.({ ...lookup, playerId: 'player-2' }), undefined);
  assert.equal(await journal.findByTransaction?.({ ...lookup, store: 'app-store' }), undefined);
  assert.equal(await journal.findByTransaction?.({ ...lookup, transactionId: 'GPA.9' }), undefined);

  // A second journal over the same storage sees the same records (durability).
  const reopened = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  assert.equal((await reopened.read('op-3') as CommercePurchaseOperationRecord).state, 'finished');

  // Terminal records past the retention window leave on the next write;
  // open records and in-window terminal records stay.
  clock += 31 * 24 * 60 * 60 * 1000;
  await journal.reserve(purchaseRecord({ key: 'op-5' }));
  assert.equal(await journal.read('op-3'), undefined, 'an expired terminal record is dropped');
  assert.notEqual(await journal.read('op-1'), undefined, 'an open record is never dropped');
  assert.notEqual(await journal.read('op-2'), undefined, 'a granted record is still open');
  assert.equal(memory.values.has(defaultMonetizationJournalKey), true);
}

// Ungranted terminal records are bounded by count as well: the newest settled stay.
{
  const memory = createMemoryStorage();
  const journal = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxTerminalRecords: 2,
  });
  const open = purchaseRecord({ key: 'open' });
  await journal.reserve(open);
  for (const [index, key] of ['old', 'middle', 'new'].entries()) {
    await journal.reserve(
      purchaseRecord({
        key,
        state: 'finished',
        ledgerEntryId: `ledger-${key}`,
        updatedAt: new Date(clock + index * 1000).toISOString(),
      }),
    );
  }
  assert.notEqual(await journal.read('old'), undefined, 'a granted purchase leaves only by age');
  for (const [index, key] of ['cancelled-old', 'cancelled-middle', 'cancelled-new'].entries()) {
    await journal.reserve(
      purchaseRecord({
        key,
        state: 'cancelled',
        updatedAt: new Date(clock + index * 1000).toISOString(),
      }),
    );
  }
  assert.equal(
    await journal.read('cancelled-old'),
    undefined,
    'the oldest ungranted record is dropped',
  );
  assert.notEqual(await journal.read('cancelled-middle'), undefined);
  assert.notEqual(await journal.read('cancelled-new'), undefined);
  for (const key of ['old', 'middle', 'new', 'open']) {
    assert.notEqual(await journal.read(key), undefined, `${key} does not count against the bound`);
  }
}

// A rejected purchase the store still lists stays out of the count bound, so
// findByTransaction keeps matching it.
{
  const memory = createMemoryStorage();
  const journal = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxTerminalRecords: 1,
  });
  await journal.reserve(
    withTransaction(purchaseRecord({ key: 'rejected', state: 'rejected' }), 'GPA.rejected'),
  );
  for (const [index, key] of ['cancelled-1', 'cancelled-2', 'cancelled-3'].entries()) {
    await journal.reserve(
      purchaseRecord({
        key,
        state: 'cancelled',
        updatedAt: new Date(clock + (index + 1) * 1000).toISOString(),
      }),
    );
  }
  assert.notEqual(await journal.read('rejected'), undefined, 'a rejected store transaction stays');
  assert.equal(await journal.read('cancelled-1'), undefined);
  assert.equal(await journal.read('cancelled-2'), undefined);
  assert.notEqual(await journal.read('cancelled-3'), undefined);
}

// The document is bounded in bytes: the oldest terminal records leave, lowest
// tier first, and open records always stay.
{
  const memory = createMemoryStorage();
  const padding = 'x'.repeat(2_000);
  const journal = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxDocumentBytes: 6_000,
  });
  const padded = (record: CommercePurchaseOperationRecord): CommercePurchaseOperationRecord => ({
    ...record,
    purchase: {
      ...record.purchase,
      evidence: { schema: 'test', payload: { padding } },
    } as CommercePurchaseOperationRecord['purchase'],
  }) as CommercePurchaseOperationRecord;
  await journal.reserve(padded(withTransaction(purchaseRecord({ key: 'open' }), 'GPA.open')));
  for (const [index, key] of ['granted-old', 'granted-new'].entries()) {
    await journal.reserve(
      padded(
        withTransaction(
          purchaseRecord({
            key,
            state: 'finished',
            ledgerEntryId: `ledger-${key}`,
            updatedAt: new Date(clock + index * 1000).toISOString(),
          }),
          `GPA.${key}`,
        ),
      ),
    );
  }
  await journal.reserve(
    padded(
      withTransaction(
        purchaseRecord({
          key: 'rejected',
          state: 'rejected',
          updatedAt: new Date(clock + 5_000).toISOString(),
        }),
        'GPA.rejected',
      ),
    ),
  );
  const saved = memory.values.get(defaultMonetizationJournalKey);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).length <= 6_000, 'the document fits');
  assert.notEqual(await journal.read('open'), undefined, 'an open record is never dropped');
  assert.equal(await journal.read('rejected'), undefined, 'the lower tier leaves first');
  assert.equal(await journal.read('granted-old'), undefined, 'then the oldest granted purchase');
  assert.notEqual(await journal.read('granted-new'), undefined);
}

// Two contexts over the same storage (two tabs, two PWA windows) share the
// host's Web Locks, so neither loses the other's write.
{
  const memory = createMemoryStorage();
  const first = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  const second = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  await Promise.all([
    first.reserve(purchaseRecord({ key: 'tab-1' })),
    second.reserve(purchaseRecord({ key: 'tab-2' })),
    first.reserve(purchaseRecord({ key: 'tab-3' })),
    second.reserve(purchaseRecord({ key: 'tab-4' })),
  ]);
  assert.deepEqual((await first.listRecoverable('player-1')).map((record) => record.key).sort(), [
    'tab-1',
    'tab-2',
    'tab-3',
    'tab-4',
  ]);
}

// An unreadable document fails every call and is never replaced.
{
  const memory = createMemoryStorage();
  memory.values.set(defaultMonetizationJournalKey, { version: 2, records: {} });
  const journal = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  await assert.rejects(
    journal.reserve(purchaseRecord({ key: 'op-1' })),
    /unreadable; it was not replaced/u,
  );
  await assert.rejects(journal.listRecoverable('player-1'), /unreadable/u);
  assert.equal(memory.saves(), 0);
  assert.deepEqual(memory.values.get(defaultMonetizationJournalKey), { version: 2, records: {} });
  // A failed call does not wedge the queue for later calls.
  memory.values.delete(defaultMonetizationJournalKey);
  assert.equal((await journal.reserve(purchaseRecord({ key: 'op-1' }))).created, true);
}

console.info('Starter commerce products, account binding, and durable journal passed.');
