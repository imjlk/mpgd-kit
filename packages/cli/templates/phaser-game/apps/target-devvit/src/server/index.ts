import { createServer, context, getServerPort, reddit, redis } from '@devvit/web/server';
import type { UiResponse } from '@devvit/web/shared';
import {
  assertBridgeRequest,
  createBridgeError,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import {
  createBridgeRpcFetchHandler,
  createBridgeRpcRouter,
  defaultBridgeRpcEndpoint,
} from '@mpgd/bridge/orpc';
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import helmet from 'helmet';

const app = express();
const redisKeyComponentPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const maxStorageKeyLength = 128;
const maxEncodedStorageKeyLength = 384;
const leaderboardUpdateMaxAttempts = 3;
const leaderboardBackoffBaseMs = 25;
const leaderboardLockTtlMs = 2_000;
const leaderboardLockTtlSeconds = Math.ceil(leaderboardLockTtlMs / 1_000);
const leaderboardLockRetryBudgetMs = leaderboardLockTtlSeconds * 1_000;
const gameName = '__GAME_NAME__';
const gameTitle = __GAME_TITLE_TS_LITERAL__;
const expressManagedResponseHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'transfer-encoding',
]);

app.disable('x-powered-by');
app.use(helmet());

const bridgeRpcFetchHandler = createBridgeRpcFetchHandler(
  createBridgeRpcRouter(handleBridgeRequest),
);

app.use(defaultBridgeRpcEndpoint, express.raw({ type: '*/*', limit: '1mb' }), async (
  request: ExpressRequest,
  response: ExpressResponse,
): Promise<void> => {
  try {
    const fetchResponse = await bridgeRpcFetchHandler(expressRequestToFetchRequest(request));
    await sendFetchResponse(response, fetchResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Devvit oRPC request failed.';
    console.error(`devvit oRPC internal error: ${message}`, error);
    response.status(500).json(
      createBridgeError(
        requestIdFromBody(request.body),
        'DEVVIT_BRIDGE_INTERNAL_ERROR',
        'Devvit bridge request failed.',
        true,
      ),
    );
  }
});

app.use(express.json({ limit: '1mb' }));

app.post('/internal/menu/create-post', async (
  _request: ExpressRequest,
  response: ExpressResponse,
): Promise<void> => {
  const subredditName = currentSubredditName();

  if (subredditName === undefined) {
    response.status(200).json({
      showToast: {
        text: 'Could not resolve the target subreddit for this menu action.',
        appearance: 'neutral',
      },
    } satisfies UiResponse);
    return;
  }

  try {
    const post = await reddit.submitCustomPost({
      subredditName,
      title: gameTitle,
      entry: 'default',
      textFallback: {
        text: `Open this Reddit custom post to play ${gameTitle}.`,
      },
      postData: {
        source: gameName,
        createdBy: 'devvit-menu',
      },
    });

    response.status(200).json({
      showToast: {
        text: `Created ${gameTitle} post ${post.id}.`,
        appearance: 'success',
      },
    } satisfies UiResponse);
  } catch (error) {
    console.error(`devvit custom post creation failed: ${errorMessage(error)}`, error);
    response.status(200).json({
      showToast: {
        text: `Could not create the ${gameTitle} post.`,
        appearance: 'neutral',
      },
    } satisfies UiResponse);
  }
});

app.post('/api/mpgd/bridge', async (
  request: ExpressRequest,
  response: ExpressResponse,
): Promise<void> => {
  let bridgeRequest: BridgeRequest;

  try {
    bridgeRequest = assertBridgeRequest(request.body);
  } catch (error) {
    response.status(400).json(
      createBridgeError(
        requestIdFromBody(request.body),
        'INVALID_BRIDGE_REQUEST',
        error instanceof Error ? error.message : 'Invalid bridge request.',
      ),
    );
    return;
  }

  try {
    const bridgeResponse = await handleBridgeRequest(bridgeRequest);
    response.status(200).json(bridgeResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Devvit bridge request failed.';
    console.error(`devvit bridge internal error: ${message}`, error);

    response.status(500).json(
      createBridgeError(
        bridgeRequest.id,
        'DEVVIT_BRIDGE_INTERNAL_ERROR',
        'Devvit bridge request failed.',
        true,
      ),
    );
  }
});

const server = createServer(app);
const port = getServerPort();

server.on('error', (error) => {
  console.error(`devvit server error: ${error.stack}`);
});

server.listen(port, () => {
  console.log(`devvit server listening on ${port}`);
});

async function handleBridgeRequest(input: BridgeRequest): Promise<BridgeResponse> {
  switch (input.method) {
    case 'runtime.getCapabilities':
      return ok(input, {
        nativeIap: false,
        nativeAds: false,
        rewardedAds: false,
        interstitialAds: false,
        nativeLeaderboard: true,
        achievements: false,
        cloudSave: true,
        socialShare: true,
        haptics: false,
        localizedContent: true,
      });

    case 'identity.getPlayer': {
      const playerId = currentPlayerId();

      if (playerId === undefined) {
        return ok(input, null);
      }

      return ok(input, {
        playerId,
        displayName: await currentDisplayName(playerId),
      });
    }

    case 'commerce.getProducts':
    case 'commerce.getEntitlements':
      return ok(input, []);

    case 'commerce.purchase':
      return ok(input, {
        status: 'cancelled',
        entitlementIds: [],
      });

    case 'commerce.restore':
      return ok(input, {
        restoredEntitlements: [],
      });

    case 'ads.preload':
      return ok(input, {});

    case 'leaderboard.open':
      return createBridgeError(
        input.id,
        'DEVVIT_LEADERBOARD_OPEN_UNAVAILABLE',
        'Devvit leaderboard display is not implemented yet.',
      );

    case 'ads.showRewarded':
      return ok(input, {
        status: 'unavailable',
        rewardGranted: false,
      });

    case 'ads.showInterstitial':
      return ok(input, {
        status: 'unavailable',
      });

    case 'leaderboard.submitScore':
      return submitLeaderboardScore(input);

    case 'storage.load':
      return loadStorage(input);

    case 'storage.save':
      return saveStorage(input);

    default:
      return createBridgeError(
        input.id,
        'UNSUPPORTED_METHOD',
        `Unsupported Devvit bridge method: ${input.method}`,
      );
  }
}

async function submitLeaderboardScore(input: BridgeRequest): Promise<BridgeResponse> {
  const payload = optionalObjectPayload(input.payload) as {
    readonly leaderboardId?: unknown;
    readonly score?: unknown;
  };
  const leaderboardId = leaderboardIdFromPayload(input, payload.leaderboardId);
  const playerId = currentPlayerId();

  if (typeof leaderboardId !== 'string') {
    return leaderboardId;
  }

  if (typeof payload.score !== 'number' || !Number.isFinite(payload.score)) {
    return createBridgeError(
      input.id,
      'INVALID_LEADERBOARD_SCORE',
      'Finite leaderboard score is required.',
    );
  }

  if (playerId === undefined) {
    return ok(input, {
      submitted: false,
    });
  }

  const redisKey = leaderboardKey(leaderboardId);
  let scoreUpdate: 'updated' | 'unchanged' | 'failed';

  try {
    scoreUpdate = await submitMaxLeaderboardScore(redisKey, playerId, payload.score);
  } catch (error) {
    console.warn(`devvit leaderboard score submission failed: ${errorMessage(error)}`);
    scoreUpdate = 'failed';
  }

  return ok(input, {
    submitted: scoreUpdate !== 'failed',
    highScoreUpdated: scoreUpdate === 'updated',
  });
}

async function loadStorage(input: BridgeRequest): Promise<BridgeResponse> {
  const playerId = currentPlayerId();

  if (playerId === undefined) {
    return ok(input, null);
  }

  const key = storageKey(input, playerId);

  if (typeof key !== 'string') {
    return key;
  }

  const stored = await redis.get(key);

  if (stored === undefined || stored === null) {
    return ok(input, null);
  }

  try {
    return ok(input, JSON.parse(stored));
  } catch {
    return createBridgeError(input.id, 'CORRUPTED_STORAGE_VALUE', 'Stored data is not valid JSON.');
  }
}

async function saveStorage(input: BridgeRequest): Promise<BridgeResponse> {
  const playerId = currentPlayerId();

  if (playerId === undefined) {
    return ok(input, {
      saved: false,
    });
  }

  const key = storageKey(input, playerId);

  if (typeof key !== 'string') {
    return key;
  }

  const payload = optionalObjectPayload(input.payload) as { readonly value?: unknown };

  try {
    await redis.set(key, JSON.stringify(payload.value ?? null));
  } catch (error) {
    console.warn(`devvit storage save was not persisted for key ${key}: ${errorMessage(error)}`);

    return ok(input, {
      saved: false,
      playerId,
    });
  }

  return ok(input, {
    saved: true,
    playerId,
  });
}

function requestIdFromBody(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return 'unknown';
  }

  const candidate = input as { readonly id?: unknown };
  return typeof candidate.id === 'string' ? candidate.id : 'unknown';
}

function ok(input: BridgeRequest, data: unknown): BridgeResponse {
  return {
    id: input.id,
    ok: true,
    data,
  };
}

function storageKey(input: BridgeRequest, playerId: string): string | BridgeResponse {
  const payload = optionalObjectPayload(input.payload);

  if (typeof payload.key !== 'string' || payload.key.length === 0) {
    return createBridgeError(input.id, 'INVALID_STORAGE_KEY', 'Storage key is required.');
  }

  if (payload.key.length > maxStorageKeyLength) {
    return createBridgeError(input.id, 'INVALID_STORAGE_KEY', 'Storage key is too long.');
  }

  const encodedKey = encodeURIComponent(payload.key);

  if (encodedKey.length > maxEncodedStorageKeyLength) {
    return createBridgeError(input.id, 'INVALID_STORAGE_KEY', 'Encoded storage key is too long.');
  }

  return `${gameName}:save:${encodeURIComponent(playerId)}:${encodedKey}`;
}

function leaderboardIdFromPayload(
  input: BridgeRequest,
  value: unknown,
): string | BridgeResponse {
  if (value === undefined) {
    return 'default';
  }

  if (typeof value !== 'string' || !isValidRedisKeyComponent(value)) {
    return createBridgeError(
      input.id,
      'INVALID_LEADERBOARD_ID',
      'Leaderboard id format is invalid.',
    );
  }

  return value;
}

function leaderboardKey(leaderboardId: string): string {
  return `${gameName}:leaderboard:${encodeURIComponent(leaderboardId)}`;
}

async function submitMaxLeaderboardScore(
  redisKey: string,
  playerId: string,
  score: number,
): Promise<'updated' | 'unchanged' | 'failed'> {
  const lockKey = leaderboardLockKey(redisKey, playerId);
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt <= leaderboardLockRetryBudgetMs) {
    const lockToken = createLockToken();
    const acquiredLock = await acquireLeaderboardLock(lockKey, lockToken);

    if (!acquiredLock) {
      await delay(nextLeaderboardRetryDelay(attempt, startedAt));
      attempt += 1;
      continue;
    }

    try {
      const currentScore = await redis.zScore(redisKey, playerId);

      if (currentScore !== undefined && score <= currentScore) {
        return 'unchanged';
      }

      if (await writeLeaderboardScoreIfLockHeld(lockKey, lockToken, redisKey, playerId, score)) {
        return 'updated';
      }

      await delay(nextLeaderboardRetryDelay(attempt, startedAt));
      attempt += 1;
    } finally {
      try {
        await releaseLeaderboardLock(lockKey, lockToken);
      } catch (error) {
        console.warn(`devvit leaderboard lock release failed: ${errorMessage(error)}`);
      }
    }
  }

  console.warn(`devvit leaderboard lock contention exceeded retry budget for key: ${lockKey}`);

  return 'failed';
}

function leaderboardLockKey(redisKey: string, playerId: string): string {
  return `${redisKey}:lock:${encodeURIComponent(playerId)}`;
}

function createLockToken(): string {
  const cryptoImpl = globalThis.crypto;

  if (typeof cryptoImpl?.randomUUID === 'function') {
    return cryptoImpl.randomUUID();
  }

  if (typeof cryptoImpl?.getRandomValues === 'function') {
    const values = new Uint32Array(4);
    cryptoImpl.getRandomValues(values);

    return Array.from(values, (value) => value.toString(36).padStart(7, '0')).join('');
  }

  throw new Error('Web Crypto is required to create a Devvit leaderboard lock token.');
}

async function acquireLeaderboardLock(lockKey: string, lockToken: string): Promise<boolean> {
  const result = await redis.set(lockKey, lockToken, {
    nx: true,
    expiration: leaderboardLockExpirationDate(),
  });

  return result === 'OK';
}

function leaderboardLockExpirationDate(): Date {
  // Devvit Redis SetOptions expects a Date and converts it to Redis EX seconds internally.
  return new Date(Date.now() + leaderboardLockTtlSeconds * 1_000);
}

async function writeLeaderboardScoreIfLockHeld(
  lockKey: string,
  lockToken: string,
  redisKey: string,
  playerId: string,
  score: number,
): Promise<boolean> {
  const transaction = await redis.watch(lockKey);
  const currentToken = await redis.get(lockKey);

  if (currentToken !== lockToken) {
    await transaction.unwatch();
    return false;
  }

  await transaction.multi();
  await transaction.zAdd(redisKey, {
    member: playerId,
    score,
  });

  const results = await transaction.exec();

  return Array.isArray(results) && results.length > 0;
}

async function releaseLeaderboardLock(lockKey: string, lockToken: string): Promise<void> {
  for (let attempt = 0; attempt < leaderboardUpdateMaxAttempts; attempt += 1) {
    const transaction = await redis.watch(lockKey);
    const currentToken = await redis.get(lockKey);

    if (currentToken !== lockToken) {
      await transaction.unwatch();
      return;
    }

    await transaction.multi();
    await transaction.del(lockKey);

    const results = await transaction.exec();

    if (Array.isArray(results) && results.length > 0) {
      return;
    }

    await delay(leaderboardBackoffBaseMs * (attempt + 1));
  }

  console.warn(`devvit leaderboard lock release exhausted retries for key: ${lockKey}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nextLeaderboardRetryDelay(attempt: number, startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, leaderboardLockRetryBudgetMs - elapsed);
  const backoff = leaderboardBackoffBaseMs * (attempt + 1);

  return Math.min(backoff, remaining);
}

function isValidRedisKeyComponent(value: string): boolean {
  return redisKeyComponentPattern.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentPlayerId(): string | undefined {
  const devvitContext = context as {
    readonly userId?: string;
  };

  return devvitContext.userId;
}

async function currentDisplayName(fallbackDisplayName: string): Promise<string> {
  try {
    const username = await reddit.getCurrentUsername();

    if (typeof username === 'string' && username.length > 0) {
      return username;
    }
  } catch (error) {
    console.warn(`devvit username lookup failed: ${errorMessage(error)}`);
  }

  return fallbackDisplayName;
}

function currentSubredditName(): string | undefined {
  const devvitContext = context as {
    readonly subredditName?: string;
  };

  return typeof devvitContext.subredditName === 'string' && devvitContext.subredditName.length > 0
    ? devvitContext.subredditName
    : undefined;
}

function optionalObjectPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }

  return payload as Record<string, unknown>;
}

function expressRequestToFetchRequest(request: ExpressRequest): Request {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    }
  }

  const init: RequestInit = {
    method: request.method,
    headers,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    init.body = requestBodyToBodyInit(request.body);
  }

  return new Request(expressRequestUrl(request), init);
}

function requestBodyToBodyInit(input: unknown): BodyInit {
  if (input instanceof Uint8Array) {
    const body = new Uint8Array(input.byteLength);
    body.set(input);

    return body.buffer as ArrayBuffer;
  }

  return JSON.stringify(input ?? null);
}

function expressRequestUrl(request: ExpressRequest): string {
  const host = request.get('host') ?? 'localhost';
  const protocol = request.protocol || 'https';

  return `${protocol}://${host}${request.originalUrl}`;
}

async function sendFetchResponse(
  response: ExpressResponse,
  fetchResponse: Response,
): Promise<void> {
  fetchResponse.headers.forEach((value: string, key: string) => {
    if (!expressManagedResponseHeaders.has(key.toLowerCase())) {
      response.setHeader(key, value);
    }
  });

  response.status(fetchResponse.status);
  response.send(await fetchResponse.text());
}
