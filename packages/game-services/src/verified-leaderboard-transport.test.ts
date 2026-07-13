import {
  createVerifiedLeaderboardSnapshotFetchClient,
  createVerifiedLeaderboardSnapshotFetchHandler,
  verifiedLeaderboardSnapshotPath,
} from './verified-leaderboard-transport.js';
import { createInMemoryVerifiedLeaderboardService } from './verified-leaderboard.js';

const service = createInMemoryVerifiedLeaderboardService({
  now: () => '2030-01-02T03:04:05.000Z',
});

for (const [index, score] of [300, 200, 100].entries()) {
  await service.recordVerifiedAttempt({
    definition: {
      leaderboardId: 'transport:board',
      scoreOrder: 'descending',
      attemptSelection: 'best',
    },
    attempt: {
      participantId: `participant:${index + 1}`,
      attemptId: `attempt:${index + 1}`,
      score,
      completedAt: `2030-01-02T03:0${index}:00.000Z`,
      verification: {
        authorityId: 'transport-test',
        evidenceId: `evidence:${index + 1}`,
        verifiedAt: `2030-01-02T03:0${index}:01.000Z`,
      },
    },
  });
}

const handler = createVerifiedLeaderboardSnapshotFetchHandler({
  reader: service,
  authenticate(request) {
    return request.headers.get('Authorization') === 'Bearer player-token'
      ? { participantId: 'participant:2' }
      : undefined;
  },
});
const baseUrl = 'https://verified-leaderboard.test';

const unmatched = await handler(new Request(`${baseUrl}/not-the-snapshot-route`));
assertEqual(unmatched, undefined, 'the handler must compose without claiming unrelated routes');

const preflight = await handler(
  new Request(`${baseUrl}${verifiedLeaderboardSnapshotPath}`, {
    method: 'OPTIONS',
  }),
);
assertEqual(preflight?.status, 204, 'preflight should not require authentication');

const unauthorized = await handler(snapshotRequest());
assertEqual(unauthorized?.status, 401, 'snapshot reads must reject missing credentials');

const forgedScope = await handler(snapshotRequest('&participantId=participant%3A1', true));
assertEqual(forgedScope?.status, 400, 'client-controlled participant scope must be rejected');

const malformedCursor = await handler(snapshotRequest('&cursor=not-a-valid-cursor', true));
assertEqual(malformedCursor?.status, 400, 'malformed cursors must return a client error');

const client = createVerifiedLeaderboardSnapshotFetchClient({
  baseUrl,
  authorization: () => 'Bearer player-token',
  fetch: async (request, init) => {
    const response = await handler(new Request(request, init));
    return response ?? new Response('Not Found', { status: 404 });
  },
});
const firstPage = await client.getSnapshot({
  leaderboardId: 'transport:board',
  limit: 1,
});
assert(firstPage !== undefined, 'the authenticated client should return known boards');
assertEqual(firstPage.entries[0]?.attemptId, 'attempt:1', 'the first page should start at rank 1');
assertEqual(
  firstPage.participantEntry?.attemptId,
  'attempt:2',
  'the handler must scope participantEntry from the authenticated principal',
);
assert(firstPage.nextCursor !== undefined, 'limited client reads should expose nextCursor');

const secondPage = await client.getSnapshot({
  leaderboardId: 'transport:board',
  limit: 1,
  cursor: firstPage.nextCursor,
});
assertEqual(secondPage?.entries[0]?.attemptId, 'attempt:2', 'the cursor should advance one entry');
assertEqual(secondPage?.entries[0]?.rank, 2, 'cursor pages should retain global ranks');

const missing = await client.getSnapshot({ leaderboardId: 'transport:missing' });
assertEqual(missing, undefined, 'the client should map missing boards to undefined');

const unauthorizedClient = createVerifiedLeaderboardSnapshotFetchClient({
  baseUrl,
  authorization: () => 'Bearer invalid-token',
  fetch: async (request, init) => {
    const response = await handler(new Request(request, init));
    return response ?? new Response('Not Found', { status: 404 });
  },
});
await assertRejects(
  () => unauthorizedClient.getSnapshot({ leaderboardId: 'transport:board' }),
  'the client must reject unauthorized transport responses',
);

const nonJsonClient = createVerifiedLeaderboardSnapshotFetchClient({
  baseUrl,
  authorization: () => 'Bearer player-token',
  fetch: async () => new Response('<html>upstream unavailable</html>', { status: 502 }),
});
await assertRejects(
  () => nonJsonClient.getSnapshot({ leaderboardId: 'transport:board' }),
  'the client must wrap non-JSON upstream responses',
);

console.log('Verified leaderboard authenticated snapshot transport smoke passed');

function snapshotRequest(suffix = '', authenticated = false): Request {
  return new Request(
    `${baseUrl}${verifiedLeaderboardSnapshotPath}`
      + `?leaderboardId=transport%3Aboard&limit=1${suffix}`,
    authenticated
      ? { headers: { Authorization: 'Bearer player-token' } }
      : undefined,
  );
}

function assert(input: unknown, message: string): asserts input {
  if (!input) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }

  throw new Error(message);
}
