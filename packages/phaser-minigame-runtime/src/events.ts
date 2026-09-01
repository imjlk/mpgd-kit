export interface MiniGameEventInit {
  readonly cancelable?: boolean;
  readonly timeStamp?: number;
}

export class MiniGameEvent {
  readonly type: string;
  readonly cancelable: boolean;
  readonly timeStamp: number;
  target: unknown = null;
  currentTarget: unknown = null;
  defaultPrevented = false;
  propagationStopped = false;
  immediatePropagationStopped = false;

  constructor(type: string, init: MiniGameEventInit = {}) {
    this.type = type;
    this.cancelable = init.cancelable === true;
    this.timeStamp = init.timeStamp ?? Date.now();
  }

  preventDefault(): void {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
    this.immediatePropagationStopped = true;
  }
}

export type MiniGameEventListener = (event: MiniGameEvent) => void;

export interface MiniGameEventListenerObject {
  handleEvent(event: MiniGameEvent): void;
}

export type MiniGameEventListenerLike = MiniGameEventListener | MiniGameEventListenerObject;

interface ListenerRegistration {
  readonly listener: MiniGameEventListenerLike;
  readonly once: boolean;
}

export class MiniGameEventTarget {
  readonly #listeners = new Map<string, ListenerRegistration[]>();

  addEventListener(
    type: string,
    listener: MiniGameEventListenerLike | null,
    options?: boolean | Readonly<{ readonly once?: boolean }>,
  ): void {
    if (listener === null) {
      return;
    }

    const registrations = this.#listeners.get(type) ?? [];

    if (registrations.some((registration) => registration.listener === listener)) {
      return;
    }

    registrations.push({
      listener,
      once: typeof options === 'object' && options.once === true,
    });
    this.#listeners.set(type, registrations);
  }

  removeEventListener(type: string, listener: MiniGameEventListenerLike | null): void {
    if (listener === null) {
      return;
    }

    const registrations = this.#listeners.get(type);

    if (registrations === undefined) {
      return;
    }

    const remaining = registrations.filter((registration) => registration.listener !== listener);

    if (remaining.length === 0) {
      this.#listeners.delete(type);
    } else {
      this.#listeners.set(type, remaining);
    }
  }

  dispatchEvent(event: MiniGameEvent): boolean {
    event.target ??= this;
    event.currentTarget = this;

    for (const registration of [...(this.#listeners.get(event.type) ?? [])]) {
      if (registration.once) {
        this.removeEventListener(event.type, registration.listener);
      }

      if (typeof registration.listener === 'function') {
        registration.listener.call(this, event);
      } else {
        registration.listener.handleEvent(event);
      }

      if (event.immediatePropagationStopped) {
        break;
      }
    }

    return !event.defaultPrevented;
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.length ?? 0;
  }

  removeAllEventListeners(): void {
    this.#listeners.clear();
  }
}
