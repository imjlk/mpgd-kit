import type Phaser from 'phaser';

const densityAwareTextureMetadataKey = 'mpgdDensityAwareTexture';

export interface DensityAwareTextureMetrics {
  readonly key: string;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly pixelHeight: number;
  readonly pixelWidth: number;
  /** Actual uniform ratio, quantized to integer physical dimensions. */
  readonly resolution: number;
}
interface MutableFrameData {
  readonly sourceSize: { h: number; w: number };
  readonly spriteSourceSize: { h: number; w: number };
  radius: number;
}

/** Bake procedural art while retaining a uniform raster ratio and logical geometry. */
export function generateDensityAwareTexture(
  scene: Phaser.Scene,
  graphics: Phaser.GameObjects.Graphics,
  key: string,
  logicalWidth: number,
  logicalHeight: number,
  resolution: number,
): void {
  const geometry = resolveTextureGeometry(logicalWidth, logicalHeight, resolution);
  requireTextureBudget(key, geometry.pixelWidth, geometry.pixelHeight);
  if (scene.textures.exists(key)) {
    if (readDensityAwareTextureMetrics(scene, key) === undefined) {
      throw new Error(`Cannot replace an unowned density texture: ${key}.`);
    }
    const texture = scene.textures.get(key) as Partial<Phaser.Textures.CanvasTexture>;
    if (typeof texture.setSize !== 'function' || typeof texture.clear !== 'function') {
      throw new Error('Density texture regeneration requires a canvas texture.');
    }
    // Keep the texture and base-frame identities alive for existing images.
    texture.setSize(geometry.pixelWidth, geometry.pixelHeight);
    texture.clear(0, 0, geometry.pixelWidth, geometry.pixelHeight, false);
  }
  const previousScaleX = graphics.scaleX;
  const previousScaleY = graphics.scaleY;
  graphics.setScale(geometry.resolution);
  try {
    graphics.generateTexture(key, geometry.pixelWidth, geometry.pixelHeight);
  } finally {
    graphics.setScale(previousScaleX, previousScaleY);
  }
  normalizeTextureResolution(scene, key, logicalWidth, logicalHeight, resolution);
}

/** Normalize only a texture whose physical axes match one exact uniform ratio. */
export function normalizeTextureResolution(
  scene: Phaser.Scene,
  key: string,
  logicalWidth: number,
  logicalHeight: number,
  resolution: number,
): void {
  const geometry = resolveTextureGeometry(logicalWidth, logicalHeight, resolution);
  requireTextureBudget(key, geometry.pixelWidth, geometry.pixelHeight);
  if (!scene.textures.exists(key)) {
    throw new Error(`Density-aware texture does not exist: ${key}.`);
  }
  const frame = scene.textures.get(key).get();
  if (frame.cutWidth !== geometry.pixelWidth || frame.cutHeight !== geometry.pixelHeight) {
    throw new Error('Physical texture dimensions do not match the uniform density geometry.');
  }
  const frameData = requireMutableFrameData(frame);
  if (typeof frame.customData !== 'object' || frame.customData === null) {
    throw new Error('Phaser frame custom data is unavailable.');
  }
  frame.source.resolution = geometry.resolution;
  frameData.sourceSize.w = logicalWidth;
  frameData.sourceSize.h = logicalHeight;
  frameData.spriteSourceSize.w = logicalWidth;
  frameData.spriteSourceSize.h = logicalHeight;
  frameData.radius = 0.5 * Math.hypot(logicalWidth, logicalHeight);
  Object.assign(frame.customData, {
    [densityAwareTextureMetadataKey]: Object.freeze({
      key, logicalHeight, logicalWidth, ...geometry,
    } satisfies DensityAwareTextureMetrics),
  });
}

export function readDensityAwareTextureMetrics(
  scene: Phaser.Scene,
  key: string,
): DensityAwareTextureMetrics | undefined {
  if (!scene.textures.exists(key)) {
    return undefined;
  }
  const metadata = (scene.textures.get(key).get().customData as Record<string, unknown>)[
    densityAwareTextureMetadataKey
  ];
  return isDensityAwareTextureMetrics(metadata) && metadata.key === key ? metadata : undefined;
}

function resolveTextureGeometry(width: number, height: number, requested: number) {
  for (const dimension of [width, height]) {
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 1_000_000_000) {
      throw new TypeError('logicalWidth/logicalHeight must be integers from 1 to 1000000000.');
    }
  }
  if (!Number.isFinite(requested) || requested <= 0 || requested > 64) {
    throw new TypeError('resolution must be positive, finite, and at most 64.');
  }
  let left = width;
  let right = height;
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  // Phaser has one scalar resolution. Quantize both axes together rather than
  // rounding each separately, which would change render size and aspect ratio.
  const units = Math.max(1, Math.floor(requested * left));
  return {
    pixelWidth: (width / left) * units,
    pixelHeight: (height / left) * units,
    resolution: units / left,
  };
}

function requireMutableFrameData(frame: Phaser.Textures.Frame): MutableFrameData {
  const candidate = (frame as Phaser.Textures.Frame & { readonly data?: unknown }).data;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('Phaser frame source metrics are unavailable.');
  }
  const data = candidate as Partial<MutableFrameData>;
  if (typeof data.sourceSize !== 'object' || data.sourceSize === null
    || typeof data.spriteSourceSize !== 'object' || data.spriteSourceSize === null
    || !Number.isFinite(data.sourceSize.w) || !Number.isFinite(data.sourceSize.h)
    || !Number.isFinite(data.spriteSourceSize.w) || !Number.isFinite(data.spriteSourceSize.h)
    || !Number.isFinite(data.radius)) {
    throw new Error('Phaser frame source metrics have an unsupported shape.');
  }
  return data as MutableFrameData;
}
function requireTextureBudget(key: string, width: number, height: number): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
    throw new TypeError('Density-aware textures require a nonempty key of at most 256 characters.');
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width > 16_384 || height > 16_384 || width * height > 16_777_216) {
    throw new TypeError('Density-aware texture dimensions exceed the supported pixel budget.');
  }
}
function isDensityAwareTextureMetrics(value: unknown): value is DensityAwareTextureMetrics {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<DensityAwareTextureMetrics>;
  return typeof candidate.key === 'string'
    && [candidate.logicalHeight, candidate.logicalWidth, candidate.pixelHeight,
      candidate.pixelWidth, candidate.resolution].every((field) =>
        typeof field === 'number' && Number.isFinite(field) && field > 0);
}
