import type { DevvitNotificationsConsentClient } from '../src/server/notifications-bridge.js';
import type {
  DevvitEnqueueResponse,
  DevvitNotificationsDeliveryClient,
} from '../src/server/notifications-delivery.js';

/**
 * The Devvit server's notifications plugin (`notifications` from
 * `@devvit/web/server`) and request context, in process: one set of
 * opted-in users, the current request's user, and the `enqueue` calls.
 */
export interface FakeDevvitNotifications
  extends DevvitNotificationsConsentClient, DevvitNotificationsDeliveryClient {
  readonly optedIn: Set<string>;
  /** The logged-in user of the current request (`context.userId`). */
  currentUserId: string | undefined;
  readonly optInCalls: number;
  readonly optOutCalls: number;
  readonly enqueueCalls: readonly {
    readonly title: string;
    readonly body: string;
    readonly userId: string;
    readonly link: string;
    readonly data: Readonly<Record<string, string>>;
  }[];
  /** Answers of the next opt-in calls; `success: true` when none is queued. */
  readonly optInAnswers: { readonly success: boolean; readonly message?: string }[];
  /** Answers of the next `enqueue` calls; a function throws or answers. */
  readonly enqueueAnswers: (DevvitEnqueueResponse | (() => Promise<DevvitEnqueueResponse>))[];
  /** Runs before each opt-in; a conformance harness checks its prompt script here. */
  beforeOptIn?: (() => void) | undefined;
}

export function createFakeDevvitNotifications(
  input: { readonly currentUserId?: string } = {},
): FakeDevvitNotifications {
  let optInCalls = 0;
  let optOutCalls = 0;
  const enqueueCalls: FakeDevvitNotifications['enqueueCalls'][number][] = [];
  const fake: FakeDevvitNotifications = {
    optedIn: new Set(),
    currentUserId: input.currentUserId,
    get optInCalls() {
      return optInCalls;
    },
    get optOutCalls() {
      return optOutCalls;
    },
    enqueueCalls,
    optInAnswers: [],
    enqueueAnswers: [],
    async optInCurrentUser() {
      optInCalls += 1;
      fake.beforeOptIn?.();
      const answer = fake.optInAnswers.shift() ?? { success: true };
      if (answer.success && fake.currentUserId !== undefined) {
        fake.optedIn.add(fake.currentUserId);
      }
      return answer;
    },
    async optOutCurrentUser() {
      optOutCalls += 1;
      if (fake.currentUserId !== undefined) {
        fake.optedIn.delete(fake.currentUserId);
      }
      return { success: true };
    },
    async isOptedIn(userId) {
      return fake.optedIn.has(userId);
    },
    async enqueue(options) {
      for (const recipient of options.recipients) {
        enqueueCalls.push({
          title: options.title,
          body: options.body,
          userId: recipient.userId,
          link: recipient.link,
          data: recipient.data,
        });
      }
      const next = fake.enqueueAnswers.shift();
      if (typeof next === 'function') {
        return next();
      }
      return next ?? { successCount: options.recipients.length, failureCount: 0, errors: [] };
    },
  };
  return fake;
}
