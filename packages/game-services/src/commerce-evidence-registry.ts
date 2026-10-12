import type { ProductCatalog } from '@mpgd/catalog';
import type {
  CommerceCapabilities,
  CommerceFinishOwner,
  PlatformEvidenceEnvelope,
} from '@mpgd/platform';
import {
  commerceProtocolVersion,
  type CommerceServiceCapabilities,
  type CommerceServiceStoreCapabilities,
  type StoreId,
} from '@mpgd/platform/commerce';

import type {
  EvidenceVerificationDecision,
  FinalizePurchaseGrantInput,
  GameServicesEvidenceVerifier,
  GameServicesPurchaseGrantFinalizer,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification.js';
import type { GameServicesStore } from './server.js';
import {
  assertCommerceStoreId,
  type EntitlementLedgerGrant,
  type EntitlementLedgerPayload,
  type ProductGrantTransaction,
  type VerifyPurchaseRequest,
} from './types.js';

/**
 * Commerce v2 evidence registry (RFC "Server: commerce service protocol").
 * The game composes one registry from the reference entries below and its
 * own; the backend routes every verify request by `evidence.schema` to the
 * entry that claims it, publishes the stores it accepts through the
 * capabilities endpoint, and finalizes server-finish grants through the
 * entry's finalizer. Nothing here grants: an entry's verifier decides, and
 * the backend writes the ledger.
 */

/** Stable rejection reasons the registry answers before any verifier runs. */
export type CommerceEvidenceRegistryErrorCode =
  | 'EVIDENCE_SCHEMA_UNSUPPORTED'
  | 'EVIDENCE_SCHEMA_STORE_MISMATCH'
  | 'EVIDENCE_SCHEMA_TARGET_MISMATCH';

/** The purchase kinds a store sells, as the capabilities endpoint publishes them. */
export type CommerceServicePurchaseCapabilities = CommerceServiceStoreCapabilities['purchase'];

export interface CommerceEvidenceRegistryEntry {
  /** The evidence schema this entry verifies, for example `google-play.product-purchase.v2`. */
  readonly schema: string;
  readonly store: StoreId;
  readonly verifier: Pick<GameServicesEvidenceVerifier, 'verifyPurchase'>;
  /** Required when `finish` is `server`; registry construction fails otherwise. */
  readonly finalizer?: GameServicesPurchaseGrantFinalizer;
  readonly finish: CommerceFinishOwner;
  /** Spend scope of credit lots bought through this store. Default 'title'. */
  readonly creditScope?: 'title' | 'cross-title';
  /**
   * Route a request of this store that carries no evidence envelope to this
   * entry (the App Store verifier keeps its Server API lookup for one). At
   * most one entry per store may declare it.
   */
  readonly acceptsMissingEvidence?: boolean;
  /**
   * Route a request of this store whose schema no entry claims to this entry
   * as well (a verifier binding that keeps its own schema list). At most one
   * entry per store may declare it; without one such a request is rejected.
   */
  readonly acceptsUnclaimedSchemas?: boolean;
  /**
   * The ledger targets a request of this store may name (`request.target`).
   * A request naming another target is rejected with
   * `EVIDENCE_SCHEMA_TARGET_MISMATCH`; absent, any target is accepted.
   */
  readonly targets?: readonly string[];
  /**
   * What the store sells, published by the capabilities endpoint. Defaults to
   * consumable and durable one-time products; every entry of one store is
   * merged.
   */
  readonly purchase?: CommerceServicePurchaseCapabilities;
}

/** A store the `unregistered` fallback verifier serves, published by the capabilities endpoint. */
export interface CommerceEvidenceFallbackStore {
  readonly store: StoreId;
  readonly finish: CommerceFinishOwner;
  readonly purchase?: CommerceServicePurchaseCapabilities;
  readonly targets?: readonly string[];
}

export interface CreateCommerceEvidenceRegistryOptions {
  /**
   * A deployment's v1 verifier (and finalizer) for requests whose schema no
   * entry claims, so a registry can be introduced next to an existing
   * aggregate verifier. Without it such a request is rejected with
   * `EVIDENCE_SCHEMA_UNSUPPORTED`. A schema an entry claims never reaches it.
   */
  readonly unregistered?: {
    readonly verifier: Pick<GameServicesEvidenceVerifier, 'verifyPurchase'>;
    readonly finalizer?: GameServicesPurchaseGrantFinalizer;
    /**
     * The stores the fallback publishes through the capabilities endpoint
     * (with no schemas), so a client of such a store is not told
     * `configuration-required`. Absent, nothing is published for the
     * fallback.
     */
    readonly stores?: readonly CommerceEvidenceFallbackStore[];
    /**
     * Whether the fallback also serves stores it did not declare (a v1
     * aggregate verifier that served every target). Defaults to true when
     * `stores` is absent and to false when it is given: a declared list is
     * then also the list of served stores, and any other store is rejected.
     */
    readonly servesUndeclaredStores?: boolean;
  };
}

export type CommerceEvidenceRoute =
  | {
      readonly status: 'routed';
      readonly store: StoreId;
      readonly entry: CommerceEvidenceRegistryEntry;
    }
  | {
      /** No entry claims the request's schema (or its missing envelope). */
      readonly status: 'unregistered';
      readonly store: StoreId;
    }
  | {
      readonly status: 'rejected';
      readonly store: StoreId;
      readonly reason: CommerceEvidenceRegistryErrorCode;
    };

export interface CommerceEvidenceRegistry {
  readonly entries: readonly CommerceEvidenceRegistryEntry[];
  /** Every store the registry serves: the entries' stores and the fallback's declared ones. */
  readonly stores: ReadonlySet<StoreId>;
  /**
   * Whether a request is served at all: a served store, or (with
   * `servesUndeclaredStores`) an undeclared store whose target's v1 store is
   * not itself served. The backend answers a 400 otherwise.
   */
  serves(request: Pick<VerifyPurchaseRequest, 'target' | 'store'>): boolean;
  /** Whether the fallback serves stores it did not declare. */
  readonly servesUndeclaredStores: boolean;
  /**
   * The ledger targets requests of a served store may name: the union of the
   * store's entries' `targets` (or the declared fallback store's), or
   * undefined when any target is accepted or the store is not served.
   */
  allowedTargets(store: StoreId): ReadonlySet<string> | undefined;
  /** The store a request names: `store`, or the v1 mapping of its `target`. */
  resolveStore(request: Pick<VerifyPurchaseRequest, 'target' | 'store'>): StoreId;
  /** Where a request's evidence is routed, without running a verifier. */
  route(request: Pick<VerifyPurchaseRequest, 'target' | 'store' | 'evidence'>): CommerceEvidenceRoute;
  /** Routes the request and runs the entry's verifier; a `GameServicesEvidenceVerifier.verifyPurchase`. */
  verifyPurchase(input: VerifyPurchaseEvidenceInput): Promise<EvidenceVerificationDecision>;
  /** Routes a grant to the entry's finalizer; a `GameServicesPurchaseGrantFinalizer`. */
  readonly finalizer: GameServicesPurchaseGrantFinalizer;
  /** What the backend accepts, for the provider capabilities endpoint. */
  getCapabilities(): CommerceServiceCapabilities;
}

const defaultPurchaseCapabilities: CommerceServicePurchaseCapabilities = Object.freeze({
  consumable: true,
  durable: true,
  subscription: false,
});

/**
 * The v1 request mapping (RFC "Open store ids"): a request without `store`
 * names its store through its deployment target. `android` is `google-play`,
 * `ios` is `app-store`, `ait` is `apps-in-toss`, `reddit` is `devvit`, and
 * every other target is its own store id (`microsoft-store`, `verse8`,
 * `oneplay`, or a project store that reuses its target name).
 */
export function resolveLegacyCommerceStoreId(target: string): StoreId {
  switch (target) {
    case 'android':
      return 'google-play';
    case 'ios':
      return 'app-store';
    case 'ait':
      return 'apps-in-toss';
    case 'reddit':
      return 'devvit';
    default:
      return target;
  }
}

/** The store a verify request names: its `store`, or the v1 mapping of its `target`. */
export function resolveCommerceStoreId(
  request: Pick<VerifyPurchaseRequest, 'target' | 'store'>,
): StoreId {
  return request.store ?? resolveLegacyCommerceStoreId(request.target);
}

/**
 * Builds the registry. Construction fails when two entries claim one schema,
 * when a `finish: 'server'` entry has no finalizer, when two entries of one
 * store disagree on `finish`, or when more than one entry of a store accepts
 * a missing envelope.
 */
export function createCommerceEvidenceRegistry(
  entries: readonly CommerceEvidenceRegistryEntry[],
  options: CreateCommerceEvidenceRegistryOptions = {},
): CommerceEvidenceRegistry {
  const bySchema = new Map<string, CommerceEvidenceRegistryEntry>();
  const byStore = new Map<StoreId, CommerceEvidenceRegistryEntry[]>();
  const missingEvidenceByStore = new Map<StoreId, CommerceEvidenceRegistryEntry>();
  const frozenEntries: CommerceEvidenceRegistryEntry[] = [];

  for (const entry of entries) {
    assertRegistryEntry(entry);
    if (bySchema.has(entry.schema)) {
      throw new TypeError(
        `Commerce evidence schema ${entry.schema} is claimed by two registry entries.`,
      );
    }
    const siblings = byStore.get(entry.store) ?? [];
    const sibling = siblings[0];
    if (sibling !== undefined && sibling.finish !== entry.finish) {
      throw new TypeError(
        `Commerce store ${entry.store} declares finish ${sibling.finish} for ${sibling.schema} `
          + `and ${entry.finish} for ${entry.schema}; one store has one finish owner.`,
      );
    }
    if (sibling !== undefined && !samePurchaseCapabilities(sibling.purchase, entry.purchase)) {
      // What a store sells is one profile; two entries of one store must
      // declare it identically (or both leave the default), never be merged.
      throw new TypeError(
        `Commerce store ${entry.store} declares different purchase kinds for ${sibling.schema} `
          + `and ${entry.schema}; every entry of a store declares the same purchase profile.`,
      );
    }
    if (entry.acceptsMissingEvidence === true) {
      if (missingEvidenceByStore.has(entry.store)) {
        throw new TypeError(
          `Commerce store ${entry.store} has two entries that accept a missing evidence envelope.`,
        );
      }
      missingEvidenceByStore.set(entry.store, entry);
    }
    const frozen = Object.freeze({ ...entry });
    bySchema.set(entry.schema, frozen);
    byStore.set(entry.store, [...siblings, frozen]);
    frozenEntries.push(frozen);
  }

  const fallback = options.unregistered;
  const fallbackStores = new Map<StoreId, CommerceEvidenceFallbackStore>();
  for (const declared of fallback?.stores ?? []) {
    assertCommerceStoreId(declared.store, 'unregistered.stores[].store');
    if (byStore.has(declared.store)) {
      throw new TypeError(
        `Commerce store ${declared.store} has registry entries and is also declared for the `
          + 'unregistered fallback; one or the other serves it.',
      );
    }
    if (fallbackStores.has(declared.store)) {
      throw new TypeError(`Commerce store ${declared.store} is declared twice for the fallback.`);
    }
    if (declared.finish === 'server' && fallback?.finalizer === undefined) {
      throw new TypeError(
        `Commerce store ${declared.store} is declared for the fallback with finish: server and `
          + 'needs unregistered.finalizer; without one its grants would never be acknowledged.',
      );
    }
    fallbackStores.set(declared.store, declared);
  }
  const unclaimedByStore = new Map<StoreId, CommerceEvidenceRegistryEntry>();
  for (const entry of frozenEntries) {
    if (entry.acceptsUnclaimedSchemas === true) {
      if (unclaimedByStore.has(entry.store)) {
        throw new TypeError(
          `Commerce store ${entry.store} has two entries that accept unclaimed schemas.`,
        );
      }
      unclaimedByStore.set(entry.store, entry);
    }
  }
  const servesUndeclaredStores = fallback !== undefined
    && (fallback.servesUndeclaredStores ?? fallback.stores === undefined);
  const stores: ReadonlySet<StoreId> = new Set([...byStore.keys(), ...fallbackStores.keys()]);

  const allowedTargets = (store: StoreId): ReadonlySet<string> | undefined => {
    const storeEntries = byStore.get(store);
    if (storeEntries !== undefined) {
      if (storeEntries.some((entry) => entry.targets === undefined)) {
        return undefined;
      }
      return new Set(storeEntries.flatMap((entry) => entry.targets ?? []));
    }
    const declared = fallbackStores.get(store);
    return declared?.targets === undefined ? undefined : new Set(declared.targets);
  };

  const resolveStore = (request: Pick<VerifyPurchaseRequest, 'target' | 'store'>): StoreId =>
    resolveCommerceStoreId(request);

  const targetAllowed = (
    allowed: readonly string[] | undefined,
    target: string,
  ): boolean => allowed === undefined || allowed.includes(target);

  const routeToEntry = (
    store: StoreId,
    target: string,
    entry: CommerceEvidenceRegistryEntry,
  ): CommerceEvidenceRoute => {
    if (entry.store !== store) {
      return { status: 'rejected', store, reason: 'EVIDENCE_SCHEMA_STORE_MISMATCH' };
    }
    if (!targetAllowed(entry.targets, target)) {
      return { status: 'rejected', store, reason: 'EVIDENCE_SCHEMA_TARGET_MISMATCH' };
    }
    return { status: 'routed', store, entry };
  };

  const route = (
    request: Pick<VerifyPurchaseRequest, 'target' | 'store' | 'evidence'>,
  ): CommerceEvidenceRoute => {
    const store = resolveStore(request);
    const schema = request.evidence?.schema;
    const claimed = schema === undefined ? undefined : bySchema.get(schema);
    if (claimed !== undefined) {
      return routeToEntry(store, request.target, claimed);
    }
    if (byStore.has(store)) {
      // A store with entries is never served by the fallback: an unclaimed
      // schema or a missing envelope reaches only the entry that opted in.
      const owner = schema === undefined
        ? missingEvidenceByStore.get(store)
        : unclaimedByStore.get(store);
      return owner === undefined
        ? { status: 'rejected', store, reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' }
        : routeToEntry(store, request.target, owner);
    }
    const declared = fallbackStores.get(store);
    if (declared !== undefined) {
      return targetAllowed(declared.targets, request.target)
        ? { status: 'unregistered', store }
        : { status: 'rejected', store, reason: 'EVIDENCE_SCHEMA_TARGET_MISMATCH' };
    }
    if (!servesUndeclaredStores) {
      return { status: 'rejected', store, reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' };
    }
    if (dodgesServedStore(request)) {
      return { status: 'rejected', store, reason: 'EVIDENCE_SCHEMA_STORE_MISMATCH' };
    }
    return { status: 'unregistered', store };
  };

  /**
   * An undeclared `store` label on a target whose v1 store is served by an
   * entry or a declared fallback store (`{ target: 'android', store: 'x' }`)
   * would route the target's purchase around that entry; it is refused.
   */
  const dodgesServedStore = (
    request: Pick<VerifyPurchaseRequest, 'target' | 'store'>,
  ): boolean => {
    const legacy = resolveLegacyCommerceStoreId(request.target);
    return request.store !== undefined && request.store !== legacy && stores.has(legacy);
  };

  type FinalizationOwner =
    | { readonly kind: 'entry'; readonly entry: CommerceEvidenceRegistryEntry }
    | { readonly kind: 'fallback' }
    /** The grant recorded a schema whose entry belongs to another store: never finalized blindly. */
    | { readonly kind: 'mismatch'; readonly entry: CommerceEvidenceRegistryEntry }
    | { readonly kind: 'none' };

  /**
   * The entry that owns a grant being finalized: the schema and store the
   * grant's ledger payload recorded come first (a retry may carry another
   * envelope), then the request's schema, then the single finalizing entry
   * of the grant's store (a grant written before the payload carried
   * `evidenceSchema`).
   */
  const routeFinalization = (
    input: Pick<FinalizePurchaseGrantInput, 'request' | 'evidencePayload'>,
  ): FinalizationOwner => {
    const payloadStore = input.evidencePayload?.store;
    const store = typeof payloadStore === 'string' && payloadStore.length > 0
      ? payloadStore
      : resolveStore(input.request);
    const payloadSchema = input.evidencePayload?.evidenceSchema;
    const schema = typeof payloadSchema === 'string' && payloadSchema.length > 0
      ? payloadSchema
      : input.request.evidence?.schema;
    if (schema !== undefined) {
      const entry = bySchema.get(schema);
      if (entry !== undefined) {
        return entry.store === store ? { kind: 'entry', entry } : { kind: 'mismatch', entry };
      }
      const unclaimed = unclaimedByStore.get(store);
      if (unclaimed !== undefined) {
        return { kind: 'entry', entry: unclaimed };
      }
    }
    const finalizing = (byStore.get(store) ?? []).filter((entry) => entry.finalizer !== undefined);
    const single = finalizing[0];
    if (finalizing.length === 1 && single !== undefined) {
      return { kind: 'entry', entry: single };
    }
    if (!byStore.has(store) && (fallbackStores.has(store) || servesUndeclaredStores)) {
      return { kind: 'fallback' };
    }
    return { kind: 'none' };
  };

  const finalizer: GameServicesPurchaseGrantFinalizer = {
    supportsPurchaseGrant(input) {
      const owner = routeFinalization(input);
      switch (owner.kind) {
        case 'entry':
          return owner.entry.finalizer !== undefined
            && (owner.entry.finalizer.supportsPurchaseGrant?.(input) ?? true);
        case 'fallback':
          return fallback?.finalizer !== undefined
            && (fallback.finalizer.supportsPurchaseGrant?.(input) ?? true);
        case 'mismatch':
          // The owning entry has a finalizer that must not run for another
          // store's grant: the grant stays pending rather than reported done.
          return owner.entry.finalizer !== undefined;
        case 'none':
          return false;
      }
    },
    async finalizePurchaseGrant(input) {
      const owner = routeFinalization(input);
      const selected = owner.kind === 'entry'
        ? owner.entry.finalizer
        : owner.kind === 'fallback'
          ? fallback?.finalizer
          : undefined;
      if (selected === undefined) {
        return {
          status: 'pending',
          alreadyCompleted: false,
          reason: owner.kind === 'mismatch'
            ? 'PURCHASE_FINALIZER_STORE_MISMATCH'
            : 'PURCHASE_FINALIZER_UNREGISTERED',
        };
      }
      return selected.finalizePurchaseGrant(input);
    },
  };

  const purchaseProfileOf = (
    declared: CommerceServicePurchaseCapabilities | undefined,
  ): CommerceServicePurchaseCapabilities => ({ ...(declared ?? defaultPurchaseCapabilities) });

  const describeStore = (
    store: StoreId,
    storeEntries: readonly CommerceEvidenceRegistryEntry[],
  ): CommerceServiceStoreCapabilities => {
    const first = storeEntries[0];
    if (first === undefined) {
      throw new Error(`Commerce store ${store} has no registry entries.`);
    }
    return {
      store,
      schemas: storeEntries.map((entry) => entry.schema),
      finish: first.finish,
      purchase: purchaseProfileOf(first.purchase),
    };
  };

  const getCapabilities = (): CommerceServiceCapabilities => {
    const published: CommerceServiceStoreCapabilities[] = [];
    for (const [store, storeEntries] of byStore) {
      published.push(describeStore(store, storeEntries));
    }
    for (const declared of fallbackStores.values()) {
      published.push({
        store: declared.store,
        schemas: [],
        finish: declared.finish,
        purchase: purchaseProfileOf(declared.purchase),
      });
    }
    return { commerceProtocolVersion, stores: published };
  };

  const serves = (request: Pick<VerifyPurchaseRequest, 'target' | 'store'>): boolean => {
    const store = resolveStore(request);
    if (stores.has(store)) {
      return true;
    }
    return servesUndeclaredStores && !dodgesServedStore(request);
  };

  const registry: CommerceEvidenceRegistry = {
    entries: Object.freeze(frozenEntries),
    stores,
    serves,
    servesUndeclaredStores,
    allowedTargets,
    resolveStore,
    route,
    async verifyPurchase(input: VerifyPurchaseEvidenceInput): Promise<EvidenceVerificationDecision> {
      const routed = route(input.request);
      if (routed.status === 'rejected') {
        return { status: 'rejected', reason: routed.reason };
      }
      if (routed.status === 'unregistered') {
        if (fallback === undefined) {
          return { status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' };
        }
        return fallback.verifier.verifyPurchase(input);
      }
      return routed.entry.verifier.verifyPurchase(input);
    },
    finalizer,
    getCapabilities,
  };
  return Object.freeze(registry);
}

function samePurchaseCapabilities(
  left: CommerceServicePurchaseCapabilities | undefined,
  right: CommerceServicePurchaseCapabilities | undefined,
): boolean {
  const a = left ?? defaultPurchaseCapabilities;
  const b = right ?? defaultPurchaseCapabilities;
  return a.consumable === b.consumable
    && a.durable === b.durable
    && a.subscription === b.subscription;
}

function assertRegistryEntry(entry: CommerceEvidenceRegistryEntry): void {
  if (
    typeof entry.schema !== 'string'
    || entry.schema.trim() === ''
    || entry.schema.length > 512
    || entry.schema.trim() !== entry.schema
  ) {
    throw new TypeError('A commerce evidence registry entry needs a bounded schema identifier.');
  }
  try {
    assertCommerceStoreId(entry.store, 'store');
  } catch (error) {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof entry.verifier?.verifyPurchase !== 'function') {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema} needs a verifier with verifyPurchase.`,
    );
  }
  if (
    entry.finish !== 'client'
    && entry.finish !== 'server'
    && entry.finish !== 'host'
    && entry.finish !== 'none'
  ) {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema} declares an unknown finish owner.`,
    );
  }
  if (entry.finalizer !== undefined && typeof entry.finalizer.finalizePurchaseGrant !== 'function') {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema} has a finalizer without finalizePurchaseGrant.`,
    );
  }
  if (entry.finish === 'server' && entry.finalizer === undefined) {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema} (store ${entry.store}) declares `
        + 'finish: server and needs a finalizer; a server-finish store without one would leave '
        + 'every grant unacknowledged.',
    );
  }
  if (
    entry.creditScope !== undefined
    && entry.creditScope !== 'title'
    && entry.creditScope !== 'cross-title'
  ) {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema} declares an unknown credit scope.`,
    );
  }
  if (entry.acceptsMissingEvidence !== undefined && typeof entry.acceptsMissingEvidence !== 'boolean') {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema}: acceptsMissingEvidence must be a boolean.`,
    );
  }
  if (entry.acceptsUnclaimedSchemas !== undefined && typeof entry.acceptsUnclaimedSchemas !== 'boolean') {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema}: acceptsUnclaimedSchemas must be a boolean.`,
    );
  }
  if (
    entry.targets !== undefined
    && (!Array.isArray(entry.targets) || entry.targets.length === 0
      || entry.targets.some((target) => typeof target !== 'string' || target.length === 0))
  ) {
    throw new TypeError(
      `Commerce evidence registry entry ${entry.schema}: targets must list ledger target names.`,
    );
  }
  if (entry.purchase !== undefined) {
    const { consumable, durable, subscription } = entry.purchase;
    if (
      typeof consumable !== 'boolean'
      || typeof durable !== 'boolean'
      || typeof subscription !== 'boolean'
    ) {
      throw new TypeError(
        `Commerce evidence registry entry ${entry.schema}: purchase flags must be booleans.`,
      );
    }
  }
}

// Reference entries. Each wraps a verifier (and finalizer) the kit already
// ships with the RFC "Capabilities" profile row of its store.

/** The ledger target each reference store's verify requests name (RFC "Open store ids"). */
export const referenceCommerceLedgerTargets = Object.freeze({
  'google-play': Object.freeze(['android']),
  'app-store': Object.freeze(['ios']),
  'microsoft-store': Object.freeze(['microsoft-store']),
  'apps-in-toss': Object.freeze(['ait']),
  devvit: Object.freeze(['reddit']),
  verse8: Object.freeze(['verse8']),
}) satisfies Readonly<Record<string, readonly string[]>>;

/** The RFC profile purchase flags of the reference stores. */
export const referenceCommercePurchaseCapabilities = Object.freeze({
  'google-play': Object.freeze({ consumable: true, durable: true, subscription: false }),
  'app-store': Object.freeze({ consumable: true, durable: true, subscription: false }),
  'microsoft-store': Object.freeze({ consumable: true, durable: false, subscription: false }),
  'apps-in-toss': Object.freeze({ consumable: true, durable: true, subscription: false }),
  devvit: Object.freeze({ consumable: true, durable: true, subscription: false }),
  verse8: Object.freeze({ consumable: true, durable: true, subscription: false }),
}) satisfies Readonly<Record<string, CommerceServicePurchaseCapabilities>>;

export const googlePlayCommerceStoreId = 'google-play' as const;
export const appStoreCommerceStoreId = 'app-store' as const;
export const microsoftStoreCommerceStoreId = 'microsoft-store' as const;
export const appsInTossCommerceStoreId = 'apps-in-toss' as const;
export const devvitCommerceStoreId = 'devvit' as const;
export const verse8CommerceStoreId = 'verse8' as const;

export const googlePlayCommerceEvidenceSchema = 'google-play.product-purchase.v2' as const;
export const appStoreCommerceEvidenceSchema = 'app-store.signed-transaction.v1' as const;
export const microsoftStoreCommerceEvidenceSchema = 'mpgd.microsoft-store.digital-goods.v1' as const;
export const appsInTossCommerceEvidenceSchema = 'apps-in-toss.iap.callback.v1' as const;
export const devvitPaymentOrderEvidenceSchema = 'devvit.payment-order.v1' as const;
export const devvitOrderEvidenceSchema = 'devvit.order.v1' as const;
export const verse8Agent8EventEvidenceSchema = 'verse8.agent8-event.v1' as const;

/**
 * `google-play.product-purchase.v2`: the Play boundary verifies the purchase
 * token and, after the ledger grant, acknowledges or consumes it
 * (`finish: 'server'`). Pass `createGooglePlayProductPurchaseBoundary(...)`,
 * or a verifier binding plus a separate finalizer.
 */
export function createGooglePlayCommerceEvidenceEntry(input: {
  readonly verifier: Pick<GameServicesEvidenceVerifier, 'verifyPurchase'>;
  /** Required for `finish: 'server'` (the default). */
  readonly finalizer?: GameServicesPurchaseGrantFinalizer;
  /** Route a token-less request to the verifier too; the Play boundary rejects one itself. */
  readonly acceptsMissingEvidence?: boolean;
  /** Route any schema of the store to the verifier (a binding that keeps its own list). */
  readonly acceptsUnclaimedSchemas?: boolean;
  /** Who finishes; `client` only for a verifier that acknowledges the purchase itself. */
  readonly finish?: Extract<CommerceFinishOwner, 'server' | 'client'>;
  readonly targets?: readonly string[];
}): CommerceEvidenceRegistryEntry {
  const finish = input.finish ?? 'server';
  return {
    schema: googlePlayCommerceEvidenceSchema,
    store: googlePlayCommerceStoreId,
    verifier: input.verifier,
    ...(finish === 'server' ? { finalizer: input.finalizer } : {}),
    finish,
    creditScope: 'title',
    ...optionalRouting(input),
    targets: input.targets ?? referenceCommerceLedgerTargets['google-play'],
    purchase: referenceCommercePurchaseCapabilities['google-play'],
  };
}

function optionalRouting(input: {
  readonly acceptsMissingEvidence?: boolean;
  readonly acceptsUnclaimedSchemas?: boolean;
}): Pick<CommerceEvidenceRegistryEntry, 'acceptsMissingEvidence' | 'acceptsUnclaimedSchemas'> {
  return {
    ...(input.acceptsMissingEvidence === undefined
      ? {}
      : { acceptsMissingEvidence: input.acceptsMissingEvidence }),
    ...(input.acceptsUnclaimedSchemas === undefined
      ? {}
      : { acceptsUnclaimedSchemas: input.acceptsUnclaimedSchemas }),
  };
}

/**
 * `app-store.signed-transaction.v1`: the App Store verifier checks the
 * StoreKit JWS offline and decides on the Server API status; a request
 * without the envelope keeps the `Get Transaction Info` lookup, so the entry
 * accepts a missing envelope. The client finishes after the ledger grant.
 */
export function createAppStoreCommerceEvidenceEntry(input: {
  readonly verifier: Pick<GameServicesEvidenceVerifier, 'verifyPurchase'>;
  /** Defaults to true: a request without the JWS keeps the Server API lookup. */
  readonly acceptsMissingEvidence?: boolean;
  readonly acceptsUnclaimedSchemas?: boolean;
  readonly targets?: readonly string[];
}): CommerceEvidenceRegistryEntry {
  return {
    schema: appStoreCommerceEvidenceSchema,
    store: appStoreCommerceStoreId,
    verifier: input.verifier,
    finish: 'client',
    creditScope: 'title',
    ...optionalRouting(input),
    acceptsMissingEvidence: input.acceptsMissingEvidence ?? true,
    targets: input.targets ?? referenceCommerceLedgerTargets['app-store'],
    purchase: referenceCommercePurchaseCapabilities['app-store'],
  };
}

/**
 * `mpgd.microsoft-store.digital-goods.v1`: the Collections verifier before
 * the grant and the consume finalizer after it (`finish: 'server'`), always
 * configured together.
 */
export function createMicrosoftStoreCommerceEvidenceEntry(input: {
  readonly verifier: Pick<GameServicesEvidenceVerifier, 'verifyPurchase'>;
  readonly finalizer: GameServicesPurchaseGrantFinalizer;
  readonly acceptsMissingEvidence?: boolean;
  readonly acceptsUnclaimedSchemas?: boolean;
  readonly targets?: readonly string[];
}): CommerceEvidenceRegistryEntry {
  return {
    schema: microsoftStoreCommerceEvidenceSchema,
    store: microsoftStoreCommerceStoreId,
    verifier: input.verifier,
    finalizer: input.finalizer,
    finish: 'server',
    ...optionalRouting(input),
    targets: input.targets ?? referenceCommerceLedgerTargets['microsoft-store'],
    purchase: referenceCommercePurchaseCapabilities['microsoft-store'],
  };
}

/**
 * `apps-in-toss.iap.callback.v1`: the production evidence verifier binds the
 * order through the partner API; the host finishes (`completeProductGrant`)
 * after the ledger grant.
 */
export function createAppsInTossCommerceEvidenceEntry(input: {
  readonly verifier: Pick<GameServicesEvidenceVerifier, 'verifyPurchase'>;
  readonly acceptsMissingEvidence?: boolean;
  readonly acceptsUnclaimedSchemas?: boolean;
  readonly targets?: readonly string[];
}): CommerceEvidenceRegistryEntry {
  return {
    schema: appsInTossCommerceEvidenceSchema,
    store: appsInTossCommerceStoreId,
    verifier: input.verifier,
    finish: 'host',
    ...optionalRouting(input),
    targets: input.targets ?? referenceCommerceLedgerTargets['apps-in-toss'],
    purchase: referenceCommercePurchaseCapabilities['apps-in-toss'],
  };
}

// Server-push stores: the host's fulfillment path writes the grant; the
// client's envelope only names the purchase.

export interface DevvitPaymentOrderAuthorityInput {
  readonly orderId: string;
  readonly playerId: string;
  readonly platformSku: string;
  readonly signal: AbortSignal;
}

/** A Reddit order as the deployment's payments authority reports it. */
export interface DevvitPaymentOrderRecord {
  readonly orderId: string;
  /** The purchasing Reddit account as the payments authority knows it. */
  readonly playerId: string;
  readonly sku: string;
  readonly status: 'PAID' | 'DELIVERED' | 'REVERTED' | string;
  /** ISO timestamp of the status change. */
  readonly occurredAt?: string;
}

export type DevvitPaymentOrderAuthorityResult =
  | { readonly decision: 'resolved'; readonly order: DevvitPaymentOrderRecord }
  | { readonly decision: 'pending'; readonly reason?: string }
  | { readonly decision: 'rejected'; readonly reason: string };

/**
 * Game-owned port the `devvit.payment-order.v1` verifier binds an order
 * through: the Devvit `payments` plugin's order read on the Devvit server, or
 * the fulfillment handler's own order when the backend runs in that process.
 * It is the authority; the envelope only names the order.
 */
export interface DevvitPaymentOrderAuthority {
  getOrder(input: DevvitPaymentOrderAuthorityInput): Promise<DevvitPaymentOrderAuthorityResult>;
}

/**
 * The `devvit.payment-order.v1` verifier: the envelope
 * `normalizeDevvitFulfillmentOrder` produced names the order, and the grant
 * is decided by the deployment's payments authority (`PAID` or `DELIVERED`
 * for the requesting player and SKU). Replay identity is the order id, so a
 * second fulfillment of one order meets the first grant.
 */
export function createDevvitPaymentOrderEvidenceVerifier(input: {
  readonly authority: DevvitPaymentOrderAuthority;
  readonly now?: () => string;
}): Pick<GameServicesEvidenceVerifier, 'verifyPurchase'> {
  const now = input.now ?? (() => new Date().toISOString());
  return {
    async verifyPurchase({ request, platformProductId, signal }) {
      const envelope = request.evidence;
      if (envelope?.schema !== devvitPaymentOrderEvidenceSchema) {
        return { status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' };
      }
      const orderId = readBoundedIdentifier(envelope.payload.orderId);
      if (orderId === undefined || orderId !== request.platformTransactionId) {
        return { status: 'rejected', reason: 'DEVVIT_ORDER_ID_MISMATCH' };
      }
      if (envelope.payload.status !== 'PAID') {
        return { status: 'rejected', reason: 'DEVVIT_ORDER_NOT_PAID' };
      }
      let result: DevvitPaymentOrderAuthorityResult;
      try {
        result = await input.authority.getOrder({
          orderId,
          playerId: request.playerId,
          platformSku: platformProductId,
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        return { status: 'pending', reason: 'DEVVIT_ORDER_AUTHORITY_UNAVAILABLE' };
      }
      if (result.decision === 'pending') {
        return { status: 'pending', ...(result.reason === undefined ? {} : { reason: result.reason }) };
      }
      if (result.decision === 'rejected') {
        return { status: 'rejected', reason: result.reason };
      }
      const order = result.order;
      if (order.orderId !== orderId) {
        return { status: 'rejected', reason: 'DEVVIT_ORDER_ID_MISMATCH' };
      }
      if (order.playerId !== request.playerId) {
        return { status: 'rejected', reason: 'DEVVIT_ORDER_PLAYER_MISMATCH' };
      }
      if (order.sku !== platformProductId) {
        return { status: 'rejected', reason: 'DEVVIT_ORDER_SKU_MISMATCH' };
      }
      if (order.status === 'REVERTED') {
        return { status: 'rejected', reason: 'DEVVIT_ORDER_REVERTED' };
      }
      if (order.status !== 'PAID' && order.status !== 'DELIVERED') {
        return { status: 'pending', reason: 'DEVVIT_ORDER_NOT_PAID' };
      }
      return {
        status: 'verified',
        verificationId: `devvit:payment-order:${orderId}`,
        verifiedAt: now(),
        platformEvidenceId: orderId,
        payload: {
          devvitOrderId: orderId,
          devvitOrderStatus: order.status,
          ...(order.occurredAt === undefined ? {} : { devvitOrderOccurredAt: order.occurredAt }),
        },
      };
    },
  };
}

/** `devvit.payment-order.v1`: the fulfillment handler's own record, bound through the payments authority. */
export function createDevvitPaymentOrderCommerceEvidenceEntry(input: {
  readonly authority: DevvitPaymentOrderAuthority;
  readonly now?: () => string;
  readonly targets?: readonly string[];
}): CommerceEvidenceRegistryEntry {
  return {
    schema: devvitPaymentOrderEvidenceSchema,
    store: devvitCommerceStoreId,
    verifier: createDevvitPaymentOrderEvidenceVerifier(input),
    finish: 'none',
    targets: input.targets ?? referenceCommerceLedgerTargets.devvit,
    purchase: referenceCommercePurchaseCapabilities.devvit,
  };
}

export interface CreateCommerceLedgerLookupVerifierInput {
  readonly schema: string;
  readonly store: StoreId;
  /** The ledger the host's fulfillment path writes. */
  readonly ledger: GameServicesStore;
  /** The store transaction id the envelope names; `undefined` rejects the envelope. */
  readonly readTransactionId: (payload: EntitlementLedgerPayload) => string | undefined;
  /** The store SKU the envelope names, compared with the catalog's platform product id when present. */
  readonly readStoreSku?: (payload: EntitlementLedgerPayload) => string | undefined;
  /** The ledger target the fulfillment path wrote the grant under; defaults to the request's target. */
  readonly ledgerTarget?: string;
}

/**
 * A server-push lookup verifier (RFC "Evidence registry"): it never grants
 * from the client envelope. It answers `settled` with the ledger entry the
 * host's fulfillment path already wrote for the same store and transaction
 * id, when that entry belongs to the requesting player and product and is
 * not reversed; `pending` while no such entry exists; and `rejected` when the
 * envelope names another transaction or product than the request, or the
 * entry belongs to someone else.
 */
export function createCommerceLedgerLookupVerifier(
  input: CreateCommerceLedgerLookupVerifierInput,
): Pick<GameServicesEvidenceVerifier, 'verifyPurchase'> {
  return {
    async verifyPurchase({ request, platformProductId }) {
      const envelope = request.evidence;
      if (envelope?.schema !== input.schema) {
        return { status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' };
      }
      const transactionId = input.readTransactionId(envelope.payload);
      if (transactionId === undefined) {
        return { status: 'rejected', reason: 'EVIDENCE_PAYLOAD_INVALID' };
      }
      if (transactionId !== request.platformTransactionId) {
        return { status: 'rejected', reason: 'PLATFORM_TRANSACTION_ID_MISMATCH' };
      }
      const storeSku = input.readStoreSku?.(envelope.payload);
      if (storeSku !== undefined && storeSku !== platformProductId) {
        return { status: 'rejected', reason: 'PLATFORM_PRODUCT_MISMATCH' };
      }
      const grant = await findPurchaseGrantByPlatformEvidence(input.ledger, {
        target: input.ledgerTarget ?? request.target,
        platformEvidenceId: transactionId,
      });
      if (grant === undefined) {
        return { status: 'pending', reason: 'LEDGER_GRANT_PENDING' };
      }
      if (grant.playerId !== request.playerId) {
        return { status: 'rejected', reason: 'LEDGER_GRANT_PLAYER_MISMATCH' };
      }
      if (grant.grantId !== request.productId) {
        return { status: 'rejected', reason: 'LEDGER_GRANT_PRODUCT_MISMATCH' };
      }
      const grantStore = grant.payload.store;
      if (typeof grantStore === 'string' && grantStore.length > 0 && grantStore !== input.store) {
        return { status: 'rejected', reason: 'EVIDENCE_SCHEMA_STORE_MISMATCH' };
      }
      if (input.ledger.findEntitlementRevocations !== undefined) {
        const revocations = await input.ledger.findEntitlementRevocations({
          ledgerEntryIds: [grant.ledgerEntryId],
        });
        if (revocations.length > 0) {
          return { status: 'rejected', reason: 'LEDGER_GRANT_REVERSED' };
        }
      }
      return {
        status: 'settled',
        ledgerEntryId: grant.ledgerEntryId,
        ...(input.ledgerTarget === undefined ? {} : { ledgerTarget: input.ledgerTarget }),
      };
    },
  };
}

/** The purchase grant written under a ledger target and store transaction id, through the store's index or a list scan. */
export async function findPurchaseGrantByPlatformEvidence(
  ledger: GameServicesStore,
  identity: { readonly target: string; readonly platformEvidenceId: string },
): Promise<ProductGrantTransaction | undefined> {
  if (ledger.findEntitlementTransactionByPlatformEvidence !== undefined) {
    return ledger.findEntitlementTransactionByPlatformEvidence({
      source: 'purchase',
      target: identity.target,
      platformEvidenceId: identity.platformEvidenceId,
    });
  }
  const transactions = await ledger.listEntitlementTransactions();
  return transactions.find(
    (transaction) =>
      transaction.source === 'purchase'
      && transaction.payload.target === identity.target
      && transaction.payload.platformTransactionId === identity.platformEvidenceId,
  );
}

/**
 * `devvit.order.v1`: the client's order envelope (a checkout result or the
 * paid-order list) looked up against the ledger the fulfillment handler
 * wrote under target `reddit` (`createPlatformOrderLedgerGrant`).
 */
export function createDevvitOrderLookupCommerceEvidenceEntry(input: {
  readonly ledger: GameServicesStore;
  /** Defaults to the request target, which `targets` pins to `reddit`. */
  readonly ledgerTarget?: string;
  readonly targets?: readonly string[];
}): CommerceEvidenceRegistryEntry {
  return {
    schema: devvitOrderEvidenceSchema,
    store: devvitCommerceStoreId,
    verifier: createCommerceLedgerLookupVerifier({
      schema: devvitOrderEvidenceSchema,
      store: devvitCommerceStoreId,
      ledger: input.ledger,
      readTransactionId: (payload) => readBoundedIdentifier(payload.orderId),
      readStoreSku: (payload) => readBoundedIdentifier(payload.sku),
      ...(input.ledgerTarget === undefined ? {} : { ledgerTarget: input.ledgerTarget }),
    }),
    finish: 'none',
    targets: input.targets ?? referenceCommerceLedgerTargets.devvit,
    purchase: referenceCommercePurchaseCapabilities.devvit,
  };
}

/**
 * `verse8.agent8-event.v1`: the client's Agent8 purchase envelope looked up
 * against the ledger the `$onItemPurchased` event wrote under target `verse8`
 * (`createServerPushLedgerGrant`; the Agent8 commerce service writes it when
 * given a ledger).
 */
export function createVerse8Agent8EventLookupCommerceEvidenceEntry(input: {
  readonly ledger: GameServicesStore;
  readonly ledgerTarget?: string;
  readonly targets?: readonly string[];
}): CommerceEvidenceRegistryEntry {
  return {
    schema: verse8Agent8EventEvidenceSchema,
    store: verse8CommerceStoreId,
    verifier: createCommerceLedgerLookupVerifier({
      schema: verse8Agent8EventEvidenceSchema,
      store: verse8CommerceStoreId,
      ledger: input.ledger,
      readTransactionId: (payload) => readBoundedIdentifier(payload.purchaseId),
      readStoreSku: (payload) => readBoundedIdentifier(payload.productId),
      ...(input.ledgerTarget === undefined ? {} : { ledgerTarget: input.ledgerTarget }),
    }),
    finish: 'none',
    targets: input.targets ?? referenceCommerceLedgerTargets.verse8,
    purchase: referenceCommercePurchaseCapabilities.verse8,
  };
}

export interface CreateServerPushLedgerGrantInput {
  readonly store: StoreId;
  /** The ledger target the lookup verifier reads under (`reddit`, `verse8`). */
  readonly target: string;
  readonly deploymentTarget?: string;
  readonly playerId: string;
  readonly product: ProductCatalog['products'][number];
  readonly platformProductId: string;
  /** The store transaction id (a Reddit order id, an Agent8 purchase id). */
  readonly transactionId: string;
  /** Units bought in one transaction; a currency or resource grant is scaled by it. Default 1. */
  readonly quantity?: number;
  readonly purchasedAt: string;
  readonly grantedAt: string;
  /** The host's own evidence (`devvit.payment-order.v1`, `verse8.agent8-event.v1`). */
  readonly evidence: PlatformEvidenceEnvelope;
  /** Defaults to the reconciler's derived key `store:<store>:<transactionId>`. */
  readonly idempotencyKey?: string;
  /** Defaults to `<store>:<schema>:<transactionId>`. */
  readonly evidenceVerificationId?: string;
}

/**
 * The ledger grant a host's fulfillment path writes for a server-push
 * purchase, in the shape the lookup verifiers read: `payload.target`,
 * `payload.store`, and `payload.platformTransactionId` identify it, and the
 * platform-evidence unique index keeps a second write of the same transaction
 * out. Write it with `GameServicesStore.recordEntitlementGrant`.
 */
export function createServerPushLedgerGrant(
  input: CreateServerPushLedgerGrantInput,
): EntitlementLedgerGrant {
  assertCommerceStoreId(input.store, 'store');
  const transactionId = readBoundedIdentifier(input.transactionId);
  if (transactionId === undefined) {
    throw new TypeError('A server-push ledger grant needs a bounded transaction id.');
  }
  const evidenceVerificationId = input.evidenceVerificationId
    ?? `${input.store}:${input.evidence.schema}:${transactionId}`;
  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new TypeError('A server-push ledger grant quantity must be a positive integer.');
  }
  const grant = input.product.grant;
  const scaledGrant = quantity === 1 || grant.type === 'entitlement'
    ? grant
    : { ...grant, amount: grant.amount * quantity };
  return {
    playerId: input.playerId,
    grantId: input.product.id,
    source: 'purchase',
    idempotencyKey: input.idempotencyKey
      ?? `store:${encodeURIComponent(input.store)}:${encodeURIComponent(transactionId)}`,
    grantedAt: input.grantedAt,
    grant: scaledGrant,
    evidenceVerificationId,
    payload: {
      target: input.target,
      store: input.store,
      ...(input.deploymentTarget === undefined ? {} : { deploymentTarget: input.deploymentTarget }),
      productId: input.product.id,
      productType: input.product.type,
      platformProductId: input.platformProductId,
      platformTransactionId: transactionId,
      quantity,
      purchasedAt: input.purchasedAt,
      evidenceSchema: input.evidence.schema,
      evidenceVerificationId,
      evidenceVerifiedAt: input.grantedAt,
    },
  };
}

// Client side: the runtime compares the backend's answer with its provider.

export type CommerceServiceAlignment =
  | { readonly status: 'aligned'; readonly store: StoreId }
  | {
      readonly status: 'configuration-required';
      readonly store: StoreId;
      readonly reason:
        | 'STORE_NOT_ACCEPTED'
        | 'FINISH_OWNER_MISMATCH'
        | 'PROTOCOL_VERSION_MISMATCH';
      readonly message: string;
    };

/**
 * Compares a provider's capability block with the backend's published
 * capabilities (RFC "Provider capabilities endpoint"): a store the backend
 * does not accept, a finish owner that disagrees, or another protocol major
 * version sets the provider's availability to `configuration-required`
 * before any purchase UI opens. The reconciler applies it at start.
 */
export function compareCommerceServiceCapabilities(input: {
  readonly store: StoreId;
  readonly provider: Pick<CommerceCapabilities, 'lifecycle'>;
  readonly service: CommerceServiceCapabilities;
}): CommerceServiceAlignment {
  const { store } = input;
  if (majorVersionOf(input.service.commerceProtocolVersion) !== majorVersionOf(commerceProtocolVersion)) {
    return {
      status: 'configuration-required',
      store,
      reason: 'PROTOCOL_VERSION_MISMATCH',
      message: `The backend speaks commerce protocol ${input.service.commerceProtocolVersion}; this client speaks ${commerceProtocolVersion}.`,
    };
  }
  const accepted = input.service.stores.find((candidate) => candidate.store === store);
  if (accepted === undefined) {
    return {
      status: 'configuration-required',
      store,
      reason: 'STORE_NOT_ACCEPTED',
      message: `The backend accepts no evidence for store ${store}.`,
    };
  }
  if (accepted.finish !== input.provider.lifecycle.finish) {
    return {
      status: 'configuration-required',
      store,
      reason: 'FINISH_OWNER_MISMATCH',
      message: `The backend expects ${accepted.finish} to finish ${store} purchases; the provider declares ${input.provider.lifecycle.finish}.`,
    };
  }
  return { status: 'aligned', store };
}

function majorVersionOf(version: string): string {
  return version.split('.')[0] ?? version;
}

function readBoundedIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    return undefined;
  }
  return value;
}
