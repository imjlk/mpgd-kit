import type { ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import {
  createGameServicesRuntime,
  resolveGameServicesAuthorityMode,
  resolveGameServicesBaseUrl,
  resolveGameServicesTransport,
  type GameServicesRuntime,
  type GameServicesRuntimeMode,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import type { PlatformGateway } from '@mpgd/platform';
import type { GameActionReconciliationPort } from '@mpgd/game-runtime/actions';
import type { PurchasePresentationEvent } from '@mpgd/game-runtime/ads';

import { resolveStarterCommerceProducts } from './commerceProducts';
import { createStorageMonetizationOperationStore } from './monetizationJournal';

const productCatalog = productCatalogJson as ProductCatalog;

/**
 * Game-owned monetization ports. `operationStore` replaces the reference
 * journal over platform storage with an encrypted, access-controlled one;
 * `reconciliation` and `purchasePresentation` supply trusted native facts.
 */
export interface StarterMonetizationPorts {
  readonly operationStore: MonetizationOperationStore;
  readonly reconciliation?: GameActionReconciliationPort;
  readonly purchasePresentation?: { subscribe(listener: (event: PurchasePresentationEvent) => void): () => void };
}

export type StarterBackendMode = GameServicesRuntimeMode;
export type StarterGameServices = GameServicesRuntime;

/**
 * Game-services runtime over the commerce v2 reconciler: every purchase is
 * journaled in a durable `MonetizationOperationStore` (the reference journal
 * over the platform storage adapter unless the game supplies its own) and
 * verified through the backend ledger, with the catalog's kinds and SKUs for
 * the gateway target resolved without a store read.
 */
export function createStarterGameServices(input: {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
  readonly configTarget: string;
  readonly operationStore?: MonetizationOperationStore;
}): StarterGameServices {
  const baseUrl = resolveGameServicesBaseUrl(import.meta.env.VITE_MPGD_GAME_SERVICES_URL, {
    target: input.gateway.target,
    ...(globalThis.location?.origin === undefined ? {} : { pageOrigin: globalThis.location.origin }),
  });
  return createGameServicesRuntime({
    gateway: input.gateway,
    playerId: input.playerId,
    operationStore: input.operationStore
      ?? createStorageMonetizationOperationStore({ storage: input.gateway.storage }),
    commerceProducts: resolveStarterCommerceProducts(productCatalog, input.configTarget),
    authorityMode: resolveGameServicesAuthorityMode(import.meta.env.MODE),
    target: import.meta.env.VITE_MPGD_GAME_SERVICES_TARGET ?? input.gateway.target,
    deploymentTarget: input.configTarget,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    transport: resolveGameServicesTransport(import.meta.env.VITE_MPGD_GAME_SERVICES_TRANSPORT),
  });
}
