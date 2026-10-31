import {
  answerAppStoreRevocationLookup,
  AppStoreDependencyUnavailableError,
  createAppStoreRevocationLookupOverBinding,
  createInMemoryAppStoreRevocationRegistry,
  type AppStoreRevocationLookupAnswer,
  type AppStoreRevocationLookupBinding,
  type AppStoreRevocationLookupRequest,
  type AppStoreRevocationRecord,
  type AppStoreRevocationRegistry,
} from './app-store-verifier';
import {
  appStoreRevocationRegistryConformanceChecks,
  appStoreRevocationRegistryDurabilityCheck,
  runAppStoreRevocationRegistryConformance,
} from './app-store-verifier-conformance';

const signal = new AbortController().signal;

// The in-memory registry passes the shared rules a durable registry runs too.
const inMemory = await runAppStoreRevocationRegistryConformance({
  registry: createInMemoryAppStoreRevocationRegistry(),
});
assertEqual(inMemory.passed, true, 'the in-memory registry passes the conformance rules');
assertEqual(
  inMemory.checks.join('|'),
  appStoreRevocationRegistryConformanceChecks.join('|'),
  'without reopen the durability rule is not claimed',
);
// A shared Map stands in for durable storage: reopen reads it through a new instance.
const shared = createInMemoryAppStoreRevocationRegistry();
const reopened = await runAppStoreRevocationRegistryConformance({
  registry: shared,
  reopen: () => ({
    findRevocation: (input) => shared.findRevocation(input),
    recordRevocation: (input) => shared.recordRevocation(input),
  }),
  runId: 'fixed',
});
assertEqual(
  reopened.checks.at(-1),
  appStoreRevocationRegistryDurabilityCheck,
  'with reopen the durability rule is claimed',
);

// A registry that partitions by the lookup's environment passes: every
// lookup names the record's own environment and bundle.
await runAppStoreRevocationRegistryConformance({ registry: environmentPartitionedRegistry() });

// A registry keyed by the verification id alone mixes Sandbox and Production.
await assertRejects(
  () => runAppStoreRevocationRegistryConformance({ registry: idOnlyRegistry() }),
  'environments are independent',
  'a registry that ignores the environment fails conformance',
);

// A registry that remembers per instance fails the durability rule.
await assertRejects(
  () =>
    runAppStoreRevocationRegistryConformance({
      registry: createInMemoryAppStoreRevocationRegistry(),
      reopen: () => createInMemoryAppStoreRevocationRegistry(),
    }),
  'read through reopen',
  'a registry that forgets across instances fails conformance',
);
// First-write-wins (the registry before OF1's latest-wins fix) fails.
await assertRejects(
  () => runAppStoreRevocationRegistryConformance({ registry: firstWriteWinsRegistry() }),
  'a later revocation replaces the earlier one',
  'a registry that keeps the first revocation fails conformance',
);
// Comparing revokedAt as text fails.
await assertRejects(
  () => runAppStoreRevocationRegistryConformance({ registry: textOrderRegistry() }),
  // Fails at the first comparison that needs instants: an equal instant in another offset.
  'the same instant in another offset',
  'a registry that orders revokedAt as text fails conformance',
);

// The lookup over a service binding, against the serving helper.
const record: AppStoreRevocationRecord = {
  verificationId: 'grant-1',
  environment: 'Production',
  bundleId: 'com.example.game',
  transactionId: '2000000000000001',
  originalTransactionId: '2000000000000001',
  productId: 'com.example.game.coins100',
  reason: 'refund',
  revokedAt: '2026-10-20T00:00:00.000Z',
  notificationType: 'REFUND',
  notificationUUID: 'uuid-1',
};
const registry = createInMemoryAppStoreRevocationRegistry();
await registry.recordRevocation({ record, signal });
const requests: AppStoreRevocationLookupRequest[] = [];
const served: AppStoreRevocationLookupBinding = {
  async findAppStoreRevocation(input) {
    requests.push(input);
    return answerAppStoreRevocationLookup(registry, input);
  },
};
const lookup = createAppStoreRevocationLookupOverBinding(served);
const request = {
  verificationId: 'grant-1',
  environment: 'Production' as const,
  bundleId: 'com.example.game',
  transactionId: '2000000000000001',
  originalTransactionId: '2000000000000001',
};
assertEqual(
  (await lookup.findRevocation({ ...request, signal }))?.notificationUUID,
  'uuid-1',
  'a recorded revocation is read through the binding',
);
assertEqual(
  'signal' in (requests[0] ?? {}),
  false,
  'the AbortSignal is not sent across the binding',
);
assertEqual(
  await lookup.findRevocation({ ...request, verificationId: 'grant-2', signal }),
  undefined,
  'an absent revocation is undefined',
);

for (const [label, binding] of [
  ['an unavailable answer', answering({ status: 'unavailable' })],
  [
    'a binding that throws',
    {
      async findAppStoreRevocation() {
        throw new Error('binding down');
      },
    },
  ],
  [
    'an answer of another shape',
    answering({ status: 'maybe' } as unknown as AppStoreRevocationLookupAnswer),
  ],
  ['an answer that is not an object', answering(null as unknown as AppStoreRevocationLookupAnswer)],
  [
    'a record for another grant',
    answering({ status: 'found', record: { ...record, verificationId: 'other' } }),
  ],
  [
    'a record of the other environment',
    answering({ status: 'found', record: { ...record, environment: 'Sandbox' } }),
  ],
] as const) {
  await assertRejectsWith(
    () => createAppStoreRevocationLookupOverBinding(binding).findRevocation({ ...request, signal }),
    AppStoreDependencyUnavailableError,
    `${label} is unavailable, never a grant`,
  );
}
const aborted = new AbortController();
aborted.abort(new Error('verification timed out'));
await assertRejectsWith(
  () => lookup.findRevocation({ ...request, signal: aborted.signal }),
  AppStoreDependencyUnavailableError,
  'an aborted verification does not wait for the binding',
);
const callsBefore = requests.length;
await assertRejectsWith(
  () => lookup.findRevocation({ ...request, signal: aborted.signal }),
  AppStoreDependencyUnavailableError,
  'an aborted verification is refused again',
);
assertEqual(requests.length, callsBefore, 'an aborted verification never calls the binding');
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
const late = new AbortController();
const lateRejection = createAppStoreRevocationLookupOverBinding({
  findAppStoreRevocation: () =>
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('late')), 5)),
}).findRevocation({ ...request, signal: late.signal });
late.abort(new Error('verification timed out'));
await assertRejectsWith(
  () => lateRejection,
  AppStoreDependencyUnavailableError,
  'an abort while the binding is pending answers unavailable',
);
await new Promise((resolve) => setTimeout(resolve, 20));
process.off('unhandledRejection', onUnhandled);
assertEqual(
  unhandled.length,
  0,
  'a binding that rejects after the abort leaves no unhandled rejection',
);
const slow = new AbortController();
const pending = createAppStoreRevocationLookupOverBinding({
  findAppStoreRevocation: () => new Promise<never>(() => undefined),
}).findRevocation({ ...request, signal: slow.signal });
slow.abort(new Error('verification timed out'));
await assertRejectsWith(
  () => pending,
  AppStoreDependencyUnavailableError,
  'an abort while the binding is pending stops the wait',
);

assertEqual(
  (await answerAppStoreRevocationLookup(
    { async findRevocation() { throw new AppStoreDependencyUnavailableError('D1 down'); } },
    request,
  )).status,
  'unavailable',
  'the serving side answers a registry outage as data',
);
await assertRejects(
  () =>
    answerAppStoreRevocationLookup(
      {
        async findRevocation() {
          throw new Error('bug');
        },
      },
      request,
    ),
  'bug',
  'any other serving error propagates',
);
await assertRejects(
  () => answerAppStoreRevocationLookup(registry, { ...request, verificationId: '' }),
  'verificationId',
  'the serving side refuses a lookup without a grant identity',
);

console.log(
  `app store revocation registry tests passed (${String(reopened.checks.length)} conformance checks)`,
);

function answering(answer: AppStoreRevocationLookupAnswer): AppStoreRevocationLookupBinding {
  return { findAppStoreRevocation: async () => answer };
}

function environmentPartitionedRegistry(): AppStoreRevocationRegistry {
  const partitions = new Map<string, AppStoreRevocationRegistry>();
  const partition = (environment: string, bundleId: string) => {
    const key = `${environment}|${bundleId}`;
    const existing = partitions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = createInMemoryAppStoreRevocationRegistry();
    partitions.set(key, created);
    return created;
  };
  return {
    findRevocation: (input) => partition(input.environment, input.bundleId).findRevocation(input),
    recordRevocation: (input) =>
      partition(input.record.environment, input.record.bundleId).recordRevocation(input),
  };
}

/** The in-memory rules, but one record per verification id whatever its environment. */
function idOnlyRegistry(): AppStoreRevocationRegistry {
  const order = createInMemoryAppStoreRevocationRegistry();
  const records = new Map<string, AppStoreRevocationRecord>();
  return {
    async findRevocation(input) {
      return records.get(input.verificationId);
    },
    async recordRevocation(input) {
      const result = await order.recordRevocation({
        ...input,
        record: { ...input.record, environment: 'Production' },
      });
      if (!result.alreadyRecorded) {
        records.set(input.record.verificationId, input.record);
      }
      return result;
    },
  };
}

function firstWriteWinsRegistry(): AppStoreRevocationRegistry {
  const records = new Map<string, AppStoreRevocationRecord>();
  return {
    async findRevocation(input) {
      return records.get(input.verificationId);
    },
    async recordRevocation(input) {
      if (records.has(input.record.verificationId)) {
        return { alreadyRecorded: true };
      }
      records.set(input.record.verificationId, input.record);
      return { alreadyRecorded: false };
    },
  };
}

function textOrderRegistry(): AppStoreRevocationRegistry {
  const records = new Map<string, AppStoreRevocationRecord>();
  return {
    async findRevocation(input) {
      return records.get(input.verificationId);
    },
    async recordRevocation(input) {
      const kept = records.get(input.record.verificationId);
      const keptValid = kept !== undefined && Number.isFinite(Date.parse(kept.revokedAt));
      const nextValid = Number.isFinite(Date.parse(input.record.revokedAt));
      if (
        kept !== undefined
        && (!keptValid || (nextValid && input.record.revokedAt <= kept.revokedAt))
      ) {
        return { alreadyRecorded: true };
      }
      records.set(input.record.verificationId, input.record);
      return { alreadyRecorded: false };
    },
  };
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expectedMessagePart: string,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const actual = error instanceof Error ? error.message : String(error);
    if (actual.includes(expectedMessagePart)) {
      return;
    }
    throw new Error(`${message}: expected "${expectedMessagePart}", received "${actual}".`);
  }
  throw new Error(`${message}: expected a rejection.`);
}

async function assertRejectsWith(
  operation: () => Promise<unknown>,
  errorClass: new (...args: never[]) => Error,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof errorClass) {
      return;
    }
    throw new Error(`${message}: received ${error instanceof Error ? error.name : String(error)}.`);
  }
  throw new Error(`${message}: expected a rejection.`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
