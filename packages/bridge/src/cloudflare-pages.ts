import {
  assertBridgeRequest,
  bridgeStorageLoadProtocol,
  createBridgeError,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from './index.js';
import {
  createBridgeRpcFetchHandler,
  createBridgeRpcRouter,
  defaultBridgeRpcEndpoint,
  type BridgeRpcPrefix,
} from './orpc.js';

export const defaultCloudflarePagesBridgeEndpoint = '/api/mpgd/bridge' as const;
export const defaultCloudflarePagesGameServicesPrefix = '/api/game-services' as const;
export const defaultCloudflarePagesGameServicesForwardHeaders = [
  'accept',
  'authorization',
  'content-type',
] as const;
export const defaultCloudflarePagesCorsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
} as const;

type CorsHeaders = Record<string, string>;

export interface CloudflarePagesAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflarePagesServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface MpgdCloudflarePagesHostEnv {
  readonly ASSETS: CloudflarePagesAssetsBinding;
  readonly GAME_SERVICES?: CloudflarePagesServiceBinding;
}

export interface MpgdCloudflarePagesHostContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type MpgdCloudflarePagesBridgeHandler<
  TEnv extends MpgdCloudflarePagesHostEnv = MpgdCloudflarePagesHostEnv,
> = (
  input: MpgdCloudflarePagesBridgeHandlerInput<TEnv>,
) => BridgeResponse | Promise<BridgeResponse>;

export interface MpgdCloudflarePagesBridgeHandlerInput<
  TEnv extends MpgdCloudflarePagesHostEnv = MpgdCloudflarePagesHostEnv,
> {
  readonly request: Request;
  readonly env: TEnv;
  readonly ctx: MpgdCloudflarePagesHostContext | undefined;
  readonly bridgeRequest: BridgeRequest;
}

export interface CreateMpgdCloudflarePagesHostFetchHandlerOptions<
  TEnv extends MpgdCloudflarePagesHostEnv = MpgdCloudflarePagesHostEnv,
> {
  readonly bridgeEndpoint?: string;
  readonly bridgeRpcEndpoint?: BridgeRpcPrefix;
  readonly bridgeHandler?: MpgdCloudflarePagesBridgeHandler<TEnv>;
  readonly gameServicesPrefix?: string;
  readonly gameServicesForwardHeaders?: readonly string[] | 'all';
  readonly corsHeaders?: CorsHeaders | false;
}

export function createMpgdCloudflarePagesHostFetchHandler<
  TEnv extends MpgdCloudflarePagesHostEnv = MpgdCloudflarePagesHostEnv,
>(
  options: CreateMpgdCloudflarePagesHostFetchHandlerOptions<TEnv> = {},
): (request: Request, env: TEnv, ctx?: MpgdCloudflarePagesHostContext) => Promise<Response> {
  const bridgeEndpoint = options.bridgeEndpoint ?? defaultCloudflarePagesBridgeEndpoint;
  const bridgeRpcEndpoint = options.bridgeRpcEndpoint ?? defaultBridgeRpcEndpoint;
  const gameServicesPrefix = options.gameServicesPrefix ?? defaultCloudflarePagesGameServicesPrefix;
  const gameServicesForwardHeaders =
    options.gameServicesForwardHeaders ?? defaultCloudflarePagesGameServicesForwardHeaders;
  const bridgeHandler = options.bridgeHandler ?? createMpgdCloudflarePagesBridgeHandler<TEnv>();
  const corsHeaders =
    options.corsHeaders === false
      ? undefined
      : (options.corsHeaders ?? defaultCloudflarePagesCorsHeaders);

  return async (request, env, ctx) => {
    const url = new URL(request.url);

    try {
      if (
        request.method === 'OPTIONS' &&
        corsHeaders !== undefined &&
        (url.pathname === bridgeEndpoint ||
          isPathUnderPrefix(url.pathname, bridgeRpcEndpoint) ||
          isPathUnderPrefix(url.pathname, gameServicesPrefix))
      ) {
        return emptyResponse(204, corsHeaders);
      }

      if (url.pathname === bridgeEndpoint) {
        return handleBridgeJsonRequest(request, env, ctx, bridgeHandler, corsHeaders);
      }

      if (isPathUnderPrefix(url.pathname, bridgeRpcEndpoint)) {
        const rpcFetch = createBridgeRpcFetchHandler(
          createBridgeRpcRouter((bridgeRequest) => {
            return bridgeHandler({
              request,
              env,
              ctx,
              bridgeRequest,
            });
          }),
          {
            prefix: bridgeRpcEndpoint,
          },
        );

        return withCors(await rpcFetch(request), corsHeaders);
      }

      if (isPathUnderPrefix(url.pathname, gameServicesPrefix)) {
        return proxyGameServicesRequest(
          request,
          env,
          gameServicesPrefix,
          corsHeaders,
          gameServicesForwardHeaders,
        );
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'mpgd Cloudflare Pages host request failed',
          path: url.pathname,
          error: errorMessage(error),
        }),
      );

      return jsonResponse({ error: 'MPGD_PAGES_HOST_INTERNAL_ERROR' }, 500, corsHeaders);
    }
  };
}

export function createMpgdCloudflarePagesBridgeHandler<
  TEnv extends MpgdCloudflarePagesHostEnv = MpgdCloudflarePagesHostEnv,
>(): MpgdCloudflarePagesBridgeHandler<TEnv> {
  return async (input) => {
    switch (input.bridgeRequest.method) {
      case 'runtime.getCapabilities':
        return ok(input.bridgeRequest, {
          nativeIap: false,
          nativeAds: false,
          rewardedAds: false,
          interstitialAds: false,
          nativeLeaderboard: false,
          achievements: false,
          cloudSave: false,
          socialShare: false,
          haptics: false,
          localizedContent: true,
        });

      case 'identity.getPlayer': {
        return ok(input.bridgeRequest, null);
      }

      case 'identity.getSession':
        return ok(input.bridgeRequest, {
          identityLevel: 'guest',
          trustLevel: 'local',
        });

      case 'identity.requestUpgrade':
        return ok(input.bridgeRequest, {
          status: 'unavailable',
          reloadExpected: false,
        });

      case 'presentation.getLaunchIntent':
        return ok(input.bridgeRequest, {
          entry: 'home',
        });

      case 'presentation.requestGameSurface':
        return ok(input.bridgeRequest, 'already-fullscreen');

      case 'share.share':
        return ok(input.bridgeRequest, {
          status: 'unavailable',
        });

      case 'share.readInboundShare':
        return ok(input.bridgeRequest, null);

      case 'notifications.getStatus':
        return ok(input.bridgeRequest, 'unsupported');

      case 'notifications.requestSubscription':
        return ok(input.bridgeRequest, 'unavailable');

      case 'commerce.getProducts':
      case 'commerce.getEntitlements':
        return ok(input.bridgeRequest, []);

      case 'commerce.purchase':
        return ok(input.bridgeRequest, {
          status: 'cancelled',
          entitlementIds: [],
        });

      case 'commerce.restore':
        return ok(input.bridgeRequest, {
          restoredEntitlements: [],
        });

      case 'ads.preload':
        return ok(input.bridgeRequest, {});

      case 'ads.showRewarded':
        return ok(input.bridgeRequest, {
          status: 'unavailable',
          rewardGranted: false,
        });

      case 'ads.showInterstitial':
        return ok(input.bridgeRequest, {
          status: 'unavailable',
        });

      case 'leaderboard.submitScore':
        return ok(input.bridgeRequest, {
          submitted: false,
        });

      case 'leaderboard.open':
        return createBridgeError(
          input.bridgeRequest.id,
          'CLOUDFLARE_PAGES_LEADERBOARD_OPEN_UNAVAILABLE',
          'Cloudflare Pages host does not provide a native leaderboard UI.',
        );

      case 'storage.load':
        return ok(input.bridgeRequest, {
          __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
          found: false,
        } satisfies BridgeStorageLoadData);

      case 'storage.save':
        return ok(input.bridgeRequest, {
          saved: false,
        });

      default:
        return createBridgeError(
          input.bridgeRequest.id,
          'UNSUPPORTED_METHOD',
          `Unsupported Cloudflare Pages bridge method: ${input.bridgeRequest.method}`,
        );
    }
  };
}

async function handleBridgeJsonRequest<TEnv extends MpgdCloudflarePagesHostEnv>(
  request: Request,
  env: TEnv,
  ctx: MpgdCloudflarePagesHostContext | undefined,
  bridgeHandler: MpgdCloudflarePagesBridgeHandler<TEnv>,
  corsHeaders: CorsHeaders | undefined,
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return emptyResponse(204, corsHeaders);
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405, corsHeaders);
  }

  let bridgeRequest: BridgeRequest;

  try {
    bridgeRequest = assertBridgeRequest(await request.json());
  } catch (error) {
    return jsonResponse(
      createBridgeError(
        'unknown',
        'INVALID_BRIDGE_REQUEST',
        `Bridge request failed runtime validation: ${errorMessage(error)}`,
      ),
      400,
      corsHeaders,
    );
  }

  try {
    return jsonResponse(
      await bridgeHandler({
        request,
        env,
        ctx,
        bridgeRequest,
      }),
      200,
      corsHeaders,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Cloudflare Pages bridge handler failed',
        bridgeRequestId: bridgeRequest.id,
        error: errorMessage(error),
      }),
    );

    return jsonResponse(
      createBridgeError(
        bridgeRequest.id,
        'BRIDGE_HANDLER_ERROR',
        'An internal error occurred while processing the bridge request.',
        true,
      ),
      500,
      corsHeaders,
    );
  }
}

async function proxyGameServicesRequest<TEnv extends MpgdCloudflarePagesHostEnv>(
  request: Request,
  env: TEnv,
  prefix: string,
  corsHeaders: CorsHeaders | undefined,
  forwardHeaders: readonly string[] | 'all',
): Promise<Response> {
  if (env.GAME_SERVICES === undefined) {
    return jsonResponse({ error: 'GAME_SERVICES_BINDING_UNAVAILABLE' }, 503, corsHeaders);
  }

  const url = new URL(request.url);
  const pathname = url.pathname.slice(prefix.length);

  if (hasParentPathSegment(pathname)) {
    return jsonResponse({ error: 'INVALID_GAME_SERVICES_PATH' }, 400, corsHeaders);
  }

  url.pathname = pathname.length === 0 ? '/' : pathname;

  return withCors(
    await env.GAME_SERVICES.fetch(await createForwardedRequest(request, url, forwardHeaders)),
    corsHeaders,
  );
}

function isPathUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function ok(input: BridgeRequest, data: unknown): BridgeResponse {
  return {
    id: input.id,
    ok: true,
    data,
  };
}

function hasParentPathSegment(pathname: string): boolean {
  return pathname.split('/').some((segment) => {
    return decodePathSegment(segment).split('/').includes('..');
  });
}

function decodePathSegment(segment: string): string {
  let decoded = segment;

  for (let index = 0; index < 64; index += 1) {
    try {
      const next = decodeURIComponent(decoded);

      if (next === decoded) {
        return decoded;
      }

      decoded = next;
    } catch {
      return '..';
    }
  }

  return '..';
}

async function createForwardedRequest(
  request: Request,
  url: URL,
  forwardHeaders: readonly string[] | 'all',
): Promise<Request> {
  const headers =
    forwardHeaders === 'all'
      ? request.headers
      : createForwardedHeaders(request.headers, forwardHeaders);
  const init: RequestInit = {
    method: request.method,
    headers,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  return new Request(url.toString(), init);
}

function createForwardedHeaders(
  headers: Headers,
  forwardHeaders: readonly string[],
): Headers {
  const forwarded = new Headers();

  for (const name of forwardHeaders) {
    const value = headers.get(name);

    if (value !== null) {
      forwarded.set(name, value);
    }
  }

  return forwarded;
}

function emptyResponse(status: number, corsHeaders: CorsHeaders | undefined): Response {
  return new Response(null, {
    status,
    ...(corsHeaders === undefined ? {} : { headers: corsHeaders }),
  });
}

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: CorsHeaders | undefined,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(corsHeaders ?? {}),
    },
  });
}

function withCors(response: Response, corsHeaders: CorsHeaders | undefined): Response {
  if (corsHeaders === undefined) {
    return response;
  }

  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
