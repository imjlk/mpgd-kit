import type { BannerAdMountResult } from '@mpgd/platform';
import { describe, expect, it, vi } from 'vitest';
import { createInlineBannerManager, type InlineBannerOptions } from './inline-banner.js';

describe('scene-owned inline banners', () => {
  it('reserves layout after confirmation and renews the surface on page restoration', async () => {
    const f = fixture();
    const layout = vi.fn();
    const manager = createInlineBannerManager(f.input);
    const release = manager.acquire({ onLayoutChange: layout });
    expect(f.parent.dataset.bannerState).toBe('loading');
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    const first = f.mountBanner.mock.calls[0]?.[0].surfaceId;
    expect(first).toMatch(/^sample-footer-/u);
    expect(f.parent.children[1]?.attributes.get('aria-label')).toBe('Advertisement');
    f.lifecycle.emit('pagehide', true);
    f.lifecycle.emit('pageshow', true);
    await vi.waitFor(() => expect(f.mountBanner).toHaveBeenCalledTimes(2));
    const second = f.mountBanner.mock.calls[1]?.[0].surfaceId;
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(f.unmountBanner).toHaveBeenCalledWith({ surfaceId: first }));
    release();
    release();
    await vi.waitFor(() => expect(f.unmountBanner).toHaveBeenCalledWith({ surfaceId: second }));
    expect(f.parent.children).toEqual([f.root]);
    expect(f.parent.dataset.bannerState).toBeUndefined();
    manager.destroy();
    manager.destroy();
    expect(f.lifecycle.listenerCount()).toBe(0);
    expect(layout).toHaveBeenCalled();
  });

  it('cannot let a late result or old release remove a newer acquisition', async () => {
    const f = fixture();
    const pending = deferred<BannerAdMountResult>();
    f.mountBanner.mockImplementationOnce(() => pending.promise);
    const manager = createInlineBannerManager(f.input);
    const releaseOld = manager.acquire();
    const first = f.mountBanner.mock.calls[0]?.[0].surfaceId;
    const releaseNew = manager.acquire();
    const second = f.mountBanner.mock.calls[1]?.[0].surfaceId;
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    releaseOld();
    pending.resolve({ status: 'mounted' });
    await vi.waitFor(() => expect(f.unmountBanner).toHaveBeenCalledWith({ surfaceId: first }));
    expect(f.parent.dataset.bannerState).toBe('mounted');
    expect(f.parent.children[1]?.id).toBe(second);
    releaseNew();
    manager.destroy();
  });

  it('keeps unique identities when separate managers share a parent slot', async () => {
    const f = fixture();
    const pending = deferred<BannerAdMountResult>();
    f.mountBanner.mockImplementationOnce(() => pending.promise);
    const first = createInlineBannerManager(f.input);
    const second = createInlineBannerManager(f.input);
    const releaseFirst = first.acquire();
    const firstId = f.mountBanner.mock.calls[0]?.[0].surfaceId;
    const releaseSecond = second.acquire();
    const secondId = f.mountBanner.mock.calls[1]?.[0].surfaceId;
    expect(secondId).not.toBe(firstId);
    pending.resolve({ status: 'mounted' });
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    releaseFirst();
    first.destroy();
    expect(f.parent.children[1]?.id).toBe(secondId);
    expect(f.parent.dataset.bannerState).toBe('mounted');
    releaseSecond();
    second.destroy();
  });

  it('disposes a displaced manager so page restoration cannot reclaim a newer slot', async () => {
    const f = fixture();
    const first = createInlineBannerManager(f.input);
    first.acquire();
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    const second = createInlineBannerManager(f.input);
    second.acquire();
    await vi.waitFor(() => expect(f.mountBanner).toHaveBeenCalledTimes(2));
    first.acquire();
    f.lifecycle.emit('pagehide', true);
    f.lifecycle.emit('pageshow', true);
    await vi.waitFor(() => expect(f.mountBanner).toHaveBeenCalledTimes(3));
    expect(f.parent.children).toHaveLength(2);
    second.destroy();
    expect(f.lifecycle.listenerCount()).toBe(0);
  });

  it.each(['unavailable', 'failed'] as const)(
    'collapses %s without unmounting terminal provider cleanup',
    async (status) => {
      const f = fixture();
      f.mountBanner.mockResolvedValueOnce({ status });
      const manager = createInlineBannerManager(f.input);
      manager.acquire();
      await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBeUndefined());
      expect(f.parent.children).toEqual([f.root]);
      expect(f.unmountBanner).not.toHaveBeenCalled();
      manager.destroy();
    },
  );

  it('renews after a non-cached page restoration and stops renewal after release', async () => {
    const f = fixture();
    const manager = createInlineBannerManager(f.input);
    const release = manager.acquire();
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    f.lifecycle.emit('pagehide', false);
    expect(f.parent.dataset.bannerState).toBeUndefined();
    f.lifecycle.emit('pageshow', false);
    await vi.waitFor(() => expect(f.mountBanner).toHaveBeenCalledTimes(2));
    release();
    f.lifecycle.emit('pagehide', true);
    f.lifecycle.emit('pageshow', true);
    expect(f.mountBanner).toHaveBeenCalledTimes(2);
    manager.destroy();
  });

  it('finishes cleanup even if layout observers throw', async () => {
    const f = fixture();
    const onObserverError = vi.fn();
    const manager = createInlineBannerManager({ ...f.input, onObserverError });
    const release = manager.acquire({
      onLayoutChange: () => {
        throw new Error('observer failure');
      },
    });
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    release();
    manager.destroy();
    await vi.waitFor(() => expect(f.unmountBanner).toHaveBeenCalledTimes(1));
    expect(onObserverError).toHaveBeenCalled();
    expect(f.parent.children).toEqual([f.root]);
    expect(f.lifecycle.listenerCount()).toBe(0);
  });

  it('does not remount after a teardown callback destroys the manager during restoration', async () => {
    const f = fixture();
    let teardown = false;
    const manager = createInlineBannerManager(f.input);
    manager.acquire({
      onLayoutChange: () => {
        if (teardown) {
          manager.destroy();
        }
      },
    });
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    teardown = true;
    f.lifecycle.emit('pagehide', true);
    f.lifecycle.emit('pageshow', true);
    expect(f.mountBanner).toHaveBeenCalledTimes(1);
    expect(f.parent.children).toEqual([f.root]);
    expect(f.lifecycle.listenerCount()).toBe(0);
  });

  it('does not renew a lease released from a restoration layout callback', async () => {
    const f = fixture();
    let cancel: () => void = () => {};
    let stop = false;
    const manager = createInlineBannerManager(f.input);
    cancel = manager.acquire({ onLayoutChange: () => { if (stop) { cancel(); } } });
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    stop = true;
    f.lifecycle.emit('pagehide', true);
    f.lifecycle.emit('pageshow', true);
    expect(f.mountBanner).toHaveBeenCalledTimes(1);
    expect(f.parent.children).toEqual([f.root]);
    manager.destroy();
  });

  it('keeps a newer acquisition made by a restoration layout callback', async () => {
    const f = fixture();
    let replace = false;
    const manager = createInlineBannerManager(f.input);
    manager.acquire({
      onLayoutChange: () => {
        if (replace) {
          replace = false;
          manager.acquire();
        }
      },
    });
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    replace = true;
    f.lifecycle.emit('pagehide', true);
    f.lifecycle.emit('pageshow', true);
    await vi.waitFor(() => expect(f.parent.dataset.bannerState).toBe('mounted'));
    expect(f.mountBanner).toHaveBeenCalledTimes(2);
    expect(f.parent.children).toHaveLength(2);
    manager.destroy();
  });

  it('skips disabled providers and validates configuration before touching layout', () => {
    const f = fixture();
    const manager = createInlineBannerManager({ ...f.input, enabled: false });
    manager.acquire();
    manager.destroy();
    manager.acquire();
    expect(f.mountBanner).not.toHaveBeenCalled();
    expect(f.parent.children).toEqual([f.root]);
    expect(() => createInlineBannerManager({ ...f.input, layoutClassName: 'bad token' })).toThrow();
    expect(f.lifecycle.listenerCount()).toBe(0);
  });
});

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {
    throw new Error('Uninitialized deferred');
  };
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: (value: Value) => resolve(value) };
}

function fixture() {
  const lifecycle = new FakeLifecycle();
  const doc = { defaultView: lifecycle, createElement: () => new FakeElement(doc) };
  const parent = new FakeElement(doc);
  const root = new FakeElement(doc);
  parent.append(root);
  const mountBanner = vi.fn(
    async (_input: { placementId: string; surfaceId: string }): Promise<BannerAdMountResult> => ({
      status: 'mounted',
    }),
  );
  const unmountBanner = vi.fn(async (_input: { surfaceId: string }) => {});
  const input: InlineBannerOptions = {
    gameRoot: root as unknown as HTMLElement,
    ads: { mountBanner, unmountBanner },
    enabled: true,
    placementId: 'FOOTER',
    surfaceId: 'sample-footer',
    label: 'Advertisement',
    layoutClassName: 'banner-layout',
    surfaceClassName: 'banner-surface',
    stateDataKey: 'bannerState',
  };
  return { input, parent, root, lifecycle, mountBanner, unmountBanner };
}

class FakeLifecycle {
  readonly crypto = globalThis.crypto;
  private readonly listeners = new Map<string, Set<(event: PageTransitionEvent) => void>>();
  addEventListener(type: string, listener: (event: PageTransitionEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: PageTransitionEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, persisted: boolean): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ persisted } as PageTransitionEvent);
    }
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}
class FakeElement {
  id = '';
  className = '';
  readonly dataset: Record<string, string | undefined> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly classList = {
    add: (value: string) => this.classes.add(value),
    remove: (value: string) => this.classes.delete(value),
  };
  private readonly classes = new Set<string>();
  constructor(readonly ownerDocument: { defaultView: FakeLifecycle; createElement: () => FakeElement }) {}
  append(child: FakeElement): void {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
  }
  remove(): void {
    if (this.parentElement === null) {
      return;
    }
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) {
      this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}
