/**
 * @deprecated Moved to `@mpgd/game-services/app-store-server` in A4 of the
 * commerce v2 plan: server-side App Store verification does not belong in the
 * client adapter. This subpath re-exports the same symbols for one release and
 * will be removed in the next major version. Install
 * `@apple/app-store-server-library` next to `@mpgd/game-services`.
 */
import {
  createAppleSignedTransactionVerifier as createAppleSignedTransactionVerifierFromGameServices,
  type CreateAppleSignedTransactionVerifierOptions as GameServicesAppleVerifierOptions,
} from '@mpgd/game-services/app-store-server';

/** @deprecated Import `createAppleSignedTransactionVerifier` from `@mpgd/game-services/app-store-server`. */
export const createAppleSignedTransactionVerifier = createAppleSignedTransactionVerifierFromGameServices;

/** @deprecated Import `CreateAppleSignedTransactionVerifierOptions` from `@mpgd/game-services/app-store-server`. */
export type CreateAppleSignedTransactionVerifierOptions = GameServicesAppleVerifierOptions;
