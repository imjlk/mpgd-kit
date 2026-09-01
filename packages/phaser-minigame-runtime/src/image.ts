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
  onload: ((event: MiniGameEvent) => void) | null = null;
  onerror: ((event: MiniGameEvent) => void) | null = null;
  crossOrigin: string | null = null;
  complete = false;
  #nativeImage: object;
  readonly #createNativeImage: (() => unknown) | undefined;
  #source = '';
  #generation = 0;
  #replaceBeforeNextLoad = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #options: Required<Pick<MiniGameImageOptions, 'pollIntervalMs' | 'loadTimeoutMs'>>
    & Pick<MiniGameImageOptions, 'allowedRemoteOrigins'>;

  constructor(
    nativeImage: unknown,
    options: MiniGameImageOptions = {},
    createNativeImage?: () => unknown,
  ) {
    super();
    this.#nativeImage = assertNativeImage(nativeImage);
    this.#createNativeImage = createNativeImage;
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

  get [miniGameNativeObjectSymbol](): object {
    return this.#nativeImage;
  }

  get src(): string {
    return this.#source;
  }

  set src(value: string) {
    this.#beginLoad(String(value));
  }

  get width(): number {
    return readImageDimension(this.#nativeImage, 'width');
  }

  set width(value: number) {
    Reflect.set(this.#nativeImage, 'width', value);
  }

  get height(): number {
    return readImageDimension(this.#nativeImage, 'height');
  }

  set height(value: number) {
    Reflect.set(this.#nativeImage, 'height', value);
  }

  get naturalWidth(): number {
    return readImageDimension(this.#nativeImage, 'naturalWidth') || this.width;
  }

  get naturalHeight(): number {
    return readImageDimension(this.#nativeImage, 'naturalHeight') || this.height;
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
    this.#generation += 1;
    const generation = this.#generation;
    this.#clearTimer();
    this.complete = false;
    this.#source = source;
    let nativeImage = this.#nativeImage;

    if (source.length === 0) {
      if (!this.#clearNativeSource(nativeImage)) {
        this.#scheduleFailure(
          generation,
          new MiniGameRuntimeError(
            'MINIGAME_IMAGE_CLEAR_FAILED',
            'The mini-game native image could not clear its source.',
          ),
        );
        return;
      }

      this.complete = true;
      return;
    }

    try {
      assertImageSourceAllowed(source, this.#options.allowedRemoteOrigins);
    } catch (error) {
      if (this.#replaceBeforeNextLoad) {
        this.#clearNativeSource(nativeImage);
      }
      this.#scheduleFailure(generation, error);
      return;
    }

    if (this.#replaceBeforeNextLoad) {
      if (!this.#clearNativeSource(nativeImage)) {
        this.#scheduleFailure(
          generation,
          new MiniGameRuntimeError(
            'MINIGAME_IMAGE_RESET_FAILED',
            'The mini-game native image could not reset before loading a new source.',
          ),
        );
        return;
      }

      try {
        nativeImage = this.#replaceNativeImage();
      } catch (error) {
        this.#scheduleFailure(generation, error);
        return;
      }
    }

    const startedAt = Date.now();
    const pollingBaseline = readNativeImageDimensions(nativeImage);

    try {
      Reflect.set(nativeImage, 'onload', () => this.#settle(generation, true));
      Reflect.set(nativeImage, 'onerror', () => this.#settle(generation, false));
      this.#replaceBeforeNextLoad = true;

      if (!Reflect.set(nativeImage, 'src', source)) {
        throw new Error('The native image source is not writable.');
      }
    } catch (error) {
      this.#scheduleFailure(generation, error);
      return;
    }

    if (generation !== this.#generation || this.complete) {
      return;
    }

    const poll = (): void => {
      if (generation !== this.#generation || this.complete) {
        return;
      }

      if (isNativeImageComplete(nativeImage, pollingBaseline)) {
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

  #replaceNativeImage(): object {
    if (this.#createNativeImage === undefined) {
      throw new MiniGameRuntimeError(
        'MINIGAME_IMAGE_RELOAD_UNAVAILABLE',
        'Mini-game image source reassignment requires a native image factory.',
      );
    }

    const replacement = assertNativeImage(this.#createNativeImage());
    this.#nativeImage = replacement;
    this.#replaceBeforeNextLoad = false;
    return replacement;
  }

  #clearNativeSource(nativeImage: object): boolean {
    try {
      Reflect.set(nativeImage, 'onload', null);
      Reflect.set(nativeImage, 'onerror', null);
      return Reflect.set(nativeImage, 'src', '');
    } catch {
      return false;
    }
  }

  #scheduleFailure(generation: number, cause: unknown): void {
    this.#timer = setTimeout(() => this.#settle(generation, false, cause), 0);
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
      this.invokeEventCallback(this.onload, event);
    } else {
      this.invokeEventCallback(this.onerror, event);
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
      super(host.createImage(), options, () => host.createImage());
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
  if (
    source.startsWith('//')
    || source.startsWith('\\\\')
    || source.startsWith('/\\')
    || source.startsWith('\\/')
  ) {
    throw new MiniGameRuntimeError(
      'MINIGAME_IMAGE_PROTOCOL_BLOCKED',
      `Protocol-relative mini-game image URLs are not supported: ${source}`,
    );
  }

  if (!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(source)) {
    assertLocalImagePath(source);
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

function assertLocalImagePath(source: string): void {
  const withoutQuery = source.split(/[?#]/u, 1)[0] ?? '';
  let decoded: string;

  try {
    decoded = decodeURIComponent(withoutQuery).replace(/^\/+|^(?:\.\/)+/u, '');
  } catch {
    throw new MiniGameRuntimeError(
      'MINIGAME_IMAGE_LOCAL_PATH_INVALID',
      `Mini-game image path contains invalid encoding: ${source}`,
    );
  }

  const segments = decoded.split('/');

  if (
    decoded.length === 0
    || decoded.includes('\\')
    || decoded.includes('\0')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new MiniGameRuntimeError(
      'MINIGAME_IMAGE_LOCAL_PATH_INVALID',
      `Mini-game image path must remain inside the package: ${source}`,
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

function assertNativeImage(image: unknown): object {
  if (image === null || (typeof image !== 'object' && typeof image !== 'function')) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_NATIVE_IMAGE',
      'The mini-game host returned an invalid native image object.',
    );
  }

  return image;
}

function isNativeImageComplete(
  image: object,
  baseline: Readonly<{ readonly width: number; readonly height: number }>,
): boolean {
  const complete = Reflect.get(image, 'complete');

  if (complete === true) {
    return true;
  }

  if (complete === false) {
    return false;
  }

  const dimensions = readNativeImageDimensions(image);
  return dimensions.width > 0
    && dimensions.height > 0
    && (dimensions.width !== baseline.width || dimensions.height !== baseline.height);
}

function readNativeImageDimensions(
  image: object,
): Readonly<{ readonly width: number; readonly height: number }> {
  return {
    width: readImageDimension(image, 'width'),
    height: readImageDimension(image, 'height'),
  };
}

function readImageDimension(image: object, property: string): number {
  const value = Reflect.get(image, property);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
