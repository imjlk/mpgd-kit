import { describe, expect, it } from 'vitest';

import type { AdPlacementEntry } from '@mpgd/catalog';
import type { ClaimAdRewardRequest, VerifyAdRewardEvidenceInput } from '@mpgd/game-services';

import {
  createVerse8AdsEvidenceVerifier,
  createVerse8AdsVerifierHttpClient,
  Verse8AdsVerifierHttpError,
  type Verse8AdsVerificationRecord,
  type Verse8AdsVerifierClient,
} from './server';

const placement = {
  id: 'CONTINUE_AFTER_FAIL',
  type: 'rewarded',
  reward: {
    type: 'continue',
    amount: 1,
  },
  frequencyCap: {
    cooldownSeconds: 60,
    maxPerSession: 3,
  },
  platformPlacementIds: {
    verse8: 'rewarded_continue',
  },
} as const satisfies AdPlacementEntry;

describe('Verse8 Ads evidence verifier', () => {
  it('consumes a matching server record and emits only trusted ledger metadata', async () => {
    let receivedRequestId: string | undefined;
    let receivedSignal: AbortSignal | undefined;
    const verifier = createVerse8AdsEvidenceVerifier({
      client: {
        async consume(input) {
          receivedRequestId = input.requestId;
          receivedSignal = input.signal;
          return verifiedRecord({
            reward: {
              amount: 999_999,
              type: 'untrusted-verifier-reward',
            },
            adNetwork: 'google',
          });
        },
      },
    });
    const input = verificationInput();

    await expect(verifier.verifyAdReward(input)).resolves.toEqual({
      status: 'verified',
      verificationId: 'verse8:ad-reward:verse8-request-1',
      verifiedAt: '2026-07-16T00:00:00.000Z',
      payload: {
        verse8RequestId: 'verse8-request-1',
        verse8PlacementId: 'rewarded_continue',
        verse8AdNetwork: 'google',
      },
    });
    expect(receivedRequestId).toBe('verse8-request-1');
    expect(receivedSignal).toBe(input.signal);
  });

  it('rejects client evidence mismatches before consuming server evidence', async () => {
    let consumeCalls = 0;
    const verifier = createVerse8AdsEvidenceVerifier({
      client: {
        async consume() {
          consumeCalls += 1;
          return verifiedRecord();
        },
      },
    });

    await expect(verifier.verifyAdReward(verificationInput({
      evidence: {
        schema: 'verse8.ads.reward.v1',
        payload: {
          requestId: 'different-request',
          placementId: 'rewarded_continue',
        },
      },
    }))).resolves.toEqual({
      status: 'rejected',
      reason: 'VERSE8_AD_REQUEST_ID_MISMATCH',
    });
    await expect(verifier.verifyAdReward({
      ...verificationInput(),
      platformPlacementId: 'different-placement',
    })).resolves.toEqual({
      status: 'rejected',
      reason: 'VERSE8_AD_PLACEMENT_MISMATCH',
    });
    expect(consumeCalls).toBe(0);
  });

  it.each([
    {
      label: 'pending',
      record: verifiedRecord({ verified: false, status: 'pending' }),
      expected: {
        status: 'pending',
        reason: 'VERSE8_AD_EVIDENCE_PENDING',
      },
    },
    {
      label: 'consumed',
      record: verifiedRecord({ status: 'consumed' }),
      expected: {
        status: 'rejected',
        reason: 'VERSE8_AD_EVIDENCE_CONSUMED',
      },
    },
    {
      label: 'different user',
      record: verifiedRecord({ userId: '0x9999999999999999' }),
      expected: {
        status: 'rejected',
        reason: 'VERSE8_AD_VERIFIED_USER_MISMATCH',
      },
    },
    {
      label: 'missing timestamp',
      record: recordWithoutVerifiedAt(),
      expected: {
        status: 'rejected',
        reason: 'VERSE8_AD_VERIFIED_AT_INVALID',
      },
    },
  ])('fails closed for a $label server record', async ({ record, expected }) => {
    const verifier = createVerse8AdsEvidenceVerifier({
      client: fixedClient(record),
    });

    await expect(verifier.verifyAdReward(verificationInput())).resolves.toEqual(expected);
  });

  it('matches Verse8 hex accounts case-insensitively', async () => {
    const verifier = createVerse8AdsEvidenceVerifier({
      client: fixedClient(verifiedRecord({ userId: '0xABCDEF1234567890' })),
    });

    await expect(verifier.verifyAdReward(verificationInput())).resolves.toMatchObject({
      status: 'verified',
    });
  });

  it('keeps Verse8 purchase evidence unavailable', async () => {
    const verifier = createVerse8AdsEvidenceVerifier({
      client: fixedClient(verifiedRecord()),
    });

    await expect(verifier.verifyPurchase({
      request: {
        target: 'verse8',
        playerId: '0xabcdef1234567890',
        productId: 'COINS_100',
        platformTransactionId: 'untrusted-client-transaction',
        idempotencyKey: 'purchase-1',
        purchasedAt: '2026-07-16T00:00:00.000Z',
      },
      product: {
        id: 'COINS_100',
        type: 'consumable',
        grant: {
          type: 'currency',
          currency: 'coin',
          amount: 100,
        },
        platformProductIds: {},
      },
      platformProductId: 'verse8-product',
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    })).resolves.toEqual({
      status: 'rejected',
      reason: 'VERSE8_PURCHASE_EVIDENCE_UNSUPPORTED',
    });
  });
});

describe('Verse8 Ads verifier HTTP client', () => {
  it('posts only the request id with the configured authorization and signal', async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const signal = new AbortController().signal;
    const client = createVerse8AdsVerifierHttpClient({
      authorization: async () => 'Bearer verse8-server-secret',
      baseUrl: 'https://verifier.test/custom/',
      async fetch(url, init) {
        requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
        return Response.json(verifiedRecord());
      },
    });

    await expect(client.consume({
      requestId: 'verse8-request-1',
      signal,
    })).resolves.toEqual(verifiedRecord());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://verifier.test/custom/ads/verify');
    expect(requests[0]?.init).toMatchObject({
      method: 'POST',
      body: '{"requestId":"verse8-request-1"}',
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer verse8-server-secret',
        'Content-Type': 'application/json',
      },
    });
  });

  it('rejects insecure endpoints and unauthorized verifier responses', async () => {
    expect(() => createVerse8AdsVerifierHttpClient({
      authorization: 'Bearer secret',
      baseUrl: 'http://verifier.test',
      async fetch() {
        return Response.json(verifiedRecord());
      },
    })).toThrow('must use HTTPS');

    const client = createVerse8AdsVerifierHttpClient({
      authorization: 'Bearer invalid',
      async fetch() {
        return Response.json({ error: 'invalid_key' }, { status: 403 });
      },
    });

    await expect(client.consume({
      requestId: 'verse8-request-1',
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<Verse8AdsVerifierHttpError>>({
      name: 'Verse8AdsVerifierHttpError',
      status: 403,
      code: 'invalid_key',
    }));
  });

  it('rejects oversized verifier responses before parsing them', async () => {
    const client = createVerse8AdsVerifierHttpClient({
      authorization: 'Bearer secret',
      async fetch() {
        return new Response('x'.repeat(65_537));
      },
    });

    await expect(client.consume({
      requestId: 'verse8-request-1',
      signal: new AbortController().signal,
    })).rejects.toThrow('exceeds the maximum size');
  });
});

function verificationInput(
  requestOverrides: Partial<ClaimAdRewardRequest> = {},
): VerifyAdRewardEvidenceInput {
  return {
    request: {
      target: 'verse8',
      playerId: '0xabcdef1234567890',
      placementId: 'CONTINUE_AFTER_FAIL',
      platformImpressionId: 'verse8-request-1',
      idempotencyKey: 'reward-1',
      completedAt: '2026-07-16T00:00:01.000Z',
      evidence: {
        schema: 'verse8.ads.reward.v1',
        payload: {
          requestId: 'verse8-request-1',
          placementId: 'rewarded_continue',
        },
      },
      ...requestOverrides,
    },
    placement,
    platformPlacementId: 'rewarded_continue',
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  };
}

function verifiedRecord(
  overrides: Partial<Verse8AdsVerificationRecord> = {},
): Verse8AdsVerificationRecord {
  return {
    verified: true,
    status: 'verified',
    requestId: 'verse8-request-1',
    placementId: 'rewarded_continue',
    userId: '0xabcdef1234567890',
    verifiedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

function fixedClient(record: Verse8AdsVerificationRecord): Verse8AdsVerifierClient {
  return {
    async consume() {
      return record;
    },
  };
}

function recordWithoutVerifiedAt(): Verse8AdsVerificationRecord {
  const { verifiedAt: _verifiedAt, ...record } = verifiedRecord();

  return record;
}
