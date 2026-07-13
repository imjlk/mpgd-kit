import type { IncomingMessage, ServerResponse } from 'node:http';

import { BodyLimitHandlerPlugin, RPCHandler } from '@orpc/server/node';

import { defaultBridgeRpcEndpoint, type BridgeRpcPrefix, type BridgeRpcRouter } from './orpc';

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
    const result = await handler.handle(request, response, {
      prefix,
      context: {
        request,
      },
    });

    return result.matched;
  };
}
