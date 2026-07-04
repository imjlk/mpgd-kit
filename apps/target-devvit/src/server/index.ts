import { createServer, context, getServerPort, redis } from '@devvit/web/server';
import { createBridgeError, type BridgeRequest, type BridgeResponse } from '@mpgd/bridge';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';

const app = express();
const redisKeyComponentPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const leaderboardUpdateMaxAttempts = 3;

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

app.post('/api/mpgd/bridge', async (request: Request, response: Response): Promise<void> => {
  let bridgeRequest: BridgeRequest;

  try {
    bridgeRequest = parseBridgeRequest(request.body);
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
        displayName: currentDisplayName(playerId),
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
    case 'leaderboard.open':
      return ok(input, {});

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

  if (playerId === undefined) {
    return createBridgeError(input.id, 'DEVVIT_AUTH_REQUIRED', 'Devvit user identity is required.');
  }

  if (typeof payload.score !== 'number' || !Number.isFinite(payload.score)) {
    return createBridgeError(
      input.id,
      'INVALID_LEADERBOARD_SCORE',
      'Finite leaderboard score is required.',
    );
  }

  const redisKey = leaderboardKey(leaderboardId);
  const submitted = await submitMaxLeaderboardScore(redisKey, playerId, payload.score);

  return ok(input, {
    submitted,
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
    return ok(input, {});
  }

  const key = storageKey(input, playerId);

  if (typeof key !== 'string') {
    return key;
  }

  const payload = optionalObjectPayload(input.payload) as { readonly value?: unknown };
  await redis.set(key, JSON.stringify(payload.value ?? null));

  return ok(input, {});
}

function parseBridgeRequest(input: unknown): BridgeRequest {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Bridge request must be an object.');
  }

  const request = input as Partial<BridgeRequest>;

  if (typeof request.id !== 'string' || typeof request.method !== 'string') {
    throw new TypeError('Bridge request id and method are required.');
  }

  return {
    id: request.id,
    method: request.method,
    payload: request.payload ?? {},
    meta: request.meta ?? {
      target: 'reddit',
      appVersion: 'unknown',
      buildId: 'unknown',
      sentAt: new Date().toISOString(),
    },
  } as BridgeRequest;
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

  if (!isValidRedisKeyComponent(payload.key)) {
    return createBridgeError(input.id, 'INVALID_STORAGE_KEY', 'Storage key format is invalid.');
  }

  return `mpgd:save:${playerId}:${encodeURIComponent(payload.key)}`;
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
  return `mpgd:leaderboard:${encodeURIComponent(leaderboardId)}`;
}

async function submitMaxLeaderboardScore(
  redisKey: string,
  playerId: string,
  score: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < leaderboardUpdateMaxAttempts; attempt += 1) {
    const transaction = await redis.watch(redisKey);
    // Devvit TxClient queues commands only after MULTI, so the compare read stays after WATCH
    // while the conditional write is executed through the watched transaction.
    const currentScore = await redis.zScore(redisKey, playerId);

    if (currentScore !== undefined && score <= currentScore) {
      await transaction.unwatch();
      return false;
    }

    await transaction.multi();
    await transaction.zAdd(redisKey, {
      member: playerId,
      score,
    });

    const results = await transaction.exec();

    if (Array.isArray(results) && results.length > 0) {
      return true;
    }
  }

  throw new Error('Failed to update Devvit leaderboard score after concurrent writes.');
}

function isValidRedisKeyComponent(value: string): boolean {
  return redisKeyComponentPattern.test(value);
}

function currentPlayerId(): string | undefined {
  const devvitContext = context as {
    readonly userId?: string;
  };

  if (devvitContext.userId === undefined) {
    console.warn('devvit context.userId is undefined for a user-scoped bridge request');
  }

  return devvitContext.userId;
}

function currentDisplayName(fallbackDisplayName: string): string {
  const devvitContext = context as {
    readonly username?: string;
  };

  return devvitContext.username ?? fallbackDisplayName;
}

function optionalObjectPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }

  return payload as Record<string, unknown>;
}
