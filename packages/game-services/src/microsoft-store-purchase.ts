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
   * renewal and change only when the player links a different Store account. Never use the
   * User Store ID or another renewable credential as this value.
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
  readonly storeIds: Readonly<Record<string, string>>;
  readonly resolveCredentials: (
    playerId: string,
    signal: AbortSignal,
  ) => Promise<MicrosoftStoreCollectionsCredentials> | MicrosoftStoreCollectionsCredentials;
  readonly now?: () => string;
}

export interface MicrosoftStorePurchaseBoundary extends GameServicesPurchaseGrantFinalizer {
  verifyPurchase(
    input: VerifyPurchaseEvidenceInput,
  ): ReturnType<GameServicesEvidenceVerifier['verifyPurchase']>;
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
  const now = input.now ?? (() => new Date().toISOString());
  const inFlightFinalizations = new Map<string, Promise<PurchaseGrantFinalization>>();

  return {
    supportsPurchaseGrant(finalizationInput) {
      return finalizationInput.request.target === 'microsoft-store'
        && finalizationInput.product.type === 'consumable'
        && finalizationInput.request.evidence?.schema
          === microsoftStoreDigitalGoodsEvidenceSchema;
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
      const storeId = storeIds.get(verificationInput.product.id);
      if (storeId === undefined) {
        return rejected('MICROSOFT_STORE_PRODUCT_MAPPING_REQUIRED');
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
          ...(item.item.transactionId === undefined
            ? {}
            : { microsoftStoreTransactionId: item.item.transactionId }),
          digitalGoodsItemId: clientEvidence.itemId,
        },
      };
    },

    async finalizePurchaseGrant(finalizationInput) {
      const context = readFinalizationContext(finalizationInput, storeIds);
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
      || raw.productId !== context.storeId
      || raw.trackingId !== trackingId
      || raw.newQuantity !== 0
    ) {
      return finalizationPending('MICROSOFT_STORE_CONSUME_RESPONSE_MISMATCH');
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
    || itemId !== input.platformProductId
    || purchaseToken !== input.platformProductId
    || input.request.platformTransactionId !== purchaseToken
  ) {
    return undefined;
  }
  return { itemId };
}

function readFinalizationContext(
  input: FinalizePurchaseGrantInput,
  storeIds: ReadonlyMap<string, string>,
):
  | {
      readonly status: 'verified';
      readonly collectionItemId: string;
      readonly storeId: string;
      readonly accountBindingHash: string;
    }
  | { readonly status: 'pending'; readonly result: PurchaseGrantFinalization } {
  if (input.request.target !== 'microsoft-store' || input.product.type !== 'consumable') {
    return { status: 'pending', result: finalizationPending('MICROSOFT_STORE_TARGET_REQUIRED') };
  }
  const storeId = storeIds.get(input.product.id);
  const payloadStoreId = optionalIdentifier(input.evidencePayload?.microsoftStoreProductId);
  const collectionItemId = optionalIdentifier(
    input.evidencePayload?.microsoftStoreCollectionItemId,
  );
  const modifiedDate = optionalIdentifier(input.evidencePayload?.microsoftStoreModifiedDate);
  const accountBindingHash = optionalIdentifier(
    input.evidencePayload?.microsoftStoreAccountBindingHash,
  );
  // The binding and this verifier ship together in the first Store release. Missing bindings are
  // therefore malformed evidence, not legacy evidence, and must fail closed to prevent an account
  // switch between verification and consumption.
  if (
    storeId === undefined
    || payloadStoreId !== storeId
    || collectionItemId === undefined
    || modifiedDate === undefined
    || accountBindingHash === undefined
    || input.evidenceVerificationId !== createVerificationId({
      id: collectionItemId,
      modifiedDate,
      productId: storeId,
    })
  ) {
    return {
      status: 'pending',
      result: finalizationPending('MICROSOFT_STORE_FINALIZATION_EVIDENCE_MISMATCH'),
    };
  }
  return { status: 'verified', collectionItemId, storeId, accountBindingHash };
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
