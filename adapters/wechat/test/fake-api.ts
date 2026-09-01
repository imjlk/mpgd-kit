import type {
  WechatMiniGameApi,
  WechatMiniGameLifecycleListener,
  WechatMiniGameRequestResult,
  WechatMiniGameShareOptions,
  WechatMiniGameTouchListener,
} from '../src/api.js';

export interface FakeWechatMiniGameApi {
  readonly api: WechatMiniGameApi;
  readonly canvases: unknown[];
  readonly storage: Map<string, unknown>;
  readonly touchListeners: Readonly<Record<
    'start' | 'move' | 'end' | 'cancel',
    Set<WechatMiniGameTouchListener>
  >>;
  readonly lifecycleListeners: Readonly<Record<
    'show' | 'hide',
    Set<WechatMiniGameLifecycleListener>
  >>;
  readonly shareCalls: WechatMiniGameShareOptions[];
}

export function createFakeWechatMiniGameApi(
  overrides: Partial<WechatMiniGameApi> = {},
  includeShare = true,
): FakeWechatMiniGameApi {
  const canvases: unknown[] = [];
  const storage = new Map<string, unknown>();
  const touchListeners = {
    start: new Set<WechatMiniGameTouchListener>(),
    move: new Set<WechatMiniGameTouchListener>(),
    end: new Set<WechatMiniGameTouchListener>(),
    cancel: new Set<WechatMiniGameTouchListener>(),
  };
  const lifecycleListeners = {
    show: new Set<WechatMiniGameLifecycleListener>(),
    hide: new Set<WechatMiniGameLifecycleListener>(),
  };
  const shareCalls: WechatMiniGameShareOptions[] = [];
  const add = <T>(listeners: Set<T>, listener: T) => listeners.add(listener);
  const remove = <T>(listeners: Set<T>, listener: T) => listeners.delete(listener);
  const api = {
    createCanvas() {
      const canvas = { id: `canvas-${String(canvases.length + 1)}` };
      canvases.push(canvas);
      return canvas;
    },
    createImage() {
      return { src: '' };
    },
    getWindowInfo() {
      return {
        windowWidth: 960,
        windowHeight: 540,
        pixelRatio: 2,
        platform: 'devtools',
        language: 'ko',
      };
    },
    getFileSystemManager() {
      return {
        readFile(input) {
          input.success({ data: new Uint8Array([1, 2, 3]) });
        },
      };
    },
    request(input) {
      const result: WechatMiniGameRequestResult = {
        statusCode: 200,
        data: input.responseType === 'arraybuffer'
          ? new Uint8Array([4, 5]).buffer
          : '{"ok":true}',
        header: { 'content-type': 'application/json', ignored: 123 },
      };
      input.success(result);
    },
    onTouchStart: (listener) => add(touchListeners.start, listener),
    offTouchStart: (listener) => remove(touchListeners.start, listener),
    onTouchMove: (listener) => add(touchListeners.move, listener),
    offTouchMove: (listener) => remove(touchListeners.move, listener),
    onTouchEnd: (listener) => add(touchListeners.end, listener),
    offTouchEnd: (listener) => remove(touchListeners.end, listener),
    onTouchCancel: (listener) => add(touchListeners.cancel, listener),
    offTouchCancel: (listener) => remove(touchListeners.cancel, listener),
    onShow: (listener) => add(lifecycleListeners.show, listener),
    offShow: (listener) => remove(lifecycleListeners.show, listener),
    onHide: (listener) => add(lifecycleListeners.hide, listener),
    offHide: (listener) => remove(lifecycleListeners.hide, listener),
    getStorageSync: (key) => storage.get(key) ?? '',
    setStorageSync: (key, value) => storage.set(key, value),
    ...(includeShare
      ? { shareAppMessage: (options: WechatMiniGameShareOptions) => shareCalls.push(options) }
      : {}),
    ...overrides,
  } satisfies WechatMiniGameApi;

  return {
    api,
    canvases,
    storage,
    touchListeners,
    lifecycleListeners,
    shareCalls,
  };
}
