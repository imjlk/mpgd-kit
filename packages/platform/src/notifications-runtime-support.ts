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
export const eventBufferLimit = 64;

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

export function timestampOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    return normalizeNotificationTimestamp(value);
  } catch {
    return undefined;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
