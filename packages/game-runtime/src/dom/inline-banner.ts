import type { BannerAdMountResult, PlatformGateway } from '@mpgd/platform';
import { observe, type ObserverErrorHandler } from '../observers.js';

export type InlineBannerAds = Pick<PlatformGateway['ads'], 'mountBanner' | 'unmountBanner'>;

export interface InlineBannerOptions {
  readonly gameRoot: HTMLElement;
  readonly ads: InlineBannerAds;
  readonly enabled: boolean;
  readonly placementId: string;
  /** Game-owned namespace; each mount appends a unique opaque suffix. */
  readonly surfaceId: string;
  readonly label: string;
  readonly layoutClassName: string;
  readonly surfaceClassName: string;
  readonly stateDataKey: string;
  readonly onObserverError?: ObserverErrorHandler;
}
export interface InlineBannerController {
  readonly destroy: () => void;
}
export interface InlineBannerManager {
  readonly acquire: (input?: { readonly onLayoutChange?: () => void }) => () => void;
  readonly destroy: () => void;
}

// A parent represents one layout slot. A newer mount releases the previous owner.
const parentOwners = new WeakMap<HTMLElement, () => void>();
const parentManagers = new WeakMap<HTMLElement, () => void>();
let nextSurfaceSequence = 0;

/** Scene-owned acquisition over the canonical gateway, with page-restore renewal. */
export function createInlineBannerManager(input: InlineBannerOptions): InlineBannerManager {
  assertOptions(input);
  let active: { controller: InlineBannerController; owner: { released: boolean }; onLayoutChange?: () => void } | null = null;
  let destroyed = false;
  let acquisitionRevision = 0;
  let restorePending = false;
  let ownedParent: HTMLElement | null = null;
  const lifecycle = input.gameRoot.ownerDocument.defaultView;
  const mount = (owner: { released: boolean }, onLayoutChange?: () => void): void => {
    const controller = mountBannerSurface(
      {
        ...input,
        ...(onLayoutChange === undefined ? {} : { onLayoutChange }),
      },
      destroyManager,
    );
    if (destroyed || owner.released || active !== null) {
      controller.destroy();
      return;
    }
    active = {
      owner,
      controller,
      ...(onLayoutChange === undefined ? {} : { onLayoutChange }),
    };
  };
  const onHide = (): void => {
    restorePending = true;
  };
  const onShow = (): void => {
    if (!restorePending) {
      return;
    }
    restorePending = false;
    if (destroyed || active === null) {
      return;
    }
    const revision = acquisitionRevision;
    const previous = active;
    active = null;
    previous.controller.destroy();
    if (destroyed || previous.owner.released || acquisitionRevision !== revision) {
      return;
    }
    mount(previous.owner, previous.onLayoutChange);
  };
  lifecycle?.addEventListener('pagehide', onHide);
  lifecycle?.addEventListener('pageshow', onShow);
  return {
    acquire(acquisition = {}) {
      if (destroyed) {
        return () => {};
      }
      const revision = ++acquisitionRevision;
      const parent = input.gameRoot.parentElement;
      if (ownedParent !== null && ownedParent !== parent && parentManagers.get(ownedParent) === destroyManager) {
        parentManagers.delete(ownedParent);
      }
      ownedParent = parent;
      if (parent !== null) {
        const previousManager = parentManagers.get(parent);
        parentManagers.set(parent, destroyManager);
        if (previousManager !== destroyManager) {
          previousManager?.();
        }
      }
      if (destroyed || acquisitionRevision !== revision) {
        return () => {};
      }
      const previous = active;
      active = null;
      previous?.controller.destroy();
      if (destroyed || acquisitionRevision !== revision) {
        return () => {};
      }
      const owner = { released: false };
      mount(owner, acquisition.onLayoutChange);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        owner.released = true;
        if (active?.owner === owner) {
          const previous = active;
          active = null;
          previous.controller.destroy();
        }
      };
    },
    destroy: destroyManager,
  };
  function destroyManager(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    lifecycle?.removeEventListener('pagehide', onHide);
    lifecycle?.removeEventListener('pageshow', onShow);
    const previous = active;
    active = null;
    previous?.controller.destroy();
    if (ownedParent !== null && parentManagers.get(ownedParent) === destroyManager) {
      parentManagers.delete(ownedParent);
    }
    ownedParent = null;
  }
}

/** Reserve layout only after provider confirmation; asynchronous cleanup keeps its own ID. */
export function mountInlineBanner(
  input: InlineBannerOptions & { readonly onLayoutChange?: () => void },
): InlineBannerController {
  return mountBannerSurface(input);
}

function mountBannerSurface(
  input: InlineBannerOptions & { readonly onLayoutChange?: () => void },
  managerOwner?: () => void,
): InlineBannerController {
  assertOptions(input);
  const parent = input.gameRoot.parentElement;
  const mountBanner = input.ads.mountBanner?.bind(input.ads);
  const unmountBanner = input.ads.unmountBanner?.bind(input.ads);
  if (!input.enabled || mountBanner === undefined || parent === null) {
    return { destroy() {} };
  }
  const layoutParent = parent;
  const doc = input.gameRoot.ownerDocument;
  const random = doc.defaultView?.crypto ?? globalThis.crypto;
  if (random === undefined) {
    throw new Error('Inline banner surfaces require a crypto random source.');
  }
  const suffix = Array.from(random.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, '0')).join('');
  nextSurfaceSequence += 1;
  const surfaceId = `${input.surfaceId}-${suffix}-${nextSurfaceSequence}`;
  const surface = doc.createElement('aside');
  surface.id = surfaceId;
  surface.className = input.surfaceClassName;
  surface.setAttribute('aria-label', input.label);
  surface.dataset.adPlacement = input.placementId;
  let destroyed = false;
  let promise: Promise<BannerAdMountResult> | null = null;
  const notifyLayout = (): void => observe(() => input.onLayoutChange?.(), input.onObserverError);
  const onHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      destroy();
    }
  };
  const lifecycle = doc.defaultView;
  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    surface.remove();
    if (parentOwners.get(layoutParent) === destroy) {
      parentOwners.delete(layoutParent);
      layoutParent.classList.remove(input.layoutClassName);
      delete layoutParent.dataset[input.stateDataKey];
    }
    lifecycle?.removeEventListener('pagehide', onHide);
    if (unmountBanner !== undefined && promise !== null) {
      void promise.then(
        (result) => result.status === 'mounted' ? unmountBanner({ surfaceId }) : undefined,
        () => undefined,
      ).catch((error: unknown) => observe(() => { throw error; }, input.onObserverError));
    }
    notifyLayout();
  }
  const manager = parentManagers.get(layoutParent);
  if (manager !== undefined && manager !== managerOwner) {
    manager();
  }
  const previousOwner = parentOwners.get(layoutParent);
  parentOwners.set(layoutParent, destroy);
  previousOwner?.();
  if (destroyed) {
    return { destroy };
  }
  layoutParent.classList.add(input.layoutClassName);
  layoutParent.dataset[input.stateDataKey] = 'loading';
  layoutParent.append(surface);
  lifecycle?.addEventListener('pagehide', onHide);
  try {
    const mounted = Promise.resolve(mountBanner({ placementId: input.placementId, surfaceId }));
    promise = mounted;
    void mounted.then(
      (result) => {
        if (destroyed) {
          return;
        }
        if (result.status === 'mounted') {
          layoutParent.dataset[input.stateDataKey] = 'mounted';
          notifyLayout();
        } else {
          destroy();
        }
      },
      () => destroy(),
    );
  } catch {
    destroy();
  }
  return { destroy };
}

function assertOptions(input: InlineBannerOptions): void {
  for (const name of [
    'placementId',
    'surfaceId',
    'label',
    'layoutClassName',
    'surfaceClassName',
    'stateDataKey',
  ] as const) {
    const value = input[name];
    if (typeof value !== 'string' || !value.trim() || value.length > (name === 'surfaceId' ? 128 : 256)
      || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError(`Inline banner ${name} is invalid.`);
    }
  }
  if (/\s/u.test(input.layoutClassName) || !/^[a-z][a-zA-Z0-9]*$/u.test(input.stateDataKey)) {
    throw new TypeError(
      'Inline banner layoutClassName must be a CSS token and stateDataKey a camel-case key.',
    );
  }
  if (typeof input.enabled !== 'boolean') {
    throw new TypeError('Inline banner enabled must be a boolean.');
  }
}
