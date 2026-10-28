import type { PluginListenerHandle } from '@capacitor/core';
import * as adapterCapacitor from '@mpgd/adapter-capacitor';

// The sheet facts of the StoreKit SDK come from `createNativePurchasePresentation`
// of `@mpgd/adapter-capacitor`, read through the module namespace: with an
// adapter from before it the export is missing (no link error), the SDK
// declares no facts, and that adapter never asks for them. The types mirror
// the adapter's field for field so this package's declarations still
// type-check against such an adapter.

export type StoreKitPurchasePresentationState = 'open' | 'closed' | 'not-started' | 'unknown';

/** A sheet fact of one `requestPurchase` call; see `StoreSdkPurchasePresentationEvent`. */
export interface StoreKitSdkPurchasePresentationEvent {
  readonly presentationId: string;
  readonly state: StoreKitPurchasePresentationState;
  readonly reason?: 'interrupted' | 'timeout';
}

/** The SDK's `purchasePresentation`; see `StoreSdkPurchasePresentation` in `@mpgd/adapter-capacitor`. */
export interface StoreKitSdkPurchasePresentation {
  subscribe(listener: (event: StoreKitSdkPurchasePresentationEvent) => void): () => void;
}

/** See `NativePurchasePresentation` in `@mpgd/adapter-capacitor`. */
export interface StoreKitNativePurchasePresentation {
  readonly purchasePresentation: StoreKitSdkPurchasePresentation;
  supported(): Promise<boolean>;
  followed(): boolean;
  begin(presentationId: string): void;
  answered(presentationId: string, answerOrError: unknown): void;
}

/** The native surface the facts need: the plugin's event and support check. */
export interface StoreKitNativePresentationPlugin {
  addListener(
    eventName: 'purchasePresentation',
    listener: (event: unknown) => void,
  ): Promise<PluginListenerHandle>;
  readonly getPresentationSupport?: () => Promise<unknown>;
}

/** The adapter's facts helper over `native`, or undefined with an adapter from before it. */
export function resolveStoreKitNativePurchasePresentation(
  native: StoreKitNativePresentationPlugin,
  adapterExports: object = adapterCapacitor,
): StoreKitNativePurchasePresentation | undefined {
  const factory = (adapterExports as Readonly<Record<string, unknown>>).createNativePurchasePresentation;
  if (typeof factory !== 'function') {
    return undefined;
  }
  return (factory as (plugin: unknown) => StoreKitNativePurchasePresentation)(native);
}
