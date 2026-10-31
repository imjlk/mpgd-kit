import {
  isValidNotificationTimeZone,
  NotificationError,
  notificationKeyIssue,
  notificationReservedKeyPrefix,
  type NotificationDeliveryOutcome,
} from '@mpgd/platform/notifications';

import type { NotificationRemoteBulkCapability } from './delivery-provider.js';

/**
 * Bulk sends (notifications v2 RFC, open question 5; BK1): the request and
 * answer types of `NotificationService.deliverBulk`, and the small pieces it
 * is built from. A bulk send is many single sends that share provider calls:
 * each recipient keeps its own key, ledger row, gate check, and answer.
 */

/** Most recipients one `deliverBulk` call takes. */
export const maxNotificationBulkRecipients = 10_000;

/** One recipient of a bulk send. Its own fields replace the send's shared ones. */
export interface NotificationBulkRecipientInput {
  readonly player: string;
  readonly templateData?: Readonly<Record<string, string | number | boolean>>;
  readonly data?: Readonly<Record<string, string>>;
  /** The locale the gate resolves this recipient's copy for, else the registered one. */
  readonly locale?: string;
  readonly link?: string;
}

/**
 * A bulk send from the game's server or an operator tool, never from a
 * client session (the Worker serves it only on the service binding).
 */
export interface NotificationBulkDeliverInput {
  /**
   * The bulk send's key. Each recipient's send key is
   * `<idempotencyKey>:<encodeURIComponent(player)>`, so the same call
   * retried answers recipients already sent from the ledger and sends only
   * the rest.
   */
  readonly idempotencyKey: string;
  /** The one provider every recipient is sent through. */
  readonly provider: string;
  readonly topic: string;
  /** 1 to `maxNotificationBulkRecipients` recipients, each player once. */
  readonly recipients: readonly NotificationBulkRecipientInput[];
  readonly templateData?: Readonly<Record<string, string | number | boolean>>;
  readonly data?: Readonly<Record<string, string>>;
  readonly locale?: string;
  readonly link?: string;
  /**
   * Recipients per provider call, at most the provider's
   * `bulk.maxRecipients` (its maximum by default; 100 for a provider that
   * sends one by one).
   */
  readonly batchSize?: number;
}

/** What the host that serves `deliverBulk` bounds a call by. */
export interface NotificationBulkDeliverOptions {
  /** Wall time after which no further batch starts; 20 seconds by default. */
  readonly budgetMs?: number;
  /**
   * Deliveries one call attempts at most (sends it makes or replays, one
   * per device of a device provider); recipients past it answer
   * `not-attempted` (`count-budget`). A recipient answered from the ledger
   * does not count. The recipient that crosses it is still sent to every
   * device it has, and the recipients of one batch are prepared side by
   * side, so they may pass it by a few.
   */
  readonly maxRecipients?: number;
  /**
   * Recipients whose key one call reads at most, in the order of the
   * request, whether or not they then need an attempt; the rest answer
   * `not-attempted` (`count-budget`). It bounds the ledger reads of a large
   * retry, which `maxRecipients` does not.
   */
  readonly maxLookups?: number;
}

/** Why a recipient was not attempted in this call; the same call retried attempts it. */
export type NotificationBulkNotAttemptedReason =
  /** The provider's app-wide `rate` (Devvit: 25,000 a day) has no room left now. */
  | 'provider-rate'
  /** The call's wall-time budget ran out before this recipient's batch. */
  | 'time-budget'
  /** The host's per-call recipient or read budget ran out. */
  | 'count-budget';

export type NotificationBulkRecipientResult =
  | {
      readonly player: string;
      readonly idempotencyKey: string;
      readonly status: 'answered';
      /** What `deliver` would answer for this recipient's key. */
      readonly outcome: NotificationDeliveryOutcome;
    }
  | {
      readonly player: string;
      readonly idempotencyKey: string;
      readonly status: 'not-attempted';
      readonly reason: NotificationBulkNotAttemptedReason;
    }
  | {
      readonly player: string;
      readonly idempotencyKey: string;
      readonly status: 'failed';
      /** As `deliver` would have thrown it: a retryable error may pass on a retry of the call. */
      readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
    };

export interface NotificationBulkSummary {
  /** Delivered by this call. */
  readonly delivered: number;
  /** Delivered by an earlier call with the same key. */
  readonly alreadyProcessed: number;
  readonly deferred: number;
  readonly inFlight: number;
  readonly suppressed: number;
  readonly unavailable: number;
  readonly notAttempted: number;
  readonly failed: number;
}

export interface NotificationBulkDeliveryResult {
  /** One per recipient, in the order of the request. */
  readonly recipients: readonly NotificationBulkRecipientResult[];
  readonly summary: NotificationBulkSummary;
  /** Provider calls this call made: bulk calls, and recipients sent one per call. */
  readonly providerCalls: { readonly batch: number; readonly single: number };
}

/** A checked bulk request with its recipients' send keys. */
export interface ParsedNotificationBulkRequest {
  readonly input: NotificationBulkDeliverInput;
  readonly keys: readonly string[];
}

/** The send key of one recipient of a bulk send. */
export function notificationBulkRecipientKey(idempotencyKey: string, player: string): string {
  return `${idempotencyKey}:${encodeURIComponent(player)}`;
}

/**
 * A well-formed bulk request, or `NOTIFICATIONS_INVALID_INPUT` for the whole
 * call. Each recipient's own request (its template data, data, locale, and
 * link, and its derived key) is checked later as a single send's is, and
 * fails that recipient alone.
 */
export function parseNotificationBulkRequest(raw: unknown): ParsedNotificationBulkRequest {
  if (!isPlainObject(raw)) {
    throw invalid('A bulk send is an object.');
  }
  const known = new Set([
    'idempotencyKey',
    'provider',
    'topic',
    'recipients',
    'templateData',
    'data',
    'locale',
    'link',
    'batchSize',
  ]);
  const unknown = Object.keys(raw).find((key) => !known.has(key));
  if (unknown !== undefined) {
    throw invalid(`Invalid bulk send: ${unknown}: not a bulk send field.`);
  }
  if (typeof raw.idempotencyKey !== 'string') {
    throw invalid('Invalid bulk send: idempotencyKey: expected a string.');
  }
  const keyIssue = notificationKeyIssue(raw.idempotencyKey);
  if (keyIssue !== undefined) {
    throw invalid(`Invalid bulk send: idempotencyKey: ${keyIssue}.`);
  }
  const reserved = notificationReservedKeyPrefix(raw.idempotencyKey);
  if (reserved !== undefined) {
    throw invalid(
      `Invalid bulk send: idempotencyKey: the ${reserved} prefix is reserved for the scheduler.`,
    );
  }
  for (const name of ['provider', 'topic'] as const) {
    if (typeof raw[name] !== 'string' || raw[name].length === 0 || raw[name].length > 2048) {
      throw invalid(`Invalid bulk send: ${name}: expected a non-empty string.`);
    }
  }
  if (
    raw.batchSize !== undefined
    && !(typeof raw.batchSize === 'number' && Number.isSafeInteger(raw.batchSize) && raw.batchSize >= 1)
  ) {
    throw invalid('Invalid bulk send: batchSize: expected a positive integer.');
  }
  const recipients = raw.recipients;
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > maxNotificationBulkRecipients) {
    throw invalid(
      `Invalid bulk send: recipients: expected 1 to ${maxNotificationBulkRecipients} recipients.`,
    );
  }
  const recipientFields = new Set(['player', 'templateData', 'data', 'locale', 'link']);
  const players = new Set<string>();
  const keys: string[] = [];
  for (const [index, recipient] of recipients.entries()) {
    if (!isPlainObject(recipient)) {
      throw invalid(`Invalid bulk send: recipients[${index}]: expected an object.`);
    }
    const field = Object.keys(recipient).find((key) => !recipientFields.has(key));
    if (field !== undefined) {
      throw invalid(`Invalid bulk send: recipients[${index}].${field}: not a recipient field.`);
    }
    const player = recipient.player;
    if (typeof player !== 'string' || player.length === 0 || player.length > 2048) {
      throw invalid(`Invalid bulk send: recipients[${index}].player: expected a non-empty string.`);
    }
    if (players.has(player)) {
      // One send per player: a second would be a second key for the same push.
      throw invalid(`Invalid bulk send: recipients[${index}].player: a player is named once.`);
    }
    players.add(player);
    keys.push(notificationBulkRecipientKey(raw.idempotencyKey, player));
  }
  return { input: raw as unknown as NotificationBulkDeliverInput, keys };
}

/**
 * A provider's bulk capability as the registry accepts it: whole numbers,
 * a minimum no larger than the maximum, and a hold window of two `HH:MM`
 * times in a valid time zone. Throws a `TypeError` naming the issue.
 */
export function assertNotificationBulkCapability(
  capability: NotificationRemoteBulkCapability,
  at: string,
): void {
  const { maxRecipients, minRecipients, perRecipientOutcomes, holdWindow } = capability;
  if (!Number.isSafeInteger(maxRecipients) || maxRecipients < 1) {
    throw new TypeError(`${at}.bulk.maxRecipients must be a positive integer.`);
  }
  if (
    minRecipients !== undefined
    && (!Number.isSafeInteger(minRecipients) || minRecipients < 1 || minRecipients > maxRecipients)
  ) {
    throw new TypeError(
      `${at}.bulk.minRecipients must be a positive integer no larger than maxRecipients.`,
    );
  }
  if (typeof perRecipientOutcomes !== 'boolean') {
    throw new TypeError(`${at}.bulk.perRecipientOutcomes must be a boolean.`);
  }
  if (holdWindow !== undefined) {
    if (
      minutesOf(holdWindow.start) === undefined
      || minutesOf(holdWindow.end) === undefined
      || holdWindow.start === holdWindow.end
      || !isValidNotificationTimeZone(holdWindow.timeZone)
    ) {
      throw new TypeError(
        `${at}.bulk.holdWindow needs two different HH:MM times and a valid time zone.`,
      );
    }
  }
}

/** Whether `at` (epoch milliseconds) falls inside a provider's hold window. */
export function isInsideNotificationHoldWindow(
  window: NotificationRemoteBulkCapability['holdWindow'],
  at: number,
): boolean {
  if (window === undefined) {
    return false;
  }
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (start === undefined || end === undefined) {
    return false;
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: window.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const now = hour * 60 + minute;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function minutesOf(time: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time);
  return match === null ? undefined : Number(match[1]) * 60 + Number(match[2]);
}

/** A counting semaphore: at most `concurrency` holders at once, served in order. */
export function createNotificationLimiter(concurrency: number): {
  acquire(): Promise<void>;
  release(): void;
} {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    acquire() {
      if (active < concurrency) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    release() {
      const next = waiting.shift();
      if (next === undefined) {
        active -= 1;
      } else {
        // The slot passes to the next waiter.
        next();
      }
    },
  };
}

/**
 * Gathers the provider calls of a known number of participants into one
 * flush. Each participant either arrives with its item, and waits for its
 * answer, or leaves without one; once every participant did one or the
 * other, `flush` runs once with the arrived items and answers each in
 * order. A participant that holds a concurrency slot gives it up before it
 * waits (see `deliverBulk`), so the barrier never waits on a participant
 * that cannot run.
 */
export function createNotificationBatchBarrier<Item, Answer>(
  participants: number,
  flush: (items: readonly Item[]) => Promise<readonly Answer[]>,
): { arrive(item: Item): Promise<Answer>; leave(): void } {
  const arrived: { readonly item: Item; readonly resolve: (answer: Answer) => void; readonly reject: (error: unknown) => void }[] = [];
  let left = 0;
  let flushed = false;
  const maybeFlush = (): void => {
    if (flushed || arrived.length + left < participants) {
      return;
    }
    flushed = true;
    if (arrived.length === 0) {
      return;
    }
    const items = arrived.map((entry) => entry.item);
    flush(items).then(
      (answers) => {
        arrived.forEach((entry, index) => {
          const answer = answers[index];
          if (answer === undefined) {
            entry.reject(new TypeError('The batch flush answered fewer items than it took.'));
          } else {
            entry.resolve(answer);
          }
        });
      },
      (error: unknown) => {
        for (const entry of arrived) {
          entry.reject(error);
        }
      },
    );
  };
  return {
    arrive(item) {
      if (flushed) {
        return Promise.reject(new TypeError('The batch was already flushed.'));
      }
      return new Promise<Answer>((resolve, reject) => {
        arrived.push({ item, resolve, reject });
        maybeFlush();
      });
    },
    leave() {
      left += 1;
      maybeFlush();
    },
  };
}

function invalid(message: string): NotificationError {
  return new NotificationError('NOTIFICATIONS_INVALID_INPUT', { message });
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
