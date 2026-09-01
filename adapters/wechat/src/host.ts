import {
  MiniGameRuntimeError,
  type MiniGameHost,
  type MiniGameRequest,
  type MiniGameResponse,
  type MiniGameTouch,
} from '@mpgd/phaser-minigame-runtime';

import {
  createWechatConfigurationError,
  resolveWechatMiniGameApi,
  type WechatMiniGameApi,
  type WechatMiniGameGlobalScope,
  type WechatMiniGameTouch,
  type WechatMiniGameTouchEvent,
  type WechatMiniGameTouchListener,
} from './api.js';

export interface CreateWechatMiniGameHostOptions {
  readonly requestAnimationFrame?: (callback: (time: number) => void) => number | void;
  readonly cancelAnimationFrame?: (id: number) => void;
}

export function createWechatMiniGameHost(
  api: WechatMiniGameApi,
  options: CreateWechatMiniGameHostOptions = resolveWechatAnimationFrameOptions(globalThis),
): MiniGameHost {
  const requestFrame = options.requestAnimationFrame;

  if (requestFrame === undefined) {
    throw createWechatConfigurationError(
      'WECHAT_RAF_UNAVAILABLE',
      'WeChat Mini Game global requestAnimationFrame() is unavailable.',
    );
  }

  readWindowInfo(api);
  const fileSystem = api.getFileSystemManager();
  let primaryCanvas: unknown;

  return {
    kind: 'wechat',
    getWindowInfo() {
      const info = readWindowInfo(api);
      return {
        width: info.windowWidth,
        height: info.windowHeight,
        pixelRatio: info.pixelRatio,
        ...(info.platform === undefined ? {} : { platform: info.platform }),
        ...(info.language === undefined ? {} : { language: info.language }),
      };
    },
    createCanvas(input = {}) {
      if (input.type !== 'offscreen') {
        primaryCanvas ??= api.createCanvas();
        return primaryCanvas;
      }

      primaryCanvas ??= api.createCanvas();
      return api.createCanvas();
    },
    createImage() {
      return api.createImage();
    },
    requestAnimationFrame(callback) {
      return requestFrame((time) => callback(Number.isFinite(time) ? time : Date.now()));
    },
    ...(options.cancelAnimationFrame === undefined
      ? {}
      : { cancelAnimationFrame: options.cancelAnimationFrame }),
    onTouchStart(callback) {
      return subscribeTouch(api.onTouchStart.bind(api), api.offTouchStart.bind(api), callback);
    },
    onTouchMove(callback) {
      return subscribeTouch(api.onTouchMove.bind(api), api.offTouchMove.bind(api), callback);
    },
    onTouchEnd(callback) {
      return subscribeTouch(api.onTouchEnd.bind(api), api.offTouchEnd.bind(api), callback);
    },
    onTouchCancel(callback) {
      return subscribeTouch(api.onTouchCancel.bind(api), api.offTouchCancel.bind(api), callback);
    },
    onPause(callback) {
      return subscribeLifecycle(api.onHide.bind(api), api.offHide.bind(api), callback);
    },
    onResume(callback) {
      return subscribeLifecycle(api.onShow.bind(api), api.offShow.bind(api), callback);
    },
    readLocalFile(path) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        try {
          fileSystem.readFile({
            filePath: path,
            success(result) {
              try {
                resolve(toArrayBuffer(result.data));
              } catch (error) {
                reject(error);
              }
            },
            fail() {
              reject(new MiniGameRuntimeError(
                'WECHAT_FILE_READ_FAILED',
                `Failed to read packaged WeChat Mini Game file: ${path}`,
              ));
            },
          });
        } catch {
          reject(new MiniGameRuntimeError(
            'WECHAT_FILE_READ_FAILED',
            `Failed to read packaged WeChat Mini Game file: ${path}`,
          ));
        }
      });
    },
    request(input) {
      return requestWechatResource(api, input);
    },
  };
}

export function createWechatMiniGameHostFromGlobal(
  scope: WechatMiniGameGlobalScope = globalThis,
): MiniGameHost {
  return createWechatMiniGameHost(
    resolveWechatMiniGameApi(scope),
    resolveWechatAnimationFrameOptions(scope),
  );
}

function resolveWechatAnimationFrameOptions(
  scope: WechatMiniGameGlobalScope,
): CreateWechatMiniGameHostOptions {
  const requestFrame = scope.requestAnimationFrame;
  const cancelFrame = scope.cancelAnimationFrame;

  return {
    ...(typeof requestFrame !== 'function'
      ? {}
      : {
          requestAnimationFrame: (callback: (time: number) => void) =>
            (requestFrame as (callback: (time: number) => void) => number | void)(callback),
        }),
    ...(typeof cancelFrame !== 'function'
      ? {}
      : { cancelAnimationFrame: (id: number) => (cancelFrame as (value: number) => void)(id) }),
  };
}

function readWindowInfo(api: WechatMiniGameApi) {
  const info = api.getWindowInfo?.() ?? api.getSystemInfoSync?.();

  if (info === undefined) {
    throw createWechatConfigurationError(
      'WECHAT_WINDOW_INFO_UNAVAILABLE',
      'WeChat Mini Game window information is unavailable.',
    );
  }

  return info;
}

function subscribeTouch(
  subscribe: (listener: WechatMiniGameTouchListener) => void,
  unsubscribe: (listener: WechatMiniGameTouchListener) => void,
  callback: (touches: readonly MiniGameTouch[]) => void,
): () => void {
  const listener = (event: WechatMiniGameTouchEvent) => {
    callback((event.changedTouches ?? event.touches ?? []).map(normalizeTouch));
  };

  subscribe(listener);
  return createIdempotentUnsubscribe(() => unsubscribe(listener));
}

function subscribeLifecycle(
  subscribe: (listener: () => void) => void,
  unsubscribe: (listener: () => void) => void,
  callback: () => void,
): () => void {
  subscribe(callback);
  return createIdempotentUnsubscribe(() => unsubscribe(callback));
}

function createIdempotentUnsubscribe(unsubscribe: () => void): () => void {
  let active = true;

  return () => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribe();
  };
}

function normalizeTouch(touch: WechatMiniGameTouch): MiniGameTouch {
  if (
    !Number.isFinite(touch.identifier)
    || !Number.isFinite(touch.clientX)
    || !Number.isFinite(touch.clientY)
  ) {
    throw new MiniGameRuntimeError(
      'WECHAT_TOUCH_EVENT_INVALID',
      'WeChat Mini Game touch coordinates must be finite numbers.',
    );
  }

  return {
    identifier: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
  };
}

function toArrayBuffer(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  if (typeof data === 'string') {
    return new TextEncoder().encode(data).buffer;
  }

  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function requestWechatResource(
  api: WechatMiniGameApi,
  input: MiniGameRequest,
): Promise<MiniGameResponse> {
  return new Promise((resolve, reject) => {
    try {
      api.request({
        url: input.url,
        method: 'GET',
        header: input.headers,
        dataType: 'text',
        responseType: input.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
        success(result) {
          try {
            resolve({
              status: assertStatusCode(result.statusCode),
              data: normalizeResponseData(result.data),
              ...(result.header === undefined ? {} : { headers: normalizeHeaders(result.header) }),
            });
          } catch (error) {
            reject(error);
          }
        },
        fail() {
          reject(new MiniGameRuntimeError(
            'WECHAT_REQUEST_FAILED',
            `WeChat Mini Game request failed: ${input.url}`,
          ));
        },
      });
    } catch {
      reject(new MiniGameRuntimeError(
        'WECHAT_REQUEST_FAILED',
        `WeChat Mini Game request failed: ${input.url}`,
      ));
    }
  });
}

function assertStatusCode(status: number): number {
  if (!Number.isInteger(status) || status < 0 || status > 999) {
    throw new MiniGameRuntimeError(
      'WECHAT_REQUEST_RESPONSE_INVALID',
      'WeChat Mini Game returned an invalid HTTP status code.',
    );
  }

  return status;
}

function normalizeResponseData(data: unknown): string | ArrayBuffer {
  if (typeof data === 'string' || data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return toArrayBuffer(data);
  }

  const serialized = JSON.stringify(data);

  if (typeof serialized !== 'string') {
    throw new MiniGameRuntimeError(
      'WECHAT_REQUEST_RESPONSE_INVALID',
      'WeChat Mini Game returned an unsupported response body.',
    );
  }

  return serialized;
}

function normalizeHeaders(
  headers: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      typeof value === 'string' ? [[name, value] as const] : []),
  );
}
