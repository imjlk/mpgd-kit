import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inspectAndroidBundleSigner } from '../../../packages/cli/src/android-bundle-signer.js';
import {
  planVerifiedAndroidBundleSubmission,
  PlaySubmissionUncertainError,
  submitVerifiedAndroidBundleWithPublisher,
} from '../../../packages/cli/src/play-internal-submission.js';
import type {
  PlayBundle,
  PlayPublisher,
  PlayTrack,
  PlayTrackRelease,
} from '../../../packages/cli/src/play-publisher-port.js';
import {
  createPlayReleaseRequest,
  isPlayDraftAppRejection,
  parsePlayReleaseNotes,
  playReleaseRequestDigest,
} from '../../../packages/cli/src/play-release-options.js';
import {
  changePlayRolloutWithPublisher,
  PlayRolloutUncertainError,
  type PlayRolloutInput,
} from '../../../packages/cli/src/play-release-rollout.js';
import {
  PlayPromoteUncertainError,
  promotePlayReleaseWithPublisher,
  type PlayPromoteInput,
} from '../../../packages/cli/src/play-release-promote.js';
import type { ImmutableNativeBuildRecord } from '../../../packages/cli/src/release-state.js';
import { createSignedAabFixture } from '../../../packages/cli/test/signed-aab-fixture.js';
import { createMockPublisher } from './index.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-play-release-'));
const aabFile = path.join(fixture, 'game.aab');
createSignedAabFixture(aabFile);
const bytes = readFileSync(aabFile);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const signerSha256 = await inspectAndroidBundleSigner(aabFile);
const mappingFile = path.join(fixture, 'mapping.txt');
writeFileSync(mappingFile, 'com.example.Game -> a:\n');
const notesFile = path.join(fixture, 'notes.txt');
writeFileSync(
  notesFile,
  '<en-US>\nFaster loading.\n</en-US>\n<ko-KR>\n로딩이 빨라졌습니다.\n</ko-KR>\n',
);
const packageName = 'dev.mpgd.playtest';
const record: ImmutableNativeBuildRecord = {
  releaseKey: 'launch-01',
  target: 'android',
  buildRunId: 'run-1',
  gameVersion: '1.0.0',
  sourceGitSha: 'a'.repeat(40),
  kitGitSha: 'b'.repeat(40),
  kitPackageVersion: '0.58.0',
  buildConfigDigest: 'c'.repeat(64),
  targetConfigDigest: 'd'.repeat(64),
  platformVersion: { versionCode: 45, versionName: '1.0.0' },
  artifactLocation: 'release-output/game.aab',
  artifactSha256: sha256,
  releaseManifestSha256: 'e'.repeat(64),
  inspectedAppId: packageName,
  inspectedSignerSha256: signerSha256,
};
const baseInput = { record, aabFile, packageName, serviceAccountFile: 'not-used-in-mock' };
const draftAppMessage = 'Only releases with status draft may be created on draft app.';

interface LiveState {
  bundles: PlayBundle[];
  tracks: Record<string, PlayTrackRelease[]>;
}

interface MockOptions {
  /** A never-published app: commits with a non-draft release are refused. */
  readonly draftApp?: boolean;
  /** The first commit applies but its response is lost. */
  readonly loseFirstCommit?: boolean;
  /** Every tracks.update answers with this HTTP status and changes nothing. */
  readonly failTrackUpdate?: number;
  /** Every edits.validate response is lost. */
  readonly loseValidate?: boolean;
}

interface Observed {
  readonly operations: string[];
  readonly updates: { readonly track: string; readonly body: PlayTrack }[];
  readonly mappings: { readonly versionCode: string; readonly body: Buffer }[];
  readonly rootUrl: string;
  live(): LiveState;
}

async function withPlay(
  initial: LiveState,
  options: MockOptions,
  action: (publisher: PlayPublisher, observed: Observed) => Promise<void>,
): Promise<void> {
  const operations: string[] = [];
  const updates: Observed['updates'] = [];
  const mappings: Observed['mappings'] = [];
  let live = structuredClone(initial);
  let counter = 0;
  let commits = 0;
  const edits = new Map<string, LiveState>();
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      const method = request.method ?? '';
      operations.push(`${method} ${pathname}`);
      assert.equal(request.headers.authorization, 'Bearer mock-play-token');
      const base = `/applications/${packageName}/edits`;
      if (method === 'POST' && pathname.endsWith(base)) {
        const id = `edit-${++counter}`;
        edits.set(id, structuredClone(live));
        reply(response, 200, { id });
        return;
      }
      const editId = pathname.slice(pathname.indexOf(base) + base.length + 1).split(/[/:]/u)[0];
      const edit = editId === undefined ? undefined : edits.get(editId);
      if (editId === undefined || edit === undefined) {
        reply(response, 404, { error: { code: 404, message: 'edit missing' } });
        return;
      }
      const trackMatch = pathname.match(/\/tracks\/([^/]+)$/u);
      const mappingMatch = pathname.match(/\/apks\/(\d+)\/deobfuscationFiles\/proguard$/u);
      if (method === 'DELETE' && pathname.endsWith(`${base}/${editId}`)) {
        edits.delete(editId);
        response.writeHead(204).end();
      } else if (method === 'GET' && pathname.endsWith('/bundles')) {
        reply(response, 200, { bundles: edit.bundles });
      } else if (method === 'POST' && pathname.endsWith('/bundles')) {
        assert.deepEqual(await readBody(request), bytes);
        edit.bundles.push({ versionCode: 45, sha256 });
        reply(response, 200, { versionCode: 45, sha256 });
      } else if (method === 'POST' && mappingMatch !== null) {
        assert.ok(pathname.startsWith('/upload/'), 'mapping must use the media upload endpoint');
        mappings.push({ versionCode: mappingMatch[1] ?? '', body: await readBody(request) });
        reply(response, 200, { deobfuscationFile: { symbolType: 'proguard' } });
      } else if (method === 'GET' && trackMatch !== null) {
        const releases = edit.tracks[trackMatch[1] ?? ''];
        if (releases === undefined) {
          reply(response, 404, { error: { code: 404, message: 'track missing' } });
        } else {
          reply(response, 200, { track: trackMatch[1], releases });
        }
      } else if (method === 'PUT' && trackMatch !== null && options.failTrackUpdate !== undefined) {
        await readBody(request);
        reply(response, options.failTrackUpdate, {
          error: { code: options.failTrackUpdate, message: 'track update failed' },
        });
      } else if (method === 'PUT' && trackMatch !== null) {
        const body = JSON.parse((await readBody(request)).toString('utf8')) as PlayTrack;
        updates.push({ track: trackMatch[1] ?? '', body });
        edit.tracks[trackMatch[1] ?? ''] = [...(body.releases ?? [])];
        reply(response, 200, body);
      } else if (method === 'POST' && pathname.endsWith(':validate')) {
        if (options.loseValidate === true) {
          reply(response, 503, { error: { code: 503, message: 'response lost' } });
          return;
        }
        reply(response, 200, { id: editId });
      } else if (method === 'POST' && pathname.endsWith(':commit')) {
        assert.equal(url.searchParams.get('changesInReviewBehavior'), 'ERROR_IF_IN_REVIEW');
        if (options.draftApp === true && Object.values(edit.tracks).flat()
          .some((release) => release.status !== 'draft')) {
          reply(response, 400, {
            error: { code: 400, message: draftAppMessage, status: 'INVALID_ARGUMENT' },
          });
          return;
        }
        live = structuredClone(edit);
        edits.delete(editId);
        commits += 1;
        if (options.loseFirstCommit === true && commits === 1) {
          reply(response, 503, { error: { code: 503, message: 'response lost' } });
        } else {
          reply(response, 200, { id: editId });
        }
      } else {
        reply(response, 404, { error: { code: 404, message: `unknown route ${pathname}` } });
      }
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  };
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string', 'listening address');
    const rootUrl = `http://127.0.0.1:${address.port}`;
    await action(createMockPublisher('mock-play-token', rootUrl), {
      operations,
      updates,
      mappings,
      rootUrl,
      live: () => live,
    });
  } finally {
    server.close();
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const completed44 = { name: 'older', status: 'completed', versionCodes: ['44'] };

try {
  // Release notes: Play Console tag blocks and JSON, 500 Unicode characters per language.
  assert.deepEqual(parsePlayReleaseNotes(readFileSync(notesFile, 'utf8')), [
    { language: 'en-US', text: 'Faster loading.' },
    { language: 'ko-KR', text: '로딩이 빨라졌습니다.' },
  ]);
  assert.deepEqual(parsePlayReleaseNotes('{"en-US":" Fixes. "}'), [
    { language: 'en-US', text: 'Fixes.' },
  ]);
  assert.deepEqual(parsePlayReleaseNotes('[{"language":"de-AT","text":"Neu"}]'), [
    { language: 'de-AT', text: 'Neu' },
  ]);
  assert.equal(parsePlayReleaseNotes(`<en-US>${'😀'.repeat(500)}</en-US>`)[0]?.text.length, 1000);
  assert.throws(
    () => parsePlayReleaseNotes(`<en-US>${'a'.repeat(501)}</en-US>`),
    /501 characters/u,
  );
  assert.throws(() => parsePlayReleaseNotes('<en-US>a</en-US><en-us>b</en-us>'), /repeat/u);
  assert.throws(() => parsePlayReleaseNotes('stray <en-US>a</en-US>'), /between <language>/u);
  assert.throws(() => parsePlayReleaseNotes('<en-US>a</en-US> trailing'), /between <language>/u);
  assert.throws(() => parsePlayReleaseNotes('{"english":"a"}'), /BCP-47/u);
  assert.throws(() => parsePlayReleaseNotes('<en-US>  </en-US>'), /empty/u);
  assert.throws(() => parsePlayReleaseNotes('{"en-US":1}'), /must be a string/u);
  assert.throws(
    () => parsePlayReleaseNotes('[{"language":"en-US","text":"a","x":1}]'),
    /only string/u,
  );

  // Release options.
  const defaults = await createPlayReleaseRequest({});
  assert.deepEqual(defaults, { track: 'internal', status: 'completed' });
  assert.equal(playReleaseRequestDigest(defaults), undefined);
  assert.equal(
    playReleaseRequestDigest(await createPlayReleaseRequest({ track: 'internal' })),
    undefined,
  );
  assert.match(
    playReleaseRequestDigest(await createPlayReleaseRequest({ track: 'alpha' })) ?? '',
    /^[a-f0-9]{64}$/u,
  );
  assert.notEqual(
    playReleaseRequestDigest(await createPlayReleaseRequest({ track: 'alpha' })),
    playReleaseRequestDigest(await createPlayReleaseRequest({ track: 'beta' })),
  );
  await assert.rejects(createPlayReleaseRequest({ status: 'halted' }), /cannot start halted/u);
  await assert.rejects(createPlayReleaseRequest({ status: 'paused' }), /--status must be/u);
  await assert.rejects(
    createPlayReleaseRequest({ status: 'inProgress' }),
    /needs --user-fraction/u,
  );
  for (const fraction of ['0', '1', '1.5', '-0.1', 'abc', '5%']) {
    await assert.rejects(
      createPlayReleaseRequest({ status: 'inProgress', userFraction: fraction }),
      /greater than 0 and less than 1/u,
    );
  }
  await assert.rejects(createPlayReleaseRequest({ userFraction: '0.1' }), /only to an inProgress/u);
  await assert.rejects(createPlayReleaseRequest({ track: '../edits' }), /track must be/u);
  await assert.rejects(createPlayReleaseRequest({ track: 'a?b' }), /track must be/u);
  await assert.rejects(
    createPlayReleaseRequest({ mappingFile: path.join(fixture, 'none') }),
    /missing/u,
  );
  assert.equal(
    (await createPlayReleaseRequest({ track: 'wear:Closed testers' })).track,
    'wear:Closed testers',
  );
  assert.equal(isPlayDraftAppRejection({ code: 400, message: draftAppMessage }), true);
  assert.equal(isPlayDraftAppRejection({ code: 503, message: draftAppMessage }), false);
  assert.equal(
    isPlayDraftAppRejection({
      response: { status: 400, data: { error: { message: draftAppMessage } } },
    }),
    true,
  );

  // A production release refuses to start without --confirm-production, before any call.
  const staged = await createPlayReleaseRequest({
    track: 'production',
    status: 'inProgress',
    userFraction: '0.05',
    releaseNotesFile: notesFile,
  });
  await withPlay({ bundles: [], tracks: { production: [completed44] } }, {}, async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({ ...baseInput, release: staged }, publisher, observed.rootUrl),
      /needs --confirm-production/u,
    );
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...baseInput, release: await createPlayReleaseRequest({ track: 'production' }),
      }, publisher, observed.rootUrl),
      /needs --confirm-production/u,
    );
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...baseInput,
        release: await createPlayReleaseRequest({ track: 'beta', status: 'inProgress', userFraction: '0.2' }),
      }, publisher, observed.rootUrl),
      /needs --confirm-production/u,
    );
    assert.equal(observed.operations.length, 0);
  });

  // Staged production rollout with release notes; the completed release stays.
  await withPlay({ bundles: [], tracks: { production: [completed44], internal: [completed44] } }, {}, async (publisher, observed) => {
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput, release: staged, confirmProduction: true,
    }, publisher, observed.rootUrl);
    assert.equal(result.track, 'production');
    assert.equal(result.releaseStatus, 'inProgress');
    assert.equal(result.draftAppFallback, false);
    assert.deepEqual(observed.updates, [{
      track: 'production',
      body: {
        track: 'production',
        releases: [completed44, {
          name: 'launch-01',
          status: 'inProgress',
          versionCodes: ['45'],
          userFraction: 0.05,
          releaseNotes: [
            { language: 'en-US', text: 'Faster loading.' },
            { language: 'ko-KR', text: '로딩이 빨라졌습니다.' },
          ],
        }],
      },
    }]);
    assert.deepEqual(observed.live().tracks.internal, [completed44], 'only the named track changes');
    // A re-run against the live track recognises the committed release.
    const again = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput, release: staged, confirmProduction: true,
    }, publisher, observed.rootUrl);
    assert.equal(again.alreadyCommitted, true);
    assert.equal(observed.operations.filter((item) => item.endsWith(':commit')).length, 1);
    // Other options for the release already there are refused, not reported as done.
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...baseInput,
        release: { ...staged, userFraction: 0.2 },
        confirmProduction: true,
      }, publisher, observed.rootUrl),
      /another rollout fraction or other release notes/u,
    );
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...baseInput,
        release: { ...staged, releaseNotes: [{ language: 'en-US', text: 'Other.' }] },
        confirmProduction: true,
      }, publisher, observed.rootUrl),
      /another rollout fraction or other release notes/u,
    );
    const reordered = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput,
      release: { ...staged, releaseNotes: [...(staged.releaseNotes ?? [])].reverse() },
      confirmProduction: true,
    }, publisher, observed.rootUrl);
    assert.equal(reordered.alreadyCommitted, true);
    // A mapping for a release already on Play is added in an edit of its own.
    const mapped = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput,
      release: await createPlayReleaseRequest({
        track: 'production', status: 'inProgress', userFraction: '0.05',
        releaseNotesFile: notesFile, mappingFile,
      }),
      confirmProduction: true,
    }, publisher, observed.rootUrl);
    assert.equal(mapped.alreadyCommitted, true);
    assert.equal(observed.mappings.length, 1);
    assert.equal(observed.updates.length, 1);
    assert.equal(observed.operations.filter((item) => item.endsWith(':commit')).length, 2);
  });

  // A new staged release replaces an in-progress rollout; a halted older one too.
  await withPlay({
    bundles: [],
    tracks: {
      production: [
        { name: 'rolling', status: 'inProgress', versionCodes: ['44'], userFraction: 0.5 },
        { name: 'base', status: 'completed', versionCodes: ['43'] },
      ],
    },
  }, {}, async (publisher, observed) => {
    await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput, release: staged, confirmProduction: true,
    }, publisher, observed.rootUrl);
    assert.deepEqual(
      observed.updates[0]?.body.releases?.map((release) => [release.status, release.versionCodes]),
      [['completed', ['43']], ['inProgress', ['45']]],
    );
  });

  // Play Console offers no rollout percentage for a first release.
  await withPlay({ bundles: [], tracks: {} }, {}, async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...baseInput, release: staged, confirmProduction: true,
      }, publisher, observed.rootUrl),
      /no completed release yet/u,
    );
    assert.equal(observed.operations.some((item) => item.includes('/upload/')), false);
  });

  // Refusals from the read-only checks happen before the edit is checkpointed,
  // so the operator can correct the options: a staged first release, a typo in
  // a closed-testing track name.
  await withPlay({ bundles: [], tracks: {} }, {}, async (publisher, observed) => {
    const persisted: string[] = [];
    const onEditCreated = async (editId: string): Promise<void> => { persisted.push(editId); };
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...baseInput, release: staged, confirmProduction: true, onEditCreated,
      }, publisher, observed.rootUrl),
      /no completed release yet/u,
    );
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...baseInput,
        release: await createPlayReleaseRequest({ track: 'Closed testrs' }),
        onEditCreated,
      }, publisher, observed.rootUrl),
      /no closed-testing track named "Closed testrs"/u,
    );
    assert.deepEqual(persisted, []);
    assert.equal(observed.operations.some((item) => item.includes('/upload/')), false);
    // A default track that Play reports missing is still treated as empty.
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput, release: await createPlayReleaseRequest({ track: 'beta' }), onEditCreated,
    }, publisher, observed.rootUrl);
    assert.equal(result.track, 'beta');
    assert.deepEqual(persisted, ['edit-3']);
  });

  // A never-published app: the completed release is re-staged as a draft and committed.
  await withPlay({ bundles: [], tracks: {} }, { draftApp: true }, async (publisher, observed) => {
    const fallbacks: string[] = [];
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput, onDraftAppFallback: (track) => { fallbacks.push(track); },
    }, publisher, observed.rootUrl);
    assert.deepEqual(fallbacks, ['internal']);
    assert.equal(result.releaseStatus, 'draft');
    assert.equal(result.draftAppFallback, true);
    assert.deepEqual(observed.updates.map((update) => update.body.releases), [
      [{ name: 'launch-01', status: 'completed', versionCodes: ['45'] }],
      [{ name: 'launch-01', status: 'draft', versionCodes: ['45'] }],
    ]);
    assert.deepEqual(observed.live().tracks.internal, [
      { name: 'launch-01', status: 'draft', versionCodes: ['45'] },
    ]);
    assert.equal(observed.operations.filter((item) => item.endsWith('/edits')).length, 1);
  });

  // A draft-app fallback whose commit response is lost is recognised on resume.
  await withPlay({ bundles: [], tracks: {} }, { draftApp: true, loseFirstCommit: true }, async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(baseInput, publisher, observed.rootUrl),
      (error: unknown) => error instanceof PlaySubmissionUncertainError
        && error.stage === 'commit' && error.editId === 'edit-1',
    );
    assert.equal(observed.live().tracks.internal?.[0]?.status, 'draft');
    // Without a resumed edit, a draft of this version is someone else's to inspect.
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(baseInput, publisher, observed.rootUrl),
      /not completed; inspect it/u,
    );
    const reconciled = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput, resumeEditId: 'edit-1',
    }, publisher, observed.rootUrl);
    assert.equal(reconciled.alreadyCommitted, true);
    assert.equal(reconciled.releaseStatus, 'draft');
    assert.equal(reconciled.draftAppFallback, true);
    assert.equal(observed.operations.filter((item) => item.endsWith(':commit')).length, 2);
  });

  // Same for a staged request: the draft drops userFraction and keeps the notes.
  await withPlay({ bundles: [], tracks: { alpha: [] } }, { draftApp: true }, async (publisher, observed) => {
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput,
      release: await createPlayReleaseRequest({ track: 'alpha', releaseNotesFile: notesFile }),
    }, publisher, observed.rootUrl);
    assert.equal(result.releaseStatus, 'draft');
    const draft = observed.live().tracks.alpha?.[0];
    assert.equal(draft?.status, 'draft');
    assert.equal(draft?.userFraction, undefined);
    assert.equal(draft?.releaseNotes?.length, 2);
  });

  // An explicit draft on a custom closed track replaces an older draft only.
  const closedDraft = await createPlayReleaseRequest({ track: 'Closed testers', status: 'draft' });
  await withPlay({
    bundles: [],
    tracks: { 'Closed testers': [completed44, { name: 'old', status: 'draft', versionCodes: ['40'] }] },
  }, {}, async (publisher, observed) => {
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput, release: closedDraft,
    }, publisher, observed.rootUrl);
    assert.equal(result.releaseStatus, 'draft');
    assert.equal(result.draftAppFallback, false);
    assert.ok(observed.operations.includes(
      `PUT /androidpublisher/v3/applications/${packageName}/edits/edit-1/tracks/Closed testers`,
    ), observed.operations.join('\n'));
    assert.deepEqual(observed.updates[0]?.body.releases, [
      completed44,
      { name: 'launch-01', status: 'draft', versionCodes: ['45'] },
    ]);
  });

  // R8 mapping: uploaded for the version code before the track update.
  const withMapping = await createPlayReleaseRequest({ track: 'alpha', mappingFile });
  await withPlay({ bundles: [], tracks: { alpha: [completed44] } }, {}, async (publisher, observed) => {
    await submitVerifiedAndroidBundleWithPublisher({
      ...baseInput, release: withMapping,
    }, publisher, observed.rootUrl);
    assert.equal(observed.mappings.length, 1);
    assert.equal(observed.mappings[0]?.versionCode, '45');
    assert.equal(observed.mappings[0]?.body.toString('utf8'), 'com.example.Game -> a:\n');
    const order = observed.operations;
    assert.ok(
      order.findIndex((item) => item.includes('deobfuscationFiles'))
        < order.findIndex((item) => item.startsWith('PUT ') && item.includes('/tracks/alpha')),
      'mapping upload precedes the track update',
    );
  });
  await withPlay({ bundles: [], tracks: {} }, {}, async (publisher, observed) => {
    writeFileSync(mappingFile, 'changed\n');
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({ ...baseInput, release: withMapping }, publisher, observed.rootUrl),
      /mapping file changed/u,
    );
    assert.equal(observed.operations.length, 0);
    writeFileSync(mappingFile, 'com.example.Game -> a:\n');
  });

  // Dry run: verified locally, planned edit printed, no Google Play call.
  const planned = await planVerifiedAndroidBundleSubmission({
    record,
    aabFile,
    packageName,
    release: staged,
  });
  assert.equal(planned.dryRun, true);
  assert.equal(planned.requiresConfirmProduction, true);
  assert.deepEqual(planned.release, {
    name: 'launch-01',
    status: 'inProgress',
    versionCodes: ['45'],
    userFraction: 0.05,
    releaseNotes: [
      { language: 'en-US', text: 'Faster loading.' },
      { language: 'ko-KR', text: '로딩이 빨라졌습니다.' },
    ],
  });
  assert.ok(
    planned.operations.includes('edits.commit changesInReviewBehavior=ERROR_IF_IN_REVIEW'),
    'planned commit',
  );

  // Rollout changes on an existing release; no new bundle.
  const rolling: PlayTrackRelease & { countryTargeting: unknown } = {
    name: 'launch-01',
    status: 'inProgress',
    versionCodes: ['45'],
    userFraction: 0.05,
    releaseNotes: [{ language: 'en-US', text: 'Faster loading.' }],
    countryTargeting: { countries: ['KR'], includeRestOfWorld: true },
  };
  const productionRollout = (): LiveState => ({
    bundles: [{ versionCode: 45, sha256 }],
    tracks: { production: [rolling, completed44], beta: [completed44] },
  });
  const rollout = (input: Partial<PlayRolloutInput>): PlayRolloutInput => ({
    packageName,
    track: 'production',
    action: 'update',
    confirmProduction: true,
    ...input,
  });
  await withPlay(productionRollout(), {}, async (publisher, observed) => {
    await assert.rejects(
      changePlayRolloutWithPublisher(rollout({ userFraction: 0.2, confirmProduction: false }), publisher),
      /needs --confirm-production/u,
    );
    await assert.rejects(
      changePlayRolloutWithPublisher(rollout({ action: 'halt', confirmProduction: false }), publisher),
      /needs --confirm-production/u,
    );
    await assert.rejects(changePlayRolloutWithPublisher(rollout({}), publisher), /needs --user-fraction/u);
    assert.equal(observed.operations.length, 0);

    const dryRun = await changePlayRolloutWithPublisher(
      rollout({ userFraction: 0.2, dryRun: true, confirmProduction: false }), publisher,
    );
    assert.equal(dryRun.status, 'dry-run');
    assert.deepEqual(dryRun.plannedTrack?.releases, [{ ...rolling, userFraction: 0.2 }, completed44]);
    assert.equal(observed.updates.length, 0);
    assert.ok(observed.operations.at(-1)?.startsWith('DELETE '), 'dry-run discards its edit');

    const updated = await changePlayRolloutWithPublisher(rollout({ userFraction: 0.2 }), publisher);
    assert.equal(updated.status, 'committed');
    assert.deepEqual(updated.before, { status: 'inProgress', userFraction: 0.05 });
    assert.deepEqual(updated.after, { status: 'inProgress', userFraction: 0.2 });
    assert.deepEqual(observed.live().tracks.production, [{ ...rolling, userFraction: 0.2 }, completed44]);
    assert.deepEqual(observed.live().tracks.beta, [completed44]);

    const unchanged = await changePlayRolloutWithPublisher(rollout({ userFraction: 0.2 }), publisher);
    assert.equal(unchanged.status, 'unchanged');

    const halted = await changePlayRolloutWithPublisher(rollout({ action: 'halt' }), publisher);
    assert.deepEqual(halted.after, { status: 'halted', userFraction: 0.2 });
    assert.equal(
      (await changePlayRolloutWithPublisher(rollout({ action: 'halt' }), publisher)).status,
      'unchanged',
    );
    await assert.rejects(
      changePlayRolloutWithPublisher(rollout({ userFraction: 0.3 }), publisher),
      /exactly one inProgress release/u,
    );
    const resumed = await changePlayRolloutWithPublisher(rollout({ action: 'resume' }), publisher);
    assert.deepEqual(resumed.after, { status: 'inProgress', userFraction: 0.2 });
    await assert.rejects(
      changePlayRolloutWithPublisher(rollout({ action: 'resume', userFraction: 0.5 }), publisher),
      /use --action update/u,
    );
    const done = await changePlayRolloutWithPublisher(rollout({ action: 'complete' }), publisher);
    assert.deepEqual(done.after, { status: 'completed' });
    const { userFraction: _unused, ...completedRolling } = rolling;
    assert.deepEqual(observed.live().tracks.production, [
      { ...completedRolling, status: 'completed' },
      completed44,
    ]);
    assert.equal(
      (await changePlayRolloutWithPublisher(rollout({ action: 'complete', versionCode: 45 }), publisher)).status,
      'unchanged',
    );
    await assert.rejects(
      changePlayRolloutWithPublisher(rollout({ action: 'complete' }), publisher),
      /exactly one inProgress or halted release/u,
    );
    await assert.rejects(
      changePlayRolloutWithPublisher(rollout({ action: 'halt', versionCode: 99 }), publisher),
      /no single release with version code 99/u,
    );
    // Halting a completed release (Play then serves the previous completed one).
    const haltedCompleted = await changePlayRolloutWithPublisher(
      rollout({ action: 'halt', versionCode: 45 }), publisher,
    );
    assert.deepEqual(haltedCompleted.after, { status: 'halted' });
    await assert.rejects(
      changePlayRolloutWithPublisher(rollout({ action: 'resume' }), publisher),
      /no rollout fraction/u,
    );
    const resumedFull = await changePlayRolloutWithPublisher(rollout({ action: 'complete' }), publisher);
    assert.deepEqual(resumedFull.after, { status: 'completed' });
    assert.equal(observed.updates.every((update) => update.track === 'production'), true);
    assert.equal(observed.operations.some((item) => item.includes('/upload/')), false);
  });

  // A lost complete names the release, so the re-run can find it once completed.
  await withPlay(productionRollout(), { loseFirstCommit: true }, async (publisher) => {
    let uncertain: unknown;
    await changePlayRolloutWithPublisher(rollout({ action: 'complete' }), publisher)
      .catch((error: unknown) => { uncertain = error; });
    assert.ok(uncertain instanceof PlayRolloutUncertainError, 'lost commit is uncertain');
    assert.deepEqual(uncertain.versionCodes, ['45']);
    assert.match(uncertain.message, /--version-code 45/u);
    const rerun = await changePlayRolloutWithPublisher(
      rollout({ action: 'complete', versionCode: 45 }), publisher,
    );
    assert.equal(rerun.status, 'unchanged');
  });

  // Production is matched case-insensitively; a trailing space is not a track name.
  await assert.rejects(
    submitVerifiedAndroidBundleWithPublisher(
      {
        ...baseInput,
        release: await createPlayReleaseRequest({ track: 'wear:Production' }),
      },
      {} as PlayPublisher,
    ),
    /needs --confirm-production/u,
  );
  await assert.rejects(createPlayReleaseRequest({ track: 'production ' }), /track must be/u);

  // A testing-track halt needs no production confirmation; a lost commit is re-checked.
  await withPlay({
    bundles: [{ versionCode: 45, sha256 }],
    tracks: { beta: [{ ...rolling, status: 'inProgress' }, completed44] },
  }, { loseFirstCommit: true }, async (publisher) => {
    await assert.rejects(
      changePlayRolloutWithPublisher({ packageName, track: 'beta', action: 'halt' }, publisher),
      (error: unknown) => error instanceof PlayRolloutUncertainError && error.stage === 'commit',
    );
    const rerun = await changePlayRolloutWithPublisher(
      { packageName, track: 'beta', action: 'halt' }, publisher,
    );
    assert.equal(rerun.status, 'unchanged');
    assert.deepEqual(rerun.after.status, 'halted');
  });
  await withPlay({ bundles: [], tracks: {} }, {}, async (publisher) => {
    await assert.rejects(
      changePlayRolloutWithPublisher({ packageName, track: 'alpha', action: 'halt' }, publisher),
      /no alpha track/u,
    );
  });

  // Promote: the tested build moves to another track; nothing is uploaded.
  const tested: PlayTrackRelease = {
    name: 'launch-01',
    status: 'completed',
    versionCodes: ['45'],
    releaseNotes: [{ language: 'en-US', text: 'Faster loading.' }],
  };
  const promotable = (): LiveState => ({
    bundles: [
      { versionCode: 45, sha256 },
      { versionCode: 46, sha256: 'f'.repeat(64) },
    ],
    tracks: {
      'Closed testers': [tested, { name: 'stopped', status: 'halted', versionCodes: ['47'] }],
      production: [completed44],
      internal: [completed44, { name: 'launch-02', status: 'completed', versionCodes: ['46'] }],
    },
  });
  const promote = (input: Partial<PlayPromoteInput>): PlayPromoteInput => ({
    packageName,
    fromTrack: 'Closed testers',
    toTrack: 'production',
    approved: true,
    ...input,
  });
  await withPlay(promotable(), {}, async (publisher, observed) => {
    await assert.rejects(promotePlayReleaseWithPublisher(promote({}), publisher), /needs --confirm-production/u);
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ toTrack: 'beta', status: 'inProgress', userFraction: 0.1 }), publisher),
      /needs --confirm-production/u,
    );
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ toTrack: 'Closed testers' }), publisher),
      /must name different/u,
    );
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ status: 'inProgress', confirmProduction: true }), publisher),
      /needs --user-fraction/u,
    );
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ userFraction: 0.1, confirmProduction: true }), publisher),
      /only to an inProgress/u,
    );
    assert.equal(observed.operations.length, 0);

    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ versionCode: 46, confirmProduction: true }), publisher),
      /no release with version code 46; only a version already on the source track/u,
    );
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ versionCode: 47, confirmProduction: true }), publisher),
      /version 47 is halted/u,
    );
    assert.equal(observed.updates.length, 0);
    assert.ok(observed.operations.at(-1)?.startsWith('DELETE '), 'refused promote discards its edit');

    const planned = await promotePlayReleaseWithPublisher(
      promote({ status: 'inProgress', userFraction: 0.1, dryRun: true }), publisher,
    );
    assert.equal(planned.status, 'dry-run');
    const staged10 = { ...tested, status: 'inProgress', userFraction: 0.1 };
    assert.deepEqual(planned.plannedTrack?.releases, [completed44, staged10]);
    assert.equal(observed.updates.length, 0);

    const promoted = await promotePlayReleaseWithPublisher(
      promote({ status: 'inProgress', userFraction: 0.1, confirmProduction: true }), publisher,
    );
    assert.equal(promoted.status, 'committed');
    assert.deepEqual(promoted.versionCodes, ['45']);
    assert.deepEqual(observed.live().tracks.production, [completed44, staged10]);
    assert.deepEqual(observed.live().tracks['Closed testers']?.[0], tested, 'source track unchanged');
    assert.equal(observed.operations.some((item) => item.includes('/upload/')), false);
    assert.deepEqual(observed.updates.map((update) => update.track), ['production']);

    const again = await promotePlayReleaseWithPublisher(
      promote({ status: 'inProgress', userFraction: 0.1, confirmProduction: true }), publisher,
    );
    assert.equal(again.status, 'unchanged');
    await assert.rejects(
      promotePlayReleaseWithPublisher(
        promote({ status: 'inProgress', userFraction: 0.2, confirmProduction: true }), publisher,
      ),
      /already has version 45 as inProgress with other options/u,
    );

    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ fromTrack: 'internal', toTrack: 'beta' }), publisher),
      /exactly one completed release to promote/u,
    );
    const toBeta = await promotePlayReleaseWithPublisher(
      promote({
        fromTrack: 'internal', toTrack: 'beta', versionCode: 46,
        releaseNotes: [{ language: 'en-US', text: 'Open beta.' }],
      }),
      publisher,
    );
    assert.equal(toBeta.status, 'committed');
    assert.deepEqual(observed.live().tracks.beta, [{
      name: 'launch-02', status: 'completed', versionCodes: ['46'],
      releaseNotes: [{ language: 'en-US', text: 'Open beta.' }],
    }]);
    await assert.rejects(
      promotePlayReleaseWithPublisher(
        promote({ toTrack: 'alpha', status: 'inProgress', userFraction: 0.1, confirmProduction: true }),
        publisher,
      ),
      /alpha has no completed release yet/u,
    );
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ toTrack: 'Closed testrs' }), publisher),
      /no Closed testrs track/u,
    );
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ fromTrack: 'Missing track', toTrack: 'beta' }), publisher),
      /no Missing track track/u,
    );
  });
  // Refusals: no --approve, an unknown status, the internal/qa alias as both ends.
  await withPlay(promotable(), {}, async (publisher, observed) => {
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ approved: false, confirmProduction: true }), publisher),
      /requires --approve/u,
    );
    await assert.rejects(
      promotePlayReleaseWithPublisher(
        promote({ status: 'halted' as never, confirmProduction: true }), publisher,
      ),
      /--status must be/u,
    );
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ fromTrack: 'internal', toTrack: 'QA' }), publisher),
      /must name different/u,
    );
    assert.equal(observed.operations.length, 0);
    // A dry run needs neither approval nor confirmation.
    const planned = await promotePlayReleaseWithPublisher(
      promote({ approved: false, dryRun: true }), publisher,
    );
    assert.equal(planned.status, 'dry-run');
  });

  // A multi-code release is promoted whole, also when selected by one code,
  // so the --version-code re-run after a lost commit reports unchanged.
  const multi: LiveState = {
    bundles: [],
    tracks: {
      alpha: [{ name: 'split', status: 'completed', versionCodes: ['50', '51'] }],
      beta: [
        { name: 'staged', status: 'inProgress', versionCodes: ['49'], userFraction: 0.3 },
        completed44,
      ],
    },
  };
  await withPlay(multi, { loseFirstCommit: true }, async (publisher, observed) => {
    let uncertain: unknown;
    await promotePlayReleaseWithPublisher(promote({ fromTrack: 'alpha', toTrack: 'beta' }), publisher)
      .catch((error: unknown) => { uncertain = error; });
    assert.ok(uncertain instanceof PlayPromoteUncertainError, 'lost multi-code commit');
    assert.deepEqual(uncertain.versionCodes, ['50', '51']);
    // The completed promotion replaced the running beta rollout, as a dry run shows.
    assert.deepEqual(observed.live().tracks.beta, [
      completed44,
      { name: 'split', status: 'completed', versionCodes: ['50', '51'] },
    ]);
    const rerun = await promotePlayReleaseWithPublisher(
      promote({ fromTrack: 'alpha', toTrack: 'beta', versionCode: 51 }), publisher,
    );
    assert.equal(rerun.status, 'unchanged');
    assert.deepEqual(rerun.versionCodes, ['50', '51']);
  });
  await withPlay(multi, {}, async (publisher) => {
    const planned = await promotePlayReleaseWithPublisher(
      promote({ fromTrack: 'alpha', toTrack: 'beta', versionCode: 50, dryRun: true }), publisher,
    );
    assert.deepEqual(planned.versionCodes, ['50', '51']);
    assert.deepEqual(planned.superseded, [
      { name: 'staged', status: 'inProgress', versionCodes: ['49'], userFraction: 0.3 },
    ]);
  });

  // A refused track update keeps Play's error and discards the edit; a lost
  // validate response is uncertain and commits nothing.
  await withPlay(promotable(), { failTrackUpdate: 400 }, async (publisher, observed) => {
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ toTrack: 'beta' }), publisher),
      (error: unknown) => !(error instanceof PlayPromoteUncertainError),
    );
    assert.ok(observed.operations.at(-1)?.startsWith('DELETE '), 'refused update discards the edit');
    assert.equal(observed.operations.some((item) => item.endsWith(':commit')), false);
  });
  await withPlay(promotable(), { failTrackUpdate: 503 }, async (publisher) => {
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ toTrack: 'beta' }), publisher),
      (error: unknown) => error instanceof PlayPromoteUncertainError && error.stage === 'track-update',
    );
  });
  await withPlay(promotable(), { loseValidate: true }, async (publisher, observed) => {
    await assert.rejects(
      promotePlayReleaseWithPublisher(promote({ toTrack: 'beta' }), publisher),
      (error: unknown) => error instanceof PlayPromoteUncertainError && error.stage === 'validate',
    );
    assert.equal(observed.operations.some((item) => item.endsWith(':commit')), false);
    assert.equal(observed.live().tracks.beta, undefined);
  });

  await withPlay(promotable(), { loseFirstCommit: true }, async (publisher) => {
    let uncertain: unknown;
    await promotePlayReleaseWithPublisher(promote({ confirmProduction: true }), publisher)
      .catch((error: unknown) => { uncertain = error; });
    assert.ok(uncertain instanceof PlayPromoteUncertainError, 'lost promote commit is uncertain');
    assert.deepEqual(uncertain.versionCodes, ['45']);
    assert.match(uncertain.message, /--version-code 45/u);
    const rerun = await promotePlayReleaseWithPublisher(
      promote({ confirmProduction: true, versionCode: 45 }), publisher,
    );
    assert.equal(rerun.status, 'unchanged');
  });

  console.info(
    'Verified Google Play tracks, rollout, notes, mapping, draft-app and promote cases passed.',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
