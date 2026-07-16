import type { ProductCatalog, ProductGrant } from '@mpgd/catalog';
import type { Entitlement, LogicalProductId } from '@mpgd/platform';

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
  readonly stateNamespace?: string;
  readonly now?: () => string;
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
  const products = createPlatformProductMap(options.catalog);

  return {
    async handleItemPurchased(event, context) {
      const normalized = assertPurchaseEvent(event);
      const product = products.get(normalized.productId);

      if (product === undefined) {
        throw new Error('Unknown Verse8 VXShop product.');
      }

      const purchaseId = String(normalized.purchaseId);
      const lockAccount = normalizeLockAccount(normalized.account);

      return context.lock(
        `mpgd:vxshop:${lockAccount}`,
        async () => {
          const userState = await context.getUserState(normalized.account);
          const current = readCommerceState(userState[namespace]);
          const existing = current.purchasesById[purchaseId];

          if (existing !== undefined) {
            assertSamePurchase(existing, normalized, product.id);

            return {
              success: true,
              alreadyProcessed: true,
              purchaseId,
              logicalProductId: existing.logicalProductId,
              entitlementIds: existing.entitlementIds,
            };
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

function createPlatformProductMap(catalog: ProductCatalog) {
  const products = new Map<string, ProductCatalog['products'][number]>();

  for (const product of catalog.products) {
    const platformProductId = product.platformProductIds.verse8?.trim();

    if (platformProductId === undefined || platformProductId.length === 0) {
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
  logicalProductId: LogicalProductId,
): void {
  if (
    existing.platformProductId !== event.productId
    || existing.logicalProductId !== logicalProductId
    || existing.quantity !== event.quantity
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

    const balance = state.balances[grant.currency] + amount;

    if (!Number.isSafeInteger(balance)) {
      throw new Error('Verse8 currency balance exceeds the safe integer range.');
    }

    return {
      state: {
        ...state,
        balances: {
          ...state.balances,
          [grant.currency]: balance,
        },
      },
      entitlementIds: [],
    };
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
