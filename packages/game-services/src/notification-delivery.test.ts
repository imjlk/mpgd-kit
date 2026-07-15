import {
  createInMemoryNotificationDeliveryLedger,
  createNotificationDeliveryService,
  NotificationDeliveryNotSentError,
  type DeliveryReceipt,
  type NotificationDeliveryLedger,
  type NotificationDeliveryProvider,
  type NotificationDeliveryRequest,
} from './notification-delivery';

const gameDeepLinkPolicy = {
  allowedOrigins: ['https://game.example'],
} as const;
const providerCalls: string[] = [];
const browserProvider = {
  target: 'browser',
  async deliverIdempotently(request) {
    providerCalls.push(`browser:${request.recipient}`);
    return {
      providerMessageId: 'browser-message-1',
      acceptedAt: '2026-07-10T01:00:00.000Z',
    };
  },
} as const satisfies NotificationDeliveryProvider;
const androidProvider = {
  target: 'android',
  async deliverIdempotently(request) {
    providerCalls.push(`android:${request.recipient}`);
    return {
      providerMessageId: 'android-message-1',
      acceptedAt: '2026-07-10T01:00:00.000Z',
    };
  },
} as const satisfies NotificationDeliveryProvider;
const deliveryLedger = createInMemoryNotificationDeliveryLedger();
const deliveryService = createNotificationDeliveryService({
  providers: [browserProvider, androidProvider],
  ledger: deliveryLedger,
  deepLinkPolicy: gameDeepLinkPolicy,
});
const androidRequest = {
  target: 'android',
  topic: 'daily-ready',
  recipient: 'android-subscription-1',
  idempotencyKey: 'notification-1',
  deepLink: 'https://game.example/daily',
  templateData: {
    playerName: 'Ari',
    remainingLives: 3,
  },
} as const satisfies NotificationDeliveryRequest;
const firstDelivery = await deliveryService.deliver(androidRequest);
const duplicateDelivery = await deliveryService.deliver(androidRequest);

assertEqual(firstDelivery.status, 'delivered', 'a configured provider should deliver');
assertEqual(
  firstDelivery.alreadyProcessed,
  false,
  'the first notification should not be marked as already processed',
);
assertEqual(
  duplicateDelivery.status,
  'delivered',
  'a completed duplicate should return the original delivery',
);
assertEqual(
  duplicateDelivery.alreadyProcessed,
  true,
  'a duplicate notification should be marked as already processed',
);
assertDeepEqual(
  providerCalls,
  ['android:android-subscription-1'],
  'the service should select by target and send a completed idempotency key once',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    templateData: {
      playerName: 'Different Player',
    },
  }),
  'cannot be reused',
  'ledger idempotency keys must bind the complete normalized request payload',
);
const providerRemovedService = createNotificationDeliveryService({
  providers: [],
  ledger: deliveryLedger,
  deepLinkPolicy: gameDeepLinkPolicy,
});
const completedAfterProviderRemoval = await providerRemovedService.deliver(androidRequest);

assertEqual(
  completedAfterProviderRemoval.status,
  'delivered',
  'completed idempotency results should survive provider removal',
);
assertEqual(
  completedAfterProviderRemoval.alreadyProcessed,
  true,
  'provider removal must not hide an already completed delivery',
);

const durableProviderOutbox = new Map<string, {
  readonly fingerprint: string;
  readonly receipt: DeliveryReceipt;
}>();
let durableExternalSends = 0;
const concurrentServiceOne = createNotificationDeliveryService({
  providers: [createDurableTestProvider()],
  ledger: createInMemoryNotificationDeliveryLedger(),
  deepLinkPolicy: gameDeepLinkPolicy,
});
const concurrentServiceTwo = createNotificationDeliveryService({
  providers: [createDurableTestProvider()],
  ledger: createInMemoryNotificationDeliveryLedger(),
  deepLinkPolicy: gameDeepLinkPolicy,
});
const concurrentRequest = {
  ...androidRequest,
  target: 'browser',
  idempotencyKey: 'notification-provider-conformance',
} as const satisfies NotificationDeliveryRequest;
const concurrentDeliveries = await Promise.all([
  concurrentServiceOne.deliver(concurrentRequest),
  concurrentServiceTwo.deliver(concurrentRequest),
]);
const recreatedProviderService = createNotificationDeliveryService({
  providers: [createDurableTestProvider()],
  ledger: createInMemoryNotificationDeliveryLedger(),
  deepLinkPolicy: gameDeepLinkPolicy,
});
const deliveryAfterProviderRecreation = await recreatedProviderService.deliver(concurrentRequest);

assertEqual(
  durableExternalSends,
  1,
  'provider outbox must deduplicate concurrent and restart calls',
);
const concurrentReceipts = concurrentDeliveries.map((delivery) => {
  return delivery.status === 'delivered' ? delivery.receipt : delivery;
});
assertDeepEqual(
  concurrentReceipts,
  [
    {
      providerMessageId: 'durable-provider-message',
      acceptedAt: '2026-07-10T01:00:00.000Z',
    },
    {
      providerMessageId: 'durable-provider-message',
      acceptedAt: '2026-07-10T01:00:00.000Z',
    },
  ],
  'concurrent provider calls should return the stable durable receipt',
);
assertEqual(
  deliveryAfterProviderRecreation.status,
  'delivered',
  'provider recreation should reconcile the durable outbox receipt',
);

const claimLedger = createInMemoryNotificationDeliveryLedger();
const firstClaim = await claimLedger.claim(
  {
    ...androidRequest,
    idempotencyKey: 'notification-in-flight',
  },
  {
    claimedAt: '2026-07-10T01:00:00.000Z',
    leaseDurationMs: 1_000,
    ...gameDeepLinkPolicy,
  },
);
const concurrentClaim = await claimLedger.claim(
  {
    ...androidRequest,
    idempotencyKey: 'notification-in-flight',
  },
  {
    claimedAt: '2026-07-10T01:00:00.500Z',
    leaseDurationMs: 1_000,
    ...gameDeepLinkPolicy,
  },
);

assertEqual(firstClaim.status, 'claimed', 'the first ledger caller should own the claim');
assertEqual(
  concurrentClaim.status,
  'in-flight',
  'a concurrent ledger caller should not receive a second claim',
);
const reclaimedClaim = await claimLedger.claim(
  {
    ...androidRequest,
    idempotencyKey: 'notification-in-flight',
  },
  {
    claimedAt: '2026-07-10T01:00:01.000Z',
    leaseDurationMs: 1_000,
    ...gameDeepLinkPolicy,
  },
);

assertEqual(reclaimedClaim.status, 'claimed', 'an expired claim should be atomically reclaimable');

let retryAttempts = 0;
const flakyProvider = {
  target: 'ios',
  async deliverIdempotently() {
    retryAttempts += 1;

    if (retryAttempts === 1) {
      throw new NotificationDeliveryNotSentError('provider temporarily unavailable');
    }

    return {
      providerMessageId: 'ios-message-after-retry',
      acceptedAt: '2026-07-10T01:05:00.000Z',
    };
  },
} as const satisfies NotificationDeliveryProvider;
const retryService = createNotificationDeliveryService({
  providers: [flakyProvider],
  ledger: createInMemoryNotificationDeliveryLedger(),
  deepLinkPolicy: gameDeepLinkPolicy,
});
const retryRequest = {
  ...androidRequest,
  target: 'ios',
  recipient: 'ios-subscription-1',
  idempotencyKey: 'notification-retry',
} as const satisfies NotificationDeliveryRequest;

await assertRejects(
  () => retryService.deliver(retryRequest),
  'provider temporarily unavailable',
  'provider failures should be surfaced',
);
const retriedDelivery = await retryService.deliver(retryRequest);

assertEqual(retriedDelivery.status, 'delivered', 'a released failure should be retryable');
assertEqual(retryAttempts, 2, 'a failed claim should permit exactly one retry call');

let malformedReceiptCalls = 0;
let malformedExternalSends = 0;
let malformedReceiptNow = '2026-07-10T01:06:00.000Z';
const malformedSentKeys = new Set<string>();
const malformedReceiptProvider = {
  target: 'tauri',
  async deliverIdempotently(request) {
    malformedReceiptCalls += 1;

    if (!malformedSentKeys.has(request.idempotencyKey)) {
      malformedSentKeys.add(request.idempotencyKey);
      malformedExternalSends += 1;
    }

    return {
      providerMessageId: '',
      acceptedAt: '2026-07-10T01:06:00.000Z',
    };
  },
} as const satisfies NotificationDeliveryProvider;
const malformedReceiptService = createNotificationDeliveryService({
  providers: [malformedReceiptProvider],
  ledger: createInMemoryNotificationDeliveryLedger(),
  deepLinkPolicy: gameDeepLinkPolicy,
  claimLeaseMs: 1_000,
  now: () => malformedReceiptNow,
});
const malformedReceiptRequest = {
  ...androidRequest,
  target: 'tauri',
  recipient: 'tauri-subscription-1',
  idempotencyKey: 'notification-malformed-receipt',
} as const satisfies NotificationDeliveryRequest;

await assertRejects(
  () => malformedReceiptService.deliver(malformedReceiptRequest),
  'providerMessageId must be a non-empty',
  'a malformed provider receipt should fail validation',
);
const malformedReceiptRetry = await malformedReceiptService.deliver(malformedReceiptRequest);

assertEqual(
  malformedReceiptRetry.status,
  'in-flight',
  'a post-send validation failure should retain its claim until lease recovery',
);
assertEqual(
  malformedReceiptCalls,
  1,
  'a malformed post-send receipt must not trigger an immediate duplicate delivery',
);
malformedReceiptNow = '2026-07-10T01:06:01.000Z';
await assertRejects(
  () => malformedReceiptService.deliver(malformedReceiptRequest),
  'providerMessageId must be a non-empty',
  'an expired uncertain claim should retry through the idempotent provider',
);
assertEqual(malformedReceiptCalls, 2, 'lease recovery should invoke provider reconciliation');
assertEqual(
  malformedExternalSends,
  1,
  'the provider contract must keep lease recovery from sending externally twice',
);

let uncertainProviderCalls = 0;
const uncertainProvider = {
  target: 'telegram',
  async deliverIdempotently() {
    uncertainProviderCalls += 1;
    throw new Error('provider outcome is uncertain');
  },
} as const satisfies NotificationDeliveryProvider;
const uncertainService = createNotificationDeliveryService({
  providers: [uncertainProvider],
  ledger: createInMemoryNotificationDeliveryLedger(),
  now: () => '2026-07-10T01:07:00.000Z',
});
const uncertainRequest = {
  ...androidRequest,
  target: 'telegram',
  recipient: 'telegram-subscription-1',
  idempotencyKey: 'notification-uncertain-provider',
  deepLink: '/daily',
} as const satisfies NotificationDeliveryRequest;

await assertRejects(
  () => uncertainService.deliver(uncertainRequest),
  'provider outcome is uncertain',
  'ambiguous provider failures should be surfaced',
);
const uncertainRetry = await uncertainService.deliver(uncertainRequest);

assertEqual(uncertainRetry.status, 'in-flight', 'ambiguous failures should retain their claim');
assertEqual(uncertainProviderCalls, 1, 'ambiguous failures must not retry before lease recovery');

let expiredLeaseProviderCalls = 0;
const expiredLeaseLedger = {
  async claim() {
    return {
      status: 'claimed',
      claimToken: 'expired-claim',
      leaseExpiresAt: '2026-07-10T01:07:59.000Z',
    } as const;
  },
  async complete() {},
  async release() {},
} satisfies NotificationDeliveryLedger;
const expiredLeaseProvider = {
  target: 'browser',
  async deliverIdempotently() {
    expiredLeaseProviderCalls += 1;
    return {
      providerMessageId: 'must-not-send',
      acceptedAt: '2026-07-10T01:08:00.000Z',
    };
  },
} as const satisfies NotificationDeliveryProvider;
const expiredLeaseService = createNotificationDeliveryService({
  providers: [expiredLeaseProvider],
  ledger: expiredLeaseLedger,
  now: () => '2026-07-10T01:08:00.000Z',
});

await assertRejects(
  () => expiredLeaseService.deliver({
    ...uncertainRequest,
    target: 'browser',
    idempotencyKey: 'notification-expired-custom-lease',
  }),
  'expire in the future',
  'an expired custom ledger claim must be rejected before provider delivery',
);
assertEqual(expiredLeaseProviderCalls, 0, 'expired custom claims must not invoke providers');

const releaseFailure = new Error('claim release failed');
const staleReleaseLedger = {
  async claim() {
    return {
      status: 'claimed',
      claimToken: 'stale-release-claim',
      leaseExpiresAt: '2026-07-10T01:10:00.000Z',
    } as const;
  },
  async complete() {},
  async release() {
    throw releaseFailure;
  },
} satisfies NotificationDeliveryLedger;
const notSentError = new NotificationDeliveryNotSentError('provider did not send');
const staleReleaseProvider = {
  target: 'ios',
  async deliverIdempotently(): Promise<DeliveryReceipt> {
    throw notSentError;
  },
} as const satisfies NotificationDeliveryProvider;
const staleReleaseService = createNotificationDeliveryService({
  providers: [staleReleaseProvider],
  ledger: staleReleaseLedger,
  now: () => '2026-07-10T01:09:00.000Z',
});
const capturedNotSentError = await captureRejection(
  () => staleReleaseService.deliver({
    ...uncertainRequest,
    target: 'ios',
    idempotencyKey: 'notification-stale-release',
  }),
);

assertEqual(capturedNotSentError, notSentError, 'release failures must preserve provider errors');
assertEqual(
  notSentError.cause,
  releaseFailure,
  'release failures should remain observable as cause',
);

const completionReceipt = {
  providerMessageId: 'completion-race-message',
  acceptedAt: '2026-07-10T01:11:00.000Z',
} as const satisfies DeliveryReceipt;
let completionPersisted = false;
const completionRaceLedger = {
  async claim() {
    return completionPersisted
      ? {
          status: 'completed',
          receipt: completionReceipt,
        } as const
      : {
          status: 'claimed',
          claimToken: 'completion-race-claim',
          leaseExpiresAt: '2026-07-10T01:12:00.000Z',
        } as const;
  },
  async complete() {
    completionPersisted = true;
    throw new Error('completion response was lost');
  },
  async release() {},
} satisfies NotificationDeliveryLedger;
const completionRaceProvider = {
  target: 'reddit',
  async deliverIdempotently() {
    return completionReceipt;
  },
} as const satisfies NotificationDeliveryProvider;
const completionRaceService = createNotificationDeliveryService({
  providers: [completionRaceProvider],
  ledger: completionRaceLedger,
  now: () => '2026-07-10T01:11:00.000Z',
});
const reconciledCompletion = await completionRaceService.deliver({
  ...uncertainRequest,
  target: 'reddit',
  idempotencyKey: 'notification-completion-race',
});

assertEqual(
  reconciledCompletion.status,
  'delivered',
  'a persisted completion should reconcile after a lost ledger response',
);
assertEqual(
  reconciledCompletion.alreadyProcessed,
  true,
  'a reconciled completion should report the existing delivery',
);

let freshClaimCalls = 0;
const freshClaimCompletionTokens: string[] = [];
const freshClaimLedger = {
  async claim() {
    freshClaimCalls += 1;
    return freshClaimCalls === 1
      ? {
          status: 'claimed',
          claimToken: 'claim-before-provider-latency',
          leaseExpiresAt: '2026-07-10T01:12:01.000Z',
        } as const
      : {
          status: 'claimed',
          claimToken: 'claim-after-provider-latency',
          leaseExpiresAt: '2026-07-10T01:14:00.000Z',
        } as const;
  },
  async complete({ claimToken }) {
    freshClaimCompletionTokens.push(claimToken);

    if (claimToken === 'claim-before-provider-latency') {
      throw new Error('original claim expired before completion');
    }
  },
  async release() {},
} satisfies NotificationDeliveryLedger;
const freshClaimService = createNotificationDeliveryService({
  providers: [completionRaceProvider],
  ledger: freshClaimLedger,
  claimLeaseMs: 1_000,
  now: (() => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls === 1
        ? '2026-07-10T01:12:00.000Z'
        : '2026-07-10T01:13:00.000Z';
    };
  })(),
});
const completedWithFreshClaim = await freshClaimService.deliver({
  ...uncertainRequest,
  target: 'reddit',
  idempotencyKey: 'notification-fresh-completion-claim',
});

assertEqual(
  completedWithFreshClaim.status,
  'delivered',
  'a fresh reconciliation claim should persist the already validated receipt',
);
assertDeepEqual(
  freshClaimCompletionTokens,
  ['claim-before-provider-latency', 'claim-after-provider-latency'],
  'completion reconciliation should use the newly acquired fenced claim',
);

let exhaustedClaimId = 0;
const exhaustedCompletionTokens: string[] = [];
const exhaustedCompletionErrors: Error[] = [];
const exhaustedReleaseTokens: string[] = [];
const exhaustedCompletionLedger = {
  async claim() {
    exhaustedClaimId += 1;
    return {
      status: 'claimed',
      claimToken: `exhausted-claim-${String(exhaustedClaimId)}`,
      leaseExpiresAt: '2026-07-10T01:30:00.000Z',
    } as const;
  },
  async complete({ claimToken }) {
    exhaustedCompletionTokens.push(claimToken);
    const error = new Error(`completion failed for ${claimToken}`);
    exhaustedCompletionErrors.push(error);
    throw error;
  },
  async release({ claimToken }) {
    exhaustedReleaseTokens.push(claimToken);
  },
} satisfies NotificationDeliveryLedger;
const exhaustedCompletionService = createNotificationDeliveryService({
  providers: [completionRaceProvider],
  ledger: exhaustedCompletionLedger,
  now: () => '2026-07-10T01:20:00.000Z',
});
const exhaustedCompletionError = await captureRejection(
  () => exhaustedCompletionService.deliver({
    ...uncertainRequest,
    target: 'reddit',
    idempotencyKey: 'notification-exhausted-completion',
  }),
);

assertEqual(
  exhaustedCompletionError,
  exhaustedCompletionErrors[0],
  'completion exhaustion should preserve the first ledger error',
);
assertDeepEqual(
  exhaustedCompletionTokens,
  ['exhausted-claim-1', 'exhausted-claim-2', 'exhausted-claim-3'],
  'completion persistence should use exactly three bounded attempts',
);
assertDeepEqual(
  exhaustedReleaseTokens,
  ['exhausted-claim-4'],
  'the unused final reconciliation claim should be released after exhaustion',
);
assertEqual(
  exhaustedCompletionErrors[0]?.cause,
  exhaustedCompletionErrors[1],
  'later completion errors should remain observable from the first error',
);

const sharedLedger = createInMemoryNotificationDeliveryLedger();
const unavailableService = createNotificationDeliveryService({
  providers: [],
  ledger: sharedLedger,
});
const unavailableRequest = {
  ...androidRequest,
  target: 'reddit',
  recipient: 'reddit-user-1',
  idempotencyKey: 'notification-unavailable',
  deepLink: '/daily',
} as const satisfies NotificationDeliveryRequest;
const unavailable = await unavailableService.deliver(unavailableRequest);

assertEqual(
  unavailable.status,
  'unavailable',
  'a target without a provider should return unavailable',
);
const verse8Unavailable = await unavailableService.deliver({
  ...unavailableRequest,
  target: 'verse8',
  recipient: 'verse8-account-1',
  idempotencyKey: 'notification-verse8-unavailable',
});

assertEqual(
  verse8Unavailable.status,
  'unavailable',
  'Verse8 should remain a valid platform target when notifications are unavailable',
);

let recoveredUnavailableCalls = 0;
const recoveredProvider = {
  target: 'reddit',
  async deliverIdempotently() {
    recoveredUnavailableCalls += 1;
    return {
      providerMessageId: 'reddit-message-1',
      acceptedAt: '2026-07-10T01:10:00.000Z',
    };
  },
} as const satisfies NotificationDeliveryProvider;
const recoveredService = createNotificationDeliveryService({
  providers: [recoveredProvider],
  ledger: sharedLedger,
});
const recovered = await recoveredService.deliver(unavailableRequest);

assertEqual(
  recovered.status,
  'delivered',
  'unavailable targets should not consume the idempotency key before a provider exists',
);
assertEqual(recoveredUnavailableCalls, 1, 'the newly available provider should be called');

await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    idempotencyKey: 'notification-invalid-link',
    deepLink: 'javascript:alert(1)',
  }),
  'HTTP(S)',
  'unsafe deep links should fail validation',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    idempotencyKey: 'notification-untrusted-origin',
    deepLink: 'https://phishing.example/daily',
  }),
  'origin is not allowed',
  'absolute notification links should require a configured trusted origin',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    idempotencyKey: 'notification-backslash-link',
    deepLink: '/\\phishing.example/daily',
  }),
  'configured game origin',
  'root-relative links must not escape through URL backslashes',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    idempotencyKey: 'notification-invalid-recipient',
    recipient: '',
  }),
  'recipient must be a non-empty',
  'empty recipients should fail validation',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    idempotencyKey: '',
  }),
  'idempotencyKey must be a non-empty',
  'empty idempotency keys should fail validation',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    idempotencyKey: 'notification\ninjected',
  }),
  'control characters',
  'provider identifiers must reject header and log injection characters',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    idempotencyKey: 'notification-invalid-template',
    templateData: {
      nested: {
        unsupported: true,
      },
    },
  } as unknown as NotificationDeliveryRequest),
  'must be a string, number, or boolean',
  'nested template data should fail validation',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    idempotencyKey: 'notification-oversized-template',
    templateData: oversizedTemplateData(),
  }),
  'templateData must not contain more than 128 entries',
  'template data should enforce its entry bound before reading values',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    target: 'unknown-target',
    idempotencyKey: 'notification-invalid-target',
  } as unknown as NotificationDeliveryRequest),
  'supported PlatformTarget',
  'unknown platform targets should fail validation',
);
await assertRejects(
  () => deliveryService.deliver({
    ...androidRequest,
    topic: 'unknown-topic',
    idempotencyKey: 'notification-invalid-topic',
  } as unknown as NotificationDeliveryRequest),
  'supported NotificationTopic',
  'unknown notification topics should fail validation',
);

console.log('GameServices notification delivery tests passed.');

function createDurableTestProvider(): NotificationDeliveryProvider {
  return {
    target: 'browser',
    async deliverIdempotently(request) {
      const fingerprint = JSON.stringify(request);
      const existing = durableProviderOutbox.get(request.idempotencyKey);

      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error('provider idempotencyKey cannot be reused for another payload');
        }

        return existing.receipt;
      }

      durableExternalSends += 1;
      const receipt = {
        providerMessageId: 'durable-provider-message',
        acceptedAt: '2026-07-10T01:00:00.000Z',
      } as const satisfies DeliveryReceipt;
      durableProviderOutbox.set(request.idempotencyKey, {
        fingerprint,
        receipt,
      });
      return receipt;
    },
  };
}

function oversizedTemplateData(): Readonly<Record<string, string>> {
  const templateData: Record<string, string> = {};

  for (let index = 0; index <= 128; index += 1) {
    Object.defineProperty(templateData, `field-${String(index)}`, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('oversized template values must not be materialized');
      },
    });
  }

  return templateData;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, received ${actualJson}.`);
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expectedMessage: string,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }

    throw error;
  }

  throw new Error(`${message}: expected operation to reject.`);
}

async function captureRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error('Expected operation to reject.');
}
