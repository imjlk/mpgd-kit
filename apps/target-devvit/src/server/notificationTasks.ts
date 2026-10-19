import {
  devvitNotificationTaskForEndpoint,
  runDevvitNotificationTask,
  type DevvitNotificationTask,
  type DevvitNotificationTaskResult,
} from '@mpgd/adapter-devvit/server';

/**
 * The notifications scheduler tasks of `devvit.json` (`scheduler.tasks`):
 * `mpgd-notifications-dispatch` runs the notifications scheduler every
 * minute (due server reminders and due sends, for at most about 20
 * seconds) and `mpgd-notifications-purge` purges old rows in bounded
 * batches every five minutes (`runDevvitNotificationTask` from
 * `@mpgd/adapter-devvit/server`).
 * A server without a notifications service (no topic catalog yet) answers
 * the tasks without work.
 */
export interface NotificationTaskAnswer {
  readonly status: number;
  /** A `TaskResponse` (`{}`) from `@devvit/web/server`. */
  readonly body: Record<string, never>;
  readonly task: DevvitNotificationTask;
  readonly result?: DevvitNotificationTaskResult;
}

/** The task an internal scheduler path names, or `undefined` for any other path. */
export function notificationTaskForPath(pathname: string): DevvitNotificationTask | undefined {
  return devvitNotificationTaskForEndpoint(pathname);
}

/**
 * Runs `task`. A failure answers 500 (so the Devvit
 * logs show it) and is logged; the next run tries again.
 */
export async function handleNotificationTask(input: {
  readonly task: DevvitNotificationTask;
  /** The service's `runScheduler` and `purge` (`createDevvitNotificationService(...).service`). */
  readonly notifications: Parameters<typeof runDevvitNotificationTask>[0] | undefined;
  readonly log?: (message: string, error?: unknown) => void;
}): Promise<NotificationTaskAnswer> {
  const log = input.log ?? ((message: string, error?: unknown) => {
    if (error === undefined) {
      console.log(message);
    } else {
      console.error(message, error);
    }
  });
  if (input.notifications === undefined) {
    return { status: 200, body: {}, task: input.task };
  }
  try {
    const result = await runDevvitNotificationTask(input.notifications, input.task);
    if (
      (result.task === 'dispatch' && (result.touched > 0 || result.failed > 0))
      || (result.task === 'purge' && result.sends + result.history + result.endpoints > 0)
    ) {
      log(`devvit notifications ${result.task}: ${JSON.stringify(result)}`);
    }
    return { status: 200, body: {}, task: input.task, result };
  } catch (error) {
    log(`devvit notifications ${input.task} task failed`, error);
    return { status: 500, body: {}, task: input.task };
  }
}
