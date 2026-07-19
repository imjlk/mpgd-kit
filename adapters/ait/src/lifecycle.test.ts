import { afterEach, describe, expect, it, vi } from 'vitest';

import { aitLifecyclePauseEvent, createAitLifecycleAdapter } from './lifecycle';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AIT lifecycle adapter', () => {
  it('deduplicates one native transition across custom, visibility, and page events', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));
    const globalEvents = new EventTarget();
    const documentEvents = new EventTarget();
    Object.defineProperty(documentEvents, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    vi.stubGlobal('addEventListener', globalEvents.addEventListener.bind(globalEvents));
    vi.stubGlobal('removeEventListener', globalEvents.removeEventListener.bind(globalEvents));
    vi.stubGlobal('document', documentEvents as unknown as Document);

    const callback = vi.fn();
    const unsubscribe = createAitLifecycleAdapter().onPause(callback);

    globalEvents.dispatchEvent(new Event(aitLifecyclePauseEvent));
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    globalEvents.dispatchEvent(new Event('pagehide'));
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(501);
    globalEvents.dispatchEvent(new Event('pagehide'));
    expect(callback).toHaveBeenCalledTimes(2);

    vi.stubGlobal('document', new EventTarget() as unknown as Document);
    unsubscribe();
    vi.advanceTimersByTime(501);
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    globalEvents.dispatchEvent(new Event('pagehide'));
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
