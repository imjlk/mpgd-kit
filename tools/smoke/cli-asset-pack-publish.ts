import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAssetPackTarget } from '../../packages/cli/src/asset-pack-target';
import {
  AssetPackPublicationError,
  publishAssetPacks,
  type AssetPackPublicationOptions,
} from '../../packages/cli/src/asset-pack-publish';

const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest(
  'hex',
);
const hmac = (key: Uint8Array | string, value: string): Buffer => createHmac('sha256', key).update(value).digest();
const fixtureAccess = 'asset173-fixture-access';
const fixtureSecret = 'asset173-fixture-secret-never-report';
const fixtureToken = 'asset173-fixture-session-never-report';
const envNames = ['ASSET173_TEST_ACCESS', 'ASSET173_TEST_SECRET', 'ASSET173_TEST_SESSION'] as const;
const originalEnv = envNames.map((name) => process.env[name]);
process.env[envNames[0]] = fixtureAccess;
process.env[envNames[1]] = fixtureSecret;
process.env[envNames[2]] = fixtureToken;
const encode = (value: string): string => encodeURIComponent(value).replace(
  /[!'()*]/g,
  (part) => '%' + part.charCodeAt(0).toString(16).toUpperCase(),
);

/** Independently validate actual SDK wire SigV4, rather than mocking send(). */
function verifySignature(request: IncomingMessage, bytes: Buffer): void {
  const auth = String(request.headers.authorization);
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
    auth,
  );
  assert.ok(match, 'Fixture requires SigV4 authorization');
  assert.equal(match[1], fixtureAccess);
  assert.equal(request.headers['x-amz-security-token'], fixtureToken);
  const scope = match[2]!;
  const [date, region, service, terminator] = scope.split('/');
  assert.equal(service, 's3');
  assert.equal(terminator, 'aws4_request');
  const url = new URL(request.url!, 'http://fixture');
  const query = [...url.searchParams].map(([key, value]) => [encode(key), encode(value)]).sort(([a, b], [c, d]) => a!.localeCompare(c!) || b!.localeCompare(d!)).map(([key, value]) => `${key}=${value}`).join(
    '&',
  );
  const headers = match[3]!.split(';').map((key) => `${key}:${String(request.headers[key]).trim().replace(/\s+/g, ' ')}\n`).join(
    '',
  );
  const payload = String(request.headers['x-amz-content-sha256']);
  assert.equal(payload, hash(bytes), 'HTTP fixture requests sign the real body digest');
  const canonical = [request.method, url.pathname, query, headers, match[3], payload].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + fixtureSecret, date!), region!), service!),
    terminator!,
  );
  const signature = hmac(signingKey, ['AWS4-HMAC-SHA256', request.headers['x-amz-date'], scope, hash(canonical)].join('\n')).toString(
    'hex',
  );
  assert.equal(match[4], signature);
}

type Stored = { body: Buffer; contentType: string; cacheControl: string; metadataSha: string };
type Mode = 'normal' | 'race-same' | 'race-different' | 'retry-once' | 'fail' | 'denied' | 'redirect' | 'hang' | 'tamper' | 'missing-checksum';
const root = await mkdtemp(join(tmpdir(), 'mpgd-asset-publish-'));
const stored = new Map<string, Stored>();
const requests: { method: string; key: string }[] = [];
const fixtureErrors: unknown[] = [];
let mode: Mode = 'normal';
let firstPut = true;
let redirected = 0;
const redirectServer = createServer((_request, response) => {
  redirected++;
  response.end();
});
await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
const redirectPort = (redirectServer.address() as { port: number }).port;
const xmlError = (response: ServerResponse, status: number, code: string): void => {
  response.writeHead(status, { 'Content-Type': 'application/xml' });
  response.end(`<Error><Code>${code}</Code><Message>${fixtureSecret}</Message></Error>`);
};
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  verifySignature(request, body);
  const url = new URL(request.url!, 'http://fixture');
  const [bucket, ...path] = url.pathname.slice(1).split('/').map(decodeURIComponent);
  assert.equal(bucket, 'fixture-bucket');
  const key = path.join('/');
  requests.push({ method: request.method!, key });
  if (mode === 'denied') {
    xmlError(response, 403, 'AccessDenied');
    return;
  }
  if (mode === 'redirect') {
    response.writeHead(307, {
      Location: `http://127.0.0.1:${redirectPort}/?credential=${fixtureSecret}`,
    });
    response.end();
    return;
  }
  if (mode === 'hang') {
    return;
  }
  if (request.method === 'HEAD') {
    assert.equal(request.headers['x-amz-checksum-mode'], 'ENABLED');
    const object = stored.get(key);
    if (!object) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': object.body.length,
      'Content-Type': object.contentType,
      'Cache-Control': object.cacheControl,
      'x-amz-meta-mpgd-sha256': object.metadataSha,
      ...(mode === 'missing-checksum' ? {} : { 'x-amz-checksum-sha256': Buffer.from(hash(object.body), 'hex').toString('base64') }),
    });
    response.end();
    return;
  }
  assert.equal(request.method, 'PUT', 'Only the required HEAD/PUT surface is allowed');
  assert.equal(request.headers['if-none-match'], '*');
  assert.equal(Number(request.headers['content-length']), body.length);
  assert.equal(
    request.headers['x-amz-checksum-sha256'],
    Buffer.from(hash(body), 'hex').toString('base64'),
  );
  assert.equal(request.headers['x-amz-meta-mpgd-sha256'], hash(body));
  const object = {
    body,
    contentType: String(request.headers['content-type']),
    cacheControl: String(request.headers['cache-control']),
    metadataSha: hash(body),
  };
  if (mode === 'fail' || (mode === 'retry-once' && firstPut)) {
    firstPut = false;
    xmlError(response, 503, 'ServiceUnavailable');
    return;
  }
  if ((mode === 'race-same' || mode === 'race-different') && firstPut) {
    stored.set(
      key,
      mode === 'race-same'
        ? object
        : {
            ...object,
            body: Buffer.alloc(body.length),
            metadataSha: hash(Buffer.alloc(body.length)),
          },
    );
  }
  firstPut = false;
  if (stored.has(key)) {
    xmlError(response, 412, 'PreconditionFailed');
    return;
  }
  stored.set(key, mode === 'tamper' ? { ...object, body: Buffer.alloc(body.length) } : object);
  response.writeHead(200, { 'Content-Type': 'application/xml' });
  response.end();
}
const server = createServer((request, response) => {
  void handle(request, response).catch((error) => { fixtureErrors.push(error); xmlError(response, 500, 'FixtureFailure'); });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const endpoint = `http://127.0.0.1:${port}/`;
const options: AssetPackPublicationOptions = {
  deployment: join(root, 'deployment'),
  endpoint,
  bucket: 'fixture-bucket',
  prefix: 'release #1',
  allowHttpLoopback: true,
  accessKeyEnv: envNames[0],
  secretKeyEnv: envNames[1],
  sessionTokenEnv: envNames[2],
  requestTimeoutMs: 2000,
  timeoutMs: 10000,
};
const reset = (next: Mode): void => {
  mode = next;
  stored.clear();
  requests.length = 0;
  firstPut = true;
};
const rejects = async (input: AssetPackPublicationOptions, code: AssetPackPublicationError['code']): Promise<void> => {
  await assert.rejects(publishAssetPacks(input), (error: unknown) => {
    assert.ok(error instanceof AssetPackPublicationError);
    assert.equal(error.code, code);
    assert.equal(String(error).includes(fixtureSecret), false);
    assert.equal(String(error).includes(fixtureToken), false);
    return true;
  });
};
try {
  const staged = await buildAssetPackTarget({
    policy: {
      buildConfig: resolve('examples/asset-packs/delivery-configs/mixed.json'),
      defaultLocation: 'remote',
      offlineRequired: ['grove'],
      remoteBaseUrl: 'https://cdn.example.test/release-1/',
    },
    baseDir: '.',
    outDir: options.deployment,
  });
  const dry = await publishAssetPacks({
    ...options,
    dryRun: true,
    accessKeyEnv: 'INTENTIONALLY_MISSING',
  });
  assert.equal(requests.length, 0);
  assert.equal(dry.uploadedBytes, 0);
  assert.equal(
    dry.objects.length,
    staged.objects.filter((object) => object.location === 'remote').length + 1,
  );
  const published = await publishAssetPacks(options);
  assert.equal(
    published.objects.every((object) => object.action === 'uploaded'),
    true,
  );
  assert.equal(published.uploadedBytes, published.plannedBytes);
  assert.deepEqual(
    requests.filter((request) => request.method === 'PUT').map((request) => request.key),
    published.objects.map((object) => object.key),
  );
  assert.ok(
    published.objects.at(-1)?.key.includes('/manifests/'),
    'Immutable snapshot is uploaded last',
  );
  assert.ok(
    !JSON.stringify(published).includes(fixtureAccess) && !JSON.stringify(published).includes(fixtureSecret) && !JSON.stringify(published).includes(fixtureToken),
  );
  const repeat = await publishAssetPacks(options);
  assert.equal(repeat.uploadedBytes, 0);
  assert.equal(
    repeat.objects.every((object) => object.action === 'reused'),
    true,
  );
  reset('race-same');
  assert.equal((await publishAssetPacks(options)).objects[0]?.action, 'reused');
  reset('race-different');
  await rejects(options, 'collision');
  assert.equal(
    [...stored.keys()].some((key) => key.includes('/manifests/')),
    false,
  );
  reset('retry-once');
  await publishAssetPacks(options);
  assert.equal(
    requests.filter((request) => request.method === 'PUT' && request.key === dry.objects[0]?.key).length,
    2,
  );
  reset('fail');
  await rejects(options, 's3');
  assert.equal(requests.filter((request) => request.method === 'PUT').length, 2);
  assert.equal(stored.size, 0);
  reset('denied');
  await rejects(options, 's3');
  assert.equal(requests.filter((request) => request.method === 'PUT').length, 0);
  reset('redirect');
  await rejects(options, 's3');
  assert.equal(redirected, 0);
  reset('tamper');
  await rejects(options, 'collision');
  assert.equal(
    [...stored.keys()].some((key) => key.includes('/manifests/')),
    false,
  );
  reset('missing-checksum');
  await rejects(options, 'collision');
  reset('hang');
  await rejects({ ...options, requestTimeoutMs: 50 }, 'timeout');
  const controller = new AbortController();
  setTimeout(() => controller.abort(fixtureSecret), 30);
  await rejects({ ...options, signal: controller.signal }, 'cancelled');
  reset('normal');
  await rejects({ ...options, allowHttpLoopback: false }, 'config');
  await rejects({ ...options, endpoint: `https://user:${fixtureSecret}@example.test/` }, 'config');
  await rejects({ ...options, endpoint: `https://example.test/?token=${fixtureSecret}` }, 'config');
  await rejects({ ...options, prefix: '../live' }, 'config');
  await rejects({ ...options, maxObjectBytes: 1 }, 'limit');
  await rejects({ ...options, maxTotalBytes: 1 }, 'limit');
  await rejects({ ...options, maxObjects: 1 }, 'limit');
  await rejects({ ...options, accessKeyEnv: 'INTENTIONALLY_MISSING' }, 'config');
  assert.equal(requests.length, 0, 'Invalid plans/credentials never write externally');
  const source = staged.objects.find((object) => object.location === 'remote')!;
  const file = join(staged.remoteDir, source.path);
  const original = await readFile(file);
  await writeFile(file, Buffer.alloc(original.length));
  await rejects({ ...options, dryRun: true }, 'integrity');
  await writeFile(file, original);
  const cli = spawnSync(
    process.execPath,
    [
      resolve('packages/cli/dist/bin.js'),
      'assets',
      'publish-s3',
      '--deployment',
      options.deployment,
      '--endpoint',
      'https://s3.example.test/',
      '--bucket',
      options.bucket,
      '--prefix',
      options.prefix,
      '--dry-run',
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).plannedBytes, dry.plannedBytes);
  assert.deepEqual(fixtureErrors, []);
  console.info(
    'Asset publication smoke passed: signed HEAD/conditional PUT, checksums, immutable collisions, manifest-last, bounded retry/abort, dry-run and secret isolation.',
  );
} finally {
  server.closeAllConnections();
  redirectServer.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => redirectServer.close(() => resolve())),
  ]);
  await rm(root, { recursive: true, force: true });
  envNames.forEach((name, index) => {
    if (originalEnv[index] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnv[index];
    }
  });
}
