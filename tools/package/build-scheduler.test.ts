import assert from 'node:assert/strict';

import { runInDependencyOrder, type ScheduledTask } from './build-scheduler';

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    throw new Error(`Package build scheduler case failed: ${name}`, { cause: error });
  }
}

function task(name: string, dependencies: readonly string[] = []): ScheduledTask {
  return { name, dependencies };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

await check('dependencies finish before dependents and concurrency is bounded', async () => {
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await runInDependencyOrder(
    [
      task('a'),
      task('b'),
      task('c'),
      task('d', ['a', 'b']),
      task('e', ['d', 'outside-the-build']),
    ],
    2,
    async ({ name }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start ${name}`);
      await tick();
      events.push(`end ${name}`);
      inFlight -= 1;
    },
  );

  assert.equal(maxInFlight, 2);
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    assert.equal(events.filter((event) => event === `start ${name}`).length, 1);
  }
  const at = (event: string) => events.indexOf(event);
  assert.ok(at('start d') > at('end a') && at('start d') > at('end b'));
  assert.ok(at('start e') > at('end d'));
});

await check('a failure starts nothing new and settles running tasks first', async () => {
  const started: string[] = [];
  const finished: string[] = [];
  await assert.rejects(
    runInDependencyOrder(
      [task('slow'), task('broken'), task('later'), task('dependent', ['slow'])],
      2,
      async ({ name }) => {
        started.push(name);
        await tick();
        if (name === 'broken') {
          throw new Error('broken build');
        }
        await tick();
        finished.push(name);
      },
    ),
    /broken build/u,
  );
  assert.deepEqual(started, ['slow', 'broken']);
  assert.deepEqual(finished, ['slow']);
});

await check('cycles and invalid concurrency are rejected', async () => {
  await assert.rejects(
    runInDependencyOrder([task('a', ['b']), task('b', ['a'])], 4, async () => {}),
    /Circular task dependency: a, b/u,
  );
  assert.throws(() => runInDependencyOrder([task('a')], 0, async () => {}), /positive integer/u);
});

console.info('Package build scheduler tests passed.');
