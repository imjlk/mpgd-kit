import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  createVerse8Agent8LeaderboardBoundary,
  type Verse8Agent8CollectionItem,
  type Verse8Agent8LeaderboardBoundary,
  type Verse8Agent8LeaderboardPageRequest,
  type Verse8Agent8ServiceContext,
} from '../../adapters/verse8/src/agent8-services';
import type { RecordVerifiedLeaderboardAttemptRequest } from '../../packages/game-services/src/verified-leaderboard';
import { loadEffectiveTargetConfigMatrix } from '../target/effective-config';

interface CompleteRankedRun {
  readonly runId: string;
}

interface AuthoritativeCompletion {
  readonly account: string;
  readonly request: RecordVerifiedLeaderboardAttemptRequest;
}

interface GeneratedPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface GeneratedTargetsFile {
  readonly targets?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

interface Agent8ContextFixture {
  readonly context: Verse8Agent8ServiceContext;
  readonly collectionWrites: Readonly<Record<string, unknown>>[];
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-verse8-agent8-acceptance-'));

try {
  await assertStructuredServerBoundary();
  await assertGeneratedTargetSurfaces(fixtureRoot);
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

process.stdout.write(
  'Verse8 Agent8 acceptance passed: authenticated structured submissions, verified records, scoped snapshots, effective target config, and generated CLI hygiene\n',
);

async function assertStructuredServerBoundary(): Promise<void> {
  const fixture = createAgent8Context();
  const completions = new Map<string, AuthoritativeCompletion>();
  const boundary = createStructuredServerBoundary(fixture.context, completions);
  const initialWrites = fixture.collectionWrites.length;

  await expectRejects(
    () => boundary.submit('', { runId: 'blank-account' }),
    /account/u,
    'blank authenticated account',
  );
  expectEqual(fixture.collectionWrites.length, initialWrites, 'blank account writes');

  const unknownResult = await boundary.submit('0xalice', { runId: 'unknown-run' });

  expectDeepEqual(
    unknownResult,
    {
      accepted: false,
      reason: 'VERIFICATION_REJECTED',
    },
    'unknown completion rejection',
  );
  expectEqual(fixture.collectionWrites.length, initialWrites, 'rejected completion writes');

  const invalidBoundary = createVerse8Agent8LeaderboardBoundary<CompleteRankedRun>({
    context: fixture.context,
    persistenceSecret: createRuntimeSecret(),
    async verifySubmission({ account }) {
      return {
        definition: {
          leaderboardId: 'ranked-runs',
          scoreOrder: 'descending',
          attemptSelection: 'best',
        },
        attempt: {
          participantId: account,
          attemptId: '',
          score: Number.NaN,
          completedAt: 'not-a-timestamp',
          verification: {
            authorityId: '',
            evidenceId: '',
            verifiedAt: 'not-a-timestamp',
          },
        },
      };
    },
  });

  await expectRejects(
    () => invalidBoundary.submit('0xalice', { runId: 'malformed' }),
    /attemptId|score|completedAt|authorityId/u,
    'malformed verified attempt',
  );
  expectEqual(fixture.collectionWrites.length, initialWrites, 'malformed attempt writes');

  const mismatchedBoundary = createVerse8Agent8LeaderboardBoundary<CompleteRankedRun>({
    context: fixture.context,
    persistenceSecret: createRuntimeSecret(),
    async verifySubmission() {
      return createVerifiedAttempt({
        account: '0xbob',
        runId: 'mismatched-account',
        score: 1,
      });
    },
  });

  await expectRejects(
    () => mismatchedBoundary.submit('0xalice', { runId: 'mismatched-account' }),
    /participant must match/u,
    'mismatched authenticated participant',
  );
  expectEqual(fixture.collectionWrites.length, initialWrites, 'mismatched participant writes');

  completions.set('alice-run', {
    account: '0xalice',
    request: createVerifiedAttempt({ account: '0xalice', runId: 'alice-run', score: 12 }),
  });
  completions.set('bob-run', {
    account: '0xbob',
    request: createVerifiedAttempt({ account: '0xbob', runId: 'bob-run', score: 18 }),
  });

  const aliceRecord = await boundary.submit('0xalice', { runId: 'alice-run' });
  const bobRecord = await boundary.submit('0xbob', { runId: 'bob-run' });

  expect(aliceRecord.accepted, 'Alice record must be accepted');
  expect(bobRecord.accepted, 'Bob record must be accepted');
  expectEqual(aliceRecord.record.entry.participantId, '0xalice', 'Alice participant');
  expectEqual(bobRecord.record.entry.participantId, '0xbob', 'Bob participant');
  expect(fixture.collectionWrites.length > initialWrites, 'accepted records must write');

  await fixture.context.addCollectionItem('acceptance-unbounded', { ordinal: 1 });
  await fixture.context.addCollectionItem('acceptance-unbounded', { ordinal: 2 });
  expectEqual(
    (await fixture.context.getCollectionItems('acceptance-unbounded')).length,
    2,
    'unbounded collection read',
  );

  const spoofedPage = {
    leaderboardId: 'ranked-runs',
    participantId: '0xbob',
  } as unknown as Verse8Agent8LeaderboardPageRequest;
  const aliceSnapshot = await boundary.getSnapshot('0xalice', spoofedPage);

  expectDeepEqual(
    aliceSnapshot?.entries.map((entry) => entry.participantId),
    ['0xbob', '0xalice'],
    'ranked snapshot participants',
  );
  expectEqual(
    aliceSnapshot?.participantEntry?.participantId,
    '0xalice',
    'authenticated snapshot participant',
  );
  expectEqual(aliceSnapshot?.totalParticipants, 2, 'snapshot participant count');

  expectThrows(
    () => boundary.getSnapshot('', { leaderboardId: 'ranked-runs' }),
    /account/u,
    'blank snapshot account',
  );
}

function createStructuredServerBoundary(
  context: Verse8Agent8ServiceContext,
  completions: ReadonlyMap<string, AuthoritativeCompletion>,
): Verse8Agent8LeaderboardBoundary<CompleteRankedRun> {
  return createVerse8Agent8LeaderboardBoundary<CompleteRankedRun>({
    context,
    persistenceSecret: createRuntimeSecret(),
    now: () => '2030-01-02T03:04:05.000Z',
    async verifySubmission({ account, submission }) {
      const completion = completions.get(submission.runId);

      if (completion === undefined || completion.account !== account) {
        return null;
      }

      return clone(completion.request);
    },
  });
}

function createVerifiedAttempt(input: {
  readonly account: string;
  readonly runId: string;
  readonly score: number;
}): RecordVerifiedLeaderboardAttemptRequest {
  return {
    definition: {
      leaderboardId: 'ranked-runs',
      scoreOrder: 'descending',
      attemptSelection: 'best',
    },
    attempt: {
      participantId: input.account,
      attemptId: input.runId,
      score: input.score,
      completedAt: '2030-01-02T03:00:00.000Z',
      verification: {
        authorityId: 'structured-server-acceptance',
        evidenceId: `completion:${input.runId}`,
        verifiedAt: '2030-01-02T03:00:01.000Z',
      },
    },
  };
}

function createRuntimeSecret(): string {
  return randomBytes(32).toString('hex');
}

async function assertGeneratedTargetSurfaces(root: string): Promise<void> {
  const gameRoot = path.join(root, 'structured-server-game');

  runGeneratedGameCreate(gameRoot);

  const packageJson = readJson<GeneratedPackageJson>(path.join(gameRoot, 'package.json'));
  const targetsFile = readJson<GeneratedTargetsFile>(path.join(gameRoot, 'mpgd.targets.json'));
  const verse8Target = targetsFile.targets?.verse8;
  const allDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  expectEqual(
    packageJson.scripts?.['build:verse8']?.includes('target build verse8'),
    true,
    'generated Verse8 build script',
  );
  expectEqual(
    packageJson.scripts?.['smoke:verse8']?.includes('target smoke verse8'),
    true,
    'generated Verse8 smoke script',
  );
  expectEqual(
    allDependencies['@mpgd/adapter-verse8'],
    'workspace:*',
    'generated Verse8 adapter dependency',
  );
  expectEqual(
    allDependencies['@agent8/gameserver-node'],
    undefined,
    'browser starter Agent8 server dependency',
  );
  expectEqual(verse8Target?.kind, 'web', 'generated Verse8 target kind');
  expectEqual(verse8Target?.adapter, 'verse8', 'generated Verse8 target adapter');
  expectEqual(verse8Target?.output, 'artifacts/verse8', 'generated Verse8 target output');

  const sensitiveTargetKeys = [
    'authorization',
    'credential',
    'endpoint',
    'mcp',
    'persistenceSecret',
    'secret',
    'token',
  ];

  for (const key of sensitiveTargetKeys) {
    expectEqual(Object.hasOwn(verse8Target ?? {}, key), false, `generated Verse8 target ${key}`);
  }

  const generatedFiles = listRelativeFiles(gameRoot);

  for (const file of generatedFiles) {
    expectDoesNotMatch(
      file,
      /(?:^|\/)(?:\.agent8|\.codex|\.mcp(?:\.json)?|\.verse8|\.env(?:\..*)?|auth(?:entication)?\.json|credentials?\.json)(?:\/|$)/u,
      'generated sensitive file path',
    );
  }

  const readme = readFileSync(path.join(gameRoot, 'README.md'), 'utf8');
  const acceptance = readFileSync(path.join(gameRoot, 'agent/acceptance.md'), 'utf8');

  expectMatch(readme, /separate Agent8\s+server project/u, 'generated Verse8 README boundary');
  expectMatch(readme, /server persistence secrets/u, 'generated Verse8 README secrets');
  expectMatch(
    acceptance,
    /Verse8 Agent8 Structured Server/u,
    'generated structured-server acceptance',
  );
  expectMatch(
    acceptance,
    /Inject endpoints, persistence secrets,[\s\S]*at\s+runtime/u,
    'generated runtime injection guidance',
  );

  const previousTargetsFile = process.env.MPGD_PLATFORM_TARGETS_FILE;
  process.env.MPGD_PLATFORM_TARGETS_FILE = path.join(gameRoot, 'mpgd.targets.json');

  try {
    const effectiveVerse8 = loadEffectiveTargetConfigMatrix().targets.verse8;

    expect(effectiveVerse8 !== undefined, 'generated Verse8 effective target must exist');
    expectEqual(effectiveVerse8.runtime, 'verse8-web', 'effective Verse8 runtime');
    expectEqual(effectiveVerse8.sources.platformTargetKind, 'web', 'effective Verse8 target kind');
    expectEqual(effectiveVerse8.sources.platformAdapter, 'verse8', 'effective Verse8 adapter');
    expectEqual(effectiveVerse8.features.leaderboard, false, 'effective leaderboard feature');
    expectEqual(effectiveVerse8.leaderboard.enabled, false, 'effective leaderboard enabled');
    expectEqual(effectiveVerse8.leaderboard.native, false, 'effective native leaderboard');
    expectEqual(effectiveVerse8.storage.support, 'local', 'effective storage support');
  } finally {
    restoreEnvironmentVariable('MPGD_PLATFORM_TARGETS_FILE', previousTargetsFile);
  }
}

function runGeneratedGameCreate(gameRoot: string): void {
  const result = spawnSync(
    process.execPath,
    [
      'tools/run-ttsx.mjs',
      '--mpgd-cli',
      'packages/cli/src/bin.ts',
      'game',
      'create',
      gameRoot,
      '--workspace',
      '--kit-path',
      process.cwd(),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  expectEqual(
    result.status,
    0,
    `generated game CLI:\n${result.stderr || result.stdout || '(no output)'}`,
  );
}

function createAgent8Context(): Agent8ContextFixture {
  const userStates = new Map<string, Readonly<Record<string, unknown>>>();
  const collections = new Map<string, Map<string, Verse8Agent8CollectionItem>>();
  const collectionWrites: Readonly<Record<string, unknown>>[] = [];
  const lockTails = new Map<string, Promise<void>>();
  let nextItemId = 1;

  const getCollection = (collectionId: string): Map<string, Verse8Agent8CollectionItem> => {
    const existing = collections.get(collectionId);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, Verse8Agent8CollectionItem>();
    collections.set(collectionId, created);
    return created;
  };

  const context: Verse8Agent8ServiceContext = {
    async getUserState(account) {
      return clone(userStates.get(account) ?? {});
    },
    async updateUserState(account, patch) {
      const next = { ...userStates.get(account), ...clone(patch) };
      userStates.set(account, next);
      return clone(next);
    },
    async lock(key, callback) {
      const previous = lockTails.get(key) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      lockTails.set(key, tail);
      await previous;

      try {
        return await callback();
      } finally {
        release();

        if (lockTails.get(key) === tail) {
          lockTails.delete(key);
        }
      }
    },
    async getCollectionItems(collectionId, options = {}) {
      const items = [...getCollection(collectionId).values()];
      return (options.limit === undefined ? items : items.slice(0, options.limit)).map(clone);
    },
    async addCollectionItem(collectionId, item) {
      const itemId = `item-${String(nextItemId)}`;
      nextItemId += 1;
      const stored = { __id: itemId, ...clone(item) } as Verse8Agent8CollectionItem;
      getCollection(collectionId).set(itemId, stored);
      collectionWrites.push(clone(stored));
      return clone(stored);
    },
    async updateCollectionItem(collectionId, item) {
      const collection = getCollection(collectionId);

      if (!collection.has(item.__id)) {
        throw new Error('Collection item does not exist.');
      }

      const stored = clone(item) as Verse8Agent8CollectionItem;
      collection.set(item.__id, stored);
      collectionWrites.push(clone(stored));
      return clone(stored);
    },
  };

  return { context, collectionWrites };
}

function listRelativeFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listRelativeFiles(root, absolutePath);
    }

    return [path.relative(root, absolutePath).split(path.sep).join('/')];
  });
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function restoreEnvironmentVariable(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function clone<T>(input: T): T {
  return structuredClone(input);
}

function expect(condition: unknown, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Expected ${label}.`);
  }
}

function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${label} to equal ${formatValue(expected)}, received ${formatValue(actual)}.`,
    );
  }
}

function expectDeepEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `Expected ${label} to equal ${formatValue(expected)}, received ${formatValue(actual)}.`,
    );
  }
}

async function expectRejects(
  action: () => Promise<unknown>,
  pattern: RegExp,
  label: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expectMatch(errorMessage(error), pattern, label);
    return;
  }

  throw new Error(`Expected ${label} to reject.`);
}

function expectThrows(action: () => unknown, pattern: RegExp, label: string): void {
  try {
    action();
  } catch (error) {
    expectMatch(errorMessage(error), pattern, label);
    return;
  }

  throw new Error(`Expected ${label} to throw.`);
}

function expectMatch(actual: string, pattern: RegExp, label: string): void {
  if (!pattern.test(actual)) {
    throw new Error(`Expected ${label} to match ${String(pattern)}, received ${actual}.`);
  }
}

function expectDoesNotMatch(actual: string, pattern: RegExp, label: string): void {
  if (pattern.test(actual)) {
    throw new Error(`Expected ${label} not to match ${String(pattern)}, received ${actual}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
