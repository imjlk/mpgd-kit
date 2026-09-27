import { VerificationException, VerificationStatus } from '@apple/app-store-server-library';
import { AppStoreDependencyUnavailableError } from '@mpgd/game-services/app-store-verifier';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppleSignedTransactionVerifier } from './app-store-server.js';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(async (_input: string): Promise<unknown> => ({})),
  constructor: vi.fn((..._args: unknown[]) => undefined),
}));

vi.mock('@apple/app-store-server-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@apple/app-store-server-library')>();
  return {
    ...actual,
    SignedDataVerifier: class {
      constructor(...args: unknown[]) {
        mocks.constructor(...args);
      }

      verifyAndDecodeTransaction(input: string) {
        return mocks.verify(input);
      }
    },
  };
});

const options = {
  rootCertificates: [Uint8Array.of(1, 2, 3)],
  environment: 'Sandbox' as const,
  bundleId: 'dev.mpgd.game',
};
const input = {
  signedTransaction: 'signed-jws',
  environment: 'Sandbox' as const,
  bundleId: 'dev.mpgd.game',
  signal: new AbortController().signal,
};
const signedPurchase = {
  transactionId: '12345',
  originalTransactionId: '12345',
  bundleId: 'dev.mpgd.game',
  productId: 'coins_100',
  purchaseDate: 1_750_000_000_000,
  signedDate: 1_750_000_000_100,
  environment: 'Sandbox',
  type: 'Consumable',
  quantity: 1,
  appAccountToken: '123e4567-e89b-12d3-a456-426614174000',
};

beforeEach(() => {
  mocks.verify.mockReset();
  mocks.constructor.mockReset();
});

describe('Apple signed transaction adapter', () => {
  it('requires trust roots and an app identifier before constructing the verifier', () => {
    expect(() => createAppleSignedTransactionVerifier({ ...options, rootCertificates: [] }))
      .toThrow('Apple root certificates are required');
    expect(() => createAppleSignedTransactionVerifier({ ...options, bundleId: '' }))
      .toThrow('App Store bundle ID is required');
    expect(() => createAppleSignedTransactionVerifier({ ...options, environment: 'Production' }))
      .toThrow('Production App Store verification requires appAppleId');
    expect(() => createAppleSignedTransactionVerifier({
      ...options, environment: 'Production', appAppleId: 123, enableOnlineChecks: false,
    })).toThrow('Production App Store verification requires online certificate checks');
    expect(() => createAppleSignedTransactionVerifier({
      ...options, environment: 'Xcode' as 'Sandbox',
    })).toThrow('App Store environment must be Production or Sandbox');
    expect(mocks.constructor).not.toHaveBeenCalled();
  });

  it('rejects a verifier scope mismatch without touching the JWS', async () => {
    const verifier = createAppleSignedTransactionVerifier(options);
    expect(await verifier.verifyAndDecode({ ...input, bundleId: 'other.game' })).toEqual({
      status: 'rejected', reason: 'APP_STORE_VERIFIER_SCOPE_MISMATCH',
    });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('exposes only complete, signed one-time transaction fields', async () => {
    mocks.verify.mockResolvedValue(signedPurchase);
    const verifier = createAppleSignedTransactionVerifier(options);
    expect(await verifier.verifyAndDecode(input)).toEqual({
      status: 'verified',
      payload: signedPurchase,
    });
    expect(mocks.verify).toHaveBeenCalledWith('signed-jws');
  });

  it('rejects incomplete and subscription payloads without granting', async () => {
    const verifier = createAppleSignedTransactionVerifier(options);
    mocks.verify.mockResolvedValue({ ...signedPurchase, transactionId: undefined });
    expect(await verifier.verifyAndDecode(input)).toEqual({
      status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_INVALID',
    });
    mocks.verify.mockResolvedValue({ ...signedPurchase, appAccountToken: 123 });
    expect(await verifier.verifyAndDecode(input)).toEqual({
      status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_INVALID',
    });
    mocks.verify.mockResolvedValue({ ...signedPurchase, type: 'Auto-Renewable Subscription' });
    expect(await verifier.verifyAndDecode(input)).toEqual({
      status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_INVALID',
    });
  });

  it('preserves transient verifier failures as pending-capable errors', async () => {
    mocks.verify.mockRejectedValue(new VerificationException(
      VerificationStatus.RETRYABLE_VERIFICATION_FAILURE,
    ));
    const verifier = createAppleSignedTransactionVerifier(options);
    await expect(verifier.verifyAndDecode(input)).rejects.toBeInstanceOf(
      AppStoreDependencyUnavailableError,
    );
  });

  it('rejects invalid signatures without exposing certificate details', async () => {
    mocks.verify.mockRejectedValue(new VerificationException(
      VerificationStatus.VERIFICATION_FAILURE,
    ));
    const verifier = createAppleSignedTransactionVerifier(options);
    expect(await verifier.verifyAndDecode(input)).toEqual({
      status: 'rejected', reason: 'APP_STORE_SIGNATURE_INVALID',
    });
  });

  it('does not accept an oversized JWS or a verification result after cancellation', async () => {
    const verifier = createAppleSignedTransactionVerifier(options);
    expect(await verifier.verifyAndDecode({
      ...input, signedTransaction: 'x'.repeat(512 * 1024 + 1),
    })).toEqual({ status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_INVALID' });
    const controller = new AbortController();
    mocks.verify.mockImplementation(async () => {
      controller.abort(new Error('cancelled'));
      return signedPurchase;
    });
    await expect(verifier.verifyAndDecode({ ...input, signal: controller.signal }))
      .rejects.toThrow('cancelled');
  });

  it('keeps cancellation ahead of signature failure and propagates unexpected faults', async () => {
    const verifier = createAppleSignedTransactionVerifier(options);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error('cancelled before verification'));
    await expect(verifier.verifyAndDecode({ ...input, signal: alreadyAborted.signal }))
      .rejects.toThrow('cancelled before verification');
    expect(mocks.verify).not.toHaveBeenCalled();

    const interrupted = new AbortController();
    mocks.verify.mockImplementationOnce(async () => {
      interrupted.abort(new Error('cancelled during verification'));
      throw new VerificationException(VerificationStatus.VERIFICATION_FAILURE);
    });
    await expect(verifier.verifyAndDecode({ ...input, signal: interrupted.signal }))
      .rejects.toThrow('cancelled during verification');

    mocks.verify.mockRejectedValueOnce(new TypeError('unexpected verifier defect'));
    await expect(verifier.verifyAndDecode(input)).rejects.toThrow('unexpected verifier defect');
  });
});
