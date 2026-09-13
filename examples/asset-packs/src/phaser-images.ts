import { definePhaserAssetManifest, loadPhaserAssets } from '@mpgd/phaser-assets';
import Phaser from 'phaser';

import { cancelled, type PreparedImage } from './leases.js';
import type { PlannedImage } from './packs.js';
import { verifiedImage } from './verified-fetch.js';

/** Owns this sample's loader queue. Fetches can overlap; Phaser decoding is serialized. */
export function createImagePreparer(scene: Phaser.Scene, locate: (image: PlannedImage) => URL) {
  let queue = Promise.resolve();
  let generation = 0;

  async function decode(blob: Blob, image: PlannedImage, signal: AbortSignal): Promise<PreparedImage> {
    if (signal.aborted) throw cancelled();
    // A late, cancelled decoder must never delete a replacement generation's texture.
    const textureKey = `pack:${image.packId}:${image.id}:${++generation}`;
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        let failed = false;
        const onError = (file: Phaser.Loader.File): void => { if (file.key === textureKey) failed = true; };
        const cleanup = (): void => {
          scene.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onError);
          scene.load.off(Phaser.Loader.Events.COMPLETE, onComplete);
          scene.events.off(Phaser.Scenes.Events.SHUTDOWN, onShutdown);
        };
        const onComplete = (): void => {
          cleanup();
          if (failed || !scene.textures.exists(textureKey)) reject(new Error(`Image preparation failed: ${image.id}`));
          else resolve();
        };
        const onShutdown = (): void => { cleanup(); reject(cancelled()); };
        scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onError);
        scene.load.once(Phaser.Loader.Events.COMPLETE, onComplete);
        scene.events.once(Phaser.Scenes.Events.SHUTDOWN, onShutdown);
        try {
          loadPhaserAssets(scene, definePhaserAssetManifest([{ kind: 'image', key: textureKey, url }]));
          scene.load.start();
        } catch (error) { cleanup(); reject(error); }
      });
      const source = scene.textures.get(textureKey).getSourceImage();
      if (!(source instanceof HTMLImageElement)) throw new Error('This prototype prepares images only');
      await source.decode();
      if (source.naturalWidth !== image.width || source.naturalHeight !== image.height) throw new Error(`Dimension mismatch: ${image.id}`);
      // Canvas-only sample: force an actual draw before level entry. No WebGL claim.
      const scratch = document.createElement('canvas');
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext('2d');
      if (!context) throw new Error('Canvas preparation unavailable');
      context.drawImage(source, 0, 0);
      if (signal.aborted) throw cancelled();
      let disposed = false;
      return { textureKey, dispose() {
        if (disposed) return;
        disposed = true;
        scene.textures.remove(textureKey);
      } };
    } catch (error) {
      if (scene.textures.exists(textureKey)) scene.textures.remove(textureKey);
      throw error;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return async (image: PlannedImage, signal: AbortSignal): Promise<PreparedImage> => {
    const blob = await verifiedImage(locate(image), image, signal);
    const prepared = queue.then(() => decode(blob, image, signal));
    queue = prepared.then(() => {}, () => {});
    return prepared;
  };
}
