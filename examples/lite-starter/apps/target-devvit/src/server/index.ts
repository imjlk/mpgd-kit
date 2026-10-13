import type { IncomingMessage, ServerResponse } from 'node:http';

import { context, createServer, getServerPort, payments, reddit, redis } from '@devvit/web/server';
import type { UiResponse } from '@devvit/web/shared';
import {
  createDevvitCommerceBridgeProducts,
  createDevvitCommerceV2BridgeHandler,
} from '@mpgd/adapter-devvit/server';
import { createBridgeRpcRouter, defaultBridgeRpcEndpoint } from '@mpgd/bridge/orpc';
import { createBridgeRpcNodeHandler } from '@mpgd/bridge/orpc/node';
import type { ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';

import devvitManifest from '../../devvit.json';
import { createDevvitBridgeHandler } from './bridge.js';

const maxRequestBodySize = 1_048_576;
const gameName = 'lite-starter';
const gameTitle = "Lite Starter";
/**
 * Commerce v2 opt-in: the catalog's Reddit SKUs (`platformProductIds.reddit`),
 * the `payments` plugin (`permissions.payments` in devvit.json), and a
 * fulfillment endpoint (`payments.endpoints.fulfillOrder`, the handler that
 * writes the backend ledger entry) must all be present. Otherwise the bridge
 * keeps every `commerce.v2.*` method failing closed with
 * `COMMERCE_V2_UNAVAILABLE`, so no checkout opens for an order nothing could
 * grant. The handler only lists orders and products; the grant stays with the
 * fulfillment handler's ledger entry.
 */
const commerceProducts = createDevvitCommerceBridgeProducts(productCatalogJson as ProductCatalog);
const fulfillOrderEndpoint = (devvitManifest as {
  readonly payments?: { readonly endpoints?: { readonly fulfillOrder?: unknown } };
}).payments?.endpoints?.fulfillOrder;
const commerceEnabled = devvitManifest.permissions.payments === true
  && typeof fulfillOrderEndpoint === 'string'
  && fulfillOrderEndpoint.trim().length > 0
  && commerceProducts.length > 0;
const commerce = commerceEnabled
  ? createDevvitCommerceV2BridgeHandler({ payments, products: commerceProducts })
  : undefined;
const handleBridgeRequest = createDevvitBridgeHandler({
  redis,
  currentPlayerId,
  currentDisplayName,
  storageKeyNamespace: gameName,
  ...(commerce === undefined ? {} : { commerce }),
});
const bridgeRpcHandler = createBridgeRpcNodeHandler(createBridgeRpcRouter(handleBridgeRequest), {
  maxBodySize: maxRequestBodySize,
  prefix: defaultBridgeRpcEndpoint,
});

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
  console.log(
    commerceEnabled
      ? `devvit commerce v2 serving ${commerceProducts.length} catalog product(s) over the payments plugin`
      : 'devvit commerce v2 disabled: needs permissions.payments, payments.endpoints.fulfillOrder, and reddit SKUs in the catalog',
  );
});

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
