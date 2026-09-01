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

export function getMiniGameCanvasBounds(info: MiniGameWindowInfo): MiniGameCanvasBounds {
  assertMiniGameWindowInfo(info);
  const values = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: info.width,
    bottom: info.height,
    width: info.width,
    height: info.height,
  } as const;

  return {
    ...values,
    toJSON: () => values,
  };
}

export function mapMiniGameTouchToDesign(
  touch: MiniGameTouch,
  windowInfo: MiniGameWindowInfo,
  designSize: Readonly<{ readonly width: number; readonly height: number }>,
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

  return {
    x: touch.clientX * designSize.width / windowInfo.width,
    y: touch.clientY * designSize.height / windowInfo.height,
  };
}
