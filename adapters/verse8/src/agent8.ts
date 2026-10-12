import {
  resolveProductPlatformId,
  type CatalogTarget,
  type ProductCatalog,
  type ProductGrant,
} from '@mpgd/catalog';
import {
  createServerPushLedgerGrant,
  verse8Agent8EventEvidenceSchema as verse8Agent8EventLedgerSchema,
  verse8CommerceStoreId as verse8LedgerStoreId,
} from '@mpgd/game-services/commerce-evidence-registry';
import type { GameServicesStore } from '@mpgd/game-services/server';
import type { Entitlement, LogicalProductId } from '@mpgd/platform';

import { defaultVerse8CatalogTarget } from './catalog-target.js';
import type { Verse8RecordedPurchase } from './commerce-contract.js';

export * from './agent8-services.js';
export {
  assertVerse8Agent8EventEvidence,
  createVerse8Agent8EventEvidence,
  verse8Agent8EventEvidenceSchema,
  verse8CommerceStoreId,
  type Verse8Agent8EventEvidencePayload,
  type Verse8RecordedPurchase,
} from './commerce-contract.js';

const defaultStateNamespace = 'mpgdVerse8Commerce';

export interface Verse8Agent8PurchaseEvent {
  readonly account: string;
  readonly purchaseId: number;
  readonly productId: string;
  readonly quantity: number;
  readonly metadata?: unknown;
}

export interface Verse8Agent8Context {
  getUserState(account: string): Promise<Readonly<Record<string, unknown>>>;
  updateUserState(
    account: string,
    state: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>>;
  lock<T>(key: string, callback: () => T | Promise<T>): Promise<T>;
}

export interface Verse8Agent8CommerceOptions {
  readonly catalog: ProductCatalog;
  readonly target?: CatalogTarget;
  readonly stateNamespace?: string;
  readonly now?: () => string;
  /**
   * The game-services ledger the commerce v2 server-push lookup reads
   * (`createVerse8Agent8EventLookupCommerceEvidenceEntry`). With it, every
   * `$onItemPurchased` grant is also written there under target `verse8`
   * (`ledgerTarget`), store `verse8`, and the purchase id as the platform
   * transaction id, after the Agent8 user state committed; a verify request
   * carrying `verse8.agent8-event.v1` evidence then answers `granted` for
   * that purchase and `pending` before it. The write is idempotent on the
   * purchase id; a ledger that is unreachable fails the event so Agent8
   * redelivers it (the user-state grant is already committed and replays as
   * `alreadyProcessed`).
   */
  readonly ledger?: GameServicesStore;
  /** The ledger target the lookup reads under; defaults to `verse8`. */
  readonly ledgerTarget?: string;
  /**
   * The deployment target the backend binds `verse8` requests to
   * (`deploymentTargetBindings`), recorded on the ledger grant so a verify
   * request bound to it meets the grant under the same key.
   */
  readonly ledgerDeploymentTarget?: string;
  /** The Agent8 account as the game-services player id; defaults to the account itself. */
  readonly resolvePlayerId?: (account: string) => string;
}

export interface Verse8Agent8PurchaseResult {
  readonly success: true;
  readonly alreadyProcessed: boolean;
  readonly purchaseId: string;
  readonly logicalProductId: LogicalProductId;
  readonly entitlementIds: readonly string[];
}

export interface Verse8Agent8CommerceSnapshot {
  readonly balances: Readonly<Record<'coin' | 'gem', number>>;
  readonly entitlements: readonly Entitlement[];
}

export interface Verse8Agent8CommerceService {
  handleItemPurchased(
    event: Verse8Agent8PurchaseEvent,
    context: Verse8Agent8Context,
  ): Promise<Verse8Agent8PurchaseResult>;
  getEntitlements(
    account: string,
    context: Pick<Verse8Agent8Context, 'getUserState'>,
  ): Promise<readonly Entitlement[]>;
  /**
   * The purchases `$onItemPurchased` recorded for the account, oldest first:
   * the server-push lookup of the commerce v2 provider
   * (`createVerse8CommerceProvider` reads it through a game-owned
   * authenticated method). Expose it for the sender's own account only.
   */
  listPurchases(
    account: string,
    context: Pick<Verse8Agent8Context, 'getUserState'>,
  ): Promise<readonly Verse8RecordedPurchase[]>;
  getSnapshot(
    account: string,
    context: Pick<Verse8Agent8Context, 'getUserState'>,
  ): Promise<Verse8Agent8CommerceSnapshot>;
}

interface StoredPurchase {
  readonly purchaseId: string;
  readonly platformProductId: string;
  readonly logicalProductId: LogicalProductId;
  readonly quantity: number;
  readonly grantedAt: string;
  readonly entitlementIds: readonly string[];
}

interface StoredCommerceState {
  readonly version: 1;
  readonly balances: Readonly<Record<'coin' | 'gem', number>>;
  readonly entitlements: readonly Entitlement[];
  readonly purchasesById: Readonly<Record<string, StoredPurchase>>;
}

export function createVerse8Agent8CommerceService(
  options: Verse8Agent8CommerceOptions,
): Verse8Agent8CommerceService {
  const namespace = normalizeNamespace(options.stateNamespace ?? defaultStateNamespace);
  const now = options.now ?? (() => new Date().toISOString());
  const products = createPlatformProductMap(
    options.catalog,
    options.target ?? defaultVerse8CatalogTarget,
  );
  const ledger = options.ledger;
  const ledgerTarget = options.ledgerTarget ?? 'verse8';
  const resolvePlayerId = options.resolvePlayerId ?? ((account: string) => account);
  const recordLedgerGrant = async (
    event: Verse8Agent8PurchaseEvent,
    product: ProductCatalog['products'][number],
    grantedAt: string,
  ): Promise<void> => {
    if (ledger === undefined) {
      return;
    }
    const purchaseId = String(event.purchaseId);
    const grant = createServerPushLedgerGrant({
      store: verse8LedgerStoreId,
      target: ledgerTarget,
      ...(options.ledgerDeploymentTarget === undefined
        ? {}
        : { deploymentTarget: options.ledgerDeploymentTarget }),
      playerId: resolvePlayerId(event.account),
      product,
      platformProductId: event.productId,
      transactionId: purchaseId,
      quantity: event.quantity,
      purchasedAt: grantedAt,
      grantedAt,
      evidence: {
        schema: verse8Agent8EventLedgerSchema,
        payload: { purchaseId, productId: event.productId, quantity: event.quantity },
      },
    });
    await ledger.recordEntitlementGrant(grant);
  };

  return {
    async handleItemPurchased(event, context) {
      const normalized = assertPurchaseEvent(event);
      const product = products.get(normalized.productId);
      const purchaseId = String(normalized.purchaseId);
      const lockAccount = normalizeLockAccount(normalized.account);

      return context.lock(
        `mpgd:vxshop:${lockAccount}`,
        async () => {
          const userState = await context.getUserState(normalized.account);
          const current = readCommerceState(userState[namespace]);
          const existing = current.purchasesById[purchaseId];

          if (existing !== undefined) {
            assertSamePurchase(existing, normalized, product?.id);
            if (product !== undefined) {
              // A redelivery after a ledger write that failed: the user-state
              // grant stands and the ledger write is retried idempotently.
              await recordLedgerGrant(normalized, product, existing.grantedAt);
            }

            return {
              success: true,
              alreadyProcessed: true,
              purchaseId,
              logicalProductId: existing.logicalProductId,
              entitlementIds: existing.entitlementIds,
            };
          }

          if (product === undefined) {
            throw new Error('Unknown Verse8 VXShop product.');
          }

          const grantedAt = now();
          assertNonEmptyString(grantedAt, 'now() result');
          const applied = applyGrant(current, product.grant, normalized.quantity, grantedAt);
          const purchase = {
            purchaseId,
            platformProductId: normalized.productId,
            logicalProductId: product.id,
            quantity: normalized.quantity,
            grantedAt,
            entitlementIds: applied.entitlementIds,
          } satisfies StoredPurchase;
          const next = {
            ...applied.state,
            purchasesById: {
              ...applied.state.purchasesById,
              [purchaseId]: purchase,
            },
          } satisfies StoredCommerceState;

          // The grant and its consume-once marker share one Agent8 user-state
          // update so a retry cannot observe one without the other.
          await context.updateUserState(normalized.account, { [namespace]: next });
          await recordLedgerGrant(normalized, product, grantedAt);

          return {
            success: true,
            alreadyProcessed: false,
            purchaseId,
            logicalProductId: product.id,
            entitlementIds: applied.entitlementIds,
          };
        },
      );
    },
    async getEntitlements(account, context) {
      return (await readSnapshot(account, context, namespace)).entitlements;
    },
    async getSnapshot(account, context) {
      return readSnapshot(account, context, namespace);
    },
    async listPurchases(account, context) {
      assertNonEmptyString(account, 'account');
      const userState = await context.getUserState(account);
      const state = readCommerceState(userState[namespace]);
      return Object.values(state.purchasesById)
        .sort((left, right) => Number(left.purchaseId) - Number(right.purchaseId))
        .map((purchase): Verse8RecordedPurchase => ({
          purchaseId: purchase.purchaseId,
          productId: purchase.platformProductId,
          quantity: purchase.quantity,
          grantedAt: purchase.grantedAt,
        }));
    },
  };
}

async function readSnapshot(
  account: string,
  context: Pick<Verse8Agent8Context, 'getUserState'>,
  namespace: string,
): Promise<Verse8Agent8CommerceSnapshot> {
  assertNonEmptyString(account, 'account');
  const userState = await context.getUserState(account);
  const state = readCommerceState(userState[namespace]);

  return {
    balances: { ...state.balances },
    entitlements: [...state.entitlements],
  };
}

function createPlatformProductMap(catalog: ProductCatalog, target: CatalogTarget) {
  const products = new Map<string, ProductCatalog['products'][number]>();

  for (const product of catalog.products) {
    const platformProductId = resolveProductPlatformId(product, target);

    if (platformProductId === undefined) {
      continue;
    }

    if (products.has(platformProductId)) {
      throw new Error(`Duplicate Verse8 platform product ID: ${platformProductId}`);
    }

    products.set(platformProductId, product);
  }

  return products;
}

function assertPurchaseEvent(event: Verse8Agent8PurchaseEvent): Verse8Agent8PurchaseEvent {
  assertNonEmptyString(event.account, 'account');
  assertNonEmptyString(event.productId, 'productId');

  if (!Number.isSafeInteger(event.purchaseId) || event.purchaseId < 0) {
    throw new Error('purchaseId must be a non-negative safe integer.');
  }

  if (!Number.isSafeInteger(event.quantity) || event.quantity <= 0) {
    throw new Error('quantity must be a positive safe integer.');
  }

  return event;
}

function assertSamePurchase(
  existing: StoredPurchase,
  event: Verse8Agent8PurchaseEvent,
  logicalProductId: LogicalProductId | undefined,
): void {
  if (
    existing.platformProductId !== event.productId
    || existing.quantity !== event.quantity
    || (
      logicalProductId !== undefined
      && existing.logicalProductId !== logicalProductId
    )
  ) {
    throw new Error('Verse8 purchase ID was reused with different purchase data.');
  }
}

function applyGrant(
  state: StoredCommerceState,
  grant: ProductGrant,
  quantity: number,
  grantedAt: string,
): { readonly state: StoredCommerceState; readonly entitlementIds: readonly string[] } {
  if (grant.type === 'currency') {
    const amount = grant.amount * quantity;

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('Verse8 currency grant exceeds the safe integer range.');
    }

    const currency = grant.currency;
    if (!isVerse8Currency(currency)) {
      throw new Error(`Verse8 commerce state does not track the ${currency} currency.`);
    }

    const balance = state.balances[currency] + amount;

    if (!Number.isSafeInteger(balance)) {
      throw new Error('Verse8 currency balance exceeds the safe integer range.');
    }

    return {
      state: {
        ...state,
        balances: {
          ...state.balances,
          [currency]: balance,
        },
      },
      entitlementIds: [],
    };
  }

  if (grant.type === 'resource') {
    throw new Error('Verse8 resource grants are not supported.');
  }

  if (quantity !== 1) {
    throw new Error('Verse8 entitlement purchases must have quantity 1.');
  }

  const existing = state.entitlements.find((entitlement) => entitlement.id === grant.entitlement);
  const entitlements = existing === undefined
    ? [
        ...state.entitlements,
        {
          id: grant.entitlement,
          source: 'purchase' as const,
          grantedAt,
        },
      ]
    : state.entitlements;

  return {
    state: {
      ...state,
      entitlements,
    },
    entitlementIds: [grant.entitlement],
  };
}

function readCommerceState(value: unknown): StoredCommerceState {
  if (value === undefined) {
    return emptyCommerceState();
  }

  if (!isRecord(value) || value.version !== 1) {
    throw invalidStoredState();
  }

  return {
    version: 1,
    balances: readBalances(value.balances),
    entitlements: readEntitlements(value.entitlements),
    purchasesById: readPurchaseIndex(value.purchasesById),
  };
}

function emptyCommerceState(): StoredCommerceState {
  return {
    version: 1,
    balances: { coin: 0, gem: 0 },
    entitlements: [],
    purchasesById: {},
  };
}

/** The stored state tracks the starter currencies only; other catalog currencies are rejected. */
function isVerse8Currency(value: string): value is keyof StoredCommerceState['balances'] {
  return value === 'coin' || value === 'gem';
}

function readBalances(value: unknown): StoredCommerceState['balances'] {
  if (!isRecord(value)) {
    throw invalidStoredState();
  }

  return {
    coin: assertSafeNonNegativeInteger(value.coin),
    gem: assertSafeNonNegativeInteger(value.gem),
  };
}

function readEntitlements(value: unknown): readonly Entitlement[] {
  if (!Array.isArray(value)) {
    throw invalidStoredState();
  }

  const entitlementIds = new Set<string>();

  return value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.id !== 'string'
      || entry.id.length === 0
      || entry.source !== 'purchase'
      || typeof entry.grantedAt !== 'string'
      || entry.grantedAt.length === 0
      || entitlementIds.has(entry.id)
    ) {
      throw invalidStoredState();
    }

    entitlementIds.add(entry.id);

    return {
      id: entry.id,
      source: 'purchase' as const,
      grantedAt: entry.grantedAt,
    };
  });
}

function readPurchaseIndex(value: unknown): Readonly<Record<string, StoredPurchase>> {
  if (!isRecord(value)) {
    throw invalidStoredState();
  }

  const purchasesById: Record<string, StoredPurchase> = {};

  for (const [purchaseId, entry] of Object.entries(value)) {
    if (
      !isCanonicalPurchaseId(purchaseId)
      || !isRecord(entry)
      || entry.purchaseId !== purchaseId
      || typeof entry.platformProductId !== 'string'
      || entry.platformProductId.length === 0
      || typeof entry.logicalProductId !== 'string'
      || entry.logicalProductId.length === 0
      || !Number.isSafeInteger(entry.quantity)
      || (entry.quantity as number) <= 0
      || typeof entry.grantedAt !== 'string'
      || entry.grantedAt.length === 0
      || !Array.isArray(entry.entitlementIds)
      || !entry.entitlementIds.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      throw invalidStoredState();
    }

    purchasesById[purchaseId] = {
      purchaseId,
      platformProductId: entry.platformProductId,
      logicalProductId: entry.logicalProductId,
      quantity: entry.quantity as number,
      grantedAt: entry.grantedAt,
      entitlementIds: entry.entitlementIds as readonly string[],
    };
  }

  return purchasesById;
}

function isCanonicalPurchaseId(value: string): boolean {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value;
}

function assertSafeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidStoredState();
  }

  return value as number;
}

function normalizeNamespace(value: string): string {
  const normalized = value.trim();

  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('stateNamespace must be a safe non-empty state key.');
  }

  return normalized;
}

function normalizeLockAccount(value: string): string {
  const normalized = value.trim();

  if (normalized !== value || normalized.length > 256) {
    throw new Error('account must be a canonical bounded string.');
  }

  return encodeURIComponent(normalized);
}

function invalidStoredState(): Error {
  return new Error('Stored Verse8 commerce state is invalid.');
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
