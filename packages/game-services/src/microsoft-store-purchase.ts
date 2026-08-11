import type {
  FinalizePurchaseGrantInput,
  GameServicesEvidenceVerifier,
  GameServicesPurchaseGrantFinalizer,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification';
import type { EntitlementLedgerPayload, PurchaseGrantFinalization } from './types';

export const microsoftStoreDigitalGoodsEvidenceSchema =
  'mpgd.microsoft-store.digital-goods.v1' as const;
export const microsoftStoreCollectionsQueryUrl =
  'https://collections.mp.microsoft.com/v9.0/collections/publisherQuery' as const;
export const microsoftStoreCollectionsConsumeUrl =
  'https://collections.mp.microsoft.com/v8.0/collections/consume' as const;

export interface MicrosoftStoreCollectionsCredentials {
  /** Runtime-generated Microsoft Entra service access token. */
  readonly accessToken: string;
  /** Server-resolved User Store ID. Never accept this value from purchase evidence. */
  readonly userStoreId: string;
  /**
   * Stable opaque ID for the trusted player-to-Store-account link. It must survive User Store ID
   * renewal, resolve to the same value whenever the same Store account appears, and change only
   * when the player links a different Store account. Never use the User Store ID, a player-pair
   * identifier, or another renewable credential as this value.
   */
  readonly accountBindingId: string;
  /** Omit for RETAIL. Non-RETAIL developer-managed consume requires delegated XSTS. */
  readonly sandbox?: string;
}

export interface MicrosoftStoreCollectionsClient {
  queryProduct(input: {
    readonly credentials: MicrosoftStoreCollectionsCredentials;
    readonly storeId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  consumeProduct(input: {
    readonly credentials: MicrosoftStoreCollectionsCredentials;
    readonly storeId: string;
    readonly trackingId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface MicrosoftStoreFetchResponse {
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export type MicrosoftStoreFetch = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<MicrosoftStoreFetchResponse>;

export interface CreateMicrosoftStoreCollectionsClientInput {
  readonly fetch?: MicrosoftStoreFetch;
  readonly userAgent?: string;
  readonly maxResponseBytes?: number;
}

export interface CreateMicrosoftStorePurchaseBoundaryInput {
  readonly client: MicrosoftStoreCollectionsClient;
  /** Trusted logical-product to current Digital Goods Product ID mapping. */
  readonly inAppOfferTokens: Readonly<Record<string, string>>;
  readonly storeIds: Readonly<Record<string, string>>;
  /** Keep old Digital Goods token/Collections ID pairs until pending purchases are settled. */
  readonly historicalProductMappings?: Readonly<Record<
    string,
    readonly MicrosoftStoreHistoricalProductMapping[]
  >>;
  readonly resolveCredentials: (
    playerId: string,
    signal: AbortSignal,
  ) => Promise<MicrosoftStoreCollectionsCredentials> | MicrosoftStoreCollectionsCredentials;
  /**
   * Durable, atomic ownership registry. Browser storage is never an authorization source.
   * Production implementations must share this state across every game-service instance.
   */
  readonly recoveryOwnershipStore: MicrosoftStoreRecoveryOwnershipStore;
  readonly now?: () => string;
}

export interface MicrosoftStoreHistoricalProductMapping {
  readonly inAppOfferToken: string;
  readonly storeId: string;
}

export interface MicrosoftStoreRecoveryOwnershipInput {
  readonly playerId: string;
  readonly productId: string;
  readonly inAppOfferToken: string;
  readonly purchaseToken: string;
  /** Stable checkout identity used as an opaque ownership generation. */
  readonly idempotencyKey?: string;
  readonly evidence: {
    readonly schema: string;
    readonly payload: Readonly<Record<string, unknown>>;
  };
  readonly signal: AbortSignal;
}

export interface MicrosoftStoreRecoveryOwnershipRecord {
  readonly accountBindingHash: string;
  readonly storeId: string;
  readonly playerId: string;
  readonly generation: string;
  /** Stable identity derived from the exact Collections item being granted. */
  readonly providerPurchaseId: string;
}

export type MicrosoftStoreRecoveryOwnershipLookup =
  & Omit<MicrosoftStoreRecoveryOwnershipRecord, 'generation' | 'providerPurchaseId'>
  & {
    readonly generation?: string;
    readonly providerPurchaseId?: string;
  };

export type MicrosoftStoreRecoveryOwnershipResult =
  | { readonly status: 'granted'; readonly idempotencyKey: string }
  | { readonly status: 'denied' }
  | { readonly status: 'unavailable' };

export interface MicrosoftStoreRecoveryOwnershipStore {
  /**
   * Atomically claims an unconsumed Store product for one authenticated game player. An
   * existing claim for the same provider purchase remains unchanged so a retry cannot replace
   * its generation. A different provider purchase may atomically replace the same player's
   * consumed purchase claim. Return the effective record, or undefined when another player owns
   * the Store product binding.
   */
  claim(input: MicrosoftStoreRecoveryOwnershipRecord):
    Promise<MicrosoftStoreRecoveryOwnershipRecord | undefined>;
  get(input: MicrosoftStoreRecoveryOwnershipLookup):
    Promise<MicrosoftStoreRecoveryOwnershipRecord | undefined>;
  /** Atomically releases only the exact player, generation, and provider purchase supplied. */
  release(input: MicrosoftStoreRecoveryOwnershipRecord): Promise<void>;
}

export interface MicrosoftStorePurchaseBoundary extends GameServicesPurchaseGrantFinalizer {
  claimRecoveryOwnership(
    input: MicrosoftStoreRecoveryOwnershipInput,
  ): Promise<MicrosoftStoreRecoveryOwnershipResult>;
  hasRecoveryOwnership(
    input: MicrosoftStoreRecoveryOwnershipInput,
  ): Promise<MicrosoftStoreRecoveryOwnershipResult>;
  verifyPurchase(
    input: VerifyPurchaseEvidenceInput,
  ): ReturnType<GameServicesEvidenceVerifier['verifyPurchase']>;
}

/** Process-local test/development store. Production requires durable atomic shared storage. */
export class InMemoryMicrosoftStoreRecoveryOwnershipStore
  implements MicrosoftStoreRecoveryOwnershipStore {
  private readonly owners = new Map<string, MicrosoftStoreRecoveryOwnershipRecord>();

  async claim(
    input: MicrosoftStoreRecoveryOwnershipRecord,
  ): Promise<MicrosoftStoreRecoveryOwnershipRecord | undefined> {
    const key = createRecoveryOwnershipKey(input);
    const owner = this.owners.get(key);
    if (owner !== undefined && owner.playerId !== input.playerId) {
      return undefined;
    }
    if (owner === undefined || owner.providerPurchaseId !== input.providerPurchaseId) {
      this.owners.set(key, Object.freeze({ ...input }));
      return Object.freeze({ ...input });
    }
    return Object.freeze({ ...owner });
  }

  async get(
    input: MicrosoftStoreRecoveryOwnershipLookup,
  ): Promise<MicrosoftStoreRecoveryOwnershipRecord | undefined> {
    const owner = this.owners.get(createRecoveryOwnershipKey(input));
    return owner === undefined ? undefined : Object.freeze({ ...owner });
  }

  async release(input: MicrosoftStoreRecoveryOwnershipRecord): Promise<void> {
    const key = createRecoveryOwnershipKey(input);
    const owner = this.owners.get(key);
    if (
      owner?.playerId === input.playerId
      && owner.generation === input.generation
      && owner.providerPurchaseId === input.providerPurchaseId
    ) {
      this.owners.delete(key);
    }
  }
}

export function createInMemoryMicrosoftStoreRecoveryOwnershipStore():
  MicrosoftStoreRecoveryOwnershipStore {
  return new InMemoryMicrosoftStoreRecoveryOwnershipStore();
}

export class MicrosoftStoreCollectionsUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MicrosoftStoreCollectionsUnavailableError';
    this.cause = cause;
  }
}

export function createMicrosoftStoreCollectionsClient(
  input: CreateMicrosoftStoreCollectionsClientInput = {},
): MicrosoftStoreCollectionsClient {
  const fetch = input.fetch ?? readGlobalFetch();
  const maxResponseBytes = positiveSafeInteger(
    input.maxResponseBytes ?? 128 * 1024,
    'maxResponseBytes',
  );
  const userAgent = optionalHeaderValue(input.userAgent);

  async function post(
    url: string,
    credentials: MicrosoftStoreCollectionsCredentials,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    assertCredentials(credentials);
    const accessToken = credentials.accessToken;
    let response: MicrosoftStoreFetchResponse;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          ...(userAgent === undefined ? {} : { 'user-agent': userAgent }),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new MicrosoftStoreCollectionsUnavailableError(
        'Microsoft Store Collections transport is unavailable.',
        error,
      );
    }

    if (response.status !== 200) {
      await cancelBody(response.body);
      throw new MicrosoftStoreCollectionsUnavailableError(
        `Microsoft Store Collections returned HTTP ${String(response.status)}.`,
      );
    }

    return readBoundedJson(response.body, maxResponseBytes, signal);
  }

  return {
    queryProduct({ credentials, storeId, signal }) {
      const normalizedStoreId = identifier(storeId, 'storeId');
      return post(
        microsoftStoreCollectionsQueryUrl,
        credentials,
        {
          beneficiaries: [beneficiary(credentials.userStoreId)],
          productSkuIds: [{ productId: normalizedStoreId }],
          excludeDuplicates: true,
          validityType: 'Valid',
          maxPageSize: 10,
          ...(credentials.sandbox === undefined ? {} : { sbx: credentials.sandbox }),
        },
        signal,
      );
    },
    consumeProduct({ credentials, storeId, trackingId, signal }) {
      return post(
        microsoftStoreCollectionsConsumeUrl,
        credentials,
        {
          beneficiary: beneficiary(credentials.userStoreId),
          // Developer-managed v8 consume has no skuId or removeQuantity. Those fields are
          // unsupported here or apply only to Store-managed consumables.
          productId: identifier(storeId, 'storeId'),
          trackingId: guid(trackingId, 'trackingId'),
          includeOrderIds: true,
          ...(credentials.sandbox === undefined ? {} : { sbx: credentials.sandbox }),
        },
        signal,
      );
    },
  };
}

export function createMicrosoftStorePurchaseBoundary(
  input: CreateMicrosoftStorePurchaseBoundaryInput,
): MicrosoftStorePurchaseBoundary {
  const storeIds = normalizeStoreIds(input.storeIds);
  const inAppOfferTokens = normalizeInAppOfferTokens(input.inAppOfferTokens, storeIds);
  const historicalProductMappings = normalizeHistoricalProductMappings(
    input.historicalProductMappings ?? {},
    storeIds,
    inAppOfferTokens,
  );
  const now = input.now ?? (() => new Date().toISOString());
  const inFlightFinalizations = new Map<string, Promise<PurchaseGrantFinalization>>();

  async function resolveRecoveryOwnership(
    ownershipInput: MicrosoftStoreRecoveryOwnershipInput,
  ): Promise<
    | {
        readonly status: 'granted';
        readonly record: Omit<MicrosoftStoreRecoveryOwnershipRecord, 'generation'>;
        readonly requestedGeneration?: string;
      }
    | { readonly status: 'denied' }
    | { readonly status: 'unavailable' }
  > {
    const playerId = optionalIdentifier(ownershipInput.playerId);
    const productId = optionalIdentifier(ownershipInput.productId);
    const generation = optionalIdentifier(ownershipInput.idempotencyKey);
    const clientEvidence = readRecoveryOwnershipEvidence(ownershipInput);
    if (
      playerId === undefined
      || productId === undefined
      || clientEvidence === undefined
    ) {
      return { status: 'denied' };
    }
    const currentInAppOfferToken = inAppOfferTokens.get(productId);
    if (
      currentInAppOfferToken === undefined
      || ownershipInput.inAppOfferToken !== currentInAppOfferToken
    ) {
      return { status: 'denied' };
    }
    const storeId = resolveMappedStoreId(
      productId,
      currentInAppOfferToken,
      clientEvidence.itemId,
      storeIds,
      historicalProductMappings,
    );
    if (storeId === undefined) {
      return { status: 'denied' };
    }

    let credentials: MicrosoftStoreCollectionsCredentials;
    try {
      credentials = await input.resolveCredentials(playerId, ownershipInput.signal);
      assertCredentials(credentials);
    } catch (error) {
      if (ownershipInput.signal.aborted) {
        throw error;
      }
      return { status: 'unavailable' };
    }
    if (credentials.sandbox !== undefined && credentials.sandbox !== 'RETAIL') {
      return { status: 'denied' };
    }

    let accountBindingHash: string;
    try {
      accountBindingHash = await createAccountBindingHash(credentials.accountBindingId);
    } catch {
      return { status: 'unavailable' };
    }

    let response: unknown;
    try {
      response = await input.client.queryProduct({
        credentials,
        storeId,
        signal: ownershipInput.signal,
      });
    } catch (error) {
      if (ownershipInput.signal.aborted) {
        throw error;
      }
      return { status: 'unavailable' };
    }
    const item = inspectPublisherQuery(response, storeId);
    if (item.status === 'pending') {
      return { status: 'unavailable' };
    }
    if (item.status === 'rejected') {
      return { status: 'denied' };
    }

    return {
      status: 'granted',
      record: {
        accountBindingHash,
        storeId,
        playerId,
        providerPurchaseId: createVerificationId(item.item),
      },
      ...(generation === undefined ? {} : { requestedGeneration: generation }),
    };
  }

  return {
    async claimRecoveryOwnership(ownershipInput) {
      const ownership = await resolveRecoveryOwnership(ownershipInput);
      if (ownership.status !== 'granted') {
        return ownership;
      }
      if (ownership.requestedGeneration === undefined) {
        return { status: 'denied' };
      }
      try {
        const effective = await input.recoveryOwnershipStore.claim({
          ...ownership.record,
          generation: ownership.requestedGeneration,
        });
        return effective?.playerId === ownership.record.playerId
          && effective.generation === ownership.requestedGeneration
          && effective.providerPurchaseId === ownership.record.providerPurchaseId
          ? { status: 'granted', idempotencyKey: effective.generation }
          : { status: 'denied' };
      } catch {
        return { status: 'unavailable' };
      }
    },

    async hasRecoveryOwnership(ownershipInput) {
      const ownership = await resolveRecoveryOwnership(ownershipInput);
      if (ownership.status !== 'granted') {
        return ownership;
      }
      try {
        const existing = await input.recoveryOwnershipStore.get(ownership.record);
        if (existing === undefined) {
          return { status: 'denied' };
        }
        if (existing.providerPurchaseId === ownership.record.providerPurchaseId) {
          return existing.playerId === ownership.record.playerId
            && (
              ownership.requestedGeneration === undefined
              || existing.generation === ownership.requestedGeneration
            )
            ? { status: 'granted', idempotencyKey: existing.generation }
            : { status: 'denied' };
        }
        if (ownership.requestedGeneration !== undefined) {
          return { status: 'denied' };
        }
        const effective = await input.recoveryOwnershipStore.claim({
          ...ownership.record,
          generation: ownership.record.providerPurchaseId,
        });
        return effective?.playerId === ownership.record.playerId
          && effective.providerPurchaseId === ownership.record.providerPurchaseId
          ? { status: 'granted', idempotencyKey: effective.generation }
          : { status: 'denied' };
      } catch {
        return { status: 'unavailable' };
      }
    },

    supportsPurchaseGrant(finalizationInput) {
      return finalizationInput.request.target === 'microsoft-store'
        && finalizationInput.product.type === 'consumable';
    },

    async verifyPurchase(verificationInput) {
      if (verificationInput.request.target !== 'microsoft-store') {
        return rejected('MICROSOFT_STORE_TARGET_REQUIRED');
      }
      if (verificationInput.product.type !== 'consumable') {
        return rejected('MICROSOFT_STORE_CONSUMABLE_REQUIRED');
      }

      const clientEvidence = readDigitalGoodsEvidence(verificationInput);
      if (clientEvidence === undefined) {
        return rejected('MICROSOFT_STORE_DIGITAL_GOODS_EVIDENCE_REQUIRED');
      }
      const currentStoreId = storeIds.get(verificationInput.product.id);
      if (currentStoreId === undefined) {
        return rejected('MICROSOFT_STORE_PRODUCT_MAPPING_REQUIRED');
      }
      const currentInAppOfferToken = inAppOfferTokens.get(verificationInput.product.id);
      if (
        currentInAppOfferToken === undefined
        || verificationInput.platformProductId !== currentInAppOfferToken
      ) {
        return rejected('MICROSOFT_STORE_PRODUCT_MAPPING_REQUIRED');
      }
      const storeId = resolveMappedStoreId(
        verificationInput.product.id,
        currentInAppOfferToken,
        clientEvidence.itemId,
        storeIds,
        historicalProductMappings,
      );
      if (storeId === undefined) {
        return rejected('MICROSOFT_STORE_DIGITAL_GOODS_EVIDENCE_REQUIRED');
      }

      let credentials: MicrosoftStoreCollectionsCredentials;
      try {
        credentials = await input.resolveCredentials(
          verificationInput.request.playerId,
          verificationInput.signal,
        );
      } catch (error) {
        if (verificationInput.signal.aborted) {
          throw error;
        }
        return pending('MICROSOFT_STORE_CREDENTIALS_UNAVAILABLE');
      }

      try {
        assertCredentials(credentials);
      } catch {
        return rejected('MICROSOFT_STORE_CREDENTIALS_INVALID');
      }
      if (credentials.sandbox !== undefined && credentials.sandbox !== 'RETAIL') {
        return pending('MICROSOFT_STORE_XSTS_REQUIRED_FOR_SANDBOX');
      }
      let accountBindingHash: string;
      try {
        accountBindingHash = await createAccountBindingHash(credentials.accountBindingId);
      } catch {
        return pending('MICROSOFT_STORE_ACCOUNT_BINDING_UNAVAILABLE');
      }
      let recoveryOwnership: MicrosoftStoreRecoveryOwnershipRecord | undefined;
      try {
        recoveryOwnership = await input.recoveryOwnershipStore.get({
          accountBindingHash,
          storeId,
          playerId: verificationInput.request.playerId,
          generation: verificationInput.request.idempotencyKey,
        });
      } catch {
        return pending('MICROSOFT_STORE_RECOVERY_OWNERSHIP_UNAVAILABLE');
      }
      if (
        recoveryOwnership === undefined
        || recoveryOwnership.playerId !== verificationInput.request.playerId
        || recoveryOwnership.generation !== verificationInput.request.idempotencyKey
      ) {
        return rejected('MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED');
      }

      let response: unknown;
      try {
        response = await input.client.queryProduct({
          credentials,
          storeId,
          signal: verificationInput.signal,
        });
      } catch (error) {
        if (verificationInput.signal.aborted) {
          throw error;
        }
        return pending('MICROSOFT_STORE_COLLECTIONS_UNAVAILABLE');
      }

      const item = inspectPublisherQuery(response, storeId);
      if (item.status !== 'verified') {
        return item;
      }

      const verifiedAt = now();
      if (!validIsoDate(verifiedAt)) {
        return pending('MICROSOFT_STORE_VERIFIER_CLOCK_INVALID');
      }
      const verificationId = createVerificationId(item.item);
      if (recoveryOwnership.providerPurchaseId !== verificationId) {
        return rejected('MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED');
      }

      return {
        status: 'verified',
        verificationId,
        verifiedAt,
        platformEvidenceId: null,
        payload: {
          microsoftStoreCollectionItemId: item.item.id,
          microsoftStoreModifiedDate: item.item.modifiedDate,
          microsoftStoreProductId: item.item.productId,
          microsoftStoreProductKind: item.item.productKind,
          microsoftStoreQuantity: item.item.quantity,
          microsoftStoreStatus: item.item.status,
          microsoftStoreAccountBindingHash: accountBindingHash,
          microsoftStoreRecoveryOwnershipGeneration: recoveryOwnership.generation,
          ...(item.item.transactionId === undefined
            ? {}
            : { microsoftStoreTransactionId: item.item.transactionId }),
          digitalGoodsItemId: clientEvidence.itemId,
        },
      };
    },

    async finalizePurchaseGrant(finalizationInput) {
      const context = readFinalizationContext(finalizationInput);
      if (context.status === 'pending') {
        return context.result;
      }

      const existing = inFlightFinalizations.get(finalizationInput.evidenceVerificationId);
      if (existing !== undefined) {
        return existing;
      }

      const finalization = consumeMicrosoftStorePurchase(input, finalizationInput, context);
      inFlightFinalizations.set(finalizationInput.evidenceVerificationId, finalization);
      try {
        return await finalization;
      } finally {
        if (inFlightFinalizations.get(finalizationInput.evidenceVerificationId) === finalization) {
          inFlightFinalizations.delete(finalizationInput.evidenceVerificationId);
        }
      }
    },
  };
}

async function consumeMicrosoftStorePurchase(
  input: CreateMicrosoftStorePurchaseBoundaryInput,
  finalizationInput: FinalizePurchaseGrantInput,
  context: MicrosoftStoreFinalizationContext,
): Promise<PurchaseGrantFinalization> {
  let credentials: MicrosoftStoreCollectionsCredentials;
  try {
    credentials = await input.resolveCredentials(
      finalizationInput.request.playerId,
      finalizationInput.signal,
    );
  } catch (error) {
    if (finalizationInput.signal.aborted) {
      throw error;
    }
    return finalizationPending('MICROSOFT_STORE_CREDENTIALS_UNAVAILABLE');
  }

  try {
    assertCredentials(credentials);
  } catch {
    return finalizationPending('MICROSOFT_STORE_CREDENTIALS_INVALID');
  }
  if (credentials.sandbox !== undefined && credentials.sandbox !== 'RETAIL') {
    return finalizationPending('MICROSOFT_STORE_XSTS_REQUIRED_FOR_SANDBOX');
  }
  let accountBindingHash: string;
  try {
    accountBindingHash = await createAccountBindingHash(credentials.accountBindingId);
  } catch {
    return finalizationPending('MICROSOFT_STORE_ACCOUNT_BINDING_UNAVAILABLE');
  }
  if (accountBindingHash !== context.accountBindingHash) {
    return finalizationPending('MICROSOFT_STORE_ACCOUNT_BINDING_CHANGED');
  }

  try {
    const trackingId = await deterministicTrackingId(finalizationInput.evidenceVerificationId);
    const raw = await input.client.consumeProduct({
      credentials,
      storeId: context.storeId,
      trackingId,
      signal: finalizationInput.signal,
    });

    if (!isRecord(raw)) {
      return finalizationPending('MICROSOFT_STORE_CONSUME_RESPONSE_INVALID');
    }
    if (
      raw.itemId !== context.collectionItemId
      || raw.trackingId !== trackingId
      || raw.newQuantity !== 0
    ) {
      return finalizationPending('MICROSOFT_STORE_CONSUME_RESPONSE_MISMATCH');
    }

    try {
      await input.recoveryOwnershipStore.release({
        accountBindingHash,
        storeId: context.storeId,
        playerId: finalizationInput.request.playerId,
        generation: context.recoveryOwnershipGeneration,
        providerPurchaseId: finalizationInput.evidenceVerificationId,
      });
    } catch {
      return finalizationPending('MICROSOFT_STORE_RECOVERY_OWNERSHIP_RELEASE_UNAVAILABLE');
    }

    return {
      status: 'completed',
      action: 'consume',
      alreadyCompleted: false,
    };
  } catch (error) {
    if (finalizationInput.signal.aborted) {
      throw error;
    }
    return finalizationPending('MICROSOFT_STORE_CONSUME_UNAVAILABLE');
  }
}

interface MicrosoftStoreCollectionItem {
  readonly id: string;
  readonly modifiedDate: string;
  readonly productId: string;
  readonly productKind: 'UnmanagedConsumable';
  readonly quantity: number;
  readonly status: 'Active';
  readonly transactionId?: string;
}

type MicrosoftStoreItemInspection =
  | { readonly status: 'verified'; readonly item: MicrosoftStoreCollectionItem }
  | { readonly status: 'pending'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string };

interface MicrosoftStoreFinalizationContext {
  readonly collectionItemId: string;
  readonly storeId: string;
  readonly accountBindingHash: string;
  readonly recoveryOwnershipGeneration: string;
}

function inspectPublisherQuery(
  raw: unknown,
  expectedStoreId: string,
): MicrosoftStoreItemInspection {
  if (!isRecord(raw)) {
    return rejected('MICROSOFT_STORE_COLLECTIONS_RESPONSE_INVALID');
  }

  // Collections v9 omits `items` when there are no matching entitlements. Treat that
  // provider-defined empty result like an empty list so a just-completed purchase can retry.
  if (raw.items === undefined) {
    return pending('MICROSOFT_STORE_PURCHASE_NOT_PROPAGATED');
  }
  if (!Array.isArray(raw.items)) {
    return rejected('MICROSOFT_STORE_COLLECTIONS_RESPONSE_INVALID');
  }

  const candidates = raw.items.filter((candidate): candidate is Record<string, unknown> => (
    isRecord(candidate) && candidate.productId === expectedStoreId
  ));
  if (candidates.length === 0) {
    return pending('MICROSOFT_STORE_PURCHASE_NOT_PROPAGATED');
  }

  const active = candidates.find((candidate) => candidate.status === 'Active');
  if (active === undefined) {
    return rejected('MICROSOFT_STORE_PURCHASE_NOT_ACTIVE');
  }
  if (active.productKind !== 'UnmanagedConsumable') {
    return rejected('MICROSOFT_STORE_PRODUCT_KIND_MISMATCH');
  }
  if (!Number.isSafeInteger(active.quantity) || Number(active.quantity) < 1) {
    return pending('MICROSOFT_STORE_PURCHASE_ALREADY_CONSUMED');
  }
  if (Number(active.quantity) !== 1) {
    return rejected('MICROSOFT_STORE_PURCHASE_QUANTITY_MISMATCH');
  }

  const id = optionalIdentifier(active.id);
  const modifiedDate = optionalIdentifier(active.modifiedDate);
  const transactionId = optionalIdentifier(active.transactionId);
  if (id === undefined || modifiedDate === undefined || !validIsoDate(modifiedDate)) {
    return rejected('MICROSOFT_STORE_COLLECTIONS_RESPONSE_INVALID');
  }

  return {
    status: 'verified',
    item: {
      id,
      modifiedDate,
      productId: expectedStoreId,
      productKind: 'UnmanagedConsumable',
      quantity: Number(active.quantity),
      status: 'Active',
      ...(transactionId === undefined ? {} : { transactionId }),
    },
  };
}

function readDigitalGoodsEvidence(input: VerifyPurchaseEvidenceInput): {
  readonly itemId: string;
} | undefined {
  const evidence = input.request.evidence;
  if (evidence?.schema !== microsoftStoreDigitalGoodsEvidenceSchema) {
    return undefined;
  }
  const itemId = optionalIdentifier(evidence.payload.itemId);
  const purchaseToken = optionalIdentifier(evidence.payload.purchaseToken);
  if (
    itemId === undefined
    || purchaseToken === undefined
    || itemId !== purchaseToken
    || input.request.platformTransactionId !== purchaseToken
  ) {
    return undefined;
  }
  return { itemId };
}

function readRecoveryOwnershipEvidence(input: MicrosoftStoreRecoveryOwnershipInput): {
  readonly itemId: string;
} | undefined {
  if (input.evidence.schema !== microsoftStoreDigitalGoodsEvidenceSchema) {
    return undefined;
  }
  const itemId = optionalIdentifier(input.evidence.payload.itemId);
  const purchaseToken = optionalIdentifier(input.evidence.payload.purchaseToken);
  if (
    itemId === undefined
    || purchaseToken === undefined
    || itemId !== purchaseToken
    || input.purchaseToken !== purchaseToken
  ) {
    return undefined;
  }
  return { itemId };
}

function resolveMappedStoreId(
  productId: string,
  currentInAppOfferToken: string,
  purchasedInAppOfferToken: string,
  storeIds: ReadonlyMap<string, string>,
  historicalProductMappings: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | undefined {
  const currentStoreId = storeIds.get(productId);
  if (currentStoreId === undefined) {
    return undefined;
  }
  return purchasedInAppOfferToken === currentInAppOfferToken
    ? currentStoreId
    : historicalProductMappings.get(productId)?.get(purchasedInAppOfferToken);
}

function createRecoveryOwnershipKey(input: {
  readonly accountBindingHash: string;
  readonly storeId: string;
}): string {
  return JSON.stringify([input.accountBindingHash, input.storeId]);
}

function readFinalizationContext(
  input: FinalizePurchaseGrantInput,
):
  | {
      readonly status: 'verified';
      readonly collectionItemId: string;
      readonly storeId: string;
      readonly accountBindingHash: string;
      readonly recoveryOwnershipGeneration: string;
    }
  | { readonly status: 'pending'; readonly result: PurchaseGrantFinalization } {
  if (input.request.target !== 'microsoft-store' || input.product.type !== 'consumable') {
    return { status: 'pending', result: finalizationPending('MICROSOFT_STORE_TARGET_REQUIRED') };
  }
  const payloadStoreId = optionalIdentifier(input.evidencePayload?.microsoftStoreProductId);
  const collectionItemId = optionalIdentifier(
    input.evidencePayload?.microsoftStoreCollectionItemId,
  );
  const modifiedDate = optionalIdentifier(input.evidencePayload?.microsoftStoreModifiedDate);
  const accountBindingHash = optionalIdentifier(
    input.evidencePayload?.microsoftStoreAccountBindingHash,
  );
  const recoveryOwnershipGeneration = optionalIdentifier(
    input.evidencePayload?.microsoftStoreRecoveryOwnershipGeneration,
  );
  // The binding and this verifier ship together in the first Store release. Missing bindings are
  // therefore malformed evidence, not legacy evidence, and must fail closed to prevent an account
  // switch between verification and consumption.
  if (
    payloadStoreId === undefined
    || collectionItemId === undefined
    || modifiedDate === undefined
    || accountBindingHash === undefined
    || recoveryOwnershipGeneration === undefined
    || recoveryOwnershipGeneration !== input.request.idempotencyKey
    || input.evidenceVerificationId !== createVerificationId({
      id: collectionItemId,
      modifiedDate,
      productId: payloadStoreId,
    })
  ) {
    return {
      status: 'pending',
      result: finalizationPending('MICROSOFT_STORE_FINALIZATION_EVIDENCE_MISMATCH'),
    };
  }
  // The provider identity is bound into the durable verification ID. Reuse it for retries so a
  // later catalog migration cannot strand an already-granted, still-unconsumed purchase.
  return {
    status: 'verified',
    collectionItemId,
    storeId: payloadStoreId,
    accountBindingHash,
    recoveryOwnershipGeneration,
  };
}

function createVerificationId(
  item: Pick<MicrosoftStoreCollectionItem, 'id' | 'modifiedDate' | 'productId'>,
): string {
  return `microsoft-store:${item.productId}:${item.id}:${item.modifiedDate}`;
}

async function deterministicTrackingId(value: string): Promise<string> {
  const subtle = readGlobalSubtleCrypto();
  const encoded = new TextEncoder().encode(value);
  const digest = new Uint8Array(await subtle.digest('SHA-256', encoded));
  digest[6] = ((digest.at(6) ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest.at(8) ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createAccountBindingHash(accountBindingId: string): Promise<string> {
  const subtle = readGlobalSubtleCrypto();
  const encoded = new TextEncoder().encode(
    `mpgd-microsoft-store-account-v1\0${identifier(accountBindingId, 'accountBindingId')}`,
  );
  const digest = new Uint8Array(await subtle.digest('SHA-256', encoded));
  return `sha256:${Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function normalizeStoreIds(input: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  const mappedStoreIds = new Set<string>();
  for (const [logicalProductId, storeId] of Object.entries(input)) {
    const normalizedLogicalProductId = identifier(logicalProductId, 'logicalProductId');
    const normalizedStoreId = identifier(storeId, 'storeId');
    if (mappedStoreIds.has(normalizedStoreId)) {
      throw new TypeError(`Duplicate Microsoft Store product mapping: ${normalizedStoreId}`);
    }
    mappedStoreIds.add(normalizedStoreId);
    output.set(normalizedLogicalProductId, normalizedStoreId);
  }
  if (output.size === 0) {
    throw new TypeError('storeIds must contain at least one product mapping.');
  }
  return output;
}

function normalizeInAppOfferTokens(
  input: Readonly<Record<string, string>>,
  storeIds: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  const mappedTokens = new Set<string>();
  for (const [logicalProductId, inAppOfferToken] of Object.entries(input)) {
    const normalizedLogicalProductId = identifier(logicalProductId, 'logicalProductId');
    const normalizedInAppOfferToken = identifier(inAppOfferToken, 'inAppOfferToken');
    if (!storeIds.has(normalizedLogicalProductId)) {
      throw new TypeError(
        `Microsoft Store Digital Goods mapping requires a Store ID: ${normalizedLogicalProductId}`,
      );
    }
    if (mappedTokens.has(normalizedInAppOfferToken)) {
      throw new TypeError(
        `Duplicate Microsoft Store Digital Goods mapping: ${normalizedInAppOfferToken}`,
      );
    }
    mappedTokens.add(normalizedInAppOfferToken);
    output.set(normalizedLogicalProductId, normalizedInAppOfferToken);
  }
  for (const logicalProductId of storeIds.keys()) {
    if (!output.has(logicalProductId)) {
      throw new TypeError(
        `Microsoft Store Store ID mapping requires a Digital Goods token: ${logicalProductId}`,
      );
    }
  }
  return output;
}

function normalizeHistoricalProductMappings(
  input: Readonly<Record<string, readonly MicrosoftStoreHistoricalProductMapping[]>>,
  currentStoreIds: ReadonlyMap<string, string>,
  currentInAppOfferTokens: ReadonlyMap<string, string>,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const output = new Map<string, ReadonlyMap<string, string>>();
  const storeIdOwners = new Map<string, string>();
  const inAppOfferTokens = new Set<string>();
  for (const [logicalProductId, storeId] of currentStoreIds) {
    storeIdOwners.set(storeId, logicalProductId);
  }
  for (const inAppOfferToken of currentInAppOfferTokens.values()) {
    inAppOfferTokens.add(inAppOfferToken);
  }

  for (const [rawLogicalProductId, rawMappings] of Object.entries(input)) {
    const logicalProductId = identifier(rawLogicalProductId, 'logicalProductId');
    if (!currentStoreIds.has(logicalProductId)) {
      throw new TypeError(
        `Historical Microsoft Store mapping requires a current product: ${logicalProductId}`,
      );
    }
    if (!Array.isArray(rawMappings)) {
      throw new TypeError(
        `Historical Microsoft Store mappings must be an array: ${logicalProductId}`,
      );
    }

    const mappings = new Map<string, string>();
    for (const rawMapping of rawMappings) {
      const inAppOfferToken = identifier(rawMapping.inAppOfferToken, 'historical inAppOfferToken');
      const storeId = identifier(rawMapping.storeId, 'historical storeId');
      if (mappings.has(inAppOfferToken)) {
        throw new TypeError(`Duplicate historical Microsoft Store token: ${inAppOfferToken}`);
      }
      if (inAppOfferTokens.has(inAppOfferToken)) {
        throw new TypeError(`Duplicate Microsoft Store Digital Goods mapping: ${inAppOfferToken}`);
      }
      const owner = storeIdOwners.get(storeId);
      if (owner !== undefined && owner !== logicalProductId) {
        throw new TypeError(`Duplicate Microsoft Store product mapping: ${storeId}`);
      }
      inAppOfferTokens.add(inAppOfferToken);
      storeIdOwners.set(storeId, logicalProductId);
      mappings.set(inAppOfferToken, storeId);
    }
    output.set(logicalProductId, mappings);
  }

  return output;
}

function assertCredentials(input: MicrosoftStoreCollectionsCredentials): void {
  authorizationValue(input.accessToken, 'accessToken');
  identifier(input.userStoreId, 'userStoreId');
  identifier(input.accountBindingId, 'accountBindingId');
  if (input.sandbox !== undefined) {
    identifier(input.sandbox, 'sandbox');
  }
}

function beneficiary(userStoreId: string): Readonly<Record<string, string>> {
  return {
    identityType: 'b2b',
    identityValue: identifier(userStoreId, 'userStoreId'),
    localTicketReference: '',
  };
}

function identifier(input: unknown, label: string): string {
  const value = optionalIdentifier(input);
  if (value === undefined) {
    throw new TypeError(`${label} must be a non-empty identifier.`);
  }
  return value;
}

function optionalIdentifier(input: unknown): string | undefined {
  return typeof input === 'string'
    && input.length > 0
    && input.trim() === input
    && input.length <= 4096
    && !/[\p{Cc}\p{Cf}]/u.test(input)
    ? input
    : undefined;
}

function authorizationValue(input: unknown, label: string): string {
  const value = identifier(input, label);
  if (/\s/u.test(value)) {
    throw new TypeError(`${label} must not contain whitespace.`);
  }
  return value;
}

function optionalHeaderValue(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input.length === 0 || /[\r\n]/u.test(input)) {
    throw new TypeError('userAgent must be a non-empty single-line string.');
  }
  return input;
}

function guid(input: unknown, label: string): string {
  const value = identifier(input, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError(`${label} must be a GUID.`);
  }
  return value;
}

function positiveSafeInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || Number(input) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return Number(input);
}

function validIsoDate(input: string): boolean {
  // Collections datetime fields commonly use an explicit `+00:00` offset rather than `Z`.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(input)
    && Number.isFinite(Date.parse(input));
}

function readGlobalSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;

  if (subtle === undefined) {
    throw new Error(
      'globalThis.crypto.subtle is unavailable. Provide a Web Crypto SubtleCrypto implementation.',
    );
  }

  return subtle;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function rejected(reason: string): { readonly status: 'rejected'; readonly reason: string } {
  return { status: 'rejected', reason };
}

function pending(reason: string): { readonly status: 'pending'; readonly reason: string } {
  return { status: 'pending', reason };
}

function finalizationPending(reason: string): PurchaseGrantFinalization {
  return { status: 'pending', action: 'consume', alreadyCompleted: false, reason };
}

function readGlobalFetch(): MicrosoftStoreFetch {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, body: response.body };
  };
}

async function readBoundedJson(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (body === null) {
    throw new MicrosoftStoreCollectionsUnavailableError(
      'Microsoft Store Collections returned an empty response.',
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        throw new MicrosoftStoreCollectionsUnavailableError(
          'Microsoft Store Collections response exceeded maxResponseBytes.',
        );
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the bounded-read or abort error that made the response unusable.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new MicrosoftStoreCollectionsUnavailableError(
      'Microsoft Store Collections returned invalid JSON.',
      error,
    );
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The HTTP status already determines the fail-closed result.
  }
}
