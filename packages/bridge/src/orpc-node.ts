import type { IncomingMessage, ServerResponse } from 'node:http';

import { BodyLimitHandlerPlugin, RPCHandler } from '@orpc/server/node';

import { defaultBridgeRpcEndpoint, type BridgeRpcPrefix, type BridgeRpcRouter } from './orpc.js';

export interface CreateBridgeRpcNodeHandlerOptions {
  readonly maxBodySize?: number;
  readonly prefix?: BridgeRpcPrefix;
}

export type BridgeRpcNodeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

/**
 * Creates a bridge transport that writes oRPC responses directly to Node HTTP.
 * The boolean result is false when another route should handle the request.
 */
export function createBridgeRpcNodeHandler(
  router: BridgeRpcRouter,
  options: CreateBridgeRpcNodeHandlerOptions = {},
): BridgeRpcNodeHandler {
  const handler = new RPCHandler(router, {
    plugins: [
      new BodyLimitHandlerPlugin({
        maxBodySize: options.maxBodySize ?? 1_000_000,
      }),
    ],
  });
  const prefix = options.prefix ?? defaultBridgeRpcEndpoint;

  return async (request, response) => {
    try {
      const result = await handler.handle(request, response, {
        prefix,
        context: {
          request,
        },
      });

      return result.matched;
    } catch (error) {
      console.error('Bridge RPC internal error:', error);
      finishInternalErrorResponse(response);
      return true;
    }
  };
}

function finishInternalErrorResponse(response: ServerResponse): void {
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.destroy();
    }

    return;
  }

  if (response.destroyed) {
    return;
  }

  const payload = JSON.stringify({
    error: 'BRIDGE_RPC_INTERNAL_ERROR',
  });

  response.statusCode = 500;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(payload);
}
