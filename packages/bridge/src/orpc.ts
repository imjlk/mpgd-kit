import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { StandardUrl } from '@orpc/client/standard';
import { oc, type as orpcType, type RouterContractClient } from '@orpc/contract';
import { implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';

import type { BridgeRequest, BridgeResponse } from './index';

export type BridgeRpcEndpoint = StandardUrl;
export type BridgeRpcPrefix = `/${string}`;

export const defaultBridgeRpcEndpoint = '/api/mpgd/rpc' satisfies BridgeRpcPrefix;

export const bridgeRpcContract = oc.router({
  request: oc.input(orpcType<BridgeRequest>()).output(orpcType<BridgeResponse>()),
});

export type BridgeRpcContract = typeof bridgeRpcContract;
export type BridgeRpcClient = RouterContractClient<BridgeRpcContract>;
export type BridgeRpcRequestHandler = (
  request: BridgeRequest,
) => BridgeResponse | Promise<BridgeResponse>;
export type BridgeRpcRouter = ReturnType<typeof createBridgeRpcRouter>;

export interface CreateBridgeOrpcClientInput {
  readonly url?: BridgeRpcEndpoint;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export interface CreateBridgeRpcFetchHandlerOptions {
  readonly prefix?: BridgeRpcPrefix;
}

export function createBridgeOrpcClient(
  input: CreateBridgeOrpcClientInput = {},
): BridgeRpcClient {
  const headers = input.headers;
  const link = new RPCLink({
    url: input.url ?? defaultBridgeRpcEndpoint,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(headers === undefined
      ? {}
      : {
          headers: () => headers,
        }),
  });

  return createORPCClient(link) as BridgeRpcClient;
}

export function createBridgeRpcRouter(handleRequest: BridgeRpcRequestHandler) {
  const contract = implement(bridgeRpcContract);

  return contract.router({
    request: contract.request.handler(({ input }) => handleRequest(input)),
  });
}

export function createBridgeRpcFetchHandler(
  router: BridgeRpcRouter,
  options: CreateBridgeRpcFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const rpcHandler = new RPCHandler(router);
  const prefix = options.prefix ?? defaultBridgeRpcEndpoint;

  return async (request) => {
    try {
      const result = await rpcHandler.handle(
        request,
        {
          prefix,
          context: {
            request,
          },
      },
      );

      if (!result.matched) {
        return new Response('Not Found', {
          status: 404,
          headers: {
            'content-type': 'text/plain',
          },
        });
      }

      return result.response;
    } catch (error) {
      console.error('Bridge RPC internal error:', error);

      return new Response(
        JSON.stringify({
          error: 'BRIDGE_RPC_INTERNAL_ERROR',
        }),
        {
          status: 500,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }
  };
}
