import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyMiniGameRequestUrl,
  createMiniGamePhaserConfig,
  getInstalledMiniGameGlobals,
  installMiniGameGlobals,
  installMiniGameTouchInput,
  installPhaserMiniGameRuntime,
  mapMiniGameTouchToDesign,
  MiniGameAnimationFrameScheduler,
  MiniGameCanvasElement,
  MiniGameEvent,
  MiniGameEventTarget,
  MiniGameImageElement,
  miniGamePhaserCanvasRenderer,
  MiniGameTouchEvent,
  MiniGameXMLHttpRequest,
  type MiniGamePhaserGame,
} from '../src/index.js';
import { encodeText, FakeMiniGameHost } from './fake-host.js';

afterEach(() => {
  getInstalledMiniGameGlobals()?.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mini-game globals and Canvas compatibility', () => {
  it('installs globals once and separates the primary and offscreen canvases', () => {
    const host = new FakeMiniGameHost();
    const installation = installMiniGameGlobals(host);
    const duplicate = installMiniGameGlobals(host);

    expect(duplicate).toBe(installation);
    expect(globalThis.window).toBe(globalThis);
    expect(globalThis.document).toBe(installation.document);
    expect(globalThis.document.getElementById('game')).toBe(installation.document.body);
    expect(globalThis.document.getElementById('mpgd-game-canvas')).toBe(installation.canvas);
    expect(installation.canvas).toBeInstanceOf(MiniGameCanvasElement);
    expect(host.createdCanvasTypes).toEqual(['primary']);
    let windowListenerThis: unknown;
    let windowEvent: MiniGameEvent | undefined;
    const windowListener = function listener(this: unknown, event: MiniGameEvent): void {
      windowListenerThis = this;
      windowEvent = event;
    };
    const addWindowListener = Reflect.get(globalThis, 'addEventListener');
    const focusWindow = Reflect.get(globalThis, 'focus');

    expect(typeof addWindowListener).toBe('function');
    expect(typeof focusWindow).toBe('function');

    if (typeof addWindowListener !== 'function' || typeof focusWindow !== 'function') {
      throw new Error('Mini-game window event globals were not installed.');
    }

    Reflect.apply(addWindowListener, globalThis, ['focus', windowListener]);
    Reflect.apply(focusWindow, globalThis, []);
    expect(windowListenerThis).toBe(globalThis);
    expect(windowEvent?.target).toBe(globalThis);
    expect(windowEvent?.currentTarget).toBe(globalThis);

    const offscreen = globalThis.document.createElement('canvas');

    expect(offscreen).toBeInstanceOf(MiniGameCanvasElement);
    expect(offscreen).not.toBe(installation.canvas);
    expect(host.createdCanvasTypes).toEqual(['primary', 'offscreen']);

    installation.canvas.style.width = '600px';
    installation.canvas.style.height = '300px';
    installation.canvas.style.setProperty('margin-left', '100px');
    installation.canvas.style.marginTop = '75px';
    expect(installation.canvas.getBoundingClientRect()).toMatchObject({
      x: 100,
      y: 75,
      left: 100,
      top: 75,
      right: 700,
      bottom: 375,
      width: 600,
      height: 300,
    });
    expect(installation.canvas.clientWidth).toBe(600);
    expect(installation.canvas.clientHeight).toBe(300);
    expect(mapMiniGameTouchToDesign(
      { identifier: 1, clientX: 400, clientY: 225 },
      host.getWindowInfo(),
      { width: 1200, height: 600 },
      installation.canvas.getBoundingClientRect(),
    )).toEqual({ x: 600, y: 300 });
    expect(() => globalThis.document.createElement('section')).toThrow(
      "does not implement document.createElement('section')",
    );
    expect(() => globalThis.document.createElement('script')).toThrow(
      'does not permit <script>',
    );
  });

  it('unwraps mini-game image wrappers passed to drawImage', async () => {
    const host = new FakeMiniGameHost();
    const installation = installMiniGameGlobals(host);
    const image = new globalThis.Image();
    const loaded = new Promise<void>((resolve) => {
      image.onload = (event) => {
        expect(event.target).toBe(image);
        resolve();
      };
    });
    image.src = 'assets/marker.png';
    await loaded;

    const context = installation.canvas.getContext('2d') as {
      drawImage(source: unknown, x: number, y: number): void;
      readonly __state: Readonly<{ readonly drawImageSources: readonly unknown[] }>;
    };
    context.drawImage(image, 0, 0);

    expect(image).toBeInstanceOf(MiniGameImageElement);
    expect(context.__state.drawImageSources).toHaveLength(1);
    expect(context.__state.drawImageSources[0]).not.toBe(image);

    const reloaded = new Promise<void>((resolve) => {
      image.onload = () => resolve();
    });
    image.src = 'assets/marker-2.png';
    context.drawImage(image, 0, 0);
    const reloadingNativeImage = context.__state.drawImageSources[1];

    expect(Reflect.get(reloadingNativeImage as object, 'src')).toBe('assets/marker-2.png');
    expect(Reflect.get(reloadingNativeImage as object, 'complete')).toBe(false);
    await reloaded;

    image.src = '';
    context.drawImage(image, 0, 0);
    const clearedNativeImage = context.__state.drawImageSources[2];

    expect(image.src).toBe('');
    expect(Reflect.get(clearedNativeImage as object, 'src')).toBe('');
    expect(Reflect.get(clearedNativeImage as object, 'width')).toBe(0);
    expect(image.complete).toBe(true);
  });

  it('uses bounded image polling when native callbacks are absent', async () => {
    const host = new FakeMiniGameHost();
    host.imageBehavior = 'poll-load';
    installMiniGameGlobals(host, {
      image: { pollIntervalMs: 1, loadTimeoutMs: 50 },
    });
    const image = new globalThis.Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unexpected image error'));
    });
    image.src = 'assets/polled.png';

    await loaded;
    expect(image.complete).toBe(true);
    expect(image.width).toBe(2);
  });

  it('reports native image errors and bounded polling timeouts', async () => {
    const failedHost = new FakeMiniGameHost();
    failedHost.imageBehavior = 'error';
    const failedInstallation = installMiniGameGlobals(failedHost);
    const failedImage = new globalThis.Image();
    const nativeError = new Promise<void>((resolve) => {
      failedImage.onerror = () => resolve();
    });
    failedImage.src = 'assets/missing.png';
    await nativeError;
    expect(failedImage.complete).toBe(true);
    failedInstallation.dispose();

    const pendingHost = new FakeMiniGameHost();
    pendingHost.imageBehavior = 'pending';
    installMiniGameGlobals(pendingHost, {
      image: { pollIntervalMs: 1, loadTimeoutMs: 5 },
    });
    const pendingImage = new globalThis.Image();
    const timeoutError = new Promise<unknown>((resolve) => {
      pendingImage.onerror = (event) => resolve(event);
    });
    pendingImage.src = 'assets/never.png';

    await expect(timeoutError).resolves.toMatchObject({ type: 'error' });
  });

  it('rejects invalid image timing and reports unsafe image sources asynchronously', async () => {
    const host = new FakeMiniGameHost();
    installMiniGameGlobals(host, {
      image: { pollIntervalMs: 0 },
    });

    expect(() => new globalThis.Image()).toThrow('pollIntervalMs must be a positive');
    getInstalledMiniGameGlobals()?.dispose();
    installMiniGameGlobals(host);

    for (const [source, code] of [
      ['blob:minigame-image', 'MINIGAME_IMAGE_PROTOCOL_BLOCKED'],
      ['//untrusted.example/image.png', 'MINIGAME_IMAGE_PROTOCOL_BLOCKED'],
      [String.raw`\\untrusted.example\image.png`, 'MINIGAME_IMAGE_PROTOCOL_BLOCKED'],
      ['../secret.png', 'MINIGAME_IMAGE_LOCAL_PATH_INVALID'],
    ] as const) {
      const image = new globalThis.Image();
      let assignmentReturned = false;
      const blockedSourceError = new Promise<unknown>((resolve) => {
        image.onerror = (event) => {
          expect(assignmentReturned).toBe(true);
          resolve(event);
        };
      });

      image.src = source;
      assignmentReturned = true;

      await expect(blockedSourceError).resolves.toMatchObject({
        type: 'error',
        error: { code },
      });
    }
  });

  it('keeps same-target listeners after stopPropagation and honors stopImmediatePropagation', () => {
    const eventTarget = new MiniGameCanvasElement(
      new FakeMiniGameHost().createCanvas({ type: 'primary' }),
      () => ({ width: 100, height: 100, pixelRatio: 1 }),
    );
    const calls: string[] = [];
    eventTarget.addEventListener('normal', (event) => {
      calls.push('normal-first');
      event.stopPropagation();
    });
    eventTarget.addEventListener('normal', () => calls.push('normal-second'));
    eventTarget.addEventListener('immediate', (event) => {
      calls.push('immediate-first');
      event.stopImmediatePropagation();
    });
    eventTarget.addEventListener('immediate', () => calls.push('immediate-second'));

    eventTarget.dispatchEvent(new MiniGameEvent('normal'));
    eventTarget.dispatchEvent(new MiniGameEvent('immediate'));

    expect(calls).toEqual(['normal-first', 'normal-second', 'immediate-first']);
  });

  it('continues event dispatch after reporting a listener exception', () => {
    const listenerError = new Error('listener failed');
    const reported: Array<Readonly<{ readonly error: unknown; readonly type: string }>> = [];
    const eventTarget = new MiniGameEventTarget((error, event) => {
      reported.push({ error, type: event.type });
    });
    const calls: string[] = [];
    eventTarget.addEventListener('load', () => {
      calls.push('failing');
      throw listenerError;
    });
    eventTarget.addEventListener('load', () => calls.push('remaining'));

    expect(() => eventTarget.dispatchEvent(new MiniGameEvent('load'))).not.toThrow();
    expect(calls).toEqual(['failing', 'remaining']);
    expect(reported).toEqual([{ error: listenerError, type: 'load' }]);
  });

  it('forwards touch start, move, end, and cancel and removes listeners on dispose', () => {
    const host = new FakeMiniGameHost();
    const installation = installMiniGameGlobals(host);
    const eventTypes: string[] = [];
    const changedCoordinates: Array<readonly [number, number]> = [];

    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      installation.canvas.addEventListener(type, (event) => {
        const touchEvent = event as MiniGameTouchEvent;
        eventTypes.push(touchEvent.type);
        const changed = touchEvent.changedTouches[0];

        if (changed !== undefined) {
          changedCoordinates.push([changed.clientX, changed.clientY]);
        }
      });
    }

    const touch = [{ identifier: 7, clientX: 400, clientY: 225 }] as const;
    host.emitTouch('start', touch);
    host.emitTouch('move', touch);
    host.emitTouch('end', touch);
    host.emitTouch('start', touch);
    host.emitTouch('cancel', touch);

    expect(eventTypes).toEqual([
      'touchstart',
      'touchmove',
      'touchend',
      'touchstart',
      'touchcancel',
    ]);
    expect(changedCoordinates[0]).toEqual([400, 225]);
    expect(mapMiniGameTouchToDesign(touch[0], host.getWindowInfo(), {
      width: 1600,
      height: 900,
    })).toEqual({ x: 800, y: 450 });
    expect(() => mapMiniGameTouchToDesign(touch[0], host.getWindowInfo(), {
      width: 0,
      height: 900,
    })).toThrow('design width and height must be positive');
    expect(host.touchListenerCount).toBe(4);

    installation.dispose();
    expect(host.touchListenerCount).toBe(0);
    host.emitTouch('start', touch);
    expect(eventTypes).toHaveLength(5);
  });

  it('rolls back touch subscriptions and deactivates an invalid leaked callback', () => {
    class InvalidTouchHost extends FakeMiniGameHost {
      override onTouchMove(
        callback: Parameters<FakeMiniGameHost['onTouchMove']>[0],
      ): () => void {
        super.onTouchMove(callback);
        return undefined as never;
      }
    }

    const host = new InvalidTouchHost();
    const canvas = new MiniGameCanvasElement(
      host.createCanvas({ type: 'primary' }),
      () => host.getWindowInfo(),
    );
    let moves = 0;
    canvas.addEventListener('touchmove', () => {
      moves += 1;
    });

    expect(() => installMiniGameTouchInput(host, canvas)).toThrow(
      'onTouchMove must return an unsubscribe function',
    );
    expect(host.touchListenerCount).toBe(1);
    host.emitTouch('move', [{ identifier: 1, clientX: 10, clientY: 10 }]);
    expect(moves).toBe(0);
  });
});

describe('mini-game requestAnimationFrame and transport', () => {
  it('keeps recursively scheduled frames alive after a callback exception', () => {
    const host = new FakeMiniGameHost();
    const errors: unknown[] = [];
    const scheduler = new MiniGameAnimationFrameScheduler(host, (error) => errors.push(error));
    let frames = 0;
    const step = (): void => {
      frames += 1;
      scheduler.request(step);

      if (frames === 1) {
        throw new Error('frame failed');
      }
    };

    scheduler.request(step);
    host.flushFrame(16);
    host.flushFrame(32);
    host.flushFrame(48);

    expect(frames).toBe(3);
    expect(errors).toHaveLength(1);
    scheduler.dispose();
    expect(host.pendingFrameCount).toBe(0);
  });

  it('loads local JSON and binary responses with the Phaser XHR surface', async () => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/config.json', encodeText('{"level":3}'));
    host.localFiles.set('assets/data.bin', new Uint8Array([1, 2, 3]).buffer);

    const jsonRequest = new MiniGameXMLHttpRequest(host);
    jsonRequest.open('GET', './assets/config.json');
    jsonRequest.responseType = 'json';
    await sendRequest(jsonRequest);
    expect(jsonRequest.status).toBe(200);
    expect(jsonRequest.readyState).toBe(jsonRequest.DONE);
    expect(jsonRequest.response).toEqual({ level: 3 });

    const binaryRequest = new MiniGameXMLHttpRequest(host);
    binaryRequest.open('GET', '/assets/data.bin');
    binaryRequest.responseType = 'arraybuffer';
    await sendRequest(binaryRequest);
    expect([...new Uint8Array(binaryRequest.response as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it('decodes Unicode local files without browser TextEncoder or TextDecoder globals', async () => {
    const host = new FakeMiniGameHost();
    const value = '{"label":"한글 😀"}';
    host.localFiles.set('assets/unicode.json', encodeText(value));
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    const request = new MiniGameXMLHttpRequest(host);
    request.open('GET', 'assets/unicode.json');
    request.responseType = 'json';

    await sendRequest(request);
    expect(request.response).toEqual({ label: '한글 😀' });
  });

  it('rejects duplicate sends, credential forwarding, and unsupported response types', async () => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/value.json', encodeText('{}'));
    const request = new MiniGameXMLHttpRequest(host);
    request.open('GET', 'assets/value.json');
    const loaded = sendRequest(request);
    expect(() => request.setRequestHeader('x-late', 'ignored')).toThrow(
      'headers cannot change after send() starts',
    );
    expect(() => request.send()).toThrow('only be called once per open');
    await loaded;

    const credentialed = new MiniGameXMLHttpRequest(host);
    credentialed.open('GET', 'assets/value.json');
    credentialed.withCredentials = true;
    expect(() => credentialed.send()).toThrow('does not support withCredentials');

    const unsupported = new MiniGameXMLHttpRequest(host);
    unsupported.open('GET', 'assets/value.json');
    Reflect.set(unsupported, 'responseType', 'blob');
    expect(() => unsupported.send()).toThrow('does not support responseType blob');
  });

  it('honors aborts raised by XHR lifecycle callbacks without starting transport', async () => {
    const host = new FakeMiniGameHost();
    const readLocalFile = vi.spyOn(host, 'readLocalFile');
    const request = new MiniGameXMLHttpRequest(host);
    request.open('GET', 'assets/aborted.json');
    const aborted = new Promise<void>((resolve) => {
      request.onabort = () => resolve();
    });
    request.onloadstart = () => request.abort();
    request.send();

    await aborted;
    expect(request.readyState).toBe(request.DONE);
    expect(readLocalFile).not.toHaveBeenCalled();
  });

  it('reports invalid host response status through the XHR error path', async () => {
    const host = new FakeMiniGameHost();
    host.remoteResponse = { status: 0, data: '{}' };
    const request = new MiniGameXMLHttpRequest(host, {
      allowedRemoteOrigins: ['https://cdn.example.com'],
    });
    request.open('GET', 'https://cdn.example.com/data.json');

    await expect(sendRequest(request)).rejects.toMatchObject({
      event: { type: 'error' },
    });
    expect(request.status).toBe(0);
  });

  it('does not reclassify a successful XHR when its load callback throws', async () => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/value.json', encodeText('{"ok":true}'));
    const listenerError = new Error('consumer load callback failed');
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const request = new MiniGameXMLHttpRequest(host);
    let errorEvents = 0;
    request.open('GET', 'assets/value.json');
    request.responseType = 'json';
    request.onload = () => {
      throw listenerError;
    };
    request.onerror = () => {
      errorEvents += 1;
    };
    const completed = new Promise<void>((resolve) => {
      request.onloadend = () => resolve();
    });

    request.send();
    await completed;

    expect(request.status).toBe(200);
    expect(request.response).toEqual({ ok: true });
    expect(errorEvents).toBe(0);
    expect(reported).toHaveBeenCalledWith(
      expect.stringContaining('load event listener failed'),
      listenerError,
    );
  });

  it.each(['load', 'error'] as const)(
    'stops an old %s lifecycle when its terminal callback starts a replacement request',
    async (terminal) => {
      const host = new FakeMiniGameHost();
      const initialPath = terminal === 'load'
        ? 'assets/initial.json'
        : 'assets/missing.json';
      host.localFiles.set('assets/initial.json', encodeText('{"stage":"initial"}'));
      host.localFiles.set('assets/replacement.json', encodeText('{"stage":"replacement"}'));
      const request = new MiniGameXMLHttpRequest(host);
      const loadendResponses: unknown[] = [];
      let replacementStarted = false;
      let completeReplacement: () => void = () => undefined;
      const completed = new Promise<void>((resolve) => {
        completeReplacement = resolve;
      });
      const startReplacement = (): void => {
        replacementStarted = true;
        request.open('GET', 'assets/replacement.json');
        request.send();
      };
      request.onload = () => {
        if (!replacementStarted && terminal === 'load') {
          startReplacement();
        }
      };
      request.onerror = () => {
        if (!replacementStarted && terminal === 'error') {
          startReplacement();
        }
      };
      request.onloadend = () => {
        loadendResponses.push(request.response);

        if (
          typeof request.response === 'object'
          && request.response !== null
          && Reflect.get(request.response, 'stage') === 'replacement'
        ) {
          completeReplacement();
        }
      };
      request.open('GET', initialPath);
      request.responseType = 'json';

      request.send();
      await completed;

      expect(loadendResponses).toEqual([{ stage: 'replacement' }]);
      expect(request.status).toBe(200);
    },
  );

  it('allows only configured HTTPS origins for remote assets', async () => {
    const host = new FakeMiniGameHost();
    vi.stubGlobal('URL', undefined);
    host.remoteResponse = {
      status: 200,
      data: '{"remote":true}',
      headers: { 'content-type': 'application/json' },
    };
    const request = new MiniGameXMLHttpRequest(host, {
      allowedRemoteOrigins: ['https://cdn.example.com'],
    });
    request.open('GET', 'https://cdn.example.com/game/config.json');
    request.responseType = 'text';
    await sendRequest(request);

    expect(request.responseText).toBe('{"remote":true}');
    expect(request.getResponseHeader('Content-Type')).toBe('application/json');
    expect(host.remoteRequests).toHaveLength(1);
    expect(classifyMiniGameRequestUrl(
      'HTTPS://CDN.EXAMPLE.COM:443/game/data.json#ignored',
      ['https://cdn.example.com/'],
    )).toEqual({
      kind: 'remote',
      url: 'https://cdn.example.com/game/data.json',
    });
    expect(() => classifyMiniGameRequestUrl(
      'https://unlisted.example.com/file.json',
      ['https://cdn.example.com'],
    )).toThrow('origin is not allowed');
    expect(() => classifyMiniGameRequestUrl('../secret.json')).toThrow(
      'must remain inside the package',
    );
    expect(() => classifyMiniGameRequestUrl('http://cdn.example.com/file.js')).toThrow(
      'only support package paths and allowed HTTPS URLs',
    );
    expect(() => classifyMiniGameRequestUrl('//cdn.example.com/file.json')).toThrow(
      'Protocol-relative mini-game request URLs are not supported',
    );
    expect(() => classifyMiniGameRequestUrl(
      'https://user:secret@cdn.example.com/file.json',
      ['https://cdn.example.com'],
    )).toThrow('must not contain embedded credentials');
    expect(() => classifyMiniGameRequestUrl(
      'https://cdn.example.com/file.json',
      ['https://cdn.example.com#fragment'],
    )).toThrow('must not include a path, query, or fragment');

    const invalidHeader = new MiniGameXMLHttpRequest(host, {
      allowedRemoteOrigins: ['https://cdn.example.com'],
    });
    invalidHeader.open('GET', 'https://cdn.example.com/file.json');
    expect(() => invalidHeader.setRequestHeader('x-test', 'ok\r\ninjected: true')).toThrow(
      'header value contains a line break',
    );
  });
});

describe('Phaser mini-game runtime patch', () => {
  it('forces Canvas config and rejects AUTO or WEBGL input', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const config = createMiniGamePhaserConfig({
      width: 800,
      height: 450,
      loader: { maxParallelDownloads: 4 },
    }, globals);

    expect(config.type).toBe(miniGamePhaserCanvasRenderer);
    expect(config.canvas).toBe(globals.canvas);
    expect(config.loader).toMatchObject({
      maxParallelDownloads: 4,
      imageLoadType: 'HTMLImageElement',
    });
    expect(config.audio).toMatchObject({ noAudio: true });
    expect(() => createMiniGamePhaserConfig({ type: 0 }, globals)).toThrow(
      'AUTO and WEBGL are not supported',
    );
    expect(() => createMiniGamePhaserConfig({ type: 2 }, globals)).toThrow(
      'AUTO and WEBGL are not supported',
    );
  });

  it('patches one RAF loop, survives frame failures, and connects lifecycle once', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const errors: unknown[] = [];
    let frames = 0;
    let pauses = 0;
    let resumes = 0;
    const raf = createFakePhaserRaf(() => {
      frames += 1;

      if (frames === 1) {
        throw new Error('scene frame failed');
      }
    });
    const originalStep = raf.step;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        raf.start(raf.callback, false, raf.delay);
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      loop,
      isPaused: false,
      pause() {
        this.isPaused = true;
        pauses += 1;
      },
      resume() {
        this.isPaused = false;
        resumes += 1;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, {
      globals,
      onFrameError: (error) => errors.push(error),
    });
    const duplicate = installPhaserMiniGameRuntime(game, { globals });

    expect(duplicate).toBe(installation);
    expect(() => globals.dispose()).toThrow(
      'Dispose the Phaser mini-game runtime before disposing mini-game globals',
    );
    expect(globals.disposed).toBe(false);
    expect(getInstalledMiniGameGlobals()).toBe(globals);
    expect(host.pendingFrameCount).toBe(1);
    expect(host.lifecycleListenerCount).toBe(2);
    host.flushFrame(16);
    host.flushFrame(32);
    expect(frames).toBe(2);
    expect(errors).toHaveLength(1);
    expect(host.pendingFrameCount).toBe(1);

    host.emitPause();
    expect(pauses).toBe(1);
    expect(loop.running).toBe(false);
    expect(globals.document.visibilityState).toBe('hidden');
    host.emitResume();
    expect(resumes).toBe(1);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');

    host.emitPause();
    expect(pauses).toBe(2);
    expect(loop.running).toBe(false);
    expect(globals.document.visibilityState).toBe('hidden');
    installation.dispose();
    expect(host.lifecycleListenerCount).toBe(0);
    expect(resumes).toBe(2);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');
    expect(raf.step).toBe(originalStep);
    expect(host.pendingFrameCount).toBe(1);
    host.flushFrame(48);
    expect(frames).toBe(3);
    expect(host.pendingFrameCount).toBe(1);
  });

  it.each([
    {
      priorState: 'manual game pause',
      initiallyPaused: true,
      initiallyRunning: true,
      expected: { sleeps: 1, wakes: 1, pauses: 0, resumes: 0 },
    },
    {
      priorState: 'sleeping loop',
      initiallyPaused: false,
      initiallyRunning: false,
      expected: { sleeps: 0, wakes: 0, pauses: 1, resumes: 1 },
    },
  ])('preserves a pre-existing $priorState across host backgrounding', ({
    initiallyPaused,
    initiallyRunning,
    expected,
  }) => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let sleeps = 0;
    let wakes = 0;
    let pauses = 0;
    let resumes = 0;
    const loop = {
      started: true,
      running: initiallyRunning,
      forceSetTimeOut: false,
      raf,
      sleep() {
        sleeps += 1;
        this.running = false;
      },
      wake() {
        wakes += 1;
        this.running = true;
      },
    };
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      loop,
      isPaused: initiallyPaused,
      pause() {
        pauses += 1;
        this.isPaused = true;
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });

    host.emitPause();
    host.emitResume();

    expect({ sleeps, wakes, pauses, resumes }).toEqual(expected);
    expect(loop.running).toBe(initiallyRunning);
    expect(game.isPaused).toBe(initiallyPaused);

    installation.dispose();
  });

  it('does not apply pause after a visibility listener disposes the runtime', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let pauses = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      loop,
      isPaused: false,
      pause() {
        pauses += 1;
        this.isPaused = true;
      },
      resume() {
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });
    globals.document.addEventListener('visibilitychange', () => {
      if (globals.document.hidden) {
        installation.dispose();
      }
    });

    host.emitPause();

    expect(installation.disposed).toBe(true);
    expect(pauses).toBe(0);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');
    expect(host.lifecycleListenerCount).toBe(0);
    expect(host.pendingFrameCount).toBe(1);
  });

  it('restores a game pause when the pause callback disposes the runtime', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let pauses = 0;
    let resumes = 0;
    let sleeps = 0;
    let installation: ReturnType<typeof installPhaserMiniGameRuntime>;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        sleeps += 1;
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      loop,
      isPaused: false,
      pause() {
        pauses += 1;
        this.isPaused = true;
        installation.dispose();
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    installation = installPhaserMiniGameRuntime(game, { globals });

    host.emitPause();

    expect(installation.disposed).toBe(true);
    expect(pauses).toBe(1);
    expect(resumes).toBe(1);
    expect(sleeps).toBe(0);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');
    expect(host.pendingFrameCount).toBe(1);
  });

  it('keeps one RAF chain when the runtime is disposed inside a frame callback', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    let frames = 0;
    let installation: ReturnType<typeof installPhaserMiniGameRuntime>;
    const raf = createFakePhaserRaf(() => {
      frames += 1;
      installation.dispose();
    });
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      loop,
    } satisfies MiniGamePhaserGame;
    installation = installPhaserMiniGameRuntime(game, { globals });

    host.flushFrame(16);
    expect(installation.disposed).toBe(true);
    expect(frames).toBe(1);
    expect(host.pendingFrameCount).toBe(1);

    host.flushFrame(32);
    expect(frames).toBe(2);
    expect(host.pendingFrameCount).toBe(1);
  });

  it('requires an explicitly configured Canvas renderer', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const gameWithoutRendererConfig = {
      loop: {
        started: false,
        running: false,
        forceSetTimeOut: false,
        raf,
        sleep: () => undefined,
        wake: () => undefined,
      },
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(gameWithoutRendererConfig, { globals })).toThrow(
      'explicit Canvas renderer',
    );
  });

  it('rolls back the RAF patch when lifecycle subscription fails', () => {
    class InvalidLifecycleHost extends FakeMiniGameHost {
      override onResume(_callback: () => void): () => void {
        throw new Error('resume subscription failed');
      }
    }

    const host = new InvalidLifecycleHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const originalStep = raf.step;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep: () => undefined,
      wake: () => undefined,
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      loop,
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(game, { globals })).toThrow(
      'resume subscription failed',
    );
    expect(raf.step).toBe(originalStep);
    expect(host.lifecycleListenerCount).toBe(0);
    expect(host.pendingFrameCount).toBe(1);
  });

  it('deactivates an unremovable lifecycle callback after installation fails', () => {
    class LeakyLifecycleHost extends FakeMiniGameHost {
      override onPause(callback: () => void): () => void {
        super.onPause(callback);
        callback();
        return undefined as never;
      }
    }

    const host = new LeakyLifecycleHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let pauses = 0;
    let resumes = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      loop,
      isPaused: false,
      pause() {
        pauses += 1;
        this.isPaused = true;
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(game, { globals })).toThrow(
      'must return an unsubscribe function',
    );
    expect(host.lifecycleListenerCount).toBe(1);
    expect(pauses).toBe(1);
    expect(resumes).toBe(1);
    expect(globals.document.visibilityState).toBe('visible');
    host.emitPause();
    expect(pauses).toBe(1);
    expect(resumes).toBe(1);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(host.pendingFrameCount).toBe(1);
  });
});

function sendRequest(request: MiniGameXMLHttpRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onload = (event) => {
      try {
        expect(event.target).toBe(request);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = (event) => reject(Object.assign(new Error('Request failed'), { event }));
    request.ontimeout = (event) => reject(Object.assign(new Error('Request timed out'), { event }));
    request.send();
  });
}

function createFakePhaserRaf(callback: (time: number) => void) {
  return {
    isRunning: false,
    isSetTimeOut: false,
    timeOutID: null as number | null,
    delay: 16,
    callback,
    step(time: number) {
      this.callback(time);

      if (this.isRunning) {
        this.timeOutID = globalThis.requestAnimationFrame(this.step.bind(this));
      }
    },
    start(nextCallback: (time: number) => void, _forceSetTimeOut: boolean, delay: number) {
      if (this.isRunning) {
        return;
      }

      this.callback = nextCallback;
      this.delay = delay;
      this.isRunning = true;
      this.timeOutID = globalThis.requestAnimationFrame(this.step.bind(this));
    },
    stop() {
      this.isRunning = false;

      if (this.timeOutID !== null) {
        globalThis.cancelAnimationFrame(this.timeOutID);
      }
    },
  };
}
