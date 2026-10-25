import {
  CapacitorGameServices,
  type CapacitorGameServicesPlugin,
} from '@mpgd/capacitor-game-services';

/** The part of `@mpgd/capacitor-game-services` the renderer read calls. */
export type CapacitorAdvertisingPushRendererPlugin = Pick<
  CapacitorGameServicesPlugin,
  'getAdvertisingPushRenderer'
>;

/**
 * Whether this Android shell renders advertising pushes itself, with the
 * opt-out action: the messaging service Firebase Messaging resolves is the
 * kit's renderer (`dev.mpgd.capacitor.AdvertisingMessagingService`, which
 * `mpgd target init capacitor --providers notifications` declares in a new
 * Android project). Pass it as the provider's `advertisingRenderer`, which
 * then registers `rendersAdvertising` on Android. It throws when the plugin
 * answers anything but `{ installed: boolean }`, and the plugin rejects it as
 * unimplemented on iOS and in a shell built with an older plugin; the
 * provider reports either failure and registers without the claim.
 */
export async function readCapacitorAdvertisingPushRenderer(
  plugin: CapacitorAdvertisingPushRendererPlugin = CapacitorGameServices,
): Promise<boolean> {
  const result: unknown = await plugin.getAdvertisingPushRenderer();
  const installed = typeof result === 'object' && result !== null
    ? (result as { readonly installed?: unknown }).installed
    : undefined;
  if (typeof installed !== 'boolean') {
    throw new Error('The advertising push renderer read answered no installed flag.');
  }
  return installed;
}
