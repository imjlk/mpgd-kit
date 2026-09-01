import { describe, expect, it } from 'vitest';

import { MiniGameRuntimeError } from '@mpgd/phaser-minigame-runtime';
import { PlatformOperationError } from '@mpgd/platform';

import {
  createWechatMiniGameHost,
  createWechatMiniGameHostFromGlobal,
  resolveWechatMiniGameApi,
  type WechatMiniGameApi,
} from '../src/index.js';
import { createFakeWechatMiniGameApi } from './fake-api.js';

describe('WeChat Mini Game host', () => {
  it('resolves the injected global API without capturing it at module load', () => {
    const fake = createFakeWechatMiniGameApi();

    expect(resolveWechatMiniGameApi({ wx: fake.api })).toBe(fake.api);
    expect(() => resolveWechatMiniGameApi({})).toThrowError(
      expect.objectContaining({ code: 'WECHAT_API_UNAVAILABLE' }),
    );
    expect(() => resolveWechatMiniGameApi({ wx: { createCanvas() {} } })).toThrowError(
      expect.objectContaining({ code: 'WECHAT_API_METHOD_UNAVAILABLE' }),
    );
    expect(() => resolveWechatMiniGameApi({
      wx: { ...fake.api, shareAppMessage: 'not-a-function' },
    })).toThrowError(PlatformOperationError);
    expect(() => resolveWechatMiniGameApi({
      wx: { ...fake.api, shareAppMessage: 'not-a-function' },
    })).toThrowError(expect.objectContaining({
      code: 'WECHAT_API_METHOD_UNAVAILABLE',
      retryable: false,
    }));
  });

  it('creates the primary canvas before offscreen canvases and reports window information', () => {
    const fake = createFakeWechatMiniGameApi();
    const host = createWechatMiniGameHost(fake.api, {
      requestAnimationFrame(callback) {
        callback(12);
        return 7;
      },
    });

    const offscreen = host.createCanvas({ type: 'offscreen' });
    const primary = host.createCanvas({ type: 'primary' });

    expect(fake.canvases).toHaveLength(2);
    expect(primary).toBe(fake.canvases[0]);
    expect(offscreen).toBe(fake.canvases[1]);
    expect(host.createCanvas()).toBe(primary);
    expect(host.getWindowInfo()).toEqual({
      width: 960,
      height: 540,
      pixelRatio: 2,
      platform: 'devtools',
      language: 'ko',
    });
  });

  it('uses the runtime-global RAF and maps changed touches with idempotent cleanup', () => {
    const fake = createFakeWechatMiniGameApi();
    const frames: number[] = [];
    const cancelled: number[] = [];
    const host = createWechatMiniGameHostFromGlobal({
      wx: fake.api,
      requestAnimationFrame(callback: (time: number) => void) {
        callback(44);
        return 9;
      },
      cancelAnimationFrame(id: number) {
        cancelled.push(id);
      },
    });

    expect(host.requestAnimationFrame((time) => frames.push(time))).toBe(9);
    host.cancelAnimationFrame?.(9);

    const observed: unknown[] = [];
    const unsubscribe = host.onTouchEnd((touches) => observed.push(touches));
    const listener = [...fake.touchListeners.end][0];
    listener?.({
      touches: [],
      changedTouches: [{ identifier: 3, clientX: 14, clientY: 15 }],
    });
    unsubscribe();
    unsubscribe();

    expect(frames).toEqual([44]);
    expect(cancelled).toEqual([9]);
    expect(observed).toEqual([[{ identifier: 3, clientX: 14, clientY: 15 }]]);
    expect(fake.touchListeners.end.size).toBe(0);
  });

  it('loads packaged bytes and normalizes remote text and binary responses', async () => {
    const fake = createFakeWechatMiniGameApi();
    const host = createWechatMiniGameHost(fake.api, {
      requestAnimationFrame: () => 1,
    });

    expect([...new Uint8Array(await host.readLocalFile?.('assets/logo.png') as ArrayBuffer)])
      .toEqual([1, 2, 3]);
    await expect(host.request?.({
      url: 'https://assets.example.test/config.json',
      method: 'GET',
      headers: {},
      responseType: 'json',
    })).resolves.toEqual({
      status: 200,
      data: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    });
    const binary = await host.request?.({
      url: 'https://assets.example.test/logo.bin',
      method: 'GET',
      headers: {},
      responseType: 'arraybuffer',
    });
    expect([...new Uint8Array(binary?.data as ArrayBuffer)]).toEqual([4, 5]);
  });

  it('surfaces malformed touch and host transport failures', async () => {
    const fake = createFakeWechatMiniGameApi({
      getFileSystemManager() {
        return {
          readFile(input) {
            input.fail(new Error('missing'));
          },
        };
      },
      request(input) {
        input.fail(new Error('offline'));
      },
    });
    const host = createWechatMiniGameHost(fake.api, { requestAnimationFrame: () => 1 });
    const unsubscribe = host.onTouchStart(() => undefined);
    const listener = [...fake.touchListeners.start][0];

    expect(() => listener?.({
      changedTouches: [{ identifier: 1, clientX: Number.NaN, clientY: 2 }],
    })).toThrowError(MiniGameRuntimeError);
    unsubscribe();
    await expect(host.readLocalFile?.('missing.png')).rejects.toMatchObject({
      code: 'WECHAT_FILE_READ_FAILED',
    });
    await expect(host.request?.({
      url: 'https://assets.example.test/missing.json',
      method: 'GET',
      headers: {},
      responseType: 'json',
    })).rejects.toMatchObject({ code: 'WECHAT_REQUEST_FAILED' });
  });

  it('rejects malformed startup state and non-binary packaged-file responses', async () => {
    const fake = createFakeWechatMiniGameApi();
    const malformedFileSystemApi = {
      ...fake.api,
      getFileSystemManager: () => ({}),
    } as unknown as WechatMiniGameApi;

    expect(() => createWechatMiniGameHost(malformedFileSystemApi, {
      requestAnimationFrame: () => 1,
    })).toThrowError(expect.objectContaining({ code: 'WECHAT_FILE_SYSTEM_UNAVAILABLE' }));
    expect(() => createWechatMiniGameHost({
      ...fake.api,
      getWindowInfo: () => ({ windowWidth: 0, windowHeight: 540, pixelRatio: 2 }),
    }, {
      requestAnimationFrame: () => 1,
    })).toThrowError(expect.objectContaining({ code: 'WECHAT_WINDOW_INFO_INVALID' }));

    const stringFileApi = createFakeWechatMiniGameApi({
      getFileSystemManager() {
        return {
          readFile(input) {
            input.success({ data: 'unexpected text' });
          },
        };
      },
    });
    const host = createWechatMiniGameHost(stringFileApi.api, {
      requestAnimationFrame: () => 1,
    });

    await expect(host.readLocalFile?.('assets/logo.png')).rejects.toMatchObject({
      code: 'WECHAT_FILE_RESPONSE_INVALID',
    });
  });
});
