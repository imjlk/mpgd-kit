import { MiniGameEvent, MiniGameEventTarget } from './events.js';
import { MiniGameRuntimeError, type MiniGameHost, type MiniGameWindowInfo } from './host.js';
import { getMiniGameCanvasBounds, type MiniGameCanvasBounds } from './scale.js';

export const miniGameNativeObjectSymbol = Symbol.for('mpgd.minigame.nativeObject');

export interface MiniGameStyleDeclaration extends Record<string, unknown> {
  getPropertyValue(name: string): string;
  removeProperty(name: string): string;
  setProperty(name: string, value: string): void;
}

export class MiniGameHTMLElement extends MiniGameEventTarget {
  readonly nodeType = 1;
  readonly nodeName: string;
  readonly tagName: string;
  readonly style: MiniGameStyleDeclaration;
  readonly children: unknown[] = [];
  parentNode: MiniGameHTMLElement | null = null;
  ownerDocument: unknown = null;
  id = '';
  className = '';
  textContent = '';
  hidden = false;
  tabIndex = -1;
  readonly #attributes = new Map<string, string>();
  readonly #bounds: () => MiniGameCanvasBounds;

  constructor(tagName: string, bounds: () => MiniGameCanvasBounds) {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.style = createMiniGameStyle();
    this.#bounds = bounds;
  }

  get childNodes(): readonly unknown[] {
    return this.children;
  }

  get firstChild(): unknown | null {
    return this.children[0] ?? null;
  }

  get clientWidth(): number {
    return this.#bounds().width;
  }

  get clientHeight(): number {
    return this.#bounds().height;
  }

  get offsetWidth(): number {
    return this.clientWidth;
  }

  get offsetHeight(): number {
    return this.clientHeight;
  }

  appendChild<T>(child: T): T {
    if (!this.children.includes(child)) {
      this.children.push(child);
    }

    if (child instanceof MiniGameHTMLElement) {
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
    }

    return child;
  }

  insertBefore<T>(child: T, reference: unknown | null): T {
    const currentIndex = this.children.indexOf(child);

    if (currentIndex >= 0) {
      this.children.splice(currentIndex, 1);
    }

    const referenceIndex = reference === null ? -1 : this.children.indexOf(reference);
    const insertionIndex = referenceIndex < 0 ? this.children.length : referenceIndex;
    this.children.splice(insertionIndex, 0, child);

    if (child instanceof MiniGameHTMLElement) {
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
    }

    return child;
  }

  removeChild<T>(child: T): T {
    const index = this.children.indexOf(child);

    if (index < 0) {
      throw new MiniGameRuntimeError(
        'MINIGAME_DOM_CHILD_NOT_FOUND',
        `Cannot remove a child that is not attached to <${this.tagName.toLowerCase()}>.`,
      );
    }

    this.children.splice(index, 1);

    if (child instanceof MiniGameHTMLElement) {
      child.parentNode = null;
    }

    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  contains(child: unknown): boolean {
    if (this.children.includes(child)) {
      return true;
    }

    return this.children.some(
      (candidate) => candidate instanceof MiniGameHTMLElement && candidate.contains(child),
    );
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, String(value));

    if (name === 'id') {
      this.id = String(value);
    }
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);

    if (name === 'id') {
      this.id = '';
    }
  }

  hasAttribute(name: string): boolean {
    return this.#attributes.has(name);
  }

  getBoundingClientRect(): MiniGameCanvasBounds {
    return this.#bounds();
  }

  getElementsByTagName(tagName: string): readonly MiniGameHTMLElement[] {
    const normalized = tagName.toUpperCase();
    const matches: MiniGameHTMLElement[] = [];

    for (const child of this.children) {
      if (!(child instanceof MiniGameHTMLElement)) {
        continue;
      }

      if (normalized === '*' || child.tagName === normalized) {
        matches.push(child);
      }

      matches.push(...child.getElementsByTagName(tagName));
    }

    return matches;
  }

  querySelector(selector: string): MiniGameHTMLElement | null {
    if (selector.startsWith('#')) {
      return this.findById(selector.slice(1));
    }

    return this.getElementsByTagName(selector)[0] ?? null;
  }

  findById(id: string): MiniGameHTMLElement | null {
    if (this.id === id) {
      return this;
    }

    for (const child of this.children) {
      if (child instanceof MiniGameHTMLElement) {
        const match = child.findById(id);

        if (match !== null) {
          return match;
        }
      }
    }

    return null;
  }

  focus(): void {
    this.dispatchEvent(new MiniGameEvent('focus'));
  }

  blur(): void {
    this.dispatchEvent(new MiniGameEvent('blur'));
  }
}

export class MiniGameCanvasElement extends MiniGameHTMLElement {
  readonly [miniGameNativeObjectSymbol]: object;
  readonly #contexts = new WeakMap<object, unknown>();
  readonly #windowInfo: () => MiniGameWindowInfo;

  constructor(nativeCanvas: unknown, windowInfo: () => MiniGameWindowInfo) {
    super('canvas', () => getMiniGameCanvasBounds(windowInfo()));
    this[miniGameNativeObjectSymbol] = assertNativeObject(nativeCanvas, 'canvas');
    this.#windowInfo = windowInfo;
  }

  override get clientWidth(): number {
    return this.getBoundingClientRect().width;
  }

  override get clientHeight(): number {
    return this.getBoundingClientRect().height;
  }

  override getBoundingClientRect(): MiniGameCanvasBounds {
    return getMiniGameCanvasBounds(this.#windowInfo(), {
      width: readStyleValue(this.style, 'width', 'width'),
      height: readStyleValue(this.style, 'height', 'height'),
      left: readStyleValue(this.style, 'left', 'left'),
      top: readStyleValue(this.style, 'top', 'top'),
      marginLeft: readStyleValue(this.style, 'marginLeft', 'margin-left'),
      marginTop: readStyleValue(this.style, 'marginTop', 'margin-top'),
    });
  }

  override setAttribute(name: string, value: string): void {
    const normalizedName = name.toLowerCase();

    if (normalizedName === 'width' || normalizedName === 'height') {
      const dimension = Number(value);

      if (!Number.isFinite(dimension) || dimension < 0) {
        throw new MiniGameRuntimeError(
          'MINIGAME_CANVAS_DIMENSION_INVALID',
          `Mini-game canvas ${normalizedName} must be a non-negative finite number.`,
        );
      }

      this[normalizedName] = Math.floor(dimension);
      super.setAttribute(normalizedName, String(value));
      return;
    }

    super.setAttribute(name, value);
  }

  get width(): number {
    return readFiniteNumber(this[miniGameNativeObjectSymbol], 'width', 1);
  }

  set width(value: number) {
    Reflect.set(this[miniGameNativeObjectSymbol], 'width', value);
  }

  get height(): number {
    return readFiniteNumber(this[miniGameNativeObjectSymbol], 'height', 1);
  }

  set height(value: number) {
    Reflect.set(this[miniGameNativeObjectSymbol], 'height', value);
  }

  getContext(type: string, ...args: readonly unknown[]): unknown {
    if (type !== '2d') {
      return null;
    }

    const getter = Reflect.get(this[miniGameNativeObjectSymbol], 'getContext');

    if (typeof getter !== 'function') {
      throw new MiniGameRuntimeError(
        'MINIGAME_CANVAS_CONTEXT_UNAVAILABLE',
        'The mini-game host canvas does not provide getContext().',
      );
    }

    const context = Reflect.apply(getter, this[miniGameNativeObjectSymbol], [type, ...args]);

    if (context === null || typeof context !== 'object') {
      return context;
    }

    const cached = this.#contexts.get(context);

    if (cached !== undefined) {
      return cached;
    }

    const wrapped = wrapCanvasContext(context, this);
    this.#contexts.set(context, wrapped);
    return wrapped;
  }

  toDataURL(...args: readonly unknown[]): string {
    const method = Reflect.get(this[miniGameNativeObjectSymbol], 'toDataURL');

    if (typeof method !== 'function') {
      throw new MiniGameRuntimeError(
        'MINIGAME_CANVAS_EXPORT_UNSUPPORTED',
        'The mini-game host canvas does not support toDataURL().',
      );
    }

    return String(Reflect.apply(method, this[miniGameNativeObjectSymbol], args));
  }
}

export function createMiniGameCanvasElement(
  host: MiniGameHost,
  type: 'primary' | 'offscreen',
): MiniGameCanvasElement {
  return new MiniGameCanvasElement(host.createCanvas({ type }), () => host.getWindowInfo());
}

export function unwrapMiniGameNativeObject(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && miniGameNativeObjectSymbol in value) {
    return (value as Readonly<Record<typeof miniGameNativeObjectSymbol, unknown>>)[
      miniGameNativeObjectSymbol
    ];
  }

  return value;
}

function wrapCanvasContext(context: object, canvas: MiniGameCanvasElement): unknown {
  const wrappedMethods = new Map<PropertyKey, unknown>();

  return new Proxy(context, {
    get(target, property) {
      if (property === 'canvas') {
        return canvas;
      }

      const value = Reflect.get(target, property, target);

      if (typeof value !== 'function') {
        return value;
      }

      if (wrappedMethods.has(property)) {
        return wrappedMethods.get(property);
      }

      if (property === 'drawImage' || property === 'createPattern') {
        const wrapped = (source: unknown, ...args: readonly unknown[]) => Reflect.apply(
          value,
          target,
          [unwrapMiniGameNativeObject(source), ...args],
        );
        wrappedMethods.set(property, wrapped);
        return wrapped;
      }

      const bound = value.bind(target);
      wrappedMethods.set(property, bound);
      return bound;
    },
    set(target, property, value) {
      wrappedMethods.delete(property);
      return Reflect.set(target, property, value, target);
    },
  });
}

function createMiniGameStyle(): MiniGameStyleDeclaration {
  const values: Record<string, string> = {};
  const methods = {
    getPropertyValue(name: string) {
      return values[name] ?? '';
    },
    removeProperty(name: string) {
      const previous = values[name] ?? '';
      delete values[name];
      return previous;
    },
    setProperty(name: string, value: string) {
      values[name] = String(value);
    },
  };

  return new Proxy(methods as unknown as MiniGameStyleDeclaration, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        return values[property] ?? '';
      }

      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        values[property] = String(value);
        return true;
      }

      return Reflect.set(target, property, value, receiver);
    },
  });
}

function readStyleValue(
  style: MiniGameStyleDeclaration,
  property: string,
  cssProperty: string,
): unknown {
  const direct = style[property];
  return direct === undefined || direct === '' ? style.getPropertyValue(cssProperty) : direct;
}

function assertNativeObject(input: unknown, kind: string): object {
  if (input === null || (typeof input !== 'object' && typeof input !== 'function')) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_NATIVE_OBJECT',
      `The mini-game host returned an invalid native ${kind} object.`,
    );
  }

  return input;
}

function readFiniteNumber(object: object, property: string, fallback: number): number {
  const value = Reflect.get(object, property);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
