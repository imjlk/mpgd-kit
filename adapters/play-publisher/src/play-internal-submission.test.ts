import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isPlayEditClosedError,
  PlaySubmissionUncertainError,
  submitVerifiedAndroidBundle,
  submitVerifiedAndroidBundleWithPublisher,
} from '../../../packages/cli/src/play-internal-submission.js';
import type {
  PlayBundle,
  PlayPublisher,
  PlayTrack,
  PlayTrackRelease,
} from '../../../packages/cli/src/play-publisher-port.js';
import type { ImmutableNativeBuildRecord } from '../../../packages/cli/src/release-state.js';
import { inspectAndroidBundleSigner } from '../../../packages/cli/src/android-bundle-signer.js';
import { createSignedAabFixture } from '../../../packages/cli/test/signed-aab-fixture.js';
import { createMockPublisher } from './index.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-play-submission-'));
const aabFile = path.join(fixture, 'game.aab');
createSignedAabFixture(aabFile);
const bytes = readFileSync(aabFile);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const signerSha256 = await inspectAndroidBundleSigner(aabFile);
const packageName = 'dev.mpgd.playtest';
const record: ImmutableNativeBuildRecord = {
  releaseKey: 'beta-01',
  target: 'android',
  buildRunId: 'run-1',
  gameVersion: '1.0.0',
  sourceGitSha: 'a'.repeat(40),
  kitGitSha: 'b'.repeat(40),
  kitPackageVersion: '0.35.0',
  buildConfigDigest: 'c'.repeat(64),
  targetConfigDigest: 'd'.repeat(64),
  platformVersion: { versionCode: 45, versionName: '1.0.0' },
  artifactLocation: 'release-output/game.aab',
  artifactSha256: sha256,
  releaseManifestSha256: 'e'.repeat(64),
  inspectedAppId: packageName,
  inspectedSignerSha256: signerSha256,
};
const input = { record, aabFile, packageName, serviceAccountFile: 'not-used-in-mock' };

interface EditState {
  bundles: PlayBundle[];
  track: { track: string; releases: PlayTrackRelease[] };
}

type MockMode = 'ok' | 'already-committed' | 'draft-existing' | 'empty-track'
  | 'track-update-rejected' | 'auth-failure' | 'version-conflict'
  | 'upload-response-lost' | 'upload-rejected' | 'validate-response-lost'
  | 'commit-response-lost' | 'commit-conflict';

async function withPublisher(
  mode: MockMode,
  action: (
    publisher: PlayPublisher,
    observations: {
      readonly operations: string[];
      readonly updates: PlayTrack[];
      readonly rootUrl: string;
      /** The edit is finished outside this submission: Play answers failedPrecondition. */
      closeEdit(editId: string): void;
      setLive(state: EditState): void;
    },
  ) => Promise<void>,
): Promise<void> {
  const operations: string[] = [];
  const updates: PlayTrack[] = [];
  let live: EditState = {
    bundles: mode === 'version-conflict' ? [{ versionCode: 45, sha256: '0'.repeat(64) }]
      : mode === 'already-committed' || mode === 'draft-existing'
        ? [{ versionCode: 45, sha256 }] : [],
    track: {
      track: 'internal',
      releases: mode === 'empty-track' ? [] : [
        { name: 'older', status: 'completed', versionCodes: ['44'] },
        ...(mode === 'already-committed'
          ? [{ name: 'beta-01', status: 'completed', versionCodes: ['45'] }] : []),
        ...(mode === 'draft-existing'
          ? [{ name: 'beta-01', status: 'draft', versionCodes: ['45'] }] : []),
      ],
    },
  };
  let counter = 0;
  const edits = new Map<string, EditState>();
  const closedEdits = new Set<string>();
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      const pathname = url.pathname;
      const method = request.method ?? '';
      operations.push(`${method} ${pathname}${url.search}`);
      assert.equal(request.headers.authorization, 'Bearer mock-play-token');
      if (mode === 'auth-failure') {
        reply(response, 403, { error: { message: 'permission denied' } });
        return;
      }
      const editMatch = pathname.match(/\/applications\/dev\.mpgd\.playtest\/edits\/([^/]+)/u);
      if (method === 'POST' && pathname.endsWith('/applications/dev.mpgd.playtest/edits')) {
        const id = `edit-${++counter}`;
        edits.set(id, structuredClone(live));
        reply(response, 200, { id });
        return;
      }
      const editId = editMatch?.[1]?.split(':')[0];
      if (editId !== undefined && closedEdits.has(editId)) {
        reply(response, 400, closedEditError);
        return;
      }
      const edit = editId === undefined ? undefined : edits.get(editId);
      if (edit === undefined) {
        reply(response, 404, { error: { message: 'edit missing' } });
        return;
      }
      if (method === 'GET' && pathname.endsWith('/bundles')) {
        reply(response, 200, { bundles: edit.bundles });
      } else if (method === 'POST' && pathname.endsWith('/bundles')) {
        if (mode === 'upload-rejected') {
          reply(response, 400, { error: { message: 'invalid AAB' } });
          return;
        }
        const body = await readBody(request);
        assert.deepEqual(body, bytes);
        edit.bundles.push({ versionCode: 45, sha256 });
        if (mode === 'upload-response-lost') {
          reply(response, 500, { error: { message: 'response lost' } });
        } else {
          reply(response, 200, { versionCode: 45, sha256 });
        }
      } else if (method === 'GET' && pathname.endsWith('/tracks/internal')) {
        if (mode === 'empty-track' && edit.track.releases?.length === 0) {
          reply(response, 404, { error: { message: 'track missing' } });
        } else {
          reply(response, 200, edit.track);
        }
      } else if (method === 'PUT' && pathname.endsWith('/tracks/internal')) {
        if (mode === 'track-update-rejected') {
          reply(response, 400, { error: { message: 'track update rejected' } });
          return;
        }
        const desired = JSON.parse(
          (await readBody(request)).toString('utf8'),
        ) as EditState['track'];
        if (desired.releases.filter((item) => item.status === 'completed').length > 1) {
          reply(response, 400, { error: { message: 'Only one completed release is allowed.' } });
          return;
        }
        edit.track = desired;
        updates.push(edit.track);
        reply(response, 200, edit.track);
      } else if (method === 'POST' && pathname.endsWith(':validate')) {
        if (mode === 'validate-response-lost') {
          reply(response, 500, { error: { message: 'response lost' } });
        } else {
          reply(response, 200, { id: editId });
        }
      } else if (method === 'POST' && pathname.endsWith(':commit')) {
        assert.equal(url.searchParams.get('changesInReviewBehavior'), 'ERROR_IF_IN_REVIEW');
        if (mode !== 'commit-conflict') {
          live = structuredClone(edit);
          if (editId !== undefined) {
            edits.delete(editId);
          }
        }
        if (mode === 'commit-response-lost') {
          reply(response, 500, { error: { message: 'response lost' } });
        } else if (mode === 'commit-conflict') {
          reply(response, 409, { error: { message: 'edit conflict' } });
        } else {
          reply(response, 200, { id: editId });
        }
      } else {
        reply(response, 404, { error: { message: 'unknown route' } });
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
    assert.ok(address !== null && typeof address !== 'string');
    const publisher = createMockPublisher('mock-play-token', `http://127.0.0.1:${address.port}`);
    await action(publisher, {
      operations,
      updates,
      rootUrl: `http://127.0.0.1:${address.port}`,
      closeEdit: (editId) => {
        closedEdits.add(editId);
      },
      setLive: (state) => {
        live = structuredClone(state);
      },
    });
  } finally {
    server.close();
  }
}

const closedEditError = {
  error: {
    code: 400,
    status: 'FAILED_PRECONDITION',
    message: 'The edit is closed.',
    errors: [{ domain: 'global', reason: 'failedPrecondition', message: 'The edit is closed.' }],
  },
};

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

try {
  await assert.rejects(submitVerifiedAndroidBundle(input), /service account file is missing/u);
  await withPublisher('ok', async (publisher, observed) => {
    const persisted: string[] = [];
    let result;
    try {
      result = await submitVerifiedAndroidBundleWithPublisher({
        ...input, onEditCreated: async (editId) => { persisted.push(editId); },
      }, publisher, observed.rootUrl);
    } catch (error) {
      throw new Error(
        `Play SDK mock operations: ${observed.operations.join(', ')}; cause: ${String((error as Error).cause)}`,
        { cause: error },
      );
    }
    assert.deepEqual(persisted, ['edit-1']);
    assert.equal(result.status, 'committed');
    assert.equal(result.versionCode, 45);
    assert.equal(result.bundleSha256, sha256);
    // Play allows one completed release per track: the new one replaces the older one.
    assert.equal(
      JSON.stringify(observed.updates[0]),
      '{"track":"internal","releases":[{"name":"beta-01","status":"completed","versionCodes":["45"]}]}',
    );
    assert.equal(result.track, 'internal');
    assert.equal(result.releaseStatus, 'completed');
    assert.equal(result.draftAppFallback, false);
    assert.equal(observed.operations.filter((item) => item.includes(':commit')).length, 1);
  });
  await withPublisher('upload-response-lost', async (publisher, observed) => {
    const result = await submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl);
    assert.equal(result.status, 'committed');
  });
  await withPublisher('ok', async (publisher, observed) => {
    const editId = await publisher.insertEdit(packageName);
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...input,
      resumeEditId: editId,
      onEditCreated: async () => { throw new Error('Existing edit must not be recreated.'); },
    }, publisher, observed.rootUrl);
    assert.equal(result.editId, editId);
    assert.equal(observed.operations.filter((item) => item.endsWith('/edits')).length, 1);
  });
  await withPublisher('ok', async (publisher, observed) => {
    const editId = await publisher.insertEdit(packageName);
    await publisher.uploadBundle({
      packageName, editId, aabFile: input.aabFile, timeoutMs: 120_000,
      requestRootUrl: observed.rootUrl,
    });
    await publisher.updateTrack(packageName, editId, {
      track: 'internal',
      releases: [{ name: 'beta-01', status: 'completed', versionCodes: ['45'] }],
    });
    const resumed = await submitVerifiedAndroidBundleWithPublisher({
      ...input, resumeEditId: editId,
    }, publisher, observed.rootUrl);
    assert.equal(resumed.alreadyCommitted, false);
    assert.equal(observed.operations.filter((item) => item.includes(':commit')).length, 1);
  });
  await withPublisher('ok', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...input,
        onEditCreated: async () => { throw new Error('checkpoint unavailable'); },
      }, publisher, observed.rootUrl),
      (error: unknown) => error instanceof PlaySubmissionUncertainError
        && error.stage === 'checkpoint' && error.editId === 'edit-1',
    );
  });
  await withPublisher('upload-rejected', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl),
      (error: unknown) => !(error instanceof PlaySubmissionUncertainError),
    );
    assert.equal(observed.operations.some((item) => item.includes(':commit')), false);
  });
  await withPublisher('validate-response-lost', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl),
      (error: unknown) => error instanceof PlaySubmissionUncertainError
        && error.stage === 'validate' && error.editId === 'edit-1',
    );
    assert.equal(observed.operations.some((item) => item.includes(':commit')), false);
  });
  await withPublisher('already-committed', async (publisher, observed) => {
    const result = await submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl);
    assert.equal(result.alreadyCommitted, true);
    assert.equal(
      observed.operations.some((item) => item.includes('/upload/')),
      false,
    );
    assert.equal(
      observed.operations.some((item) => item.includes(':commit')),
      false,
    );
  });
  await withPublisher('already-committed', async (publisher, observed) => {
    const replaced: string[] = [];
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...input,
      resumeEditId: 'expired-edit',
      onEditCreated: async (id) => { replaced.push(id); },
    }, publisher, observed.rootUrl);
    assert.equal(result.alreadyCommitted, true);
    assert.deepEqual(replaced, ['edit-1']);
    assert.equal(observed.operations.some((item) => item.includes(':commit')), false);
  });
  // An edit left open by a refused track update resumes and replaces the older release.
  await withPublisher('ok', async (publisher, observed) => {
    const editId = await publisher.insertEdit(packageName);
    await publisher.uploadBundle({
      packageName, editId, aabFile: input.aabFile, timeoutMs: 120_000,
      requestRootUrl: observed.rootUrl,
    });
    const resumed = await submitVerifiedAndroidBundleWithPublisher({
      ...input, resumeEditId: editId,
    }, publisher, observed.rootUrl);
    assert.equal(resumed.editId, editId);
    assert.equal(resumed.alreadyCommitted, false);
    assert.deepEqual(observed.updates[0]?.releases?.map((item) => item.versionCodes), [['45']]);
  });
  // The recorded edit was committed outside the Kit: the live track shows the
  // release, so the resume marks it committed without another upload or commit.
  await withPublisher('ok', async (publisher, observed) => {
    const editId = await publisher.insertEdit(packageName);
    await publisher.uploadBundle({
      packageName, editId, aabFile: input.aabFile, timeoutMs: 120_000,
      requestRootUrl: observed.rootUrl,
    });
    await publisher.updateTrack(packageName, editId, {
      track: 'internal',
      releases: [{ name: 'beta-01', status: 'completed', versionCodes: ['45'] }],
    });
    await publisher.commitEdit(packageName, editId);
    observed.closeEdit(editId);
    const replaced: string[] = [];
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...input,
      resumeEditId: editId,
      onEditCreated: async (id) => { replaced.push(id); },
    }, publisher, observed.rootUrl);
    assert.equal(result.status, 'committed');
    assert.equal(result.alreadyCommitted, true);
    assert.equal(result.editId, 'edit-2');
    assert.deepEqual(replaced, ['edit-2']);
    assert.equal(observed.operations.filter((item) => item.includes('/upload/')).length, 1);
    assert.equal(observed.operations.filter((item) => item.includes(':commit')).length, 1);
    assert.equal(observed.updates.length, 1);
  });
  // The recorded edit closed without reaching the track: submit in the new edit.
  await withPublisher('ok', async (publisher, observed) => {
    const editId = await publisher.insertEdit(packageName);
    observed.closeEdit(editId);
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...input, resumeEditId: editId,
    }, publisher, observed.rootUrl);
    assert.equal(result.alreadyCommitted, false);
    assert.equal(result.editId, 'edit-2');
    assert.deepEqual(observed.updates[0]?.releases?.map((item) => item.versionCodes), [['45']]);
    assert.equal(observed.operations.filter((item) => item.includes(':commit')).length, 1);
  });
  // Closed edit, and the live track has this version code with other or no bytes.
  await withPublisher('ok', async (publisher, observed) => {
    const editId = await publisher.insertEdit(packageName);
    observed.closeEdit(editId);
    const holding = { track: 'internal', releases: [{ status: 'completed', versionCodes: ['45'] }] };
    observed.setLive({ bundles: [{ versionCode: 45, sha256: '0'.repeat(64) }], track: holding });
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...input, resumeEditId: editId,
      }, publisher, observed.rootUrl),
      /different bundle version or SHA-256/u,
    );
    observed.setLive({ bundles: [], track: holding });
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...input, resumeEditId: editId,
      }, publisher, observed.rootUrl),
      /without matching bundle bytes/u,
    );
    assert.equal(observed.operations.some((item) => item.includes(':commit')), false);
  });
  // The edit may close between the two reads of a resume.
  await withPublisher('ok', async (publisher, observed) => {
    const editId = await publisher.insertEdit(packageName);
    observed.setLive({
      bundles: [{ versionCode: 45, sha256 }],
      track: { track: 'internal', releases: [{ status: 'completed', versionCodes: ['45'] }] },
    });
    const closesOnTrackRead: PlayPublisher = {
      ...publisher,
      async getTrack(name, id, track, signal) {
        if (id === editId) {
          throw Object.assign(new Error('The edit is closed.'), {
            response: { status: 400, data: closedEditError },
          });
        }
        return publisher.getTrack(name, id, track, signal);
      },
    };
    const result = await submitVerifiedAndroidBundleWithPublisher({
      ...input, resumeEditId: editId,
    }, closesOnTrackRead, observed.rootUrl);
    assert.equal(result.alreadyCommitted, true);
    assert.equal(result.editId, 'edit-2');
  });
  // Any other refusal keeps the recorded edit: no replacement edit is opened.
  await withPublisher('auth-failure', async (publisher, observed) => {
    await assert.rejects(submitVerifiedAndroidBundleWithPublisher({
      ...input, resumeEditId: 'edit-1',
    }, publisher, observed.rootUrl));
    assert.equal(observed.operations.some((item) => item.endsWith('/edits')), false);
  });
  assert.equal(isPlayEditClosedError({ response: { status: 404 } }), true);
  assert.equal(
    isPlayEditClosedError({
      response: { status: 400, data: { error: { status: 'FAILED_PRECONDITION' } } },
    }),
    true,
  );
  assert.equal(
    isPlayEditClosedError({
      code: 400,
      errors: [{ reason: 'failedPrecondition' }],
    }),
    true,
  );
  assert.equal(
    isPlayEditClosedError({
      response: { status: 400, data: { error: { status: 'INVALID_ARGUMENT' } } },
    }),
    false,
  );
  // A 5xx says nothing about the edit, whatever its body names.
  assert.equal(
    isPlayEditClosedError({
      response: { status: 503, data: { error: { status: 'FAILED_PRECONDITION' } } },
    }),
    false,
  );
  assert.equal(isPlayEditClosedError(new Error('failedPrecondition')), false);
  // A stale release never replaces a newer completed one, before anything is sent.
  await withPublisher('ok', async (publisher, observed) => {
    observed.setLive({
      bundles: [],
      track: { track: 'internal', releases: [{ status: 'completed', versionCodes: ['46'] }] },
    });
    const persisted: string[] = [];
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher({
        ...input, onEditCreated: async (id) => { persisted.push(id); },
      }, publisher, observed.rootUrl),
      /newer/u,
    );
    assert.deepEqual(persisted, []);
    assert.equal(observed.operations.some((item) => item.includes('/upload/')), false);
    assert.equal(observed.updates.length, 0);
  });
  await withPublisher('draft-existing', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl),
      /not completed/u,
    );
    assert.equal(observed.operations.some((item) => item.includes(':commit')), false);
  });
  await withPublisher('empty-track', async (publisher, observed) => {
    const result = await submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl);
    assert.equal(result.status, 'committed');
    assert.deepEqual(
      observed.updates[0]?.releases?.map((item) => item.versionCodes),
      [['45']],
    );
  });
  await withPublisher('track-update-rejected', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl),
      (error: unknown) => !(error instanceof PlaySubmissionUncertainError),
    );
    assert.equal(observed.operations.some((item) => item.includes(':commit')), false);
  });
  await withPublisher('commit-response-lost', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl),
      (error: unknown) => error instanceof PlaySubmissionUncertainError
        && error.stage === 'commit' && error.editId === 'edit-1',
    );
    assert.equal(observed.operations.filter((item) => item.endsWith('/edits')).length, 1);
    const replacements: string[] = [];
    const reconciled = await submitVerifiedAndroidBundleWithPublisher({
      ...input,
      resumeEditId: 'edit-1',
      onEditCreated: async (id) => { replacements.push(id); },
    }, publisher, observed.rootUrl);
    assert.equal(reconciled.alreadyCommitted, true);
    assert.deepEqual(replacements, ['edit-2']);
    assert.equal(observed.operations.filter((item) => item.includes(':commit')).length, 1);
  });
  await withPublisher('commit-conflict', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl),
      (error: unknown) => error instanceof PlaySubmissionUncertainError
        && error.stage === 'commit' && error.editId === 'edit-1',
    );
  });
  await withPublisher('version-conflict', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl),
      /different bundle version or SHA-256/u,
    );
    assert.equal(observed.operations.some((item) => item.includes(':commit')), false);
  });
  await withPublisher('auth-failure', async (publisher, observed) => {
    await assert.rejects(submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl));
  });
  await withPublisher('ok', async (publisher, observed) => {
    await assert.rejects(submitVerifiedAndroidBundleWithPublisher({
      ...input, record: { ...record, inspectedSignerSha256: 'f'.repeat(64) },
    }, publisher, observed.rootUrl), /AAB signer differs/u);
    assert.equal(observed.operations.length, 0);
  });
  await withPublisher('ok', async (publisher, observed) => {
    await assert.rejects(submitVerifiedAndroidBundleWithPublisher({
      ...input, packageName: 'dev.mpgd.wrong',
    }, publisher, observed.rootUrl), /matching verified Android AAB/u);
    assert.equal(observed.operations.length, 0);
  });
  writeFileSync(aabFile, 'tampered');
  await withPublisher('ok', async (publisher, observed) => {
    await assert.rejects(
      submitVerifiedAndroidBundleWithPublisher(input, publisher, observed.rootUrl),
      /AAB bytes differ/u,
    );
    assert.equal(observed.operations.length, 0);
  });
  console.info('Verified Google Play internal submission mock cases passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
