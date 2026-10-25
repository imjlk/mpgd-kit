import {
  AppStoreDependencyUnavailableError,
  appStoreServerNotificationHttpStatus,
  handleAppStoreServerNotification,
  maxAppStoreServerNotificationBytes,
  type AppStoreEnvironment,
  type AppStoreServerNotificationVerificationResult,
  type AppStoreServerNotificationVerifier,
  type GameServicesStore,
} from '@mpgd/game-services';

/**
 * App Store Server Notifications V2 intake. Set these URLs in App Store
 * Connect (App Information, App Store Server Notifications, Version 2): the
 * production URL and the sandbox URL. The sandbox one revokes App Review,
 * TestFlight, and sandbox-tester grants a production deployment recorded
 * with `sandboxPurchases: { mode: 'grant' }`.
 */
export const appStoreNotificationPaths = Object.freeze({
  Production: '/app-store/notifications/v2',
  Sandbox: '/app-store/notifications/v2/sandbox',
} as const) satisfies Readonly<Record<AppStoreEnvironment, string>>;

/**
 * A private Worker that verifies the `signedPayload` with Apple's library
 * (`createAppleServerNotificationVerifier` from
 * `@mpgd/game-services/app-store-server`, one per environment, over the same
 * Apple root certificates as the purchase verifier). Errors do not keep their
 * class across a service binding, so a transient certificate check outage is
 * answered as `{ status: 'unavailable' }`.
 */
export interface AppStoreNotificationVerifierBinding {
  verifyAppStoreServerNotification(input: {
    readonly signedPayload: string;
    readonly environment: AppStoreEnvironment;
    readonly bundleId: string;
    readonly timeoutMs: number;
  }): Promise<
    AppStoreServerNotificationVerificationResult | { readonly status: 'unavailable' }
  >;
}

export function createAppStoreNotificationsFetchHandler(input: {
  readonly store: GameServicesStore;
  readonly binding: AppStoreNotificationVerifierBinding;
  readonly bundleId: string;
  readonly timeoutMs?: number;
}): (request: Request) => Promise<Response | undefined> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const verifier: AppStoreServerNotificationVerifier = {
    async verifyAndDecodeNotification({ signedPayload, environment, bundleId }) {
      // AbortSignal is not structured-cloneable across a service binding;
      // the binding enforces timeoutMs itself, and a binding that does not
      // answer in time is treated as unavailable so Apple redelivers.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        input.binding.verifyAppStoreServerNotification({
          signedPayload,
          environment,
          bundleId,
          timeoutMs,
        }),
        new Promise<{ readonly status: 'unavailable' }>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'unavailable' }), timeoutMs + bindingGraceMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.status === 'unavailable') {
        throw new AppStoreDependencyUnavailableError(
          'The App Store notification verifier is unavailable.',
        );
      }
      return result;
    },
  };

  return async (request) => {
    const environment = matchEnvironment(new URL(request.url).pathname);
    if (environment === undefined) {
      return undefined;
    }
    if (request.method !== 'POST') {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'POST' });
    }
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (declaredLength > maxBodyLength) {
      return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    }
    const text = await readBoundedText(request, maxBodyLength);
    if (text === undefined) {
      return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ status: 'rejected', reason: 'APP_STORE_NOTIFICATION_PAYLOAD_INVALID' }, 400);
    }
    if (!looksLikeCompactJws(body)) {
      // Refused before the verifier binding (and its certificate checks) runs.
      return json({ status: 'rejected', reason: 'APP_STORE_NOTIFICATION_PAYLOAD_INVALID' }, 400);
    }
    try {
      const outcome = await handleAppStoreServerNotification({
        store: input.store,
        verifier,
        body,
        environment,
        bundleId: input.bundleId,
        // Past the binding race below, so a slow binding answers 503, not 500.
        signal: AbortSignal.timeout(timeoutMs + 2 * bindingGraceMs),
      });
      if (outcome.status === 'refund_reversed') {
        // The player paid again but the grant stays revoked: support re-grants
        // (docs/GAME_SERVICES_BACKEND.md, "Re-granting after a refund reversal").
        console.warn(
          'App Store refund reversed: player',
          outcome.playerId,
          'grant',
          outcome.ledgerEntryId,
          'revocation',
          outcome.revocationLedgerEntryId,
          'notification',
          outcome.notificationUUID,
          outcome.recorded ? '(ledger note kept)' : '(no ledger note: this log is the record)',
        );
        // Apple ignores the body: the player and grant stay in the log only.
        return json(
          {
            status: outcome.status,
            notificationUUID: outcome.notificationUUID,
            recorded: outcome.recorded,
            alreadyRecorded: outcome.alreadyRecorded,
          },
          appStoreServerNotificationHttpStatus(outcome),
        );
      }
      // The status, reason, and notification id trace a delivery; the
      // refund-reversal warning above is the one log that names the player,
      // for support. No purchase token or JWS is logged.
      console.log(
        'App Store notification',
        environment,
        outcome.status,
        'notificationUUID' in outcome ? (outcome.notificationUUID ?? '-') : '-',
        outcome.status === 'revoked'
          ? `alreadyProcessed=${String(outcome.alreadyProcessed)}`
          : outcome.reason,
      );
      return json(outcome, appStoreServerNotificationHttpStatus(outcome));
    } catch (error) {
      // A store or binding failure: answer 500 so Apple redelivers (1, 12,
      // 24, 48, and 72 hours later in production; sandbox does not retry).
      console.error(
        'App Store notification failed:',
        error instanceof Error ? error.name : 'unknown error',
      );
      return json({ error: 'INTERNAL_ERROR' }, 500);
    }
  };
}

/** The JSON envelope around the signedPayload, on top of its own limit. */
const maxBodyLength = maxAppStoreServerNotificationBytes + 1024;
/** Time past the binding's own timeout before the route stops waiting for it. */
const bindingGraceMs = 5_000;

/** The body as text, or undefined once it passes `limit` bytes (chunked bodies included). */
async function readBoundedText(request: Request, limit: number): Promise<string | undefined> {
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** `{ signedPayload }` holding three base64url segments, the shape of Apple's JWS. */
function looksLikeCompactJws(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false;
  }
  const signedPayload = (body as Readonly<Record<string, unknown>>).signedPayload;
  return typeof signedPayload === 'string'
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(signedPayload);
}

function matchEnvironment(pathname: string): AppStoreEnvironment | undefined {
  const normalised = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
  if (normalised === appStoreNotificationPaths.Production) {
    return 'Production';
  }
  if (normalised === appStoreNotificationPaths.Sandbox) {
    return 'Sandbox';
  }
  return undefined;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
