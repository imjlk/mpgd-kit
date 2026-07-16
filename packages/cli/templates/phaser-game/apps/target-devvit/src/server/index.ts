import type { IncomingMessage, ServerResponse } from 'node:http';

import { createServer, context, getServerPort, reddit, redis } from '@devvit/web/server';
import type { UiResponse } from '@devvit/web/shared';
import {
  createBridgeError,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import {
  createBridgeRpcRouter,
  defaultBridgeRpcEndpoint,
} from '@mpgd/bridge/orpc';
import { createBridgeRpcNodeHandler } from '@mpgd/bridge/orpc/node';

const maxStorageKeyLength = 128;
const maxEncodedStorageKeyLength = 384;
const maxStorageValueBytes = 262_144;
const maxRequestBodySize = 1_048_576;
const gameName = '__GAME_NAME__';
const gameTitle = __GAME_TITLE_TS_LITERAL__;
const bridgeRpcHandler = createBridgeRpcNodeHandler(
  createBridgeRpcRouter(handleBridgeRequest),
  {
    maxBodySize: maxRequestBodySize,
    prefix: defaultBridgeRpcEndpoint,
  },
);

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  setResponseSecurityHeaders(response);

  if (request.method === 'POST' && requestPathname(request) === '/internal/menu/create-post') {
    try {
      await drainRequestBody(request, maxRequestBodySize);
    } catch (error) {
      if (!(error instanceof RequestBodyTooLargeError)) {
        throw error;
      }

      discardOversizedRequestBody(request, response);
      sendJson(response, 413, {
        error: 'REQUEST_BODY_TOO_LARGE',
      });
      return;
    }

    await handleCreatePostMenu(response);
    return;
  }

  if (await bridgeRpcHandler(request, response)) {
    return;
  }

  sendJson(response, 404, {
    error: 'NOT_FOUND',
  });
}

async function handleCreatePostMenu(response: ServerResponse): Promise<void> {
  const subredditName = currentSubredditName();

  if (subredditName === undefined) {
    sendJson(response, 200, {
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

    sendJson(response, 200, {
      showToast: {
        text: `Created ${gameTitle} post ${post.id}.`,
        appearance: 'success',
      },
    } satisfies UiResponse);
  } catch (error) {
    console.error(`devvit custom post creation failed: ${errorMessage(error)}`, error);
    sendJson(response, 200, {
      showToast: {
        text: `Could not create the ${gameTitle} post.`,
        appearance: 'neutral',
      },
    } satisfies UiResponse);
  }
}

const server = createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error: unknown) => {
    console.error(`devvit server request failed: ${errorMessage(error)}`, error);

    if (response.headersSent) {
      response.end();
      return;
    }

    sendJson(response, 500, {
      error: 'DEVVIT_SERVER_INTERNAL_ERROR',
    });
  });
});

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
        nativeLeaderboard: false,
        achievements: false,
        cloudSave: true,
        socialShare: false,
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

    case 'identity.getSession': {
      const playerId = currentPlayerId();

      return ok(
        input,
        playerId === undefined
          ? {
              identityLevel: 'guest',
              trustLevel: 'local',
            }
          : {
              identityLevel: 'authenticated',
              playerId,
              trustLevel: 'server-verified',
            },
      );
    }

    case 'identity.requestUpgrade': {
      const authenticated = currentPlayerId() !== undefined;

      return ok(input, {
        status: authenticated ? 'completed' : 'unavailable',
        reloadExpected: false,
      });
    }

    case 'presentation.getLaunchIntent':
      return ok(input, { entry: 'home' });

    case 'presentation.requestGameSurface':
      return ok(input, 'unavailable');

    case 'share.share':
      return ok(input, { status: 'unavailable' });

    case 'share.readInboundShare':
      return ok(input, null);

    case 'notifications.getStatus':
      return ok(input, 'approval-required');

    case 'notifications.requestSubscription':
      return ok(input, 'unavailable');

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
      return ok(input, {
        submitted: false,
      });

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

async function loadStorage(input: BridgeRequest): Promise<BridgeResponse> {
  const playerId = currentPlayerId();

  if (playerId === undefined) {
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_IDENTITY_REQUIRED',
      'A current Reddit player is required to load storage.',
    );
  }

  const key = storageKey(input, playerId);

  if (typeof key !== 'string') {
    return key;
  }

  let stored: string | null | undefined;

  try {
    stored = await redis.get(key);
  } catch (error) {
    console.warn(`devvit storage load failed: ${errorMessage(error)}`);
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_LOAD_FAILED',
      'Devvit storage could not be loaded.',
      true,
    );
  }

  if (stored === undefined || stored === null) {
    return ok(input, { found: false } satisfies BridgeStorageLoadData);
  }

  try {
    return ok(
      input,
      {
        found: true,
        value: JSON.parse(stored),
      } satisfies BridgeStorageLoadData,
    );
  } catch {
    return createBridgeError(input.id, 'CORRUPTED_STORAGE_VALUE', 'Stored data is not valid JSON.');
  }
}

async function saveStorage(input: BridgeRequest): Promise<BridgeResponse> {
  const playerId = currentPlayerId();

  if (playerId === undefined) {
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_IDENTITY_REQUIRED',
      'A current Reddit player is required to save storage.',
    );
  }

  const key = storageKey(input, playerId);

  if (typeof key !== 'string') {
    return key;
  }

  const payload = optionalObjectPayload(input.payload) as { readonly value?: unknown };
  let serialized: string;

  try {
    const candidate = JSON.stringify(payload.value);

    if (typeof candidate !== 'string') {
      throw new Error('JSON serialization did not produce a string.');
    }

    serialized = candidate;
  } catch {
    return createBridgeError(
      input.id,
      'INVALID_STORAGE_VALUE',
      'Storage values must be JSON serializable.',
    );
  }

  if (new TextEncoder().encode(serialized).length > maxStorageValueBytes) {
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_QUOTA_EXCEEDED',
      `Storage values must not exceed ${String(maxStorageValueBytes)} UTF-8 bytes.`,
    );
  }

  try {
    await redis.set(key, serialized);
  } catch (error) {
    console.warn(`devvit storage save was not persisted: ${errorMessage(error)}`);
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_SAVE_FAILED',
      'Devvit storage could not be saved.',
      true,
    );
  }

  return ok(input, {
    saved: true,
    playerId,
  });
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

function requestPathname(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

class RequestBodyTooLargeError extends Error {}

async function* readRequestBodyChunks(
  request: IncomingMessage,
  maxBodySize: number,
): AsyncGenerator<Buffer, void, undefined> {
  assertContentLengthWithinLimit(request, maxBodySize);

  let bodySize = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodySize += buffer.byteLength;

    if (bodySize > maxBodySize) {
      throw new RequestBodyTooLargeError();
    }

    yield buffer;
  }
}

async function drainRequestBody(
  request: IncomingMessage,
  maxBodySize: number,
): Promise<void> {
  for await (const _chunk of readRequestBodyChunks(request, maxBodySize)) {
    // Drain the bounded request stream without retaining its contents.
  }
}

function assertContentLengthWithinLimit(
  request: IncomingMessage,
  maxBodySize: number,
): void {
  const contentLength = request.headers['content-length'];

  if (
    contentLength !== undefined
    && Number.isFinite(Number(contentLength))
    && Number(contentLength) > maxBodySize
  ) {
    throw new RequestBodyTooLargeError();
  }
}

function discardOversizedRequestBody(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader('connection', 'close');
  request.resume();
}

function setResponseSecurityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(payload);
}
