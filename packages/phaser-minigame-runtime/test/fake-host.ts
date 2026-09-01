import type {
  MiniGameHost,
  MiniGameRequest,
  MiniGameResponse,
  MiniGameTouch,
  MiniGameWindowInfo,
} from '../src/index.js';

type TouchKind = 'start' | 'move' | 'end' | 'cancel';
type ImageBehavior = 'load' | 'error' | 'poll-load' | 'pending';

interface FakeCanvasContextState {
  readonly drawImageSources: unknown[];
}

export interface FakeNativeCanvas {
  width: number;
  height: number;
  readonly context: object;
  getContext(type: string): object | null;
  toDataURL(): string;
}

export class FakeMiniGameHost implements MiniGameHost {
  readonly kind: 'wechat' | 'tiktok';
  readonly createdCanvasTypes: Array<'primary' | 'offscreen'> = [];
  readonly localFiles = new Map<string, ArrayBuffer>();
  readonly remoteRequests: MiniGameRequest[] = [];
  readonly frameErrors: unknown[] = [];
  remoteResponse: MiniGameResponse = {
    status: 200,
    data: '{}',
  };
  imageBehavior: ImageBehavior = 'load';
  readonly #windowInfo: MiniGameWindowInfo;
  readonly #frames = new Map<number, (time: number) => void>();
  readonly #touchListeners: Record<TouchKind, Set<(touches: readonly MiniGameTouch[]) => void>> = {
    start: new Set(),
    move: new Set(),
    end: new Set(),
    cancel: new Set(),
  };
  readonly #pauseListeners = new Set<() => void>();
  readonly #resumeListeners = new Set<() => void>();
  #nextFrameId = 1;

  constructor(
    kind: 'wechat' | 'tiktok' = 'wechat',
    windowInfo: MiniGameWindowInfo = {
      width: 800,
      height: 450,
      pixelRatio: 2,
      language: 'en',
      platform: 'test',
    },
  ) {
    this.kind = kind;
    this.#windowInfo = windowInfo;
  }

  getWindowInfo(): MiniGameWindowInfo {
    return this.#windowInfo;
  }

  createCanvas(input?: Readonly<{ readonly type?: 'primary' | 'offscreen' }>): FakeNativeCanvas {
    const type = input?.type ?? 'offscreen';
    this.createdCanvasTypes.push(type);
    const state: FakeCanvasContextState = { drawImageSources: [] };
    const contextTarget: Record<string, unknown> = {
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      imageSmoothingEnabled: true,
      fillStyle: '#000000',
      strokeStyle: '#000000',
      lineWidth: 1,
      font: '10px sans-serif',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      drawImage(source: unknown) {
        state.drawImageSources.push(source);
      },
      measureText(text: string) {
        return {
          width: text.length * 10,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
        };
      },
      createImageData(width: number, height: number) {
        return { width, height, data: new Uint8ClampedArray(width * height * 4) };
      },
      getImageData(_x: number, _y: number, width: number, height: number) {
        return { width, height, data: new Uint8ClampedArray(width * height * 4) };
      },
      createLinearGradient: createGradient,
      createRadialGradient: createGradient,
      createPattern: () => ({}),
      getLineDash: () => [],
      isPointInPath: () => false,
      isPointInStroke: () => false,
    };
    const context = new Proxy(contextTarget, {
      get(target, property, receiver) {
        if (property === '__state') {
          return state;
        }

        const value = Reflect.get(target, property, receiver);

        if (value !== undefined) {
          return value;
        }

        if (typeof property === 'string') {
          const noOp = () => undefined;
          Reflect.set(target, property, noOp);
          return noOp;
        }

        return undefined;
      },
    });
    const canvas: FakeNativeCanvas = {
      width: this.#windowInfo.width,
      height: this.#windowInfo.height,
      context,
      getContext(requestedType: string) {
        return requestedType === '2d' ? context : null;
      },
      toDataURL() {
        return 'data:image/png;base64,AA==';
      },
    };
    Reflect.set(contextTarget, 'canvas', canvas);
    return canvas;
  }

  createImage(): object {
    const behavior = this.imageBehavior;
    const image: Record<string, unknown> = {
      width: 0,
      height: 0,
      complete: false,
      onload: null,
      onerror: null,
    };

    Object.defineProperty(image, 'src', {
      configurable: true,
      enumerable: true,
      get: () => image.__src ?? '',
      set: (value: string) => {
        image.__src = value;

        if (behavior === 'pending') {
          return;
        }

        queueMicrotask(() => {
          if (behavior === 'error') {
            const onerror = image.onerror;

            if (typeof onerror === 'function') {
              Reflect.apply(onerror, image, []);
            }
            return;
          }

          image.width = 2;
          image.height = 2;
          image.complete = true;

          if (behavior === 'load') {
            const onload = image.onload;

            if (typeof onload === 'function') {
              Reflect.apply(onload, image, []);
            }
          }
        });
      },
    });

    return image;
  }

  requestAnimationFrame(callback: (time: number) => void): number {
    const id = this.#nextFrameId++;
    this.#frames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.#frames.delete(id);
  }

  flushFrame(time = 16): void {
    const callbacks = [...this.#frames.values()];
    this.#frames.clear();

    for (const callback of callbacks) {
      callback(time);
    }
  }

  get pendingFrameCount(): number {
    return this.#frames.size;
  }

  onTouchStart(callback: (touches: readonly MiniGameTouch[]) => void): () => void {
    return this.#subscribeTouch('start', callback);
  }

  onTouchMove(callback: (touches: readonly MiniGameTouch[]) => void): () => void {
    return this.#subscribeTouch('move', callback);
  }

  onTouchEnd(callback: (touches: readonly MiniGameTouch[]) => void): () => void {
    return this.#subscribeTouch('end', callback);
  }

  onTouchCancel(callback: (touches: readonly MiniGameTouch[]) => void): () => void {
    return this.#subscribeTouch('cancel', callback);
  }

  emitTouch(kind: TouchKind, touches: readonly MiniGameTouch[]): void {
    for (const listener of this.#touchListeners[kind]) {
      listener(touches);
    }
  }

  get touchListenerCount(): number {
    return Object.values(this.#touchListeners)
      .reduce((sum, listeners) => sum + listeners.size, 0);
  }

  onPause(callback: () => void): () => void {
    this.#pauseListeners.add(callback);
    return () => this.#pauseListeners.delete(callback);
  }

  onResume(callback: () => void): () => void {
    this.#resumeListeners.add(callback);
    return () => this.#resumeListeners.delete(callback);
  }

  emitPause(): void {
    for (const listener of this.#pauseListeners) {
      listener();
    }
  }

  emitResume(): void {
    for (const listener of this.#resumeListeners) {
      listener();
    }
  }

  get lifecycleListenerCount(): number {
    return this.#pauseListeners.size + this.#resumeListeners.size;
  }

  async readLocalFile(path: string): Promise<ArrayBuffer> {
    const data = this.localFiles.get(path);

    if (data === undefined) {
      throw new Error(`Missing fake local file: ${path}`);
    }

    return data;
  }

  async request(input: MiniGameRequest): Promise<MiniGameResponse> {
    this.remoteRequests.push(input);
    return this.remoteResponse;
  }

  #subscribeTouch(
    kind: TouchKind,
    callback: (touches: readonly MiniGameTouch[]) => void,
  ): () => void {
    this.#touchListeners[kind].add(callback);
    return () => this.#touchListeners[kind].delete(callback);
  }
}

function createGradient(): Readonly<{ readonly addColorStop: () => void }> {
  return { addColorStop: () => undefined };
}

export function encodeText(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}
