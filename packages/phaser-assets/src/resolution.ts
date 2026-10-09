/** Presentation budgets; logical layout and game simulation stay unchanged. */
export interface RenderQualityPreset {
  id: string;
  label: string;
  maxBackingPixels: number;
  maxDevicePixelRatio: number;
  maxRasterScale: number;
  hudHz: number;
}
export interface RenderQualityPresets {
  defaultQualityId: string;
  qualities: RenderQualityPreset[];
}
export interface RenderBackingSize {
  width: number;
  height: number;
  /** Multiply logical coordinates by these exact, rounded backing-store ratios. */
  scaleX: number;
  scaleY: number;
}
const MAX_BACKING_PIXELS = 16_777_216;
const MAX_INPUT_DIMENSION = 1_000_000_000;

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const countMatches = Object.keys(value).length === keys.length;
  return countMatches && keys.every((key) => Object.hasOwn(value, key));
}
function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function dimension(value: unknown): value is number {
  return bounded(value, 1, MAX_INPUT_DIMENSION);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function validateQuality(value: unknown): RenderQualityPreset {
  if (!hasKeys(value, [
    'id',
    'label',
    'maxBackingPixels',
    'maxDevicePixelRatio',
    'maxRasterScale',
    'hudHz',
  ])) {
    throw new TypeError('Runtime quality fields are missing or unknown.');
  }
  if (!identifier(value.id)) {
    throw new TypeError('Runtime quality requires a bounded lowercase identifier.');
  }
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80) {
    throw new TypeError('Runtime quality requires a label of at most 80 characters.');
  }
  if (/[\u0000-\u001f\u007f]/.test(value.label)) {
    throw new TypeError('Runtime quality labels cannot contain control characters.');
  }
  if (!bounded(value.maxBackingPixels, 1, MAX_BACKING_PIXELS)) {
    throw new TypeError('Runtime backing pixel budget must be an integer from 1 to 16777216.');
  }
  if (!Number.isInteger(value.maxBackingPixels)) {
    throw new TypeError('Runtime backing pixel budget must be an integer from 1 to 16777216.');
  }
  if (!bounded(value.maxDevicePixelRatio, 0.25, 8)) {
    throw new TypeError('Runtime device pixel ratio limit must be between 0.25 and 8.');
  }
  if (!bounded(value.maxRasterScale, 0.25, 4)) {
    throw new TypeError('Runtime raster scale limit must be between 0.25 and 4.');
  }
  if (!bounded(value.hudHz, 1, 120) || !Number.isInteger(value.hudHz)) {
    throw new TypeError('Runtime HUD frequency must be an integer from 1 to 120.');
  }
  return {
    id: value.id,
    label: value.label,
    maxBackingPixels: value.maxBackingPixels,
    maxDevicePixelRatio: value.maxDevicePixelRatio,
    maxRasterScale: value.maxRasterScale,
    hudHz: value.hudHz,
  };
}

/** Validate external preset data atomically, retaining no mutable input references. */
export function validateRenderQualities(value: unknown): RenderQualityPresets {
  if (!hasKeys(value, ['defaultQualityId', 'qualities']) || !identifier(value.defaultQualityId)) {
    throw new TypeError('Runtime qualities require a default identifier and qualities list.');
  }
  if (!Array.isArray(value.qualities) || !value.qualities.length || value.qualities.length > 16) {
    throw new TypeError('Runtime qualities require between 1 and 16 presets.');
  }
  const qualities: RenderQualityPreset[] = [];
  const ids = new Set<string>();
  for (const entry of value.qualities) {
    const quality = validateQuality(entry);
    if (ids.has(quality.id)) {
      throw new TypeError(`Duplicate runtime quality identifier: ${quality.id}.`);
    }
    ids.add(quality.id);
    qualities.push(quality);
  }
  if (!ids.has(value.defaultQualityId)) {
    throw new TypeError('Default runtime quality must identify a supplied preset.');
  }
  return { defaultQualityId: value.defaultQualityId, qualities };
}

/**
 * Fit one uniform raster scale into the logical, CSS/DPR, and total-pixel limits.
 * Floor both axes independently: aspect changes by less than one backing pixel
 * per axis. Each axis has a one-pixel minimum, including extreme aspect ratios.
 * Use scaleX/scaleY for rendering and their inverses for backing-to-logical input;
 * CSS pointer coordinates still map through the host's logical viewport layout.
 */
export function resolveRenderBackingSize(
  layout: { width: number; height: number },
  viewport: { width: number; height: number; devicePixelRatio: number },
  quality: RenderQualityPreset,
): RenderBackingSize {
  const validated = validateQuality(quality);
  if (!layout || !dimension(layout.width) || !dimension(layout.height)) {
    throw new TypeError('Logical layout dimensions must be finite and between 1 and 1000000000.');
  }
  if (!viewport || !dimension(viewport.width) || !dimension(viewport.height)) {
    throw new TypeError('CSS viewport dimensions must be finite and between 1 and 1000000000.');
  }
  if (!bounded(viewport.devicePixelRatio, Number.MIN_VALUE, 64)) {
    throw new TypeError('Device pixel ratio must be finite, positive, and at most 64.');
  }
  const dpr = Math.min(viewport.devicePixelRatio, validated.maxDevicePixelRatio);
  const scale = Math.min(
    validated.maxRasterScale,
    viewport.width * dpr / layout.width,
    viewport.height * dpr / layout.height,
    Math.sqrt(validated.maxBackingPixels / layout.width / layout.height),
    // These caps preserve the total budget when the other axis rounds up to 1px.
    validated.maxBackingPixels / layout.width,
    validated.maxBackingPixels / layout.height,
  );
  let width = Math.max(1, Math.floor(layout.width * scale));
  let height = Math.max(1, Math.floor(layout.height * scale));
  // Protect the integer budget even at floating-point boundary values.
  if (width * height > validated.maxBackingPixels) {
    if (width >= height) {
      width = Math.max(1, Math.floor(validated.maxBackingPixels / height));
    } else {
      height = Math.max(1, Math.floor(validated.maxBackingPixels / width));
    }
  }
  return { width, height, scaleX: width / layout.width, scaleY: height / layout.height };
}
