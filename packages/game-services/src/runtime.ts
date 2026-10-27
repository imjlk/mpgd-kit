import {
  AccountDeletionError,
  createAccountDeletionClient,
  type AccountDeletionClient,
} from './account-deletion.js';
import type { AnalyticsSink } from '@mpgd/analytics';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform';
import { CommerceError } from '@mpgd/platform/commerce';

import {
  assertCommerceStaleLaunchedAfterMs,
  createGameServicesClient,
  createGameServicesFetchBackendTransport,
  createGameServicesHttpBackendApi,
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
  resolveGameServicesRequestHeaders,
  type GameServicesBackendApi,
  type GameServicesBackendTransport,
  type GameServicesClient,
  type GameServicesHeaderResolver,
} from './client.js';
import {
  gameServicesPlayerChangedCode,
  GameServicesRuntimeClosedError,
  gameServicesRuntimeDisposedCode,
  gameServicesSessionRequiredCode,
  type GameServicesRuntimeClosedCode,
} from './request-headers.js';
import type { GameServicesLedgerTarget } from './types.js';
import type { ClientRewardEvidenceRegistry } from './client-reward-evidence.js';
import type {
  CommerceReconciler,
  CommerceReconcilerProduct,
  CreateCommerceReconcilerInput,
} from './commerce-reconciler.js';
import type { GameServicesPurchaseResult, GameServicesRewardedAdResult } from './operations.js';
import {
  createRecoverableMonetizationClient,
  type MonetizationOperationStore,
  type RecoverableMonetizationClient,
} from './monetization-recovery.js';

export type GameServicesAuthorityMode = 'production' | 'non-production';
export type GameServicesRuntimeMode = 'disabled' | 'local' | 'http' | 'orpc';
export type GameServicesDisabledReason =
  | 'unsupported_target'
  | 'missing_authoritative_backend'
  | 'invalid_authoritative_backend'
  | 'local_backend_not_allowed'
  | 'local_backend_unavailable';

export interface GameServicesRuntime {
  readonly mode: GameServicesRuntimeMode;
  readonly reason?: GameServicesDisabledReason;
  readonly baseUrl?: string;
  readonly target?: GameServicesLedgerTarget;
  readonly client?: GameServicesClient;
  readonly monetizationRecovery?: RecoverableMonetizationClient;
  /**
   * The signed-in player's account deletion (`POST /game-services/account/delete`)
   * with the runtime's headers; present with an authoritative `baseUrl`.
   */
  readonly accountDeletion?: AccountDeletionClient;
  /**
   * Closes the runtime for good, then waits until a purchase whose store
   * sheet is open has journaled its answer, a startup or resume recovery
   * pass (`monetizationRecovery.reconcile()`) has finished, and the commerce
   * reconciler has stopped (each wait bounded by `gameServicesDisposeWaitMs`); repeated
   * calls share that wait. Afterwards nothing it holds talks to the backend
   * or the store for its player: a purchase answers `failed` with the
   * retryable diagnostic `gameServicesRuntimeDisposedCode` before any store
   * UI, a rewarded-ad claim answers `unavailable` before any ad, recovery
   * runs nothing, Restore Purchases and leaderboard submissions reject with
   * `GameServicesRuntimeClosedError`, and every backend request (account
   * deletion included) is refused before its headers are resolved. The
   * journal keeps every record; a runtime created later for the same player
   * resumes them. A disabled runtime has nothing to close.
   */
  dispose(): Promise<void>;
}

/**
 * How long `dispose()` waits for a purchase whose store sheet is open to
 * journal its answer, and then for the reconciler to stop: 3 minutes, past
 * Google Play's own wait for a purchase result.
 */
export const gameServicesDisposeWaitMs = 3 * 60 * 1000;

export {
  gameServicesPlayerChangedCode,
  gameServicesRuntimeDisposedCode,
  GameServicesRuntimeClosedError,
  gameServicesSessionRequiredCode,
  type GameServicesRuntimeClosedCode,
} from './request-headers.js';

interface CreateGameServicesRuntimeCommonInput {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
  readonly authorityMode: GameServicesAuthorityMode;
  readonly target?: PlatformTarget | string;
  readonly deploymentTarget?: string;
  readonly baseUrl?: string;
  /** Static headers sent with every authoritative game-services request. */
  readonly headers?: Record<string, string>;
  /** Resolve rotating credentials at request time, not runtime creation time. */
  readonly getHeaders?: GameServicesHeaderResolver;
  readonly allowLocalBackend?: boolean;
  readonly localBackend?: GameServicesBackendApi;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
  readonly now?: () => string;
  /** Durable, compare-and-swap journal for purchase and rewarded-ad recovery. */
  readonly operationStore?: MonetizationOperationStore;
  readonly rewardEvidenceRegistry?: ClientRewardEvidenceRegistry;
  /**
   * Catalog kinds and store SKUs the commerce v2 reconciler resolves without a
   * store read (`CommerceReconcilerProduct`), for example derived from the
   * product catalog's `platformProductIds` for the gateway target.
   */
  readonly commerceProducts?: readonly CommerceReconcilerProduct[];
  /**
   * The player the session's credentials belong to right now, read
   * synchronously: pass it whenever `getHeaders` (or the store account
   * binding) follows a session that can change player within the run. It is
   * checked before every backend request and again once its headers are
   * resolved (no request leaves with another player's credentials), and by
   * the commerce reconciler before it journals, verifies, restores, or
   * finishes anything and right before a store UI opens. The store
   * provider resolves its account binding after that last check, so the
   * binding resolver must follow this player too (bind nothing for anyone
   * else) for a purchase never to be journaled here and bound to another
   * account; a binding refused while the session changed stays retryable.
   * Another
   * player closes the runtime for good, as `dispose()` does, with
   * `gameServicesPlayerChangedCode`; no player refuses with
   * `gameServicesSessionRequiredCode` and leaves the runtime open. Refusals
   * are retryable and end no record, so a purchase of this player is never
   * verified with another player's session (which a backend answers with a
   * permanent account-mismatch rejection) and is resumed by a runtime for
   * this player later. A custom `httpTransport` must send only the headers
   * the runtime resolved for each request.
   */
  readonly sessionPlayerId?: () => string | undefined;
  /**
   * This player's store account binding, derived from `playerId` the way
   * the store provider binds the player's new purchases (Google Play's
   * obfuscated account id, StoreKit's app account token). With it the
   * commerce reconciler leaves a store purchase bound to another account
   * alone instead of journaling and verifying it for this player (a backend
   * rejects that for good as an account mismatch): after a restart as
   * another player, Google Play still lists the previous player's
   * unacknowledged purchases. The player's Restore Purchases still takes a
   * durable bound to another account (restore sharing). Derive it from
   * `playerId`, not from the live session. Pass it only for a store whose
   * purchases carry this kind of binding: answering `undefined` leaves every
   * bound purchase alone, which is meant only while the binding is briefly
   * unreadable. Omitted, nothing is compared (for example Microsoft Store,
   * whose purchases carry their own claimed scope).
   */
  readonly commerceAccountBinding?: CreateCommerceReconcilerInput['accountBinding'];
  /**
   * The reconciler's `staleLaunchedAfterMs`: how long a `launched` purchase
   * with no store purchase keeps serializing its product before it ends
   * `failed`. Defaults to 24 hours; `Infinity` never expires it.
   */
  readonly commerceStaleLaunchedAfterMs?: number;
}

export type CreateGameServicesRuntimeInput = CreateGameServicesRuntimeCommonInput & (
  | {
      readonly transport?: 'http';
      /** A JSON endpoint transport, not a replacement for the Fetch API. */
      readonly httpTransport?: GameServicesBackendTransport;
    }
  | {
      readonly transport: 'orpc';
      readonly httpTransport?: never;
    }
);

export function createGameServicesRuntime(
  input: CreateGameServicesRuntimeInput,
): GameServicesRuntime {
  assertAuthorityMode(input.authorityMode);
  assertTransport(input.transport);
  assertCommerceStaleLaunchedAfterMs(input.commerceStaleLaunchedAfterMs);
  if (input.transport === 'orpc' && input.httpTransport !== undefined) {
    throw new Error('Game Services httpTransport cannot be used with oRPC.');
  }

  const target = resolveGameServicesLedgerTarget(input.target ?? input.gateway.target);
  const gate = createRuntimeGate(input.playerId, input.sessionPlayerId);

  if (target === null) {
    return disabledRuntime('unsupported_target');
  }

  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.httpTransport !== undefined && baseUrl === undefined) {
    throw new Error('Game Services httpTransport requires an authoritative baseUrl.');
  }
  let backend: GameServicesBackendApi;
  let mode: Exclude<GameServicesRuntimeMode, 'disabled'>;

  if (baseUrl !== undefined) {
    const url = parseAbsoluteUrl(baseUrl);

    if (input.authorityMode === 'production' && !isPublicHttpsUrl(url)) {
      return disabledRuntime('invalid_authoritative_backend', target);
    }

    if (url === undefined) {
      throw new Error('Game Services baseUrl must be a valid absolute URL.');
    }

    mode = input.transport === 'orpc' ? 'orpc' : 'http';
    backend = mode === 'orpc'
      ? createGameServicesOrpcBackendApi(createGameServicesOrpcClient({
          url: baseUrl,
          ...(input.headers === undefined ? {} : { headers: input.headers }),
          getHeaders: guardHeaders(input.getHeaders, gate),
        }))
      : createGameServicesHttpBackendApi({
          transport: withRuntimeHeaders(
            input.httpTransport ?? createGameServicesFetchBackendTransport({ baseUrl }),
            input,
            gate,
          ),
        });
  } else {
    if (input.authorityMode === 'production') {
      return disabledRuntime('missing_authoritative_backend', target);
    }

    if (input.allowLocalBackend !== true) {
      return disabledRuntime('local_backend_not_allowed', target);
    }

    if (input.localBackend === undefined) {
      return disabledRuntime('local_backend_unavailable', target);
    }

    mode = 'local';
    backend = input.localBackend;
  }
  // Every backend call is refused before it starts once the runtime is closed.
  backend = guardBackend(backend, gate);

  const clientInput = {
    // A rewarded ad queued before the runtime closed is not shown after it.
    gateway: guardRewardedAds(input.gateway, gate),
    backend,
    playerId: input.playerId,
    target,
    ...(input.deploymentTarget === undefined
      ? {}
      : { deploymentTarget: input.deploymentTarget }),
    ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
    ...(input.analyticsSessionId === undefined
      ? {}
      : { analyticsSessionId: input.analyticsSessionId }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.rewardEvidenceRegistry === undefined ? {} : { rewardEvidenceRegistry: input.rewardEvidenceRegistry }),
    ...(input.commerceProducts === undefined ? {} : { commerceProducts: input.commerceProducts }),
    ...(input.commerceAccountBinding === undefined ? {} : { commerceAccountBinding: input.commerceAccountBinding }),
    commerceSessionCheck: () => {
      const refusal = gate.check();
      return refusal === undefined
        ? undefined
        : new CommerceError('ACCOUNT_BINDING_REQUIRED', {
            retryable: true,
            storeCode: refusal.code,
            message: refusal.message,
          });
    },
    ...(input.commerceStaleLaunchedAfterMs === undefined
      ? {}
      : { commerceStaleLaunchedAfterMs: input.commerceStaleLaunchedAfterMs }),
  };
  const monetizationRecovery = input.operationStore === undefined
    ? undefined
    : createRecoverableMonetizationClient({ ...clientInput, operationStore: input.operationStore });
  // The recovery client owns the reconciler over the durable journal; the
  // plain client shares it instead of journaling in memory.
  const client = createGameServicesClient({
    ...clientInput,
    ...(monetizationRecovery?.commerceReconciler === undefined
      ? {}
      : { commerceReconciler: monetizationRecovery.commerceReconciler }),
  });
  let routedClient = client;
  if (monetizationRecovery !== undefined) {
    routedClient = {
      ...client,
      purchase: monetizationRecovery.purchase,
      claimRewardedAd: monetizationRecovery.claimRewardedAd,
      // The recovery client owns the reconciler over the durable journal.
      ...(monetizationRecovery.commerceReconciler === undefined
        ? {}
        : { commerceReconciler: monetizationRecovery.commerceReconciler }),
    };
  }
  const reconciler = routedClient.commerceReconciler;
  /**
   * Purchases, rewarded-ad claims, and recovery passes running now:
   * `dispose()` lets them journal first.
   */
  const purchases = new Set<Promise<unknown>>();
  const track = <T>(running: Promise<T>): Promise<T> => {
    purchases.add(running);
    void running.finally(() => purchases.delete(running)).catch(() => undefined);
    return running;
  };
  const exposedReconciler = reconciler === undefined
    ? undefined
    : guardReconciler(reconciler, gate, track);
  gate.onClose(async () => {
    // A purchase whose store sheet is open journals the store answer first,
    // an open rewarded ad its platform result (both stay this player's to
    // recover), and a recovery pass finishes its start, then the reconciler
    // stops.
    await settleWithin(Promise.allSettled([...purchases]), gameServicesDisposeWaitMs);
    await settleWithin(reconciler?.stop() ?? Promise.resolve(), gameServicesDisposeWaitMs);
  });
  return {
    mode,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    target,
    client: guardClient(routedClient, gate, track, exposedReconciler),
    ...(monetizationRecovery === undefined
      ? {}
      : { monetizationRecovery: guardRecovery(monetizationRecovery, gate, exposedReconciler, track) }),
    ...(baseUrl === undefined
      ? {}
      : {
          accountDeletion: guardAccountDeletion(createAccountDeletionClient({
            // The deletion route is plain HTTP next to the oRPC handler: an
            // oRPC URL names the handler's `/rpc` prefix, which the route
            // does not sit under.
            baseUrl: input.transport === 'orpc' ? baseUrl.replace(/\/rpc\/?$/u, '') : baseUrl,
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            getHeaders: guardHeaders(input.getHeaders, gate),
          }), gate),
        }),
    dispose: () => gate.close(gameServicesRuntimeDisposedCode),
  };
}

/**
 * Whether the runtime may act for its player: open, and (with
 * `sessionPlayerId`) the session's player is the runtime's. Another player
 * closes it for good; closing stops the commerce reconciler once.
 */
interface RuntimeGate {
  /** The refusal for an operation starting now, if any. */
  check(): GameServicesRuntimeClosedError | undefined;
  /** Throws the refusal, if any. */
  assert(): void;
  /** Closed for good (disposed, or another player); signed out is not closed. */
  readonly closed: boolean;
  close(code: GameServicesRuntimeClosedCode): Promise<void>;
  onClose(teardown: () => Promise<void>): void;
}

function createRuntimeGate(
  playerId: string,
  sessionPlayerId: (() => string | undefined) | undefined,
): RuntimeGate {
  let closed: GameServicesRuntimeClosedError | undefined;
  let closing: Promise<void> | undefined;
  const teardowns: (() => Promise<void>)[] = [];
  const gate: RuntimeGate = {
    check() {
      if (closed !== undefined) {
        return closed;
      }
      if (sessionPlayerId === undefined) {
        return undefined;
      }
      let current: string | undefined;
      try {
        current = sessionPlayerId()?.trim();
      } catch {
        current = undefined;
      }
      if (current === undefined || current === '') {
        return new GameServicesRuntimeClosedError(gameServicesSessionRequiredCode);
      }
      if (current !== playerId.trim()) {
        void gate.close(gameServicesPlayerChangedCode);
        return closed;
      }
      return undefined;
    },
    get closed() {
      return closed !== undefined;
    },
    assert() {
      const refusal = gate.check();
      if (refusal !== undefined) {
        throw refusal;
      }
    },
    close(code) {
      closed ??= new GameServicesRuntimeClosedError(code);
      closing ??= (async () => {
        for (const teardown of teardowns) {
          try {
            await teardown();
          } catch {
            // Closed regardless: every operation is refused from now on.
          }
        }
      })();
      return closing;
    },
    onClose(teardown) {
      teardowns.push(teardown);
    },
  };
  return gate;
}

/**
 * Account deletion refused before anything resolves or is sent: signed out
 * answers `UNAUTHORIZED` (no session on this device), a closed runtime the
 * retryable `ACCOUNT_DELETION_UNREACHABLE`. Static headers never stand in
 * for a session the runtime refuses.
 */
function guardAccountDeletion(deletion: AccountDeletionClient, gate: RuntimeGate): AccountDeletionClient {
  return {
    ...deletion,
    async deleteAccount(request) {
      const refusal = gate.check();
      if (refusal !== undefined) {
        throw new AccountDeletionError(
          refusal.code === gameServicesSessionRequiredCode
            ? 'UNAUTHORIZED'
            : 'ACCOUNT_DELETION_UNREACHABLE',
          { requestSent: false, cause: refusal },
        );
      }
      return deletion.deleteAccount(request);
    },
  };
}

function guardHeaders(
  getHeaders: GameServicesHeaderResolver | undefined,
  gate: RuntimeGate,
): GameServicesHeaderResolver {
  return async () => {
    gate.assert();
    const headers = (await getHeaders?.()) ?? {};
    // A session that changed player while its headers were resolved: they
    // may be the new player's, so they are never sent for this one.
    gate.assert();
    return headers;
  };
}

function guardBackend(backend: GameServicesBackendApi, gate: RuntimeGate): GameServicesBackendApi {
  const { purchases, adRewards, leaderboard } = backend;
  const ledgerStatus = purchases.getPurchaseLedgerStatus;
  const capabilities = purchases.getCommerceCapabilities;
  return {
    ...(backend.version === undefined ? {} : { version: backend.version }),
    purchases: {
      async verifyPurchase(request) {
        gate.assert();
        return purchases.verifyPurchase(request);
      },
      ...(ledgerStatus === undefined
        ? {}
        : {
            async getPurchaseLedgerStatus(request) {
              gate.assert();
              return ledgerStatus.call(purchases, request);
            },
          }),
      ...(capabilities === undefined
        ? {}
        : {
            async getCommerceCapabilities() {
              gate.assert();
              return capabilities.call(purchases);
            },
          }),
    },
    adRewards: {
      async claimAdReward(request) {
        gate.assert();
        return adRewards.claimAdReward(request);
      },
    },
    leaderboard: {
      async recordScore(request) {
        gate.assert();
        return leaderboard.recordScore(request);
      },
    },
  };
}

/** Resolves when `work` settles or after `ms`, whichever is first; never rejects. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The gateway with a rewarded-ad dispatch that throws the refusal once the
 * runtime refuses, so no ad opens. It is not an ad outcome: a journaled
 * operation stays unstarted (not ended), and `claimRewardedAd` answers
 * `unavailable`.
 */
function guardRewardedAds(gateway: PlatformGateway, gate: RuntimeGate): PlatformGateway {
  const ads = gateway.ads;
  return {
    ...gateway,
    ads: {
      ...ads,
      async showRewarded(request) {
        gate.assert();
        return ads.showRewarded(request);
      },
    },
  };
}

/** A reward claim through an open runtime; a dispatch the runtime refused answers `unavailable`. */
async function guardedReward(
  gate: RuntimeGate,
  track: PurchaseTracker,
  run: () => Promise<GameServicesRewardedAdResult>,
): Promise<GameServicesRewardedAdResult> {
  if (gate.check() !== undefined) {
    return refusedReward();
  }
  try {
    return await track(run());
  } catch (error) {
    if (error instanceof GameServicesRuntimeClosedError) {
      return refusedReward();
    }
    throw error;
  }
}

function refusedPurchase(refusal: GameServicesRuntimeClosedError): GameServicesPurchaseResult {
  return {
    status: 'failed',
    purchase: {
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: refusal.code, retryable: true },
    },
  };
}

function refusedReward(): GameServicesRewardedAdResult {
  return { status: 'unavailable', reward: { status: 'unavailable', rewardGranted: false } };
}

type PurchaseTracker = <T>(running: Promise<T>) => Promise<T>;

/**
 * A purchase through an open runtime. A refusal the reconciler gave because
 * the runtime closed meanwhile answers the runtime's diagnostic, as a
 * refusal at the entry does.
 */
async function guardedPurchase(
  gate: RuntimeGate,
  track: PurchaseTracker,
  run: () => Promise<GameServicesPurchaseResult>,
): Promise<GameServicesPurchaseResult> {
  const refusal = gate.check();
  if (refusal !== undefined) {
    return refusedPurchase(refusal);
  }
  const result = await track(run());
  const late = result.status === 'failed'
      && result.purchase.diagnostic?.code === 'ACCOUNT_BINDING_REQUIRED'
    ? gate.check()
    : undefined;
  return late === undefined ? result : refusedPurchase(late);
}

/**
 * The reconciler a runtime exposes: once the runtime closed for good, a
 * `start()` (a caller that passed its check just before) subscribes nothing.
 * While only signed out it starts as usual and its work waits for the
 * session (the reconciler's `sessionCheck`). Its purchases are tracked like
 * the client's, so `dispose()` waits for an open store sheet's answer.
 */
function guardReconciler(
  reconciler: CommerceReconciler,
  gate: RuntimeGate,
  track: PurchaseTracker,
): CommerceReconciler {
  // The runtime owns this reconciler, and the recovery client starts the
  // same instance from its startup pass (`reconcile()`), which can reach
  // `start()` after `dispose()` stopped it (a pass still awaiting the journal
  // when the dispose wait ran out). So the instance itself refuses a start
  // once the runtime closed for good. A start already under way when it
  // closes is the one `stop()` waits for and unsubscribes.
  const startOpen = reconciler.start;
  reconciler.start = async () => {
    if (!gate.closed) {
      await startOpen.call(reconciler);
    }
  };
  // The reconciler's getters and methods are closures: the prototype chain serves them.
  return Object.create(reconciler, {
    requestPurchase: {
      value: (request: Parameters<CommerceReconciler['requestPurchase']>[0]) =>
        track(reconciler.requestPurchase(request)),
    },
  }) as CommerceReconciler;
}

/** The client of an open runtime; refusals answer before any store UI or ad opens. */
function guardClient(
  client: GameServicesClient,
  gate: RuntimeGate,
  track: PurchaseTracker,
  reconciler: CommerceReconciler | undefined,
): GameServicesClient {
  return {
    ...client,
    ...(reconciler === undefined ? {} : { commerceReconciler: reconciler }),
    purchase: (purchase, options) =>
      guardedPurchase(gate, track, () => client.purchase(purchase, options)),
    claimRewardedAd: (reward, options) =>
      guardedReward(gate, track, () => client.claimRewardedAd(reward, options)),
    async submitLeaderboardScore(score) {
      gate.assert();
      return client.submitLeaderboardScore(score);
    },
  };
}

function guardRecovery(
  recovery: RecoverableMonetizationClient,
  gate: RuntimeGate,
  reconciler: CommerceReconciler | undefined,
  track: PurchaseTracker,
): RecoverableMonetizationClient {
  return {
    ...recovery,
    ...(reconciler === undefined ? {} : { commerceReconciler: reconciler }),
    purchase: (purchase, options) => guardedPurchase(gate, track, () => recovery.purchase(purchase, options)),
    claimRewardedAd: (reward, options) =>
      guardedReward(gate, track, () => recovery.claimRewardedAd(reward, options)),
    // A late ad callback is journaled; its claim is refused until a runtime
    // for the player resends it, so it stays pending, never ended.
    recoverRewardResult: (idempotencyKey, platform) => recovery.recoverRewardResult(idempotencyKey, platform),
    async reconcile() {
      // Startup and resume recovery wait for a runtime the session permits.
      // `dispose()` waits for a pass under way, so the reconciler it starts
      // is stopped after it, not before.
      return gate.check() === undefined ? track(recovery.reconcile()) : [];
    },
    async restorePurchases() {
      gate.assert();
      let restored: Awaited<ReturnType<RecoverableMonetizationClient['restorePurchases']>>;
      try {
        restored = await recovery.restorePurchases();
      } catch (error) {
        // Closed during the restore: the runtime's refusal says why.
        gate.assert();
        throw error;
      }
      // Closed during the restore: its passes stopped early for this player.
      gate.assert();
      return restored;
    },
  };
}

function withRuntimeHeaders(
  transport: GameServicesBackendTransport,
  input: CreateGameServicesRuntimeCommonInput,
  gate: RuntimeGate,
): GameServicesBackendTransport {
  return {
    async send(request) {
      gate.assert();
      const headers = await resolveGameServicesRequestHeaders({
        headers: input.headers,
        getHeaders: input.getHeaders,
        requestHeaders: request.headers,
      });
      // A session that changed player while its headers were resolved: they
      // may be the new player's, so they are never sent for this one.
      gate.assert();
      return transport.send({
        ...request,
        headers,
      });
    },
  };
}

export function resolveGameServicesLedgerTarget(
  target: PlatformTarget | string,
): GameServicesLedgerTarget | null {
  if (
    target === 'browser'
    || target === 'microsoft-store'
    || target === 'android'
    || target === 'ios'
    || target === 'ait'
    || target === 'reddit'
    || target === 'verse8'
    || target === 'oneplay'
  ) {
    return target;
  }

  return null;
}

export function resolveGameServicesAuthorityMode(profile: string): GameServicesAuthorityMode {
  if (profile.length === 0 || profile.trim() !== profile) {
    throw new Error('Game Services profile must be non-empty without surrounding whitespace.');
  }

  return profile === 'production' ? 'production' : 'non-production';
}

export function resolveGameServicesTransport(
  transport: string | undefined,
): 'http' | 'orpc' {
  if (transport === undefined || transport.length === 0 || transport === 'http') {
    return 'http';
  }

  if (transport === 'orpc') {
    return 'orpc';
  }

  throw new Error('Game Services transport must be http or orpc.');
}

function disabledRuntime(
  reason: GameServicesDisabledReason,
  target?: GameServicesLedgerTarget,
): GameServicesRuntime {
  return {
    mode: 'disabled',
    reason,
    ...(target === undefined ? {} : { target }),
    // Nothing to close: a disabled runtime holds no client.
    dispose: async () => undefined,
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = baseUrl?.trim();

  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

/**
 * Whether a game-services URL may carry a session's credentials in a
 * production build: an absolute https URL with no credentials and a public
 * host, the rule the authoritative commerce backend follows. The
 * notifications client's starter wiring uses it too.
 */
export function isPublicGameServicesUrl(baseUrl: string): boolean {
  return isPublicHttpsUrl(parseAbsoluteUrl(baseUrl.trim()));
}

function isPublicHttpsUrl(url: URL | undefined): boolean {
  return url !== undefined
    && url.protocol === 'https:'
    && url.username.length === 0
    && url.password.length === 0
    && !isNonPublicHostname(url.hostname);
}

function parseAbsoluteUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isNonPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/u, '');

  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
  ) {
    return true;
  }

  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(normalized)) {
    return isNonPublicIpv4(normalized);
  }

  return normalized.includes(':') && isNonPublicIpv6(normalized);
}

function isNonPublicIpv4(address: string): boolean {
  const [first = 0, second = 0, third = 0] = address.split('.').map(Number);

  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isNonPublicIpv6(address: string): boolean {
  const words = expandIpv6(address);

  if (words === undefined) {
    return true;
  }

  if (words.slice(0, 7).every((word) => word === 0)) {
    return true;
  }

  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isNonPublicIpv4(wordsToIpv4(words));
  }

  if (words.slice(0, 6).every((word) => word === 0)) {
    return isNonPublicIpv4(wordsToIpv4(words));
  }

  const first = words[0] ?? 0;

  return (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && words[1] === 0x0db8);
}

function wordsToIpv4(words: readonly number[]): string {
  return `${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 0xff}.`
    + `${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 0xff}`;
}

function expandIpv6(address: string): readonly number[] | undefined {
  const sections = address.split('::');

  if (sections.length > 2) {
    return undefined;
  }

  const head = ipv6Words(sections[0] ?? '');
  const tail = ipv6Words(sections[1] ?? '');

  if (head === undefined || tail === undefined) {
    return undefined;
  }

  const omitted = 8 - head.length - tail.length;

  if ((sections.length === 1 && omitted !== 0) || (sections.length === 2 && omitted < 1)) {
    return undefined;
  }

  return [...head, ...Array.from({ length: omitted }, () => 0), ...tail];
}

function ipv6Words(section: string): readonly number[] | undefined {
  if (section.length === 0) {
    return [];
  }

  const words: number[] = [];

  for (const segment of section.split(':')) {
    if (!/^[0-9a-f]{1,4}$/u.test(segment)) {
      return undefined;
    }

    words.push(Number.parseInt(segment, 16));
  }

  return words;
}

function assertAuthorityMode(
  authorityMode: GameServicesAuthorityMode,
): asserts authorityMode is GameServicesAuthorityMode {
  if (authorityMode !== 'production' && authorityMode !== 'non-production') {
    throw new Error('authorityMode must be production or non-production.');
  }
}

function assertTransport(
  transport: CreateGameServicesRuntimeInput['transport'],
): void {
  if (transport !== undefined && transport !== 'http' && transport !== 'orpc') {
    throw new Error('Game Services transport must be http or orpc.');
  }
}
