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

// Records parked as another account's purchase are open but bounded: they
// leave 30 days after their last write (the parking or a Restore Purchases
// resend). Every other open record stays, whoever's it is.
{
  const memory = createMemoryStorage();
  const journal = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  const day = 24 * 60 * 60 * 1000;
  const start = clock;
  const at = (offset: number) => new Date(start + offset).toISOString();
  const parked = (key: string, writtenAt: number, playerId = 'player-2') =>
    withTransaction(
      purchaseRecord({
        key,
        playerId,
        state: 'verifying',
        origin: 'discovered',
        updatedAt: at(writtenAt),
        anotherAccount: { reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', reportedAt: at(writtenAt) },
      }),
      `GPA.${key}`,
    );
  await journal.reserve(parked('parked-old', 0));
  await journal.reserve(parked('parked-young', 2 * day));
  await journal.reserve(parked('parked-own-player', 0, 'player-1'));
  await journal.reserve(parked('restored', 0));
  // The verifying record of the purchase's own account, and one Restore Purchases unparked.
  await journal.reserve(
    withTransaction(purchaseRecord({ key: 'owner-scoped', state: 'verifying' }), 'GPA.owner'),
  );
  await journal.reserve(
    withTransaction(
      purchaseRecord({ key: 'unparked', playerId: 'player-2', state: 'verifying' }),
      'GPA.unparked',
    ),
  );
  clock = start + 31 * day;
  // A Restore Purchases resend rewrites the parked record before it is sent.
  const restored = (await journal.read('restored')) as CommercePurchaseOperationRecord;
  await journal.replace(restored.revision, {
    ...restored,
    revision: restored.revision + 1,
    updatedAt: new Date(clock).toISOString(),
  });
  assert.equal(await journal.read('parked-old'), undefined, 'a parked record leaves by age');
  assert.equal(
    await journal.read('parked-own-player'),
    undefined,
    'whichever player it was parked for',
  );
  assert.notEqual(await journal.read('parked-young'), undefined, 'a recent parked record stays');
  assert.notEqual(
    await journal.read('restored'),
    undefined,
    'a record a Restore Purchases resend just rewrote stays while its answer is awaited',
  );
  for (const key of ['owner-scoped', 'unparked']) {
    assert.notEqual(await journal.read(key), undefined, `${key} is open and never dropped`);
  }
  // The rule only removes records: the document keeps its version-1 shape.
  assert.equal(
    (memory.values.get(defaultMonetizationJournalKey) as { version: number }).version,
    1,
  );
}

// Parked records are bounded by count across every player of the install: the
// most recently written stay, so a resend in flight is never the one dropped.
{
  const memory = createMemoryStorage();
  const journal = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxParkedRecords: 2,
  });
  const parked = (key: string, offset: number) =>
    withTransaction(
      purchaseRecord({
        key,
        playerId: `player-${key}`,
        state: 'verifying',
        updatedAt: new Date(clock + offset).toISOString(),
        anotherAccount: {
          reason: 'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
          reportedAt: new Date(clock + offset).toISOString(),
        },
      }),
      `GPA.${key}`,
    );
  const hour = 60 * 60 * 1000;
  await journal.reserve(purchaseRecord({ key: 'open' }));
  await journal.reserve(parked('first', -3 * hour));
  await journal.reserve(parked('second', -2 * hour));
  await journal.reserve(parked('third', -hour));
  assert.equal(await journal.read('first'), undefined, 'the least recently written leaves');
  // Restore Purchases resends the older survivor: rewritten now, it stays.
  const second = (await journal.read('second')) as CommercePurchaseOperationRecord;
  await journal.replace(second.revision, {
    ...second,
    revision: second.revision + 1,
    updatedAt: new Date(clock).toISOString(),
  });
  assert.notEqual(await journal.read('second'), undefined, 'the resent record stays');
  assert.notEqual(await journal.read('third'), undefined);
  assert.notEqual(await journal.read('open'), undefined, 'other open records do not count');
}

// The byte budget drops parked records before granted purchases, except one
// that may be in flight.
{
  const memory = createMemoryStorage();
  const padding = 'x'.repeat(2_000);
  const journal = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxDocumentBytes: 8_000,
  });
  const padded = (record: CommercePurchaseOperationRecord): CommercePurchaseOperationRecord => ({
    ...record,
    purchase: {
      ...record.purchase,
      evidence: { schema: 'test', payload: { padding } },
    } as CommercePurchaseOperationRecord['purchase'],
  }) as CommercePurchaseOperationRecord;
  const parked = (key: string, offset: number) =>
    padded(
      withTransaction(
        purchaseRecord({
          key,
          playerId: 'player-2',
          state: 'verifying',
          updatedAt: new Date(clock + offset).toISOString(),
          anotherAccount: {
            reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
            reportedAt: new Date(clock + offset).toISOString(),
          },
        }),
        `GPA.${key}`,
      ),
    );
  await journal.reserve(
    padded(
      withTransaction(
        purchaseRecord({
          key: 'granted',
          state: 'finished',
          ledgerEntryId: 'ledger-granted',
          updatedAt: new Date(clock - 1_000).toISOString(),
        }),
        'GPA.granted',
      ),
    ),
  );
  await journal.reserve(parked('parked-old', -2 * 60 * 60 * 1000));
  await journal.reserve(parked('parked-new', -60 * 60 * 1000));
  await journal.reserve(padded(withTransaction(purchaseRecord({ key: 'open' }), 'GPA.open')));
  assert.equal(await journal.read('parked-old'), undefined, 'an older parked record leaves first');
  assert.notEqual(await journal.read('parked-new'), undefined, 'the newest parked record stays');
  assert.notEqual(await journal.read('granted'), undefined);
  assert.notEqual(await journal.read('open'), undefined);

  // Over a budget too small for both, the granted purchase leaves before the
  // newest parked record, whose resend may be awaiting its answer.
  const tight = createMemoryStorage();
  const tightJournal = createStorageMonetizationOperationStore({
    storage: tight.storage,
    now,
    maxDocumentBytes: 3_000,
    maxParkedRecords: 0,
  });
  await tightJournal.reserve(
    padded(
      withTransaction(
        purchaseRecord({ key: 'granted', state: 'finished', ledgerEntryId: 'ledger-granted' }),
        'GPA.granted',
      ),
    ),
  );
  await tightJournal.reserve(parked('in-flight', 2_000));
  assert.notEqual(
    await tightJournal.read('in-flight'),
    undefined,
    'neither a zero bound nor the byte budget drops a parked record that may be in flight',
  );
  assert.equal(await tightJournal.read('granted'), undefined);
}

// The parked record a Restore Purchases resend just rewrote stays whatever
// the timestamps say: here it ties with another and its fresh evidence pushes
// the document over the byte budget.
{
  const memory = createMemoryStorage();
  const journal = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxDocumentBytes: 3_500,
  });
  // Written an hour ago, so only `lastWrittenParked` protects the resent one.
  const writtenAt = new Date(clock - 60 * 60 * 1000).toISOString();
  const parked = (key: string) =>
    withTransaction(
      purchaseRecord({
        key,
        playerId: 'player-2',
        state: 'verifying',
        updatedAt: writtenAt,
        anotherAccount: { reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', reportedAt: writtenAt },
      }),
      `GPA.${key}`,
    );
  await journal.reserve(parked('first'));
  await journal.reserve(parked('resent'));
  const resent = (await journal.read('resent')) as CommercePurchaseOperationRecord;
  await journal.replace(resent.revision, {
    ...resent,
    revision: resent.revision + 1,
    purchase: {
      ...resent.purchase,
      evidence: { schema: 'test', payload: { padding: 'x'.repeat(3_000) } },
    } as CommercePurchaseOperationRecord['purchase'],
  } as CommercePurchaseOperationRecord);
  assert.notEqual(await journal.read('resent'), undefined, 'the resent record stays');
  assert.equal(await journal.read('first'), undefined, 'the other parked record leaves');
}

// Another tab's journal never drops a parked record written within the
// in-flight window: that tab's Restore Purchases may await its answer.
{
  const memory = createMemoryStorage();
  const tabA = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  const tabB = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxParkedRecords: 1,
  });
  const parked = (key: string, writtenAt: string) =>
    withTransaction(
      purchaseRecord({
        key,
        playerId: 'player-2',
        state: 'verifying',
        updatedAt: writtenAt,
        anotherAccount: { reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', reportedAt: writtenAt },
      }),
      `GPA.${key}`,
    );
  await tabA.reserve(parked('a', new Date(clock - 60 * 60 * 1000).toISOString()));
  const a = (await tabA.read('a')) as CommercePurchaseOperationRecord;
  await tabA.replace(a.revision, {
    ...a,
    revision: a.revision + 1,
    updatedAt: new Date(clock).toISOString(),
  });
  await tabB.reserve(parked('b', new Date(clock).toISOString()));
  assert.notEqual(await tabB.read('a'), undefined, "tab A's resend in flight stays");
  assert.notEqual(await tabB.read('b'), undefined);
  clock += 11 * 60 * 1000;
  await tabB.reserve(purchaseRecord({ key: 'later' }));
  assert.equal(await tabB.read('a'), undefined, 'past the window the bound applies again');
}

// A parked record without a readable time is never in flight: it sorts as the
// newest, so age does not drop it, but the count bound does.
{
  const memory = createMemoryStorage();
  const parked = (key: string, writtenAt: string) =>
    withTransaction(
      purchaseRecord({
        key,
        playerId: 'player-2',
        state: 'verifying',
        updatedAt: writtenAt,
        anotherAccount: { reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', reportedAt: writtenAt },
      }),
      `GPA.${key}`,
    );
  const roomy = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  await roomy.reserve(parked('garbled', 'not-a-time'));
  clock += 31 * 24 * 60 * 60 * 1000;
  await roomy.reserve(purchaseRecord({ key: 'later' }));
  assert.notEqual(await roomy.read('garbled'), undefined, 'age does not drop it');
  const bounded = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxParkedRecords: 1,
  });
  await bounded.reserve(parked('readable', new Date(clock - 60 * 60 * 1000).toISOString()));
  assert.equal(await bounded.read('garbled'), undefined, 'the count bound drops it');
  assert.notEqual(await bounded.read('readable'), undefined);
}

// The in-flight window follows `parkedInFlightMs`, for a game that changed the
// reconciler's `inFlightTimeoutMs`.
{
  const memory = createMemoryStorage();
  const writtenAt = new Date(clock).toISOString();
  const parked = (key: string, at: string) =>
    withTransaction(
      purchaseRecord({
        key,
        playerId: 'player-2',
        state: 'verifying',
        updatedAt: at,
        anotherAccount: { reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', reportedAt: at },
      }),
      `GPA.${key}`,
    );
  const tabA = createStorageMonetizationOperationStore({ storage: memory.storage, now });
  await tabA.reserve(parked('a', writtenAt));
  clock += 2 * 60 * 1000;
  const defaults = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxParkedRecords: 1,
  });
  await defaults.reserve(parked('b', new Date(clock - 60 * 60 * 1000).toISOString()));
  assert.notEqual(await defaults.read('a'), undefined, 'two minutes is inside the default window');
  const short = createStorageMonetizationOperationStore({
    storage: memory.storage,
    now,
    maxParkedRecords: 1,
    parkedInFlightMs: 60 * 1000,
  });
  await short.reserve(parked('c', new Date(clock - 30 * 60 * 1000).toISOString()));
  assert.equal(await short.read('a'), undefined, 'but outside a one-minute window');
  assert.notEqual(await short.read('c'), undefined);
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
