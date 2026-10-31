import type { NotificationDeliveryProviderEntry } from './notifications-policy.js';
import {
  assertRecordNotificationNoticeInput,
  normalizeNotificationTimestamp,
  NotificationError,
  notificationKeyIssue,
  notificationTemplateDataIssue,
  type NotificationEvent,
  type NotificationNoticeIdentity,
  type RecordNotificationNoticeInput,
  type SetNotificationReminderInput,
} from './notifications.js';

/**
 * Helpers the notifications runtime and the conformance runner share. Not a
 * package entry: `@mpgd/platform/notifications-runtime` and
 * `@mpgd/platform/notifications-conformance` are.
 */

/** Events a provider or runtime keeps for its first listener. */
const eventBufferLimit = 64;

/**
 * Buffers an event for the first listener, keeping at most
 * `eventBufferLimit`: past it the oldest event that is not an open goes first,
 * so a cold-start open is not lost to later events.
 */
export function bufferEvent(buffer: NotificationEvent[], event: NotificationEvent): void {
  buffer.push(event);
  if (buffer.length > eventBufferLimit) {
    const evicted = buffer.findIndex((buffered) => buffered.type !== 'opened');
    buffer.splice(evicted === -1 ? 0 : evicted, 1);
  }
}

/** Calls every listener with every event, in order; returns the errors they threw. */
export function deliverEach(
  listeners: readonly ((event: NotificationEvent) => void)[],
  events: readonly NotificationEvent[],
): unknown[] {
  const errors: unknown[] = [];
  for (const event of events) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  return errors;
}

/** A well-formed `notices.recordShown` input, or `NOTIFICATIONS_INVALID_INPUT`. */
export function recordNoticeInputOf(input: unknown): RecordNotificationNoticeInput {
  try {
    return assertRecordNotificationNoticeInput(input);
  } catch (error) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'A notice is a listed notice, or its kind, the kind and time of the record it reports '
        + `on, and its dueBy: ${describeError(error)}`,
      cause: error,
    });
  }
}

/**
 * Only the fields that name a notice, with the record time in the canonical
 * form; a listed notice's `record.state` and `textVersion` are left out.
 */
export function noticeIdentityOf(notice: NotificationNoticeIdentity): NotificationNoticeIdentity {
  return {
    kind: notice.kind,
    record: { kind: notice.record.kind, at: normalizeNotificationTimestamp(notice.record.at) },
    dueBy: notice.dueBy,
  };
}

/** Why a reminder's input breaks the RFC bounds, or `undefined`. */
export function reminderInputIssue(input: SetNotificationReminderInput): string | undefined {
  const keyIssue = notificationKeyIssue(input.key);
  if (keyIssue !== undefined) {
    return `key: ${keyIssue}`;
  }
  if (timestampOrUndefined(input.fireAt) === undefined) {
    return 'fireAt: expected RFC 3339 with an explicit offset';
  }
  if (input.templateData !== undefined) {
    const issue = notificationTemplateDataIssue(input.templateData);
    if (issue !== undefined) {
      return `templateData: ${issue}`;
    }
  }
  if (input.link !== undefined && !isBoundedText(input.link)) {
    return 'link: expected a non-empty string';
  }
  return undefined;
}

export function isBoundedText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384;
}

function timestampOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    return normalizeNotificationTimestamp(value);
  } catch {
    return undefined;
  }
}

/**
 * An error's name and message, or a thrown value's text, for another error's
 * message. Never throws: a getter or `toString` that throws, or a `Proxy`
 * whose traps throw, reads as a failure that cannot be read.
 */
export function describeError(error: unknown): string {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return 'a failure that cannot be read';
  }
}

/** An error's message, or a thrown value's text; never throws, as `describeError`. */
export function errorMessageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'a failure that cannot be read';
  }
}

/**
 * A registry entry the runtime can compare its provider with, as a plain
 * copy, or why it cannot. Only the fields `notificationRegistryMismatch`
 * reads are checked, so an entry with fields a newer backend added still
 * compares. The copy is plain data, so a getter or `Proxy` in the entry
 * cannot answer differently later; an entry that cannot be copied is refused.
 */
export function comparableRegistryEntry(
  entry: unknown,
): { readonly entry: NotificationDeliveryProviderEntry } | { readonly issue: string } {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(entry)) as unknown;
  } catch {
    return { issue: 'it cannot be read as JSON' };
  }
  if (!isRecord(copy)) {
    return { issue: 'it is not an object' };
  }
  const { provider, addressing, content, purposes, permission } = copy;
  if (typeof provider !== 'string' || provider.length === 0) {
    return { issue: 'provider is not a non-empty string' };
  }
  if (typeof addressing !== 'string' || typeof content !== 'string') {
    return { issue: 'addressing or content is not a string' };
  }
  if (!Array.isArray(purposes) || !purposes.every((purpose) => typeof purpose === 'string')) {
    return { issue: 'purposes is not a list of strings' };
  }
  if (
    !isRecord(permission)
    || typeof permission['scope'] !== 'string'
    || typeof permission['serverReadable'] !== 'boolean'
    || typeof permission['allowance'] !== 'string'
  ) {
    return { issue: 'permission is not { scope, serverReadable, allowance }' };
  }
  return { entry: copy as unknown as NotificationDeliveryProviderEntry };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
