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
  type WechatMiniGameFileSystemManager,
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
  resolveWechatMiniGameApi({ wx: api });
  const requestFrame = options.requestAnimationFrame;

  if (requestFrame === undefined) {
    throw createWechatConfigurationError(
      'WECHAT_RAF_UNAVAILABLE',
      'WeChat Mini Game global requestAnimationFrame() is unavailable.',
    );
  }

  readWindowInfo(api);
  const fileSystem = readFileSystemManager(api);
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
  const windowInfo = readWechatInformation(api.getWindowInfo?.bind(api));
  const systemInfo = readWechatInformation(api.getSystemInfoSync?.bind(api));
  const geometry = [windowInfo, systemInfo].find(hasValidWindowGeometry);

  if (geometry === undefined) {
    const unavailable = windowInfo === undefined && systemInfo === undefined;
    throw createWechatConfigurationError(
      unavailable ? 'WECHAT_WINDOW_INFO_UNAVAILABLE' : 'WECHAT_WINDOW_INFO_INVALID',
      unavailable
        ? 'WeChat Mini Game window information is unavailable.'
        : 'WeChat Mini Game window information is invalid.',
    );
  }

  const platform = readOptionalString(windowInfo, 'platform')
    ?? readOptionalString(systemInfo, 'platform');
  const language = readOptionalString(windowInfo, 'language')
    ?? readOptionalString(systemInfo, 'language');

  return {
    windowWidth: geometry.windowWidth,
    windowHeight: geometry.windowHeight,
    pixelRatio: geometry.pixelRatio,
    ...(platform === undefined ? {} : { platform }),
    ...(language === undefined ? {} : { language }),
  };
}

function readWechatInformation(read: (() => unknown) | undefined): unknown {
  if (read === undefined) {
    return undefined;
  }

  try {
    return read();
  } catch {
    return undefined;
  }
}

function hasValidWindowGeometry(input: unknown): input is Readonly<{
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly pixelRatio: number;
}> {
  return isRecord(input)
    && isPositiveFiniteNumber(input.windowWidth)
    && isPositiveFiniteNumber(input.windowHeight)
    && isPositiveFiniteNumber(input.pixelRatio);
}

function readOptionalString(input: unknown, key: 'platform' | 'language'): string | undefined {
  return isRecord(input) && typeof input[key] === 'string' ? input[key] : undefined;
}

function readFileSystemManager(api: WechatMiniGameApi): WechatMiniGameFileSystemManager {
  let fileSystem: unknown;

  try {
    fileSystem = api.getFileSystemManager();
  } catch {
    throw createWechatConfigurationError(
      'WECHAT_FILE_SYSTEM_UNAVAILABLE',
      'WeChat Mini Game packaged-file access is unavailable.',
    );
  }

  if (!isRecord(fileSystem) || typeof fileSystem.readFile !== 'function') {
    throw createWechatConfigurationError(
      'WECHAT_FILE_SYSTEM_UNAVAILABLE',
      'WeChat Mini Game packaged-file access is unavailable.',
    );
  }

  return fileSystem as unknown as WechatMiniGameFileSystemManager;
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
    throw new MiniGameRuntimeError(
      'WECHAT_FILE_RESPONSE_INVALID',
      'WeChat Mini Game packaged-file reads must return binary data.',
    );
  }

  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function requestWechatResource(
  api: WechatMiniGameApi,
  input: MiniGameRequest,
): Promise<MiniGameResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let requestTask: ReturnType<WechatMiniGameApi['request']> | undefined;
    let unsubscribeAbort: () => void = () => undefined;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribeAbort();
      callback();
    };

    if (isMiniGameRequestAborted(input)) {
      settle(() => reject(createWechatRequestAbortedError(input.url)));
      return;
    }
    unsubscribeAbort = input.signal?.onAbort(() => {
      const activeRequestTask = requestTask;
      settle(() => reject(createWechatRequestAbortedError(input.url)));
      try {
        activeRequestTask?.abort();
      } catch {
        // The host promise still settles as aborted when native cancellation throws.
      }
    }) ?? unsubscribeAbort;

    try {
      requestTask = api.request({
        url: input.url,
        method: 'GET',
        header: input.headers,
        dataType: 'text',
        responseType: input.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
        success(result) {
          try {
            const response = {
              status: assertStatusCode(result.statusCode),
              data: normalizeResponseData(result.data),
              url: requireWechatResponseUrl(result.url),
              ...(result.header === undefined ? {} : { headers: normalizeHeaders(result.header) }),
            };
            settle(() => resolve(response));
          } catch (error) {
            settle(() => reject(error));
          }
        },
        fail() {
          settle(() => reject(new MiniGameRuntimeError(
            'WECHAT_REQUEST_FAILED',
            `WeChat Mini Game request failed: ${input.url}`,
          )));
        },
      });
      if (isMiniGameRequestAborted(input)) {
        try {
          requestTask.abort();
        } catch {
          // The cancellation listener has already settled the host promise.
        }
      }
    } catch {
      settle(() => reject(new MiniGameRuntimeError(
        'WECHAT_REQUEST_FAILED',
        `WeChat Mini Game request failed: ${input.url}`,
      )));
    }
  });
}

function requireWechatResponseUrl(url: string | undefined): string {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new MiniGameRuntimeError(
      'WECHAT_REQUEST_FINAL_URL_UNAVAILABLE',
      'WeChat Mini Game remote responses must report their final URL after redirects.',
    );
  }

  return url;
}

function isMiniGameRequestAborted(input: MiniGameRequest): boolean {
  return input.signal?.aborted === true;
}

function createWechatRequestAbortedError(url: string): MiniGameRuntimeError {
  return new MiniGameRuntimeError(
    'WECHAT_REQUEST_ABORTED',
    `WeChat Mini Game request was aborted: ${url}`,
  );
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

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isPositiveFiniteNumber(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input) && input > 0;
}
