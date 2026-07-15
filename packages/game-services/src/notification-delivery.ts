import type { NotificationTopic, PlatformTarget } from '@mpgd/platform';

import { assertOwnEnumerablePropertyLimit } from './validation';

const platformTargets = new Set<PlatformTarget>([
  'browser',
  'android',
  'ios',
  'ait',
  'reddit',
  'verse8',
  'telegram',
  'tauri',
]);
const notificationTopics = new Set<NotificationTopic>([
  'daily-ready',
  'streak-at-risk',
  'friend-challenge',
]);
const defaultClaimLeaseMs = 5 * 60 * 1_000;
const maxCompletionAttempts = 3;
const maxNotificationTemplateDataEntries = 128;

export type NotificationTemplateValue = string | number | boolean;
export type NotificationTemplateData = Readonly<Record<string, NotificationTemplateValue>>;

export interface NotificationDeliveryRequest {
  readonly target: PlatformTarget;
  readonly topic: NotificationTopic;
  readonly recipient: string;
  readonly idempotencyKey: string;
  readonly deepLink: string;
  readonly templateData: NotificationTemplateData;
}

export interface DeliveryReceipt {
  readonly providerMessageId: string;
  readonly acceptedAt: string;
}

export interface NotificationDeliveryProvider {
  readonly target: PlatformTarget;
  /**
   * MUST durably deduplicate concurrent and repeated calls by idempotencyKey
   * before sending externally, using a provider key or a durable outbox.
   */
  deliverIdempotently(request: NotificationDeliveryRequest): Promise<DeliveryReceipt>;
}

/** Throw only when the provider can prove that no external send was attempted. */
export class NotificationDeliveryNotSentError extends Error {
  override readonly name = 'NotificationDeliveryNotSentError';
}

export interface NotificationDeepLinkPolicy {
  /** Exact HTTP(S) origins permitted for absolute links. Root-relative links are always allowed. */
  readonly allowedOrigins?: readonly string[];
}

export interface NotificationDeliveryClaimOptions extends NotificationDeepLinkPolicy {
  readonly claimedAt: string;
  readonly leaseDurationMs: number;
}

export type NotificationDeliveryClaimResult =
  | {
    readonly status: 'claimed';
    readonly claimToken: string;
    readonly leaseExpiresAt: string;
  }
  | {
    readonly status: 'in-flight';
  }
  | {
    readonly status: 'completed';
    readonly receipt: DeliveryReceipt;
  };

export interface NotificationDeliveryLedger {
  /**
   * Atomically claims or returns an existing delivery for the idempotency key.
   * Expired claims must be reclaimable so a crashed worker cannot block delivery forever.
   * Implementations MUST bind the key to the full normalized request and reject payload reuse.
   */
  claim(
    request: NotificationDeliveryRequest,
    options: NotificationDeliveryClaimOptions,
  ): Promise<NotificationDeliveryClaimResult>;
  /**
   * MUST atomically fence on the current claimToken and idempotently persist one stable receipt.
   * A stale token must never overwrite a reclaimed or completed delivery.
   */
  complete(input: {
    readonly idempotencyKey: string;
    readonly claimToken: string;
    readonly receipt: DeliveryReceipt;
  }): Promise<void>;
  /** MUST delete only the current in-flight claim; stale tokens must not affect newer state. */
  release(input: {
    readonly idempotencyKey: string;
    readonly claimToken: string;
  }): Promise<void>;
}

export type NotificationDeliveryResult =
  | {
    readonly status: 'delivered';
    readonly alreadyProcessed: boolean;
    readonly receipt: DeliveryReceipt;
  }
  | {
    readonly status: 'in-flight';
    readonly alreadyProcessed: true;
  }
  | {
    readonly status: 'unavailable';
    readonly alreadyProcessed: false;
  };

export interface NotificationDeliveryService {
  deliver(request: NotificationDeliveryRequest): Promise<NotificationDeliveryResult>;
}

interface ClaimingNotificationDelivery {
  readonly status: 'claiming';
  readonly fingerprint: string;
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
}

interface CompletedNotificationDelivery {
  readonly status: 'completed';
  readonly fingerprint: string;
  readonly claimToken: string;
  readonly receipt: DeliveryReceipt;
}

type StoredNotificationDelivery =
  | ClaimingNotificationDelivery
  | CompletedNotificationDelivery;

/** Process-local test helper. Production services must provide a durable ledger. */
export class InMemoryNotificationDeliveryLedger implements NotificationDeliveryLedger {
  private readonly deliveriesByIdempotencyKey = new Map<string, StoredNotificationDelivery>();
  private nextClaimId = 1;

  async claim(
    input: NotificationDeliveryRequest,
    options: NotificationDeliveryClaimOptions,
  ): Promise<NotificationDeliveryClaimResult> {
    const policy: NotificationDeepLinkPolicy = options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins };
    const request = normalizeNotificationDeliveryRequest(input, policy);
    const claimedAt = normalizeTimestamp(options.claimedAt, 'claimedAt');
    const leaseDurationMs = normalizeLeaseDuration(options.leaseDurationMs);
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + leaseDurationMs).toISOString();
    const fingerprint = createNotificationDeliveryFingerprint(request);
    const existing = this.deliveriesByIdempotencyKey.get(request.idempotencyKey);

    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error('idempotencyKey cannot be reused for another notification delivery.');
      }

      if (existing.status === 'completed') {
        return {
          status: 'completed',
          receipt: existing.receipt,
        };
      }

      if (Date.parse(existing.leaseExpiresAt) > Date.parse(claimedAt)) {
        return { status: 'in-flight' };
      }
    }

    const claimToken = `notification-claim-${String(this.nextClaimId)}`;
    this.nextClaimId += 1;
    this.deliveriesByIdempotencyKey.set(request.idempotencyKey, {
      status: 'claiming',
      fingerprint,
      claimToken,
      leaseExpiresAt,
    });

    return {
      status: 'claimed',
      claimToken,
      leaseExpiresAt,
    };
  }

  async complete(input: {
    readonly idempotencyKey: string;
    readonly claimToken: string;
    readonly receipt: DeliveryReceipt;
  }): Promise<void> {
    const idempotencyKey = normalizeIdentifier(input.idempotencyKey, 'idempotencyKey');
    const claimToken = normalizeIdentifier(input.claimToken, 'claimToken');
    const receipt = normalizeDeliveryReceipt(input.receipt);
    const existing = this.deliveriesByIdempotencyKey.get(idempotencyKey);

    if (existing === undefined) {
      throw new Error('Cannot complete an unclaimed notification delivery.');
    }

    if (existing.claimToken !== claimToken) {
      throw new Error('claimToken does not own this notification delivery.');
    }

    if (existing.status === 'completed') {
      if (!deliveryReceiptsEqual(existing.receipt, receipt)) {
        throw new Error('A completed notification delivery cannot change its receipt.');
      }

      return;
    }

    this.deliveriesByIdempotencyKey.set(idempotencyKey, {
      status: 'completed',
      fingerprint: existing.fingerprint,
      claimToken,
      receipt,
    });
  }

  async release(input: {
    readonly idempotencyKey: string;
    readonly claimToken: string;
  }): Promise<void> {
    const idempotencyKey = normalizeIdentifier(input.idempotencyKey, 'idempotencyKey');
    const claimToken = normalizeIdentifier(input.claimToken, 'claimToken');
    const existing = this.deliveriesByIdempotencyKey.get(idempotencyKey);

    if (existing === undefined) {
      return;
    }

    if (existing.claimToken !== claimToken) {
      throw new Error('claimToken does not own this notification delivery.');
    }

    if (existing.status === 'completed') {
      throw new Error('A completed notification delivery cannot be released.');
    }

    this.deliveriesByIdempotencyKey.delete(idempotencyKey);
  }
}

export function createInMemoryNotificationDeliveryLedger(): InMemoryNotificationDeliveryLedger {
  return new InMemoryNotificationDeliveryLedger();
}

export function createNotificationDeliveryService(input: {
  readonly providers: readonly NotificationDeliveryProvider[];
  readonly ledger: NotificationDeliveryLedger;
  readonly deepLinkPolicy?: NotificationDeepLinkPolicy;
  readonly claimLeaseMs?: number;
  readonly now?: () => string;
}): NotificationDeliveryService {
  const providersByTarget = new Map<PlatformTarget, NotificationDeliveryProvider>();
  const allowedDeepLinkOrigins = normalizeAllowedDeepLinkOrigins(
    input.deepLinkPolicy?.allowedOrigins,
  );
  const ledger = input.ledger;
  const claimLeaseMs = normalizeLeaseDuration(input.claimLeaseMs ?? defaultClaimLeaseMs);
  const now = input.now ?? (() => new Date().toISOString());

  for (const provider of input.providers) {
    const target = normalizePlatformTarget(provider.target);

    if (providersByTarget.has(target)) {
      throw new Error(`Only one notification provider can be registered for ${target}.`);
    }

    providersByTarget.set(target, provider);
  }

  const claimDelivery = async (
    request: NotificationDeliveryRequest,
  ): Promise<NotificationDeliveryClaimResult> => {
    const claimedAt = normalizeTimestamp(now(), 'now()');
    const result = await ledger.claim(request, {
      claimedAt,
      leaseDurationMs: claimLeaseMs,
      allowedOrigins: [...allowedDeepLinkOrigins],
    });

    return normalizeNotificationDeliveryClaimResult(result, claimedAt);
  };
  const completeDelivery = async (
    request: NotificationDeliveryRequest,
    initialClaimToken: string,
    receipt: DeliveryReceipt,
  ): Promise<NotificationDeliveryResult | undefined> => {
    let claimToken = initialClaimToken;
    let firstCompletionError: unknown;

    // Bound total persistence attempts (the initial claim plus at most two reclaimed claims).
    for (let attempt = 0; attempt < maxCompletionAttempts; attempt += 1) {
      try {
        await ledger.complete({
          idempotencyKey: request.idempotencyKey,
          claimToken,
          receipt,
        });
        return undefined;
      } catch (completionError) {
        if (firstCompletionError === undefined) {
          firstCompletionError = completionError;
        } else {
          attachSecondaryError(firstCompletionError, completionError);
        }

        let reconciledClaim: NotificationDeliveryClaimResult;

        try {
          reconciledClaim = await claimDelivery(request);
        } catch (reconciliationError) {
          attachSecondaryError(firstCompletionError, reconciliationError);
          throw firstCompletionError;
        }

        if (reconciledClaim.status === 'completed') {
          return {
            status: 'delivered',
            alreadyProcessed: true,
            receipt: reconciledClaim.receipt,
          };
        }

        if (reconciledClaim.status === 'in-flight') {
          return {
            status: 'in-flight',
            alreadyProcessed: true,
          };
        }

        claimToken = reconciledClaim.claimToken;
      }
    }

    try {
      await ledger.release({
        idempotencyKey: request.idempotencyKey,
        claimToken,
      });
    } catch (releaseError) {
      attachSecondaryError(firstCompletionError, releaseError);
    }

    throw firstCompletionError;
  };

  return {
    async deliver(deliveryInput) {
      const request = normalizeNotificationDeliveryRequest(deliveryInput, {
        allowedOrigins: [...allowedDeepLinkOrigins],
      });
      const claim = await claimDelivery(request);

      if (claim.status === 'completed') {
        return {
          status: 'delivered',
          alreadyProcessed: true,
          receipt: claim.receipt,
        };
      }

      if (claim.status === 'in-flight') {
        return {
          status: 'in-flight',
          alreadyProcessed: true,
        };
      }

      const provider = providersByTarget.get(request.target);

      if (provider === undefined) {
        await ledger.release({
          idempotencyKey: request.idempotencyKey,
          claimToken: claim.claimToken,
        });

        return {
          status: 'unavailable',
          alreadyProcessed: false,
        };
      }

      let receiptInput: unknown;

      try {
        receiptInput = await provider.deliverIdempotently(request);
      } catch (error) {
        if (error instanceof NotificationDeliveryNotSentError) {
          try {
            await ledger.release({
              idempotencyKey: request.idempotencyKey,
              claimToken: claim.claimToken,
            });
          } catch (releaseError) {
            attachSecondaryError(error, releaseError);
          }
        }

        throw error;
      }

      // Once a provider resolves, delivery may already have happened. Keep the
      // claim on validation or completion failure so an immediate retry cannot
      // send a duplicate; the lease provides explicit recovery semantics.
      const receipt = normalizeDeliveryReceipt(receiptInput);

      const reconciliation = await completeDelivery(
        request,
        claim.claimToken,
        receipt,
      );

      if (reconciliation !== undefined) {
        return reconciliation;
      }

      return {
        status: 'delivered',
        alreadyProcessed: false,
        receipt,
      };
    },
  };
}

export function normalizeNotificationDeliveryRequest(
  input: unknown,
  policy: NotificationDeepLinkPolicy = {},
): NotificationDeliveryRequest {
  assertRecord(input, 'NotificationDeliveryRequest');
  const allowedDeepLinkOrigins = normalizeAllowedDeepLinkOrigins(policy.allowedOrigins);

  return {
    target: normalizePlatformTarget(input.target),
    topic: normalizeNotificationTopic(input.topic),
    recipient: normalizeIdentifier(input.recipient, 'recipient'),
    idempotencyKey: normalizeIdentifier(input.idempotencyKey, 'idempotencyKey'),
    deepLink: normalizeDeepLink(input.deepLink, allowedDeepLinkOrigins),
    templateData: normalizeTemplateData(input.templateData),
  };
}

function normalizePlatformTarget(input: unknown): PlatformTarget {
  const target = normalizeIdentifier(input, 'target') as PlatformTarget;

  if (!platformTargets.has(target)) {
    throw new Error('target must be a supported PlatformTarget.');
  }

  return target;
}

function normalizeNotificationTopic(input: unknown): NotificationTopic {
  const topic = normalizeIdentifier(input, 'topic') as NotificationTopic;

  if (!notificationTopics.has(topic)) {
    throw new Error('topic must be a supported NotificationTopic.');
  }

  return topic;
}

export function normalizeDeliveryReceipt(input: unknown): DeliveryReceipt {
  assertRecord(input, 'DeliveryReceipt');

  return {
    providerMessageId: normalizeIdentifier(
      input.providerMessageId,
      'providerMessageId',
    ),
    acceptedAt: normalizeTimestamp(input.acceptedAt, 'acceptedAt'),
  };
}

function normalizeNotificationDeliveryClaimResult(
  input: unknown,
  claimedAt: string,
): NotificationDeliveryClaimResult {
  assertRecord(input, 'NotificationDeliveryClaimResult');

  switch (input.status) {
    case 'claimed': {
      const leaseExpiresAt = normalizeTimestamp(input.leaseExpiresAt, 'leaseExpiresAt');

      if (Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) {
        throw new Error('Notification delivery claim lease must expire in the future.');
      }

      return {
        status: 'claimed',
        claimToken: normalizeIdentifier(input.claimToken, 'claimToken'),
        leaseExpiresAt,
      };
    }
    case 'in-flight':
      return { status: 'in-flight' };
    case 'completed':
      return {
        status: 'completed',
        receipt: normalizeDeliveryReceipt(input.receipt),
      };
    default:
      throw new Error('NotificationDeliveryClaimResult has an unsupported status.');
  }
}

function normalizeTemplateData(input: unknown): NotificationTemplateData {
  assertRecord(input, 'templateData');
  assertOwnEnumerablePropertyLimit(input, maxNotificationTemplateDataEntries, 'templateData');
  const inputEntries = Object.entries(input);

  const entries = inputEntries.map(([key, value]) => {
    const normalizedKey = normalizeIdentifier(key, 'templateData key');

    if (
      typeof value !== 'string'
      && typeof value !== 'number'
      && typeof value !== 'boolean'
    ) {
      throw new Error(`templateData.${key} must be a string, number, or boolean.`);
    }

    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`templateData.${key} must be a finite number.`);
    }

    if (typeof value === 'string' && value.length > 16_384) {
      throw new Error(`templateData.${key} must contain at most 16384 characters.`);
    }

    return [normalizedKey, value] as const;
  });

  entries.sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.fromEntries(entries);
}

function normalizeDeepLink(
  input: unknown,
  allowedOrigins: ReadonlySet<string>,
): string {
  const deepLink = normalizeIdentifier(input, 'deepLink');

  if (/[\x00-\x1F\x7F]/u.test(deepLink)) {
    throw new Error('deepLink must not contain control characters.');
  }

  if (deepLink.startsWith('/') && !deepLink.startsWith('//')) {
    const baseUrl = new URL('https://mpgd.invalid');
    const parsed = new URL(deepLink, baseUrl);

    if (parsed.origin !== baseUrl.origin) {
      throw new Error('deepLink must stay on the configured game origin.');
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  let parsed: URL;

  try {
    parsed = new URL(deepLink);
  } catch {
    throw new Error('deepLink must be an absolute URL or root-relative path.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('deepLink must use an HTTP(S) URL.');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('deepLink must not contain URL credentials.');
  }

  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error('deepLink origin is not allowed.');
  }

  return parsed.toString();
}

function normalizeAllowedDeepLinkOrigins(
  input: readonly string[] | undefined,
): ReadonlySet<string> {
  const origins = new Set<string>();

  for (const [index, value] of (input ?? []).entries()) {
    const originInput = normalizeIdentifier(value, `allowedOrigins[${String(index)}]`);
    let parsed: URL;

    try {
      parsed = new URL(originInput);
    } catch {
      throw new Error(`allowedOrigins[${String(index)}] must be an HTTP(S) origin.`);
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`allowedOrigins[${String(index)}] must be an HTTP(S) origin.`);
    }

    if (
      parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      throw new Error(`allowedOrigins[${String(index)}] must not include credentials or a path.`);
    }

    origins.add(parsed.origin);
  }

  return origins;
}

function normalizeLeaseDuration(input: unknown): number {
  if (
    typeof input !== 'number'
    || !Number.isSafeInteger(input)
    || input <= 0
    || input > 24 * 60 * 60 * 1_000
  ) {
    throw new Error('claimLeaseMs must be a positive integer no greater than 24 hours.');
  }

  return input;
}

function createNotificationDeliveryFingerprint(
  request: NotificationDeliveryRequest,
): string {
  return JSON.stringify([
    request.target,
    request.topic,
    request.recipient,
    request.deepLink,
    request.templateData,
  ]);
}

function deliveryReceiptsEqual(left: DeliveryReceipt, right: DeliveryReceipt): boolean {
  return (
    left.providerMessageId === right.providerMessageId
    && left.acceptedAt === right.acceptedAt
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

function attachSecondaryError(primary: unknown, secondary: unknown): void {
  if (primary instanceof Error && primary.cause === undefined) {
    primary.cause = secondary;
  }
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function normalizeIdentifier(input: unknown, label: string): string {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > 2_048
    || input.trim() !== input
  ) {
    throw new Error(`${label} must be a non-empty, trimmed string.`);
  }

  if (/[\x00-\x1F\x7F]/u.test(input)) {
    throw new Error(`${label} must not contain control characters.`);
  }

  return input;
}

function normalizeTimestamp(input: unknown, label: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${label} must be a valid timestamp.`);
  }

  const timestamp = Date.parse(input);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid timestamp.`);
  }

  return new Date(timestamp).toISOString();
}
