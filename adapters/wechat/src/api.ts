import { PlatformOperationError } from '@mpgd/platform';

export interface WechatMiniGameWindowInfoResult {
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly pixelRatio: number;
  readonly platform?: string;
  readonly language?: string;
}

export interface WechatMiniGameTouch {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface WechatMiniGameTouchEvent {
  readonly touches?: readonly WechatMiniGameTouch[];
  readonly changedTouches?: readonly WechatMiniGameTouch[];
}

export type WechatMiniGameTouchListener = (event: WechatMiniGameTouchEvent) => void;
export type WechatMiniGameLifecycleListener = () => void;

export interface WechatMiniGameReadFileResult {
  readonly data: string | ArrayBuffer | ArrayBufferView;
}

export interface WechatMiniGameFileSystemManager {
  readFile(input: Readonly<{
    readonly filePath: string;
    readonly success: (result: WechatMiniGameReadFileResult) => void;
    readonly fail: (error: unknown) => void;
  }>): void;
}

export interface WechatMiniGameRequestResult {
  readonly statusCode: number;
  readonly data: unknown;
  readonly header?: Readonly<Record<string, unknown>>;
}

export interface WechatMiniGameShareOptions {
  readonly title?: string;
  readonly query?: string;
  readonly imageUrl?: string;
}

export interface WechatMiniGameApi {
  createCanvas(): unknown;
  createImage(): unknown;
  getWindowInfo?(): WechatMiniGameWindowInfoResult;
  getSystemInfoSync?(): WechatMiniGameWindowInfoResult;
  getFileSystemManager(): WechatMiniGameFileSystemManager;
  request(input: Readonly<{
    readonly url: string;
    readonly method: 'GET';
    readonly header: Readonly<Record<string, string>>;
    readonly dataType: 'text';
    readonly responseType: 'text' | 'arraybuffer';
    readonly success: (result: WechatMiniGameRequestResult) => void;
    readonly fail: (error: unknown) => void;
  }>): void;
  onTouchStart(listener: WechatMiniGameTouchListener): void;
  offTouchStart(listener: WechatMiniGameTouchListener): void;
  onTouchMove(listener: WechatMiniGameTouchListener): void;
  offTouchMove(listener: WechatMiniGameTouchListener): void;
  onTouchEnd(listener: WechatMiniGameTouchListener): void;
  offTouchEnd(listener: WechatMiniGameTouchListener): void;
  onTouchCancel(listener: WechatMiniGameTouchListener): void;
  offTouchCancel(listener: WechatMiniGameTouchListener): void;
  onShow(listener: WechatMiniGameLifecycleListener): void;
  offShow(listener: WechatMiniGameLifecycleListener): void;
  onHide(listener: WechatMiniGameLifecycleListener): void;
  offHide(listener: WechatMiniGameLifecycleListener): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  shareAppMessage?(options: WechatMiniGameShareOptions): void;
}

export interface WechatMiniGameGlobalScope {
  readonly wx?: unknown;
  readonly requestAnimationFrame?: unknown;
  readonly cancelAnimationFrame?: unknown;
}

export function resolveWechatMiniGameApi(scope: WechatMiniGameGlobalScope): WechatMiniGameApi {
  if (!isRecord(scope.wx)) {
    throw createWechatConfigurationError(
      'WECHAT_API_UNAVAILABLE',
      'WeChat Mini Game global wx API is unavailable.',
    );
  }

  assertMethod(scope.wx, 'createCanvas');
  assertMethod(scope.wx, 'createImage');
  if (typeof scope.wx.getWindowInfo !== 'function' && typeof scope.wx.getSystemInfoSync !== 'function') {
    throw createWechatConfigurationError(
      'WECHAT_WINDOW_INFO_UNAVAILABLE',
      'WeChat Mini Game requires wx.getWindowInfo() or wx.getSystemInfoSync().',
    );
  }
  for (const method of [
    'getFileSystemManager',
    'request',
    'onTouchStart',
    'offTouchStart',
    'onTouchMove',
    'offTouchMove',
    'onTouchEnd',
    'offTouchEnd',
    'onTouchCancel',
    'offTouchCancel',
    'onShow',
    'offShow',
    'onHide',
    'offHide',
    'getStorageSync',
    'setStorageSync',
  ] as const) {
    assertMethod(scope.wx, method);
  }
  if (scope.wx.shareAppMessage !== undefined) {
    assertMethod(scope.wx, 'shareAppMessage');
  }

  return scope.wx as unknown as WechatMiniGameApi;
}

export function createWechatConfigurationError(
  code: string,
  message: string,
): PlatformOperationError {
  return new PlatformOperationError({ code, message, retryable: false });
}

function assertMethod(input: Record<string, unknown>, name: string): void {
  if (typeof input[name] !== 'function') {
    throw createWechatConfigurationError(
      'WECHAT_API_METHOD_UNAVAILABLE',
      `WeChat Mini Game API method wx.${name}() is unavailable.`,
    );
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
