import {
  createMiniGameCanvasElement,
  MiniGameCanvasElement,
  MiniGameHTMLElement,
} from './canvas.js';
import { MiniGameEvent, MiniGameEventTarget, type MiniGameEventListenerLike } from './events.js';
import {
  assertMiniGameWindowInfo,
  MiniGameRuntimeError,
  type MiniGameHost,
  type MiniGameImageOptions,
  type MiniGameRuntimeOptions,
  type MiniGameTransportOptions,
  type MiniGameWindowInfo,
} from './host.js';
import {
  createMiniGameImageConstructor,
  MiniGameImageElement,
  type MiniGameImageElementConstructor,
} from './image.js';
import { installMiniGameTouchInput, MiniGameTouchEvent } from './input.js';
import { MiniGameAnimationFrameScheduler } from './loop.js';
import { getMiniGameCanvasBounds } from './scale.js';
import { createMiniGameXMLHttpRequestConstructor, MiniGameProgressEvent } from './xhr.js';

const supportedGenericElements = new Set(['audio', 'div', 'video']);

export class MiniGameDocument extends MiniGameEventTarget {
  readonly nodeType = 9;
  readonly nodeName = '#document';
  readonly readyState = 'complete';
  readonly compatMode = 'CSS1Compat';
  readonly characterSet = 'UTF-8';
  readonly documentElement: MiniGameHTMLElement;
  readonly head: MiniGameHTMLElement;
  readonly body: MiniGameHTMLElement;
  readonly #host: MiniGameHost;
  readonly #Image: MiniGameImageElementConstructor;
  defaultView: unknown = null;
  hidden = false;
  visibilityState: 'visible' | 'hidden' = 'visible';

  constructor(
    host: MiniGameHost,
    primaryCanvas: MiniGameCanvasElement,
    ImageConstructor: MiniGameImageElementConstructor,
  ) {
    super();
    this.#host = host;
    this.#Image = ImageConstructor;
    const bounds = () => getMiniGameCanvasBounds(host.getWindowInfo());
    this.documentElement = new MiniGameHTMLElement('html', bounds);
    this.head = new MiniGameHTMLElement('head', bounds);
    this.body = new MiniGameHTMLElement('body', bounds);
    this.body.id = 'game';
    this.documentElement.ownerDocument = this;
    this.head.ownerDocument = this;
    this.body.ownerDocument = this;
    primaryCanvas.ownerDocument = this;
    primaryCanvas.id = 'mpgd-game-canvas';
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.body.appendChild(primaryCanvas);
  }

  get activeElement(): MiniGameHTMLElement {
    return this.body;
  }

  createElement(tagName: string): MiniGameHTMLElement | MiniGameImageElement {
    const normalized = tagName.toLowerCase();

    if (normalized === 'canvas') {
      const canvas = createMiniGameCanvasElement(this.#host, 'offscreen');
      canvas.ownerDocument = this;
      return canvas;
    }

    if (normalized === 'img' || normalized === 'image') {
      return new this.#Image();
    }

    if (normalized === 'script' || normalized === 'iframe') {
      throw new MiniGameRuntimeError(
        'MINIGAME_DOM_EXECUTABLE_ELEMENT_BLOCKED',
        `Mini-game runtime does not permit <${normalized}> executable DOM elements.`,
      );
    }

    if (!supportedGenericElements.has(normalized)) {
      throw new MiniGameRuntimeError(
        'MINIGAME_DOM_ELEMENT_UNSUPPORTED',
        `Mini-game runtime does not implement document.createElement('${tagName}').`,
      );
    }

    const element = new MiniGameHTMLElement(
      normalized,
      () => (getMiniGameCanvasBounds(this.#host.getWindowInfo())),
    );
    element.ownerDocument = this;

    if (normalized === 'audio' || normalized === 'video') {
      Object.assign(element, {
        canPlayType: () => '',
        load: () => undefined,
        pause: () => undefined,
      });
    }

    return element;
  }

  createElementNS(namespace: string, tagName: string): MiniGameHTMLElement | MiniGameImageElement {
    if (namespace !== 'http://www.w3.org/1999/xhtml') {
      throw new MiniGameRuntimeError(
        'MINIGAME_DOM_NAMESPACE_UNSUPPORTED',
        `Mini-game runtime does not implement DOM namespace ${namespace}.`,
      );
    }

    return this.createElement(tagName);
  }

  createTextNode(text: string): Readonly<{
    readonly nodeType: 3;
    readonly nodeName: '#text';
    readonly textContent: string;
  }> {
    return {
      nodeType: 3,
      nodeName: '#text',
      textContent: text,
    };
  }

  getElementById(id: string): MiniGameHTMLElement | null {
    return this.documentElement.findById(id);
  }

  getElementsByTagName(tagName: string): readonly MiniGameHTMLElement[] {
    if (tagName === 'html') {
      return [this.documentElement];
    }

    if (tagName === 'head') {
      return [this.head];
    }

    if (tagName === 'body') {
      return [this.body];
    }

    return this.documentElement.getElementsByTagName(tagName);
  }

  querySelector(selector: string): MiniGameHTMLElement | null {
    return this.documentElement.querySelector(selector);
  }

  hasFocus(): boolean {
    return !this.hidden;
  }
}

export interface MiniGameGlobalInstallation {
  readonly host: MiniGameHost;
  readonly canvas: MiniGameCanvasElement;
  readonly document: MiniGameDocument;
  readonly window: object;
  readonly disposed: boolean;
  registerDisposalGuard(guard: () => void): () => void;
  dispose(): void;
}

interface SavedGlobalProperty {
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor | undefined;
}

let activeInstallation: MiniGameGlobalInstallationImpl | undefined;

class MiniGameGlobalInstallationImpl implements MiniGameGlobalInstallation {
  readonly host: MiniGameHost;
  readonly canvas: MiniGameCanvasElement;
  readonly document: MiniGameDocument;
  readonly window: object = globalThis;
  readonly #savedProperties: SavedGlobalProperty[] = [];
  readonly #scheduler: MiniGameAnimationFrameScheduler;
  readonly #options: MiniGameRuntimeOptions;
  readonly #windowEvents = new MiniGameEventTarget(undefined, globalThis);
  readonly #disposalGuards = new Set<() => void>();
  #disposeInput: () => void = () => undefined;
  #disposing = false;
  #disposed = false;

  constructor(host: MiniGameHost, options: MiniGameRuntimeOptions) {
    this.host = host;
    this.#options = snapshotMiniGameRuntimeOptions(options);
    const windowInfo = host.getWindowInfo();
    assertMiniGameWindowInfo(windowInfo);
    this.canvas = createMiniGameCanvasElement(host, 'primary');
    const ImageConstructor = createMiniGameImageConstructor(host, this.#options.image);
    const XMLHttpRequestConstructor = createMiniGameXMLHttpRequestConstructor(
      host,
      this.#options.transport,
    );
    this.document = new MiniGameDocument(host, this.canvas, ImageConstructor);
    this.document.defaultView = globalThis;
    this.#scheduler = new MiniGameAnimationFrameScheduler(
      host,
      this.#options.onAnimationFrameError,
    );
    try {
      this.#installGlobals(windowInfo, ImageConstructor, XMLHttpRequestConstructor);
      this.#disposeInput = installMiniGameTouchInput(host, this.canvas).dispose;
    } catch (error) {
      this.#scheduler.dispose();
      this.#restoreGlobals();
      throw error;
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  hasCompatibleOptions(options: MiniGameRuntimeOptions): boolean {
    return haveEquivalentMiniGameRuntimeOptions(
      this.#options,
      snapshotMiniGameRuntimeOptions(options),
    );
  }

  registerDisposalGuard(guard: () => void): () => void {
    if (this.#disposed) {
      throw new MiniGameRuntimeError(
        'MINIGAME_GLOBALS_DISPOSED',
        'Cannot register a dependency on disposed mini-game globals.',
      );
    }

    if (typeof guard !== 'function') {
      throw new MiniGameRuntimeError(
        'MINIGAME_GLOBAL_DISPOSAL_GUARD_INVALID',
        'Mini-game global disposal guards must be functions.',
      );
    }

    this.#disposalGuards.add(guard);
    return () => this.#disposalGuards.delete(guard);
  }

  dispose(): void {
    if (this.#disposed || this.#disposing) {
      return;
    }

    this.#disposing = true;

    try {
      for (const guard of this.#disposalGuards) {
        guard();
      }
    } catch (error) {
      this.#disposing = false;
      throw error;
    }

    this.#disposed = true;
    this.#disposing = false;
    this.#disposeInput();
    this.#scheduler.dispose();
    this.#windowEvents.removeAllEventListeners();
    this.document.removeAllEventListeners();
    this.#disposalGuards.clear();

    this.#restoreGlobals();

    if (activeInstallation === this) {
      activeInstallation = undefined;
    }
  }

  #restoreGlobals(): void {
    for (const saved of [...this.#savedProperties].reverse()) {
      if (saved.descriptor === undefined) {
        Reflect.deleteProperty(globalThis, saved.key);
      } else {
        Object.defineProperty(globalThis, saved.key, saved.descriptor);
      }
    }
    this.#savedProperties.length = 0;
  }

  #installGlobals(
    windowInfo: MiniGameWindowInfo,
    ImageConstructor: MiniGameImageElementConstructor,
    XMLHttpRequestConstructor: ReturnType<typeof createMiniGameXMLHttpRequestConstructor>,
  ): void {
    const performanceValue = typeof globalThis.performance?.now === 'function'
      ? globalThis.performance
      : { now: () => Date.now() };
    const language = windowInfo.language ?? 'en';
    const location = {
      href: 'minigame://game/',
      origin: 'minigame://game',
      protocol: 'minigame:',
      host: 'game',
      hostname: 'game',
      port: '',
      pathname: '/',
      search: '',
      hash: '',
      assign: unsupportedNavigation,
      replace: unsupportedNavigation,
      reload: unsupportedNavigation,
      toString() {
        return this.href;
      },
    };
    const screen = {
      width: windowInfo.width,
      height: windowInfo.height,
      availWidth: windowInfo.width,
      availHeight: windowInfo.height,
      colorDepth: 24,
      pixelDepth: 24,
      orientation: {
        type: windowInfo.width >= windowInfo.height ? 'landscape-primary' : 'portrait-primary',
        angle: 0,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    };
    const navigator = {
      userAgent: `mpgd-minigame/${this.host.kind}`,
      appVersion: `mpgd-minigame/${this.host.kind}`,
      platform: windowInfo.platform ?? this.host.kind,
      language,
      languages: [language],
      maxTouchPoints: 10,
      cookieEnabled: false,
      onLine: true,
      getGamepads: () => [],
    };
    const addEventListener = (
      type: string,
      listener: MiniGameEventListenerLike | null,
      eventOptions?: boolean | Readonly<{ readonly once?: boolean }>,
    ): void => this.#windowEvents.addEventListener(type, listener, eventOptions);
    const removeEventListener = (
      type: string,
      listener: MiniGameEventListenerLike | null,
    ): void => this.#windowEvents.removeEventListener(type, listener);
    const dispatchEvent = (event: MiniGameEvent): boolean => {
      event.target ??= globalThis;
      return this.#windowEvents.dispatchEvent(event);
    };

    this.#define('window', globalThis);
    this.#define('self', globalThis);
    this.#define('top', globalThis);
    this.#define('parent', globalThis);
    this.#define('document', this.document);
    this.#define('navigator', navigator);
    this.#define('location', location);
    this.#define('screen', screen);
    this.#define('performance', performanceValue);
    this.#define('innerWidth', windowInfo.width);
    this.#define('innerHeight', windowInfo.height);
    this.#define('outerWidth', windowInfo.width);
    this.#define('outerHeight', windowInfo.height);
    this.#define('devicePixelRatio', windowInfo.pixelRatio);
    this.#define('pageXOffset', 0);
    this.#define('pageYOffset', 0);
    this.#define('scrollX', 0);
    this.#define('scrollY', 0);
    this.#define('orientation', windowInfo.width >= windowInfo.height ? 90 : 0);
    this.#define('Event', MiniGameEvent);
    this.#define('EventTarget', MiniGameEventTarget);
    this.#define('HTMLElement', MiniGameHTMLElement);
    this.#define('Element', MiniGameHTMLElement);
    this.#define('HTMLCanvasElement', MiniGameCanvasElement);
    this.#define('HTMLImageElement', MiniGameImageElement);
    this.#define('Image', ImageConstructor);
    this.#define('ProgressEvent', MiniGameProgressEvent);
    this.#define('TouchEvent', MiniGameTouchEvent);
    this.#define('XMLHttpRequest', XMLHttpRequestConstructor);
    this.#define(
      'requestAnimationFrame',
      (callback: (time: number) => void) => (this.#scheduler.request(callback)),
    );
    this.#define('cancelAnimationFrame', (id: number) => this.#scheduler.cancel(id));
    this.#define('addEventListener', addEventListener);
    this.#define('removeEventListener', removeEventListener);
    this.#define('dispatchEvent', dispatchEvent);
    this.#define('focus', () => dispatchEvent(new MiniGameEvent('focus')));
    this.#define('scrollTo', () => undefined);
    this.#define('matchMedia', (query: string) => ({
      matches: query.includes('landscape')
        ? windowInfo.width >= windowInfo.height
        : query.includes('portrait') && windowInfo.height > windowInfo.width,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }));
    this.#define('getComputedStyle', (element: MiniGameHTMLElement) => element.style);
  }

  #define(key: PropertyKey, value: unknown): void {
    this.#savedProperties.push({
      key,
      descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
    });

    try {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value,
      });
    } catch (error) {
      throw new MiniGameRuntimeError(
        'MINIGAME_GLOBAL_INSTALL_FAILED',
        `Unable to install required mini-game global ${String(key)}: ${String(error)}`,
      );
    }
  }
}

export function installMiniGameGlobals(
  host: MiniGameHost,
  options: MiniGameRuntimeOptions = {},
): MiniGameGlobalInstallation {
  if (activeInstallation !== undefined && !activeInstallation.disposed) {
    if (activeInstallation.host === host) {
      if (!activeInstallation.hasCompatibleOptions(options)) {
        throw new MiniGameRuntimeError(
          'MINIGAME_GLOBALS_OPTIONS_MISMATCH',
          'Mini-game globals are already installed with different runtime options.',
        );
      }

      return activeInstallation;
    }

    throw new MiniGameRuntimeError(
      'MINIGAME_GLOBALS_ALREADY_INSTALLED',
      'Mini-game globals are already installed for another host.',
    );
  }

  activeInstallation = new MiniGameGlobalInstallationImpl(host, options);
  return activeInstallation;
}

export function getInstalledMiniGameGlobals(): MiniGameGlobalInstallation | undefined {
  return activeInstallation?.disposed === false ? activeInstallation : undefined;
}

function snapshotMiniGameRuntimeOptions(options: MiniGameRuntimeOptions): MiniGameRuntimeOptions {
  return Object.freeze({
    ...(options.image === undefined ? {} : { image: snapshotImageOptions(options.image) }),
    ...(options.transport === undefined
      ? {}
      : { transport: snapshotTransportOptions(options.transport) }),
    ...(options.onAnimationFrameError === undefined
      ? {}
      : { onAnimationFrameError: options.onAnimationFrameError }),
  });
}

function snapshotImageOptions(options: MiniGameImageOptions): MiniGameImageOptions {
  return Object.freeze({
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.loadTimeoutMs === undefined ? {} : { loadTimeoutMs: options.loadTimeoutMs }),
    ...(options.allowedRemoteOrigins === undefined
      ? {}
      : { allowedRemoteOrigins: snapshotOriginList(options.allowedRemoteOrigins) }),
  });
}

function snapshotTransportOptions(options: MiniGameTransportOptions): MiniGameTransportOptions {
  return Object.freeze({
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.allowedRemoteOrigins === undefined
      ? {}
      : { allowedRemoteOrigins: snapshotOriginList(options.allowedRemoteOrigins) }),
  });
}

function snapshotOriginList(origins: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(origins)].sort());
}

function haveEquivalentMiniGameRuntimeOptions(
  left: MiniGameRuntimeOptions,
  right: MiniGameRuntimeOptions,
): boolean {
  return left.onAnimationFrameError === right.onAnimationFrameError
    && Object.is(left.image?.pollIntervalMs, right.image?.pollIntervalMs)
    && Object.is(left.image?.loadTimeoutMs, right.image?.loadTimeoutMs)
    && haveEquivalentOriginLists(
      left.image?.allowedRemoteOrigins,
      right.image?.allowedRemoteOrigins,
    )
    && Object.is(left.transport?.requestTimeoutMs, right.transport?.requestTimeoutMs)
    && haveEquivalentOriginLists(
      left.transport?.allowedRemoteOrigins,
      right.transport?.allowedRemoteOrigins,
    );
}

function haveEquivalentOriginLists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const leftOrigins = left ?? [];
  const rightOrigins = right ?? [];

  return leftOrigins.length === rightOrigins.length
    && leftOrigins.every((origin, index) => origin === rightOrigins[index]);
}

function unsupportedNavigation(): never {
  throw new MiniGameRuntimeError(
    'MINIGAME_NAVIGATION_UNSUPPORTED',
    'Browser navigation is not available in a native mini-game runtime.',
  );
}
