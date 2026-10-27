/**
 * oRPC error-body compatibility across the 2.0.0-beta.34 `inferable` removal.
 *
 * oRPC 2.0.0-beta.14 writes RPC error bodies as
 * `{ json: { defined, inferable, code, message, data? } }` and its client rejects a body
 * without a boolean `inferable`. Since 2.0.0-beta.34 (middleapi/orpc#1987) the server
 * omits `inferable` and the client rejects a body that has it. Either way a client on
 * the other version reports a malformed response instead of the error code, so a game
 * built against one kit release and a Worker built against another would lose
 * `BAD_REQUEST` and `NOT_FOUND` (and with it the commerce reconciler's "v1 backend"
 * detection) whenever they are deployed separately.
 *
 * The game-services oRPC transport therefore bridges both directions:
 * - the server adds `inferable: false` to error bodies, so older clients still decode them;
 * - the client removes a boolean `inferable` before oRPC validates, so it still decodes
 *   older servers' errors. Nothing else in the body changes, so a body that is malformed
 *   for any other reason is still rejected by oRPC.
 *
 * Success responses are passed through untouched in both directions.
 *
 * Remove this module when the oldest supported game-services client and every supported
 * Worker come from `@mpgd/game-services` 0.31.0 or later (oRPC 2.0.0-beta.46), that is, once
 * no client or Worker from 0.30.5 or older (oRPC 2.0.0-beta.14) is supported.
 */

const legacyErrorFlag = 'inferable';

/**
 * Server side: adds `inferable: false` to an oRPC error body that lacks it.
 * Responses that are not oRPC JSON error bodies are returned unchanged.
 */
export async function addLegacyOrpcErrorFlag(response: Response): Promise<Response> {
  if (!isJsonErrorResponse(response)) {
    return response;
  }

  const text = await response.text();
  const envelope = parseErrorEnvelope(text);

  if (envelope === undefined || Object.hasOwn(envelope.json, legacyErrorFlag)) {
    return rebuild(response, text);
  }

  return rebuild(
    response,
    JSON.stringify({ ...envelope.root, json: { ...envelope.json, [legacyErrorFlag]: false } }),
  );
}

/**
 * Client side: removes a boolean `inferable` from an oRPC error body so a current oRPC
 * client accepts errors from a pre-beta.34 server. Only that key is removed; oRPC still
 * validates the rest of the body as usual.
 */
export async function stripLegacyOrpcErrorFlag(response: Response): Promise<Response> {
  if (!isJsonErrorResponse(response)) {
    return response;
  }

  const text = await response.text();
  const envelope = parseErrorEnvelope(text);

  if (envelope === undefined || typeof envelope.json[legacyErrorFlag] !== 'boolean') {
    return rebuild(response, text);
  }

  const { [legacyErrorFlag]: _legacy, ...json } = envelope.json;

  return rebuild(response, JSON.stringify({ ...envelope.root, json }));
}

/**
 * Wraps an oRPC link `fetch` so every response passes through
 * {@link stripLegacyOrpcErrorFlag}. Any oRPC 2.0.0-beta.34+ client that talks to a
 * game-services Worker must use it while the Worker writes the legacy flag. Extra arguments
 * oRPC passes (client options, procedure path) are forwarded unchanged.
 */
export function withLegacyOrpcErrorCompat<Rest extends unknown[]>(
  fetcher: (url: string, init: RequestInit, ...rest: Rest) => Promise<Response>,
): (url: string, init: RequestInit, ...rest: Rest) => Promise<Response> {
  return async (url, init, ...rest) => stripLegacyOrpcErrorFlag(await fetcher(url, init, ...rest));
}

function isJsonErrorResponse(response: Response): boolean {
  return (
    response.status >= 400
    && response.body !== null
    && (response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
  );
}

interface ErrorEnvelope {
  readonly root: Record<string, unknown>;
  readonly json: Record<string, unknown>;
}

function parseErrorEnvelope(text: string): ErrorEnvelope | undefined {
  let root: unknown;

  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isPlainObject(root) || !isPlainObject(root.json)) {
    return undefined;
  }

  return { root, json: root.json };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  return prototype === Object.prototype || prototype === null;
}

function rebuild(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  // The body is re-encoded as plain text: any transfer encoding or length no longer applies.
  headers.delete('content-encoding');
  headers.delete('content-length');

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
