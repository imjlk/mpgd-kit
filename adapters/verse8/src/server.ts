import type {
  EvidenceVerificationDecision,
  GameServicesEvidenceVerifier,
  VerifyAdRewardEvidenceInput,
} from '@mpgd/game-services';

import { verse8AdsRewardEvidenceSchema } from './ads-contract.js';

export const defaultVerse8AdsVerifierBaseUrl = 'https://ads-verifier.verse8.io';

const maximumVerifierResponseLength = 65_536;

export interface Verse8AdsVerifierReward {
  readonly amount: number;
  readonly type: string;
}

export interface Verse8AdsVerificationRecord {
  readonly verified: boolean;
  readonly status?: 'verified' | 'consumed' | 'pending';
  readonly reward?: Verse8AdsVerifierReward;
  readonly requestId?: string;
  readonly placementId?: string;
  readonly userId?: string;
  readonly adNetwork?: 'google';
  readonly verifiedAt?: string;
  readonly consumedAt?: string;
  readonly error?: string;
}

export interface Verse8AdsVerifierClient {
  consume(input: {
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<Verse8AdsVerificationRecord>;
}

export type Verse8AdsVerifierAuthorization =
  | string
  | (() => string | Promise<string>);

export interface CreateVerse8AdsVerifierHttpClientInput {
  readonly authorization: Verse8AdsVerifierAuthorization;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

export interface CreateVerse8AdsEvidenceVerifierInput {
  readonly client: Verse8AdsVerifierClient;
}

export class Verse8AdsVerifierHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(`Verse8 Ads verifier request failed with HTTP ${status}.`);
    this.name = 'Verse8AdsVerifierHttpError';
    this.status = status;
    this.code = code;
  }
}

export function createVerse8AdsVerifierHttpClient(
  input: CreateVerse8AdsVerifierHttpClientInput,
): Verse8AdsVerifierClient {
  const endpoint = verifierEndpoint(input.baseUrl ?? defaultVerse8AdsVerifierBaseUrl);
  const fetcher = input.fetch ?? readGlobalFetch();

  return {
    async consume({ requestId, signal }) {
      requireNonEmptyString(requestId, 'requestId');
      const authorization = await resolveAuthorization(input.authorization);
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requestId }),
        signal,
      });
      const body = await readBoundedJson(response);

      if (!response.ok && !isVerse8AdsVerificationRecord(body)) {
        throw new Verse8AdsVerifierHttpError(response.status, readErrorCode(body));
      }

      const record = assertVerse8AdsVerificationRecord(body);

      if (!response.ok && record.status !== 'consumed') {
        throw new Verse8AdsVerifierHttpError(response.status, record.error);
      }

      return record;
    },
  };
}

export function createVerse8AdsEvidenceVerifier(
  input: CreateVerse8AdsEvidenceVerifierInput,
): GameServicesEvidenceVerifier {
  return {
    async verifyPurchase() {
      return rejected('VERSE8_PURCHASE_EVIDENCE_UNSUPPORTED');
    },
    async verifyAdReward(verificationInput) {
      return verifyVerse8AdReward(input.client, verificationInput);
    },
  };
}

async function verifyVerse8AdReward(
  client: Verse8AdsVerifierClient,
  input: VerifyAdRewardEvidenceInput,
): Promise<EvidenceVerificationDecision> {
  const { request, platformPlacementId } = input;

  if (request.target !== 'verse8') {
    return rejected('VERSE8_AD_TARGET_REQUIRED');
  }

  if (platformPlacementId === undefined || platformPlacementId.length === 0) {
    return rejected('VERSE8_AD_PLACEMENT_UNCONFIGURED');
  }

  const requestId = request.platformImpressionId;

  if (requestId === undefined) {
    return rejected('VERSE8_AD_REQUEST_ID_REQUIRED');
  }

  if (request.evidence?.schema !== verse8AdsRewardEvidenceSchema) {
    return rejected('VERSE8_AD_EVIDENCE_SCHEMA_INVALID');
  }

  const evidenceRequestId = readEvidenceString(request.evidence.payload, 'requestId');
  const evidencePlacementId = readEvidenceString(request.evidence.payload, 'placementId');

  if (evidenceRequestId !== requestId) {
    return rejected('VERSE8_AD_REQUEST_ID_MISMATCH');
  }

  if (evidencePlacementId !== platformPlacementId) {
    return rejected('VERSE8_AD_PLACEMENT_MISMATCH');
  }

  const record = await client.consume({
    requestId,
    signal: input.signal,
  });

  if (record.status === 'pending') {
    return {
      status: 'pending',
      reason: 'VERSE8_AD_EVIDENCE_PENDING',
    };
  }

  if (record.status === 'consumed') {
    return rejected('VERSE8_AD_EVIDENCE_CONSUMED');
  }

  if (record.status === 'verified' && !record.verified) {
    return rejected('VERSE8_AD_VERIFIER_RESPONSE_INCONSISTENT');
  }

  if (!record.verified) {
    return {
      status: 'pending',
      reason: 'VERSE8_AD_EVIDENCE_PENDING',
    };
  }

  if (record.requestId !== requestId) {
    return rejected('VERSE8_AD_VERIFIED_REQUEST_MISMATCH');
  }

  if (record.placementId !== platformPlacementId) {
    return rejected('VERSE8_AD_VERIFIED_PLACEMENT_MISMATCH');
  }

  if (record.userId === undefined || !sameVerse8User(record.userId, request.playerId)) {
    return rejected('VERSE8_AD_VERIFIED_USER_MISMATCH');
  }

  const verifiedAt = normalizeTimestamp(record.verifiedAt);

  if (verifiedAt === undefined) {
    return rejected('VERSE8_AD_VERIFIED_AT_INVALID');
  }

  return {
    status: 'verified',
    verificationId: `verse8:ad-reward:${requestId}`,
    verifiedAt,
    payload: {
      verse8RequestId: requestId,
      verse8PlacementId: platformPlacementId,
      ...(record.adNetwork === undefined ? {} : { verse8AdNetwork: record.adNetwork }),
    },
  };
}

function verifierEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);

  if (url.protocol !== 'https:') {
    throw new Error('Verse8 Ads verifier baseUrl must use HTTPS.');
  }

  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ads/verify`;

  return url.toString();
}

function readGlobalFetch(): typeof fetch {
  const fetcher = (globalThis as { readonly fetch?: typeof fetch }).fetch;

  if (fetcher === undefined) {
    throw new Error(
      'globalThis.fetch is unavailable. Provide a Verse8 verifier fetch implementation.',
    );
  }

  return fetcher.bind(globalThis);
}

async function resolveAuthorization(
  authorization: Verse8AdsVerifierAuthorization,
): Promise<string> {
  const resolved = typeof authorization === 'function' ? await authorization() : authorization;

  requireNonEmptyString(resolved, 'authorization');

  return resolved.trim();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = await readBoundedBody(response);

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Verse8 Ads verifier response must be valid JSON.');
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('Content-Length');

  if (declaredLength !== null && Number(declaredLength) > maximumVerifierResponseLength) {
    throw new Error('Verse8 Ads verifier response exceeds the maximum size.');
  }

  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let body = '';

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        return body + decoder.decode();
      }

      byteLength += chunk.value.byteLength;

      if (byteLength > maximumVerifierResponseLength) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Verse8 Ads verifier response exceeds the maximum size.');
      }

      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function assertVerse8AdsVerificationRecord(input: unknown): Verse8AdsVerificationRecord {
  if (!isVerse8AdsVerificationRecord(input)) {
    throw new Error('Verse8 Ads verifier response has an invalid shape.');
  }

  return input;
}

function isVerse8AdsVerificationRecord(
  input: unknown,
): input is Verse8AdsVerificationRecord {
  if (!isRecord(input) || typeof input.verified !== 'boolean') {
    return false;
  }

  if (
    input.status !== undefined
    && input.status !== 'verified'
    && input.status !== 'consumed'
    && input.status !== 'pending'
  ) {
    return false;
  }

  if (!isOptionalString(input.requestId)
    || !isOptionalString(input.placementId)
    || !isOptionalString(input.userId)
    || !isOptionalString(input.verifiedAt)
    || !isOptionalString(input.consumedAt)
    || !isOptionalString(input.error)) {
    return false;
  }

  if (input.adNetwork !== undefined && input.adNetwork !== 'google') {
    return false;
  }

  if (input.reward !== undefined) {
    if (!isRecord(input.reward)
      || typeof input.reward.amount !== 'number'
      || !Number.isFinite(input.reward.amount)
      || typeof input.reward.type !== 'string') {
      return false;
    }
  }

  return true;
}

function readErrorCode(input: unknown): string | undefined {
  return isRecord(input) && typeof input.error === 'string' ? input.error : undefined;
}

function readEvidenceString(
  payload: Readonly<Record<string, string | number | boolean>>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function sameVerse8User(left: string, right: string): boolean {
  return isHexAccount(left) && isHexAccount(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isHexAccount(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value);
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

function isOptionalString(input: unknown): input is string | undefined {
  return input === undefined || typeof input === 'string';
}

function requireNonEmptyString(input: string, label: string): void {
  if (input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}
