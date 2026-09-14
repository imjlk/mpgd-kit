import type { PhaserAssetPack } from '@mpgd/phaser-assets/packs';

/** Build-report metadata belongs to the sample, not the runtime package. */
export interface DeliveryPack extends PhaserAssetPack {
  readonly packaged: boolean;
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string; readonly mediaType: string; readonly width: number; readonly height: number }[];
}
