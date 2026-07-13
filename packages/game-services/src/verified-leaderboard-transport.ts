import {
  assertGetVerifiedLeaderboardSnapshotRequest,
  assertVerifiedLeaderboardSnapshot,
  VerifiedLeaderboardCursorError,
  type GetVerifiedLeaderboardSnapshotRequest,
  type VerifiedLeaderboardReader,
  type VerifiedLeaderboardSnapshot,
} from './verified-leaderboard.js';

export const verifiedLeaderboardSnapshotPath =
  '/game-services/verified-leaderboard/snapshot';

export type GetPublicVerifiedLeaderboardSnapshotRequest = Pick<
  GetVerifiedLeaderboardSnapshotRequest,
  'leaderboardId' | 'limit' | 'cursor'
>;

export interface VerifiedLeaderboardSnapshotPrincipal {
  readonly participantId: string;
}

export type AuthenticateVerifiedLeaderboardSnapshotRequest = (
  request: Request,
) => Promise<VerifiedLeaderboardSnapshotPrincipal | undefined>
  | VerifiedLeaderboardSnapshotPrincipal
  | undefined;

export interface CreateVerifiedLeaderboardSnapshotFetchHandlerInput {
  readonly reader: VerifiedLeaderboardReader;
  readonly authenticate: AuthenticateVerifiedLeaderboardSnapshotRequest;
  readonly path?: string;
  readonly corsHeaders?: Readonly<Record<string, string>>;
}

export interface VerifiedLeaderboardSnapshotFetchClient {
  getSnapshot(
    input: GetPublicVerifiedLeaderboardSnapshotRequest,
  ): Promise<VerifiedLeaderboardSnapshot | undefined>;
}

export interface CreateVerifiedLeaderboardSnapshotFetchClientInput {
  readonly baseUrl: string;
  readonly authorization: () => Promise<string> | string;
  readonly fetch?: typeof fetch;
  readonly path?: string;
}

export function createVerifiedLeaderboardSnapshotFetchHandler(
  input: CreateVerifiedLeaderboardSnapshotFetchHandlerInput,
): (request: Request) => Promise<Response | undefined> {
  const path = input.path ?? verifiedLeaderboardSnapshotPath;

  return async (request) => {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname !== path) {
      return undefined;
    }

    if (request.method === 'OPTIONS') {
      return emptyResponse(204, input.corsHeaders);
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405, input.corsHeaders, {
        Allow: 'GET, OPTIONS',
      });
    }

    let principal: VerifiedLeaderboardSnapshotPrincipal | undefined;

    try {
      principal = await input.authenticate(request);

      if (principal !== undefined) {
        assertPrincipal(principal);
      }
    } catch {
      return jsonResponse({ error: 'AUTHENTICATION_FAILED' }, 500, input.corsHeaders);
    }

    if (principal === undefined) {
      return jsonResponse({ error: 'UNAUTHORIZED' }, 401, input.corsHeaders);
    }

    let snapshotRequest: GetPublicVerifiedLeaderboardSnapshotRequest;

    try {
      snapshotRequest = readSnapshotRequest(requestUrl);
      assertGetVerifiedLeaderboardSnapshotRequest(snapshotRequest);
    } catch (error) {
      if (error instanceof VerifiedLeaderboardCursorError) {
        return jsonResponse({ error: 'INVALID_CURSOR' }, 400, input.corsHeaders);
      }

      return jsonResponse(
        { error: error instanceof Error ? error.message : 'BAD_REQUEST' },
        400,
        input.corsHeaders,
      );
    }

    try {
      const snapshot = await input.reader.getSnapshot({
        ...snapshotRequest,
        participantId: principal.participantId,
      });

      if (snapshot === undefined) {
        return jsonResponse({ error: 'LEADERBOARD_NOT_FOUND' }, 404, input.corsHeaders);
      }

      assertVerifiedLeaderboardSnapshot(snapshot);
      return jsonResponse(snapshot, 200, input.corsHeaders);
    } catch (error) {
      return error instanceof VerifiedLeaderboardCursorError
        ? jsonResponse({ error: 'INVALID_CURSOR' }, 400, input.corsHeaders)
        : jsonResponse({ error: 'INTERNAL_ERROR' }, 500, input.corsHeaders);
    }
  };
}

export function createVerifiedLeaderboardSnapshotFetchClient(
  input: CreateVerifiedLeaderboardSnapshotFetchClientInput,
): VerifiedLeaderboardSnapshotFetchClient {
  const fetcher = input.fetch ?? globalThis.fetch;

  if (fetcher === undefined) {
    throw new Error('A fetch implementation is required for leaderboard snapshot reads.');
  }

  const endpoint = createEndpointUrl(input.baseUrl, input.path ?? verifiedLeaderboardSnapshotPath);

  return {
    async getSnapshot(requestInput) {
      assertGetVerifiedLeaderboardSnapshotRequest(requestInput);
      const authorization = await input.authorization();

      if (typeof authorization !== 'string' || authorization.length === 0) {
        throw new Error('authorization must be a non-empty string.');
      }

      const url = new URL(endpoint);
      url.searchParams.set('leaderboardId', requestInput.leaderboardId);

      if (requestInput.limit !== undefined) {
        url.searchParams.set('limit', String(requestInput.limit));
      }

      if (requestInput.cursor !== undefined) {
        url.searchParams.set('cursor', requestInput.cursor);
      }

      const response = await fetcher(url, {
        method: 'GET',
        headers: {
          Authorization: authorization,
        },
      });

      let body: unknown;

      try {
        body = await response.json();
      } catch {
        throw new Error(
          `Verified leaderboard snapshot response was not JSON (status ${response.status}).`,
        );
      }

      if (response.status === 404 && readErrorCode(body) === 'LEADERBOARD_NOT_FOUND') {
        return undefined;
      }

      if (!response.ok) {
        const error = readErrorCode(body);
        throw new Error(`Verified leaderboard snapshot request failed: ${error}.`);
      }

      assertVerifiedLeaderboardSnapshot(body);
      return body;
    },
  };
}

function readSnapshotRequest(url: URL): GetPublicVerifiedLeaderboardSnapshotRequest {
  const allowedParameters = new Set(['leaderboardId', 'limit', 'cursor']);

  for (const parameter of url.searchParams.keys()) {
    if (!allowedParameters.has(parameter)) {
      throw new Error(`Unsupported snapshot query parameter: ${parameter}.`);
    }
  }

  for (const parameter of allowedParameters) {
    if (url.searchParams.getAll(parameter).length > 1) {
      throw new Error(`Snapshot query parameter must not be repeated: ${parameter}.`);
    }
  }

  const leaderboardId = url.searchParams.get('leaderboardId') ?? '';
  const limitValue = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limit = limitValue === null ? undefined : Number(limitValue);

  return {
    leaderboardId,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function assertPrincipal(
  input: unknown,
): asserts input is VerifiedLeaderboardSnapshotPrincipal {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Verified leaderboard principal must be an object.');
  }

  const participantId = (input as { readonly participantId?: unknown }).participantId;

  if (typeof participantId !== 'string' || participantId.length === 0) {
    throw new Error('Verified leaderboard principal participantId must be non-empty.');
  }
}

function readErrorCode(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return 'UNKNOWN_ERROR';
  }

  const error = (input as { readonly error?: unknown }).error;
  return typeof error === 'string' && error.length > 0 ? error : 'UNKNOWN_ERROR';
}

function createEndpointUrl(baseUrl: string, path: string): URL {
  const normalizedBaseUrl = new URL(baseUrl);
  normalizedBaseUrl.search = '';
  normalizedBaseUrl.hash = '';

  if (!normalizedBaseUrl.pathname.endsWith('/')) {
    normalizedBaseUrl.pathname = `${normalizedBaseUrl.pathname}/`;
  }

  return new URL(path.replace(/^\/+/u, ''), normalizedBaseUrl);
}

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders?: Readonly<Record<string, string>>,
  additionalHeaders?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...additionalHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}

function emptyResponse(
  status: number,
  corsHeaders?: Readonly<Record<string, string>>,
): Response {
  return new Response(null, {
    status,
    ...(corsHeaders === undefined ? {} : { headers: corsHeaders }),
  });
}
