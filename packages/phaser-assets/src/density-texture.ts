import type Phaser from 'phaser';

const densityAwareTextureMetadataKey = 'mpgdDensityAwareTexture';

export interface DensityAwareTextureMetrics {
  readonly key: string;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly pixelHeight: number;
  readonly pixelWidth: number;
  readonly resolution: number;
}

interface MutableFrameData {
  readonly sourceSize: { h: number; w: number };
  readonly spriteSourceSize: { h: number; w: number };
  radius: number;
}

/** Bake procedural art densely while preserving logical Image and Sprite geometry. */
export function generateDensityAwareTexture(
  scene: Phaser.Scene,
  graphics: Phaser.GameObjects.Graphics,
  key: string,
  logicalWidth: number,
  logicalHeight: number,
  resolution: number,
): void {
  requirePositiveFinite('logicalWidth', logicalWidth);
  requirePositiveFinite('logicalHeight', logicalHeight);
  requirePositiveFinite('resolution', resolution);
  const pixelWidth = Math.max(1, Math.round(logicalWidth * resolution));
  const pixelHeight = Math.max(1, Math.round(logicalHeight * resolution));
  requireTextureBudget(key, pixelWidth, pixelHeight);
  const previousScaleX = graphics.scaleX;
  const previousScaleY = graphics.scaleY;
  graphics.setScale(resolution);
  try {
    graphics.generateTexture(key, pixelWidth, pixelHeight);
  } finally {
    graphics.setScale(previousScaleX, previousScaleY);
  }

  normalizeTextureResolution(scene, key, logicalWidth, logicalHeight, resolution);
}

/** Retain raster source pixels without enlarging game-world bounds. */
export function normalizeTextureResolution(
  scene: Phaser.Scene,
  key: string,
  logicalWidth: number,
  logicalHeight: number,
  resolution: number,
): void {
  requirePositiveFinite('logicalWidth', logicalWidth);
  requirePositiveFinite('logicalHeight', logicalHeight);
  requirePositiveFinite('resolution', resolution);
  const pixelWidth = Math.max(1, Math.round(logicalWidth * resolution));
  const pixelHeight = Math.max(1, Math.round(logicalHeight * resolution));
  requireTextureBudget(key, pixelWidth, pixelHeight);
  if (!scene.textures.exists(key)) {
    throw new Error(`Density-aware texture does not exist: ${key}.`);
  }
  const texture = scene.textures.get(key);
  const frame = texture.get();
  // Phaser keeps Frame.data private in its declarations. Image sizing still reads these source
  // metrics, so retain the physical cut rectangle and normalize only logical source geometry.
  const frameData = requireMutableFrameData(frame);
  frame.source.resolution = resolution;
  frameData.sourceSize.w = logicalWidth;
  frameData.sourceSize.h = logicalHeight;
  frameData.spriteSourceSize.w = logicalWidth;
  frameData.spriteSourceSize.h = logicalHeight;
  frameData.radius = 0.5 * Math.hypot(logicalWidth, logicalHeight);
  Object.assign(frame.customData, {
    [densityAwareTextureMetadataKey]: Object.freeze({
      key,
      logicalHeight,
      logicalWidth,
      pixelHeight,
      pixelWidth,
      resolution,
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

  const frame = scene.textures.get(key).get();
  const metadata = (frame.customData as Record<string, unknown>)[densityAwareTextureMetadataKey];

  return isDensityAwareTextureMetrics(metadata) && metadata.key === key ? metadata : undefined;
}

function requireMutableFrameData(frame: Phaser.Textures.Frame): MutableFrameData {
  const candidate = (frame as Phaser.Textures.Frame & { readonly data?: unknown }).data;

  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('Phaser frame source metrics are unavailable.');
  }

  const frameData = candidate as Partial<MutableFrameData>;
  if (
    typeof frameData.sourceSize !== 'object'
    || frameData.sourceSize === null
    || typeof frameData.spriteSourceSize !== 'object'
    || frameData.spriteSourceSize === null
    || !Number.isFinite(frameData.sourceSize.w)
    || !Number.isFinite(frameData.sourceSize.h)
    || !Number.isFinite(frameData.spriteSourceSize.w)
    || !Number.isFinite(frameData.spriteSourceSize.h)
    || !Number.isFinite(frameData.radius)
  ) {
    throw new Error('Phaser frame source metrics have an unsupported shape.');
  }

  return frameData as MutableFrameData;
}

function requirePositiveFinite(name: string, value: number): void {
  const maximum = name === 'resolution' ? 64 : 1_000_000_000;
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be positive, finite, and at most ${maximum}.`);
  }
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

function isDensityAwareTextureMetrics(
  value: unknown,
): value is DensityAwareTextureMetrics {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<DensityAwareTextureMetrics>;
  return typeof candidate.key === 'string'
    && [candidate.logicalHeight, candidate.logicalWidth, candidate.pixelHeight,
      candidate.pixelWidth, candidate.resolution].every((value) =>
        typeof value === 'number' && Number.isFinite(value) && value > 0);
}
