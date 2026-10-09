export interface RenderDensityPolicy {
  readonly maximumBackingPixels: number;
  readonly maximumDensity: number;
  readonly precision?: number;
}

export interface RenderDensityInput {
  readonly devicePixelRatio: number;
  readonly height: number;
  readonly width: number;
}

export interface RenderDensitySnapshot extends RenderDensityInput {
  readonly density: number;
  readonly revision: number;
}

export interface RenderDensityStore {
  readonly getSnapshot: () => RenderDensitySnapshot;
  readonly update: (input: RenderDensityInput) => RenderDensitySnapshot;
}

interface ResolutionMediaQuery {
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface DevicePixelRatioSource {
  readonly devicePixelRatio: number;
  readonly matchMedia: (query: string) => ResolutionMediaQuery;
}

export function createRenderDensityStore(
  input: RenderDensityInput,
  policy: RenderDensityPolicy,
): RenderDensityStore {
  const stablePolicy = Object.freeze({ ...policy });
  let snapshot = createRenderDensitySnapshot(input, stablePolicy, 0);

  return {
    getSnapshot: () => snapshot,
    update(nextInput) {
      const nextDevicePixelRatio = normalizeDevicePixelRatio(nextInput.devicePixelRatio);

      if (
        nextDevicePixelRatio === snapshot.devicePixelRatio
        && nextInput.height === snapshot.height
        && nextInput.width === snapshot.width
      ) {
        return snapshot;
      }

      snapshot = createRenderDensitySnapshot(
        { ...nextInput, devicePixelRatio: nextDevicePixelRatio },
        stablePolicy,
        snapshot.revision + 1,
      );
      return snapshot;
    },
  };
}

/** Observe DPR-only screen changes that may not emit a window resize. */
export function observeDevicePixelRatio(
  source: DevicePixelRatioSource,
  onChange: (devicePixelRatio: number) => void,
): () => void {
  if (typeof source?.matchMedia !== 'function' || typeof onChange !== 'function') {
    throw new TypeError('DPR observation requires a media-query source and a callback.');
  }
  let disposed = false;
  let observedDensity = normalizeDevicePixelRatio(source.devicePixelRatio);
  let mediaQuery: ResolutionMediaQuery | undefined;

  const handleChange = (): void => {
    if (disposed) {
      return;
    }

    const nextDensity = normalizeDevicePixelRatio(source.devicePixelRatio);
    arm(nextDensity);

    if (nextDensity === observedDensity) {
      return;
    }

    observedDensity = nextDensity;
    onChange(nextDensity);
  };
  const arm = (density: number): void => {
    mediaQuery?.removeEventListener('change', handleChange);
    mediaQuery = source.matchMedia(`(resolution: ${density}dppx)`);
    mediaQuery.addEventListener('change', handleChange);
  };

  arm(observedDensity);

  return () => {
    disposed = true;
    mediaQuery?.removeEventListener('change', handleChange);
    mediaQuery = undefined;
  };
}

/**
 * Preserve a minimum texture density of 1. When logical pixels already exceed
 * the budget, use resolveRenderBackingSize instead to permit downscaling.
 */
export function resolveRenderDensity(
  input: RenderDensityInput,
  policy: RenderDensityPolicy,
): number {
  requirePositiveFinite('width', input.width);
  requirePositiveFinite('height', input.height);
  requirePositiveFinite('maximumBackingPixels', policy.maximumBackingPixels);
  requireAtLeastOne('maximumDensity', policy.maximumDensity);
  if (!Number.isInteger(policy.maximumBackingPixels) || policy.maximumBackingPixels > 16_777_216) {
    throw new TypeError('maximumBackingPixels must be an integer from 1 to 16777216.');
  }
  const precision = policy.precision ?? 2;

  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw new TypeError('precision must be an integer between 0 and 6.');
  }

  const deviceDensity = normalizeDevicePixelRatio(input.devicePixelRatio);
  const budgetDensity = Math.sqrt(policy.maximumBackingPixels / (input.width * input.height));
  const precisionScale = 10 ** precision;
  const maximum = Math.max(1, Math.min(policy.maximumDensity, deviceDensity, budgetDensity));
  // Search integer precision steps instead of subtracting potentially millions
  // of tiny increments when rounded pixels cross the budget.
  let low = precisionScale;
  let high = Math.floor(maximum * precisionScale);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const density = middle / precisionScale;
    if (toRenderPixels(input.width, density) * toRenderPixels(input.height, density)
      <= policy.maximumBackingPixels) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low / precisionScale;
}

export function toRenderPixels(
  logicalPixels: number,
  renderDensity: number,
): number {
  requirePositiveFinite('logicalPixels', logicalPixels);
  requireAtLeastOne('renderDensity', renderDensity);
  return Math.max(1, Math.round(logicalPixels * renderDensity));
}

function createRenderDensitySnapshot(
  input: RenderDensityInput,
  policy: RenderDensityPolicy,
  revision: number,
): RenderDensitySnapshot {
  const devicePixelRatio = normalizeDevicePixelRatio(input.devicePixelRatio);

  return Object.freeze({
    width: input.width,
    height: input.height,
    devicePixelRatio,
    density: resolveRenderDensity({ ...input, devicePixelRatio }, policy),
    revision,
  });
}

function normalizeDevicePixelRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(1, value) : 1;
}

function requirePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1 || value > 1_000_000_000) {
    throw new TypeError(`${name} must be finite and between 1 and 1000000000.`);
  }
}

function requireAtLeastOne(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1 || value > 64) {
    throw new TypeError(`${name} must be finite and between 1 and 64.`);
  }
}
