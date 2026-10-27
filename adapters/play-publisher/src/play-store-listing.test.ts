import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMockStoreListing } from './index.js';

/**
 * The store listing adapter against a local mock of the Android Publisher
 * REST surface: the paths, query parameters and bodies the generated SDK
 * sends for `edits.details`, `edits.listings`, `edits.images` and the edit
 * itself. No Google endpoint is called.
 */

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: Buffer;
}

const packageName = 'dev.mpgd.store';
const editId = 'edit-1';
const recorded: Recorded[] = [];
const base = `/androidpublisher/v3/applications/${packageName}`;
const uploadBase = `/upload/androidpublisher/v3/applications/${packageName}`;

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '', 'http://localhost');
    const entry: Recorded = {
      method: request.method ?? '',
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      body: await readBody(request),
    };
    recorded.push(entry);
    assert.equal(request.headers.authorization, 'Bearer mock-play-token');
    const key = `${entry.method} ${entry.path}`;
    switch (key) {
      case `POST ${base}/edits`:
        reply(response, 200, { id: editId });
        return;
      case `GET ${base}/edits/${editId}/details`:
        reply(response, 200, { defaultLanguage: 'en-US', contactEmail: 'old@example.com' });
        return;
      case `PUT ${base}/edits/${editId}/details`:
      case `PUT ${base}/edits/${editId}/listings/ko-KR`:
        reply(response, 200, JSON.parse(entry.body.toString('utf8')) as unknown);
        return;
      case `GET ${base}/edits/${editId}/listings`:
        reply(response, 200, { listings: [{ language: 'en-US', title: 'Block Party' }] });
        return;
      case `GET ${base}/edits/${editId}/listings/en-US/phoneScreenshots`:
        reply(response, 200, { images: [{ id: 'img-1', sha256: 'aa' }] });
        return;
      case `POST ${uploadBase}/edits/${editId}/listings/en-US/phoneScreenshots`:
        reply(response, 200, { image: { id: 'img-2', sha256: 'bb' } });
        return;
      case `DELETE ${base}/edits/${editId}/listings/en-US/phoneScreenshots`:
        reply(response, 200, { deleted: [{ id: 'img-1' }] });
        return;
      case `POST ${base}/edits/${editId}:commit`:
        reply(response, 200, { id: editId });
        return;
      case `DELETE ${base}/edits/${editId}`:
        reply(response, 204, undefined);
        return;
      default:
        reply(response, 404, { error: { code: 404, message: `unexpected ${key}` } });
    }
  })().catch((error: unknown) => {
    reply(response, 500, { error: { code: 500, message: String(error) } });
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-play-listing-adapter-'));
try {
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}/`;
  const port = createMockStoreListing('mock-play-token', root, root);

  assert.equal(await port.insertEdit(packageName), editId);
  assert.deepEqual(await port.getDetails(packageName, editId), {
    defaultLanguage: 'en-US',
    contactEmail: 'old@example.com',
  });
  await port.updateDetails({
    packageName,
    editId,
    details: { defaultLanguage: 'en-US', contactEmail: 'new@example.com' },
  });
  assert.deepEqual(JSON.parse(recorded[2]?.body.toString('utf8') ?? ''), {
    defaultLanguage: 'en-US',
    contactEmail: 'new@example.com',
  });
  assert.deepEqual(
    (await port.listListings(packageName, editId)).map((listing) => listing.language),
    ['en-US'],
  );
  await port.updateListing({
    packageName,
    editId,
    listing: { language: 'ko-KR', title: '블록', shortDescription: 's', fullDescription: 'f' },
  });
  assert.equal(recorded[4]?.method, 'PUT');
  assert.deepEqual(JSON.parse(recorded[4]?.body.toString('utf8') ?? ''), {
    language: 'ko-KR',
    title: '블록',
    shortDescription: 's',
    fullDescription: 'f',
  });

  const target = { packageName, editId, language: 'en-US', imageType: 'phoneScreenshots' as const };
  assert.deepEqual(await port.listImages(target), [{ id: 'img-1', sha256: 'aa' }]);
  const file = path.join(fixture, 'shot.png');
  writeFileSync(file, Buffer.from('png-bytes'));
  assert.deepEqual(
    await port.uploadImage({ ...target, file, mimeType: 'image/png', timeoutMs: 5000 }),
    { id: 'img-2', sha256: 'bb' },
  );
  const upload = recorded[6];
  assert.equal(upload?.method, 'POST');
  assert.ok(upload?.path.startsWith('/upload/'), 'images go to the media endpoint');
  assert.ok(upload?.body.includes(Buffer.from('png-bytes')), 'the file bytes are sent');
  await port.deleteAllImages(target);
  assert.equal(recorded[7]?.method, 'DELETE');

  await port.commitEdit({ packageName, editId, changesNotSentForReview: false });
  assert.deepEqual(recorded[8]?.query, { changesInReviewBehavior: 'ERROR_IF_IN_REVIEW' });
  await port.commitEdit({ packageName, editId, changesNotSentForReview: true });
  assert.deepEqual(recorded[9]?.query, {
    changesInReviewBehavior: 'ERROR_IF_IN_REVIEW',
    changesNotSentForReview: 'true',
  });
  await port.deleteEdit(packageName, editId);
  assert.equal(recorded[10]?.path, `${base}/edits/${editId}`);
  assert.equal(recorded.length, 11);
} finally {
  server.close();
  rmSync(fixture, { recursive: true, force: true });
}

console.info('Google Play store listing adapter tests passed.');
