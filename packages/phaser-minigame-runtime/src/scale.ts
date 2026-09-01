import {
  assertMiniGameWindowInfo,
  MiniGameRuntimeError,
  type MiniGameTouch,
  type MiniGameWindowInfo,
} from './host.js';

export interface MiniGameCanvasBounds {
  readonly x: number;
  readonly y: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly toJSON: () => Readonly<Record<string, number>>;
}

export interface MiniGameDesignPoint {
  readonly x: number;
  readonly y: number;
}

export interface MiniGameCanvasDisplayStyle {
  readonly width?: unknown;
  readonly height?: unknown;
  readonly left?: unknown;
  readonly top?: unknown;
  readonly marginLeft?: unknown;
  readonly marginTop?: unknown;
}

export function getMiniGameCanvasBounds(
  info: MiniGameWindowInfo,
  style: MiniGameCanvasDisplayStyle = {},
): MiniGameCanvasBounds {
  assertMiniGameWindowInfo(info);
  const width = resolveCssLength(style.width, info.width, info.width, false);
  const height = resolveCssLength(style.height, info.height, info.height, false);
  const left = resolveCssLength(style.left, 0, info.width, true)
    + resolveCssLength(style.marginLeft, 0, info.width, true);
  const top = resolveCssLength(style.top, 0, info.height, true)
    + resolveCssLength(style.marginTop, 0, info.height, true);
  const values = {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  } as const;

  return {
    ...values,
    toJSON: () => values,
  };
}

function resolveCssLength(
  input: unknown,
  fallback: number,
  percentBase: number,
  allowNegative: boolean,
): number {
  if (input === undefined || input === null || input === '') {
    return fallback;
  }

  if (typeof input === 'number') {
    return Number.isFinite(input) && (allowNegative || input >= 0) ? input : fallback;
  }

  if (typeof input !== 'string') {
    return fallback;
  }

  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|%)?$/iu.exec(input.trim());

  if (match === null) {
    return fallback;
  }

  const numeric = Number(match[1]);
  const value = match[2] === '%' ? numeric * percentBase / 100 : numeric;

  return Number.isFinite(value) && (allowNegative || value >= 0) ? value : fallback;
}

export function mapMiniGameTouchToDesign(
  touch: MiniGameTouch,
  windowInfo: MiniGameWindowInfo,
  designSize: Readonly<{ readonly width: number; readonly height: number }>,
  canvasBounds: Pick<MiniGameCanvasBounds, 'left' | 'top' | 'width' | 'height'> = (
    getMiniGameCanvasBounds(windowInfo)
  ),
): MiniGameDesignPoint {
  assertMiniGameWindowInfo(windowInfo);

  if (
    !Number.isFinite(designSize.width)
    || designSize.width <= 0
    || !Number.isFinite(designSize.height)
    || designSize.height <= 0
  ) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_DESIGN_SIZE',
      'Mini-game design width and height must be positive finite numbers.',
    );
  }

  if (
    !Number.isFinite(canvasBounds.left)
    || !Number.isFinite(canvasBounds.top)
    || !Number.isFinite(canvasBounds.width)
    || canvasBounds.width <= 0
    || !Number.isFinite(canvasBounds.height)
    || canvasBounds.height <= 0
  ) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_CANVAS_BOUNDS',
      'Mini-game canvas bounds must contain finite offsets and positive dimensions.',
    );
  }

  return {
    x: (touch.clientX - canvasBounds.left) * designSize.width / canvasBounds.width,
    y: (touch.clientY - canvasBounds.top) * designSize.height / canvasBounds.height,
  };
}
