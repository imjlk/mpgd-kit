import type { AdPlacementEntry } from '@mpgd/catalog';

import type {
  EvidenceVerificationDecision,
  GameServicesEvidenceVerifier,
  VerifyAdRewardEvidenceInput,
} from './evidence-verification';
import type { ClaimAdRewardRequest } from './types';

export const admobSsvCustomDataSchema = 'mpgd.admob.ssv.binding.v1';
export const defaultAdMobSsvMaximumCallbackAgeMs = 86_400_000;
export const defaultAdMobSsvMaximumFutureSkewMs = 300_000;

const signatureMarker = '&signature=';
const maximumCallbackUrlLength = 65_536;
const maximumDateTimestampMs = 8_640_000_000_000_000;
const requiredSignedParameters = [
  'ad_network',
  'ad_unit',
  'custom_data',
  'reward_amount',
  'reward_item',
  'timestamp',
  'transaction_id',
  'user_id',
] as const;

export interface AdMobSsvCustomDataBinding {
  readonly playerId: string;
  readonly placementId: string;
  readonly idempotencyKey: string;
}

export interface AdMobSsvCallbackLookupInput {
  readonly request: ClaimAdRewardRequest;
  readonly platformPlacementId: string;
  readonly signal: AbortSignal;
}

export interface AdMobSsvCallbackSource {
  findCallback(input: AdMobSsvCallbackLookupInput): Promise<string | undefined>;
}

export interface AdMobSsvPublicKeyLookupInput {
  readonly keyId: string;
  readonly signal: AbortSignal;
}

export interface AdMobSsvPublicKeySource {
  getPublicKey(input: AdMobSsvPublicKeyLookupInput): Promise<CryptoKey | undefined>;
}

export interface ResolveAdMobSsvRewardItemInput {
  readonly request: ClaimAdRewardRequest;
  readonly placement: AdPlacementEntry;
}

export interface CreateAdMobSsvEvidenceVerifierInput {
  readonly callbackSource: AdMobSsvCallbackSource;
  readonly publicKeySource: AdMobSsvPublicKeySource;
  readonly subtle?: SubtleCrypto;
  readonly now?: () => number;
  readonly maximumCallbackAgeMs?: number;
  readonly maximumFutureSkewMs?: number;
  readonly resolveRewardItem?: (input: ResolveAdMobSsvRewardItemInput) => string;
}

interface ParsedAdMobSsvCallback {
  readonly adNetwork: string;
  readonly adUnit: string;
  readonly customData: string;
  readonly keyId: string;
  readonly rewardAmount: number;
  readonly rewardItem: string;
  readonly signature: Uint8Array<ArrayBuffer>;
  readonly signedContent: Uint8Array<ArrayBuffer>;
  readonly timestampMs: number;
  readonly transactionId: string;
  readonly userId: string;
}

export function encodeAdMobSsvCustomData(input: AdMobSsvCustomDataBinding): string {
  requireNonEmptyString(input.playerId, 'playerId');
  requireNonEmptyString(input.placementId, 'placementId');
  requireNonEmptyString(input.idempotencyKey, 'idempotencyKey');

  return JSON.stringify({
    schema: admobSsvCustomDataSchema,
    playerId: input.playerId,
    placementId: input.placementId,
    idempotencyKey: input.idempotencyKey,
  });
}

export function decodeAdMobSsvCustomData(
  input: string,
): AdMobSsvCustomDataBinding | undefined {
  try {
    const parsed: unknown = JSON.parse(input);

    if (!isRecord(parsed) || parsed.schema !== admobSsvCustomDataSchema) {
      return undefined;
    }

    if (
      !isNonEmptyString(parsed.playerId)
      || !isNonEmptyString(parsed.placementId)
      || !isNonEmptyString(parsed.idempotencyKey)
    ) {
      return undefined;
    }

    return {
      playerId: parsed.playerId,
      placementId: parsed.placementId,
      idempotencyKey: parsed.idempotencyKey,
    };
  } catch {
    return undefined;
  }
}

export async function importAdMobSsvPublicKey(
  base64Spki: string,
  subtle: SubtleCrypto = readGlobalSubtleCrypto(),
): Promise<CryptoKey> {
  requireNonEmptyString(base64Spki, 'base64Spki');

  return subtle.importKey(
    'spki',
    decodeBase64(base64Spki),
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    false,
    ['verify'],
  );
}

export function createAdMobSsvEvidenceVerifier(
  input: CreateAdMobSsvEvidenceVerifierInput,
): GameServicesEvidenceVerifier {
  const subtle = input.subtle ?? readGlobalSubtleCrypto();
  const now = input.now ?? Date.now;
  const maximumCallbackAgeMs = input.maximumCallbackAgeMs
    ?? defaultAdMobSsvMaximumCallbackAgeMs;
  const maximumFutureSkewMs = input.maximumFutureSkewMs
    ?? defaultAdMobSsvMaximumFutureSkewMs;
  const resolveRewardItem = input.resolveRewardItem ?? defaultRewardItem;

  requireNonNegativeFiniteNumber(maximumCallbackAgeMs, 'maximumCallbackAgeMs');
  requireNonNegativeFiniteNumber(maximumFutureSkewMs, 'maximumFutureSkewMs');

  return {
    async verifyPurchase() {
      return rejected('ADMOB_SSV_PURCHASE_EVIDENCE_UNSUPPORTED');
    },
    async verifyAdReward(verificationInput) {
      return verifyAdMobSsvReward({
        callbackSource: input.callbackSource,
        publicKeySource: input.publicKeySource,
        subtle,
        now,
        maximumCallbackAgeMs,
        maximumFutureSkewMs,
        resolveRewardItem,
      }, verificationInput);
    },
  };
}

async function verifyAdMobSsvReward(
  context: {
    readonly callbackSource: AdMobSsvCallbackSource;
    readonly publicKeySource: AdMobSsvPublicKeySource;
    readonly subtle: SubtleCrypto;
    readonly now: () => number;
    readonly maximumCallbackAgeMs: number;
    readonly maximumFutureSkewMs: number;
    readonly resolveRewardItem: (input: ResolveAdMobSsvRewardItemInput) => string;
  },
  input: VerifyAdRewardEvidenceInput,
): Promise<EvidenceVerificationDecision> {
  const { request, placement, platformPlacementId, signal } = input;

  if (request.target !== 'android' && request.target !== 'ios') {
    return rejected('ADMOB_SSV_TARGET_UNSUPPORTED');
  }

  if (platformPlacementId === undefined || platformPlacementId.length === 0) {
    return rejected('ADMOB_SSV_AD_UNIT_UNCONFIGURED');
  }

  const callbackUrl = await context.callbackSource.findCallback({
    request,
    platformPlacementId,
    signal,
  });

  if (callbackUrl === undefined) {
    return {
      status: 'pending',
      reason: 'ADMOB_SSV_EVIDENCE_PENDING',
    };
  }

  const callback = parseAdMobSsvCallback(callbackUrl);

  if (callback === undefined) {
    return rejected('ADMOB_SSV_CALLBACK_INVALID');
  }

  let publicKey: CryptoKey | undefined;

  try {
    publicKey = await context.publicKeySource.getPublicKey({
      keyId: callback.keyId,
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    return rejected('ADMOB_SSV_KEY_ERROR');
  }

  if (publicKey === undefined) {
    return rejected('ADMOB_SSV_KEY_UNAVAILABLE');
  }

  const signature = convertDerEcdsaSignature(callback.signature, publicKey);

  if (signature === undefined) {
    return rejected('ADMOB_SSV_KEY_OR_SIGNATURE_INVALID');
  }

  let signatureVerified: boolean;

  try {
    signatureVerified = await context.subtle.verify(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      publicKey,
      signature,
      callback.signedContent,
    );
  } catch {
    return rejected('ADMOB_SSV_KEY_OR_SIGNATURE_INVALID');
  }

  if (!signatureVerified) {
    return rejected('ADMOB_SSV_SIGNATURE_INVALID');
  }

  if (callback.adUnit !== platformPlacementId) {
    return rejected('ADMOB_SSV_AD_UNIT_MISMATCH');
  }

  if (callback.userId !== request.playerId) {
    return rejected('ADMOB_SSV_USER_MISMATCH');
  }

  const binding = decodeAdMobSsvCustomData(callback.customData);

  if (
    binding === undefined
    || binding.playerId !== request.playerId
    || binding.placementId !== request.placementId
    || binding.idempotencyKey !== request.idempotencyKey
  ) {
    return rejected('ADMOB_SSV_CUSTOM_DATA_MISMATCH');
  }

  const expectedRewardItem = context.resolveRewardItem({ request, placement });

  if (!isNonEmptyString(expectedRewardItem)) {
    return rejected('ADMOB_SSV_REWARD_ITEM_UNCONFIGURED');
  }

  if (
    callback.rewardAmount !== placement.reward?.amount
    || callback.rewardItem !== expectedRewardItem
  ) {
    return rejected('ADMOB_SSV_REWARD_MISMATCH');
  }

  const nowMs = context.now();

  if (!Number.isFinite(nowMs)) {
    return rejected('ADMOB_SSV_CLOCK_INVALID');
  }

  if (callback.timestampMs > nowMs + context.maximumFutureSkewMs) {
    return rejected('ADMOB_SSV_TIMESTAMP_IN_FUTURE');
  }

  if (callback.timestampMs < nowMs - context.maximumCallbackAgeMs) {
    return rejected('ADMOB_SSV_CALLBACK_EXPIRED');
  }

  return {
    status: 'verified',
    verificationId: `admob:ssv:${callback.transactionId}`,
    verifiedAt: new Date(callback.timestampMs).toISOString(),
    payload: {
      admobSsvTransactionId: callback.transactionId,
      admobSsvAdNetwork: callback.adNetwork,
      admobSsvAdUnit: callback.adUnit,
      admobSsvRewardAmount: callback.rewardAmount,
      admobSsvRewardItem: callback.rewardItem,
      admobSsvKeyId: callback.keyId,
    },
  };
}

function parseAdMobSsvCallback(input: string): ParsedAdMobSsvCallback | undefined {
  try {
    if (input.length === 0 || input.length > maximumCallbackUrlLength) {
      return undefined;
    }

    const url = new URL(input);

    if (
      url.protocol !== 'https:'
      || url.username.length > 0
      || url.password.length > 0
      || url.hash.length > 0
    ) {
      return undefined;
    }

    const queryStart = input.indexOf('?');

    if (queryStart < 0) {
      return undefined;
    }

    const query = input.slice(queryStart + 1);
    const signatureIndex = query.indexOf(signatureMarker);

    if (
      signatureIndex <= 0
      || signatureIndex !== query.lastIndexOf(signatureMarker)
    ) {
      return undefined;
    }

    const signedContent = query.slice(0, signatureIndex);
    const signatureAndKey = query.slice(signatureIndex + 1);
    const suffixMatch = /^signature=([^&]+)&key_id=([^&]+)$/.exec(signatureAndKey);

    if (suffixMatch === null) {
      return undefined;
    }

    const parameters = new URLSearchParams(signedContent);

    for (const parameter of requiredSignedParameters) {
      if (parameters.getAll(parameter).length !== 1) {
        return undefined;
      }
    }

    const rewardAmount = parseUnsignedInteger(readParameter(parameters, 'reward_amount'));
    const timestampMs = parseUnsignedInteger(readParameter(parameters, 'timestamp'));

    if (rewardAmount === undefined || timestampMs === undefined) {
      return undefined;
    }

    const adNetwork = readParameter(parameters, 'ad_network');
    const adUnit = readParameter(parameters, 'ad_unit');
    const customData = readParameter(parameters, 'custom_data');
    const rewardItem = readParameter(parameters, 'reward_item');
    const transactionId = readParameter(parameters, 'transaction_id');
    const userId = readParameter(parameters, 'user_id');
    const signature = decodeBase64Url(suffixMatch[1] ?? '');
    const keyId = suffixMatch[2] ?? '';

    if (
      !/^[0-9]+$/.test(adNetwork)
      || !isNonEmptyString(adUnit)
      || !isNonEmptyString(customData)
      || !isNonEmptyString(rewardItem)
      || !/^[A-Fa-f0-9]+$/.test(transactionId)
      || !isNonEmptyString(userId)
      || signature === undefined
      || !/^[0-9]+$/.test(keyId)
    ) {
      return undefined;
    }

    return {
      adNetwork,
      adUnit,
      customData,
      keyId,
      rewardAmount,
      rewardItem,
      signature,
      signedContent: new TextEncoder().encode(signedContent),
      timestampMs,
      transactionId,
      userId,
    };
  } catch {
    return undefined;
  }
}

function convertDerEcdsaSignature(
  signature: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
): Uint8Array<ArrayBuffer> | undefined {
  if (key.type !== 'public' || key.algorithm.name !== 'ECDSA') {
    return undefined;
  }

  const namedCurve = (key.algorithm as EcKeyAlgorithm).namedCurve;
  const componentLength = namedCurve === 'P-256'
    ? 32
    : namedCurve === 'P-384'
      ? 48
      : namedCurve === 'P-521'
        ? 66
        : undefined;

  if (componentLength === undefined) {
    return undefined;
  }

  const sequence = readDerElement(signature, 0, 0x30);

  if (sequence === undefined || sequence.end !== signature.length) {
    return undefined;
  }

  const r = readDerElement(signature, sequence.contentStart, 0x02);

  if (r === undefined) {
    return undefined;
  }

  const s = readDerElement(signature, r.end, 0x02);

  if (s === undefined || s.end !== sequence.end) {
    return undefined;
  }

  const rawR = normalizeDerInteger(signature.slice(r.contentStart, r.end), componentLength);
  const rawS = normalizeDerInteger(signature.slice(s.contentStart, s.end), componentLength);

  if (rawR === undefined || rawS === undefined) {
    return undefined;
  }

  const raw = new Uint8Array(componentLength * 2);
  raw.set(rawR, 0);
  raw.set(rawS, componentLength);

  return raw;
}

function readDerElement(
  input: Uint8Array<ArrayBuffer>,
  offset: number,
  expectedTag: number,
): { readonly contentStart: number; readonly end: number } | undefined {
  if (input[offset] !== expectedTag) {
    return undefined;
  }

  const length = readDerLength(input, offset + 1);

  if (length === undefined) {
    return undefined;
  }

  const end = length.contentStart + length.length;

  if (end > input.length) {
    return undefined;
  }

  return {
    contentStart: length.contentStart,
    end,
  };
}

function readDerLength(
  input: Uint8Array<ArrayBuffer>,
  offset: number,
): { readonly contentStart: number; readonly length: number } | undefined {
  const first = input[offset];

  if (first === undefined) {
    return undefined;
  }

  if ((first & 0x80) === 0) {
    return {
      contentStart: offset + 1,
      length: first,
    };
  }

  const byteCount = first & 0x7f;

  if (byteCount === 0 || byteCount > 4 || offset + byteCount >= input.length) {
    return undefined;
  }

  let length = 0;

  for (let index = 0; index < byteCount; index += 1) {
    const byte = input[offset + 1 + index];

    if (byte === undefined) {
      return undefined;
    }

    length = (length * 256) + byte;
  }

  if (length < 128) {
    return undefined;
  }

  return {
    contentStart: offset + 1 + byteCount,
    length,
  };
}

function normalizeDerInteger(
  input: Uint8Array<ArrayBuffer>,
  componentLength: number,
): Uint8Array<ArrayBuffer> | undefined {
  if (input.length === 0) {
    return undefined;
  }

  if (input[0] === 0) {
    if (input.length === 1 || (input[1] ?? 0) < 0x80) {
      return undefined;
    }

    input = input.slice(1);
  } else if ((input[0] ?? 0) >= 0x80) {
    return undefined;
  }

  if (input.length > componentLength) {
    return undefined;
  }

  const normalized = new Uint8Array(componentLength);
  normalized.set(input, componentLength - input.length);

  return normalized;
}

function defaultRewardItem(input: ResolveAdMobSsvRewardItemInput): string {
  const reward = input.placement.reward;

  if (reward === undefined) {
    return '';
  }

  return reward.type === 'currency' ? reward.currency : reward.type;
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

function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(input);
  const output = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index += 1) {
    output[index] = decoded.charCodeAt(index);
  }

  return output;
}

function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    return undefined;
  }

  const remainder = input.length % 4;

  if (remainder === 1) {
    return undefined;
  }

  const base64 = input.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - remainder) % 4);

  try {
    return decodeBase64(base64);
  } catch {
    return undefined;
  }
}

function readParameter(parameters: URLSearchParams, name: string): string {
  return parameters.get(name) ?? '';
}

function parseUnsignedInteger(input: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(input)) {
    return undefined;
  }

  const parsed = Number(input);

  return (
      Number.isSafeInteger(parsed)
      && parsed <= maximumDateTimestampMs
    )
    ? parsed
    : undefined;
}

function rejected(reason: string): EvidenceVerificationDecision {
  return {
    status: 'rejected',
    reason,
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0;
}

function requireNonEmptyString(input: string, name: string): void {
  if (!isNonEmptyString(input)) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function requireNonNegativeFiniteNumber(input: number, name: string): void {
  if (!Number.isFinite(input) || input < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
}
