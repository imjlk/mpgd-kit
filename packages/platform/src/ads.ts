import type { AdAdapter, PlatformEvidenceEnvelope } from './index.js';

export const adProtocolVersion = '2.0.0-draft.1' as const;
export const adProtocol = 'mpgd.ads.v2' as const;
export type AdFormat = 'rewarded' | 'interstitial';
export type AdProviderId = string;
export type AdReason = 'unsupported' | 'configuration-required' | 'policy-disabled'
  | 'action-required' | 'no-fill' | 'busy' | 'transient-failure' | 'outcome-unknown';
export type AdPresentationState = 'not-started' | 'open' | 'closed' | 'unknown';
export type AdRewardEligibility = 'eligible' | 'not-earned' | 'unknown' | 'not-applicable';

export interface AdPlacementInput {
  readonly placementId: string;
  readonly format: AdFormat;
}

export interface AdShowInput extends AdPlacementInput {
  readonly invocationId: string;
  readonly idempotencyKey: string;
}

export interface AdAvailability {
  readonly state: 'available' | 'unsupported' | 'configuration-required'
    | 'action-required' | 'temporarily-unavailable';
  readonly reason?: AdReason;
}

export interface AdPreparationResult {
  readonly status: 'ready' | 'deferred' | 'unavailable' | 'failed';
  readonly reason?: AdReason;
}

export interface AdShowResult {
  readonly providerId: AdProviderId;
  readonly invocationId: string;
  readonly format: AdFormat;
  readonly outcome: 'shown' | 'skipped' | 'unavailable' | 'failed' | 'pending';
  readonly presentation: Exclude<AdPresentationState, 'open'>;
  readonly eligibility: AdRewardEligibility;
  readonly reason?: AdReason;
  /** A callback is a claim candidate only; no ledger grant belongs here. */
  readonly evidence?: PlatformEvidenceEnvelope;
  /** Server proof-lookup correlation; it does not establish local reward eligibility. */
  readonly claimEvidence?: PlatformEvidenceEnvelope;
}

export type AdPresentationEvent = Readonly<{
  providerId: AdProviderId;
  invocationId: string;
  sequence: number;
} & (
  | { type: 'requested'; claimEvidence?: PlatformEvidenceEnvelope }
  | { type: 'started' | 'closed' | 'unknown' }
  | { type: 'reward-earned'; evidence: PlatformEvidenceEnvelope }
  | { type: 'failed'; reason: AdReason }
)>;

/** Provider-facing surface. Runtime arbitration and backend grants are separate owners. */
export interface AdProvider {
  readonly id: AdProviderId;
  readonly protocol: typeof adProtocol;
  readonly protocolVersion: typeof adProtocolVersion;
  readonly rewardSignal: 'immediate' | 'delayed';
  getAvailability(input: AdPlacementInput): Promise<AdAvailability>;
  preload(input: AdPlacementInput): Promise<AdPreparationResult>;
  show(input: AdShowInput): Promise<AdShowResult>;
  /** Install before show; unknown presentation must retain a later close observer. */
  subscribe(listener: (event: AdPresentationEvent) => void): () => void;
}

export interface AdSessionSnapshot {
  readonly providerId: AdProviderId;
  readonly invocationId: string;
  readonly format: AdFormat;
  readonly rewardSignal: 'immediate' | 'delayed';
  readonly sequence: number;
  readonly presentation: AdPresentationState;
  readonly eligibility: AdRewardEligibility;
  readonly started: boolean;
  readonly terminal: boolean;
  readonly reason?: AdReason;
  readonly evidence?: PlatformEvidenceEnvelope;
  readonly claimEvidence?: PlatformEvidenceEnvelope;
}

export function createAdSession(input: {
  readonly providerId: AdProviderId;
  readonly invocationId: string;
  readonly format: AdFormat;
  readonly rewardSignal?: 'immediate' | 'delayed';
}): AdSessionSnapshot {
  assertId(input.providerId, 'providerId');
  assertId(input.invocationId, 'invocationId');
  assertFormat(input.format);
  if (input.rewardSignal !== undefined && input.rewardSignal !== 'immediate' && input.rewardSignal !== 'delayed') {
    throw new TypeError('Invalid ad reward signal.');
  }
  return Object.freeze({
    providerId: input.providerId,
    invocationId: input.invocationId,
    format: input.format,
    rewardSignal: input.rewardSignal ?? 'immediate',
    sequence: 0,
    presentation: 'not-started',
    eligibility: input.format === 'interstitial' ? 'not-applicable' : 'unknown',
    started: false,
    terminal: false,
  });
}

/** Pure transition: stale identities, duplicate events, and late reopen signals are ignored. */
export function reduceAdSession(
  snapshot: AdSessionSnapshot,
  supplied: AdPresentationEvent,
): AdSessionSnapshot {
  const header = assertRecord(supplied);
  assertId(header.providerId, 'providerId');
  assertId(header.invocationId, 'invocationId');
  if (header.providerId !== snapshot.providerId || header.invocationId !== snapshot.invocationId) {
    return snapshot;
  }
  if (!Number.isSafeInteger(header.sequence) || (header.sequence as number) < 1) {
    throw new TypeError('Invalid ad event sequence.');
  }
  if ((header.sequence as number) <= snapshot.sequence) {
    return snapshot;
  }
  const event = assertAdPresentationEvent(supplied);
  const next = { ...snapshot, sequence: event.sequence };
  // A closed invocation may receive delayed reward evidence, but cannot reopen.
  if (snapshot.terminal && (event.type !== 'reward-earned'
    || snapshot.presentation !== 'closed' || snapshot.rewardSignal !== 'delayed')) {
    return Object.freeze(next);
  }
  switch (event.type) {
    case 'requested':
      return Object.freeze({ ...next, ...(snapshot.format !== 'rewarded' || event.claimEvidence === undefined
        ? {} : { claimEvidence: snapshot.claimEvidence ?? event.claimEvidence }) });
    case 'started':
      return Object.freeze({ ...next, presentation: 'open', started: true });
    case 'reward-earned':
      if (snapshot.format !== 'rewarded' || snapshot.eligibility === 'eligible') {
        return Object.freeze(next);
      }
      return Object.freeze({ ...next, eligibility: 'eligible', evidence: event.evidence });
    case 'unknown':
      return Object.freeze({ ...next, presentation: 'unknown', reason: 'outcome-unknown' });
    case 'closed': {
      const { reason: previousReason, claimEvidence, ...closed } = next;
      let eligibility = snapshot.eligibility;
      if (snapshot.format === 'interstitial') {
        eligibility = 'not-applicable';
      } else if (eligibility !== 'eligible') {
        eligibility = snapshot.rewardSignal === 'delayed' ? 'unknown' : 'not-earned';
      }
      return Object.freeze({
        ...closed,
        presentation: 'closed',
        terminal: true,
        ...(previousReason === undefined || previousReason === 'outcome-unknown' ? {} : { reason: previousReason }),
        eligibility,
        ...(claimEvidence === undefined || eligibility === 'not-earned' || eligibility === 'not-applicable'
          ? {} : { claimEvidence }),
      });
    }
    case 'failed': {
      const { claimEvidence, ...failed } = next;
      return Object.freeze({
        ...failed,
        presentation: snapshot.started ? 'closed' : 'not-started',
        terminal: true,
        reason: event.reason,
        ...(snapshot.started && claimEvidence !== undefined ? { claimEvidence } : {}),
      });
    }
  }
}

export function assertAdShowInput(value: unknown): AdShowInput {
  const record = assertRecord(value);
  assertId(record.placementId, 'placementId');
  assertId(record.invocationId, 'invocationId');
  assertId(record.idempotencyKey, 'idempotencyKey');
  assertFormat(record.format);
  return Object.freeze({
    placementId: record.placementId,
    invocationId: record.invocationId,
    idempotencyKey: record.idempotencyKey,
    format: record.format,
  });
}

export function assertAdAvailability(value: unknown): AdAvailability {
  const record = assertRecord(value);
  if (!['available', 'unsupported', 'configuration-required', 'action-required', 'temporarily-unavailable'].includes(
    record.state as string,
  )) {
    throw new TypeError('Invalid ad availability.');
  }
  if (record.reason !== undefined) {
    assertReason(record.reason);
    if (record.state === 'available') {
      throw new TypeError('Available advertising cannot carry an unavailable reason.');
    }
  }
  return Object.freeze({
    state: record.state as AdAvailability['state'],
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  });
}

export function assertAdPreparationResult(value: unknown): AdPreparationResult {
  const record = assertRecord(value);
  if (!['ready', 'deferred', 'unavailable', 'failed'].includes(record.status as string)) {
    throw new TypeError('Invalid ad preparation result.');
  }
  if (record.reason !== undefined) {
    assertReason(record.reason);
    if (record.status === 'ready' || record.status === 'deferred') {
      throw new TypeError('Successful advertising preparation cannot carry a failure reason.');
    }
  }
  return Object.freeze({
    status: record.status as AdPreparationResult['status'],
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  });
}

export function assertAdPresentationEvent(value: unknown): AdPresentationEvent {
  const record = assertRecord(value);
  assertId(record.providerId, 'providerId');
  assertId(record.invocationId, 'invocationId');
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) {
    throw new TypeError('Invalid ad event sequence.');
  }
  const base = {
    providerId: record.providerId,
    invocationId: record.invocationId,
    sequence: record.sequence as number,
  };
  switch (record.type) {
    case 'requested':
      return Object.freeze({ ...base, type: 'requested', ...(record.claimEvidence === undefined
        ? {} : { claimEvidence: assertEvidence(record.claimEvidence) }) });
    case 'started':
    case 'closed':
    case 'unknown':
      return Object.freeze({ ...base, type: record.type });
    case 'failed':
      assertReason(record.reason);
      return Object.freeze({ ...base, type: 'failed', reason: record.reason });
    case 'reward-earned':
      return Object.freeze({
        ...base,
        type: 'reward-earned',
        evidence: assertEvidence(record.evidence),
      });
    default:
      throw new TypeError('Invalid ad event type.');
  }
}

export function assertAdShowResult(value: unknown): AdShowResult {
  const record = assertRecord(value);
  assertId(record.providerId, 'providerId');
  assertId(record.invocationId, 'invocationId');
  assertFormat(record.format);
  if (!['shown', 'skipped', 'unavailable', 'failed', 'pending'].includes(record.outcome as string)
    || !['not-started', 'closed', 'unknown'].includes(record.presentation as string)
    || !['eligible', 'not-earned', 'unknown', 'not-applicable'].includes(record.eligibility as string)) {
    throw new TypeError('Invalid ad result state.');
  }
  if (record.reason !== undefined) {
    assertReason(record.reason);
  }
  if ((record.format === 'interstitial') !== (record.eligibility === 'not-applicable')
    || ((record.outcome === 'shown' || record.outcome === 'skipped') && record.presentation !== 'closed')
    || (record.presentation === 'unknown' && record.outcome !== 'pending')
    || (record.outcome === 'pending' && record.presentation !== 'unknown')
    || (record.outcome === 'unavailable' && record.presentation !== 'not-started')
    || (record.eligibility === 'eligible' && record.presentation === 'not-started')
    || (record.outcome === 'skipped' && record.eligibility === 'eligible')
    || (record.presentation === 'unknown' && record.reason !== 'outcome-unknown')
    || (record.eligibility === 'eligible' && record.evidence === undefined)
    || (record.evidence !== undefined && record.eligibility !== 'eligible')) {
    throw new TypeError('Inconsistent ad result state.');
  }
  if (record.claimEvidence !== undefined && (record.format !== 'rewarded'
    || record.presentation === 'not-started'
    || record.eligibility === 'not-earned' || record.eligibility === 'not-applicable')) {
    throw new TypeError('Inconsistent ad claim candidate state.');
  }
  return Object.freeze({
    providerId: record.providerId,
    invocationId: record.invocationId,
    format: record.format,
    outcome: record.outcome as AdShowResult['outcome'],
    presentation: record.presentation as AdShowResult['presentation'],
    eligibility: record.eligibility as AdRewardEligibility,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.evidence === undefined ? {} : { evidence: assertEvidence(record.evidence) }),
    ...(record.claimEvidence === undefined ? {} : { claimEvidence: assertEvidence(record.claimEvidence) }),
  });
}

/** Additive v1 facade. It never reports an SDK eligibility event as a grant. */
let legacyInterstitialSequence = 0;

export function toAdAdapter(provider: AdProvider): AdAdapter {
  // These ids identify impressions, not authorization. A per-facade nonce survives
  // resettable module counters without requiring DOM/SDK/crypto globals.
  const interstitialSessionId = [
    Date.now().toString(36), Math.random().toString(36).slice(2), Math.random().toString(36).slice(2),
  ].join('-');
  assertId(provider.id, 'providerId');
  if (provider.protocol !== adProtocol || provider.protocolVersion !== adProtocolVersion) {
    throw new TypeError('Unsupported advertising provider protocol.');
  }
  if (provider.rewardSignal !== 'immediate' && provider.rewardSignal !== 'delayed') {
    throw new TypeError('Invalid advertising provider reward signal.');
  }
  return {
    provider,
    async preload(input) {
      if (input.format === 'banner') {
        return;
      }
      assertAdPreparationResult(await provider.preload({ placementId: input.placementId, format: input.format ?? 'rewarded' }));
    },
    async showRewarded(input) {
      const result = assertAdShowResult(await provider.show({
        ...input, format: 'rewarded', invocationId: input.idempotencyKey,
      }));
      if (result.format !== 'rewarded' || result.providerId !== provider.id || result.invocationId !== input.idempotencyKey) {
        throw new TypeError('Ad result does not match its invocation.');
      }
      let status: 'completed' | 'pending' | 'skipped' | 'unavailable' | 'failed';
      if (result.eligibility === 'eligible') {
        status = result.presentation === 'unknown' ? 'pending' : 'completed';
      } else if (result.outcome === 'shown') {
        status = result.eligibility === 'unknown' ? 'pending' : 'skipped';
      } else {
        status = result.outcome;
      }
      const evidence = result.claimEvidence ?? result.evidence;
      return { status, rewardGranted: false, ...(evidence === undefined ? {} : { evidence }) };
    },
    async showInterstitial(input) {
      const invocationId = `legacy-interstitial:${interstitialSessionId}:${++legacyInterstitialSequence}`;
      const result = assertAdShowResult(await provider.show({
        ...input, format: 'interstitial', invocationId, idempotencyKey: invocationId,
      }));
      if (result.format !== 'interstitial' || result.providerId !== provider.id || result.invocationId !== invocationId) {
        throw new TypeError('Ad result does not match its invocation.');
      }
      let status: 'shown' | 'unavailable' | 'skipped' = 'skipped';
      if (result.outcome === 'shown') {
        status = 'shown';
      } else if (result.outcome === 'unavailable') {
        status = 'unavailable';
      }
      return { status };
    },
  };
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an ad contract object.');
  }
  return value as Record<string, unknown>;
}

function assertId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new TypeError(`Invalid ad ${name}.`);
  }
}

function assertFormat(value: unknown): asserts value is AdFormat {
  if (value !== 'rewarded' && value !== 'interstitial') {
    throw new TypeError('Invalid ad format.');
  }
}

function assertReason(value: unknown): asserts value is AdReason {
  if (!['unsupported', 'configuration-required', 'policy-disabled', 'action-required',
    'no-fill', 'busy', 'transient-failure', 'outcome-unknown'].includes(value as string)) {
    throw new TypeError('Invalid ad reason.');
  }
}

function assertEvidence(value: unknown): PlatformEvidenceEnvelope {
  const record = assertRecord(value);
  assertId(record.schema, 'evidence schema');
  const payload = assertRecord(record.payload);
  const entries = Object.entries(payload);
  if (entries.length > 32 || entries.some(([key, item]) => key.length > 128
    || (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean')
    || (typeof item === 'string' && item.length > 4096)
    || (typeof item === 'number' && !Number.isFinite(item)))) {
    throw new TypeError('Invalid ad evidence payload.');
  }
  return Object.freeze({
    schema: record.schema,
    payload: Object.freeze(Object.fromEntries(entries) as Record<string, string | number | boolean>),
  });
}
