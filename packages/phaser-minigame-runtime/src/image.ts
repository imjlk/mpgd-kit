import { miniGameNativeObjectSymbol, unwrapMiniGameNativeObject } from './canvas.js';
import { MiniGameEvent, MiniGameEventTarget } from './events.js';
import { MiniGameRuntimeError, type MiniGameHost, type MiniGameImageOptions } from './host.js';
import { normalizeMiniGameHttpsOrigin, parseMiniGameHttpsUrl } from './url.js';

const defaultPollIntervalMs = 16;
const defaultLoadTimeoutMs = 5_000;

export interface MiniGameImageElementConstructor {
  new(): MiniGameImageElement;
}

export class MiniGameImageElement extends MiniGameEventTarget {
  readonly [miniGameNativeObjectSymbol]: object;
  onload: ((event: MiniGameEvent) => void) | null = null;
  onerror: ((event: MiniGameEvent) => void) | null = null;
  crossOrigin: string | null = null;
  complete = false;
  #source = '';
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #options: Required<Pick<MiniGameImageOptions, 'pollIntervalMs' | 'loadTimeoutMs'>>
    & Pick<MiniGameImageOptions, 'allowedRemoteOrigins'>;

  constructor(nativeImage: unknown, options: MiniGameImageOptions = {}) {
    super();

    if (nativeImage === null || (typeof nativeImage !== 'object' && typeof nativeImage !== 'function')) {
      throw new MiniGameRuntimeError(
        'MINIGAME_INVALID_NATIVE_IMAGE',
        'The mini-game host returned an invalid native image object.',
      );
    }

    this[miniGameNativeObjectSymbol] = nativeImage;
    this.#options = {
      pollIntervalMs: normalizePositiveDuration(
        options.pollIntervalMs,
        defaultPollIntervalMs,
        'pollIntervalMs',
      ),
      loadTimeoutMs: normalizePositiveDuration(
        options.loadTimeoutMs,
        defaultLoadTimeoutMs,
        'loadTimeoutMs',
      ),
      ...(options.allowedRemoteOrigins === undefined
        ? {}
        : { allowedRemoteOrigins: options.allowedRemoteOrigins }),
    };
  }

  get src(): string {
    return this.#source;
  }

  set src(value: string) {
    this.#beginLoad(String(value));
  }

  get width(): number {
    return readImageDimension(this[miniGameNativeObjectSymbol], 'width');
  }

  set width(value: number) {
    Reflect.set(this[miniGameNativeObjectSymbol], 'width', value);
  }

  get height(): number {
    return readImageDimension(this[miniGameNativeObjectSymbol], 'height');
  }

  set height(value: number) {
    Reflect.set(this[miniGameNativeObjectSymbol], 'height', value);
  }

  get naturalWidth(): number {
    return readImageDimension(this[miniGameNativeObjectSymbol], 'naturalWidth') || this.width;
  }

  get naturalHeight(): number {
    return readImageDimension(this[miniGameNativeObjectSymbol], 'naturalHeight') || this.height;
  }

  removeAttribute(name: string): void {
    if (name === 'crossOrigin') {
      this.crossOrigin = null;
    }
  }

  setAttribute(name: string, value: string): void {
    if (name === 'crossOrigin') {
      this.crossOrigin = value;
      return;
    }

    if (name === 'src') {
      this.src = value;
    }
  }

  #beginLoad(source: string): void {
    if (source.length > 0) {
      assertImageSourceAllowed(source, this.#options.allowedRemoteOrigins);
    }

    this.#generation += 1;
    const generation = this.#generation;
    this.#clearTimer();
    this.complete = false;
    this.#source = source;
    const nativeImage = this[miniGameNativeObjectSymbol];

    if (source.length === 0) {
      Reflect.set(nativeImage, 'onload', null);
      Reflect.set(nativeImage, 'onerror', null);

      try {
        if (!Reflect.set(nativeImage, 'src', '')) {
          throw new Error('The native image source is not writable.');
        }
      } catch {
        throw new MiniGameRuntimeError(
          'MINIGAME_IMAGE_CLEAR_FAILED',
          'The mini-game native image could not clear its source.',
        );
      }

      return;
    }

    const startedAt = Date.now();

    Reflect.set(nativeImage, 'onload', () => this.#settle(generation, true));
    Reflect.set(nativeImage, 'onerror', () => this.#settle(generation, false));

    try {
      Reflect.set(nativeImage, 'src', source);
    } catch (error) {
      this.#settle(generation, false, error);
      return;
    }

    if (generation !== this.#generation || this.complete) {
      return;
    }

    const poll = (): void => {
      if (generation !== this.#generation || this.complete) {
        return;
      }

      if (isNativeImageComplete(nativeImage)) {
        this.#settle(generation, true);
        return;
      }

      if (Date.now() - startedAt >= this.#options.loadTimeoutMs) {
        this.#settle(
          generation,
          false,
          new MiniGameRuntimeError(
            'MINIGAME_IMAGE_LOAD_TIMEOUT',
            `Mini-game image loading timed out after ${this.#options.loadTimeoutMs}ms: ${source}`,
          ),
        );
        return;
      }

      this.#timer = setTimeout(poll, this.#options.pollIntervalMs);
    };

    this.#timer = setTimeout(poll, this.#options.pollIntervalMs);
  }

  #settle(generation: number, succeeded: boolean, cause?: unknown): void {
    if (generation !== this.#generation || this.complete) {
      return;
    }

    this.complete = true;
    this.#clearTimer();
    const event = new MiniGameEvent(succeeded ? 'load' : 'error');
    event.target = this;
    event.currentTarget = this;

    if (cause !== undefined) {
      Object.assign(event, { error: cause });
    }

    if (succeeded) {
      this.onload?.call(this, event);
    } else {
      this.onerror?.call(this, event);
    }

    this.dispatchEvent(event);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

export function createMiniGameImageConstructor(
  host: MiniGameHost,
  options: MiniGameImageOptions = {},
): MiniGameImageElementConstructor {
  return class HostMiniGameImageElement extends MiniGameImageElement {
    constructor() {
      super(host.createImage(), options);
    }
  };
}

export function unwrapMiniGameImage(value: unknown): unknown {
  if (value instanceof MiniGameImageElement) {
    return value[miniGameNativeObjectSymbol];
  }

  return unwrapMiniGameNativeObject(value);
}

function assertImageSourceAllowed(
  source: string,
  allowedRemoteOrigins: readonly string[] | undefined,
): void {
  if (!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(source)) {
    return;
  }

  if (source.startsWith('data:')) {
    return;
  }

  if (!/^https:\/\//iu.test(source)) {
    throw new MiniGameRuntimeError(
      'MINIGAME_IMAGE_PROTOCOL_BLOCKED',
      `Mini-game images may only use package paths, data URLs, or allowed HTTPS origins: ${source}`,
    );
  }
  const parsed = parseMiniGameHttpsUrl(
    source,
    'MINIGAME_IMAGE_SOURCE_INVALID',
    'Invalid mini-game image URL',
    'MINIGAME_IMAGE_CREDENTIALS_BLOCKED',
  );
  const allowed = new Set((allowedRemoteOrigins ?? []).map(normalizeMiniGameHttpsOrigin));

  if (!allowed.has(parsed.origin)) {
    throw new MiniGameRuntimeError(
      'MINIGAME_IMAGE_ORIGIN_BLOCKED',
      `Remote mini-game image origin is not allowed: ${parsed.origin}`,
    );
  }
}

function normalizePositiveDuration(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;

  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_DURATION',
      `Mini-game image ${label} must be a positive finite number.`,
    );
  }

  return resolved;
}

function isNativeImageComplete(image: object): boolean {
  return Reflect.get(image, 'complete') === true
    || (readImageDimension(image, 'width') > 0 && readImageDimension(image, 'height') > 0);
}

function readImageDimension(image: object, property: string): number {
  const value = Reflect.get(image, property);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
