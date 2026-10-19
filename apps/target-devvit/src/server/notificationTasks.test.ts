import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { devvitNotificationSchedulerTasks } from '@mpgd/adapter-devvit/server';

import { handleNotificationTask, notificationTaskForPath } from './notificationTasks.js';

/** devvit.json from the source tree, wherever the test runs from. */
function readManifest(): { readonly scheduler?: { readonly tasks?: Record<string, { endpoint?: string; cron?: string }> } } {
  const relative = join('apps', 'target-devvit', 'devvit.json');
  for (const root of [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    join(import.meta.dirname, '..', '..', '..', '..'),
  ]) {
    if (root !== undefined && root.length > 0 && existsSync(join(root, relative))) {
      return JSON.parse(
        readFileSync(join(root, relative), 'utf8'),
      ) as ReturnType<typeof readManifest>;
    }
  }
  throw new Error(`Cannot locate ${relative}.`);
}

test('devvit.json declares each notifications scheduler task at its endpoint', () => {
  const tasks = readManifest().scheduler?.tasks ?? {};
  for (const declared of Object.values(devvitNotificationSchedulerTasks)) {
    assert.deepEqual(tasks[declared.name], { endpoint: declared.endpoint, cron: declared.cron });
  }
});

test('only the scheduler task paths name a task', () => {
  assert.equal(
    notificationTaskForPath('/internal/scheduler/mpgd-notifications-dispatch'),
    'dispatch',
  );
  assert.equal(notificationTaskForPath('/internal/scheduler/mpgd-notifications-purge'), 'purge');
  assert.equal(notificationTaskForPath('/internal/menu/create-post'), undefined);
});

test('a server without a notifications service answers the task without work', async () => {
  assert.deepEqual(await handleNotificationTask({ task: 'dispatch', notifications: undefined }), {
    status: 200,
    body: {},
    task: 'dispatch',
  });
});

test('a task runs one bounded batch and logs only when it did work', async () => {
  const limits: unknown[] = [];
  const logs: string[] = [];
  const notifications = {
    async dispatchDue(input?: { readonly limit?: number }) {
      limits.push(input?.limit);
      return {
        results: [
          { sendKey: 'k', outcome: { status: 'delivered' as const, alreadyProcessed: false } },
        ],
        failed: 0,
      };
    },
    async purge() {
      return { sends: 0, history: 0, endpoints: 0 };
    },
  };
  const log = (message: string): void => {
    logs.push(message);
  };
  const dispatched = await handleNotificationTask({ task: 'dispatch', notifications, log });
  assert.deepEqual(dispatched.result, { task: 'dispatch', replayed: 1, failed: 0 });
  // One short chunk: nothing more was due.
  assert.deepEqual(limits, [20]);
  const purged = await handleNotificationTask({ task: 'purge', notifications, log });
  assert.equal(purged.status, 200);
  assert.equal(logs.length, 1);
});

test('a failing task answers 500 and logs the error', async () => {
  const logged: unknown[] = [];
  const answer = await handleNotificationTask({
    task: 'purge',
    notifications: {
      dispatchDue: async () => ({ results: [], failed: 0 }),
      purge: async () => {
        throw new Error('redis down');
      },
    },
    log: (_message, error) => {
      logged.push(error);
    },
  });
  assert.equal(answer.status, 500);
  assert.match(String(logged[0]), /redis down/u);
});
