import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aitLifecyclePauseEvent,
  aitLifecycleResumeEvent,
  createAitLifecycleAdapter,
} from './lifecycle';

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
    expect(callback).toHaveBeenCalledTimes(1);

    vi.stubGlobal('document', new EventTarget() as unknown as Document);
    unsubscribe();
    vi.advanceTimersByTime(501);
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    globalEvents.dispatchEvent(new Event('pagehide'));
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('keeps hidden-page ownership after native resume and allows immediate real transitions', async () => {
    const globalEvents = new EventTarget();
    const documentEvents = new EventTarget();
    let visibilityState = 'visible';
    Object.defineProperty(documentEvents, 'visibilityState', { get: () => visibilityState });
    vi.stubGlobal('addEventListener', globalEvents.addEventListener.bind(globalEvents));
    vi.stubGlobal('removeEventListener', globalEvents.removeEventListener.bind(globalEvents));
    vi.stubGlobal('document', documentEvents as unknown as Document);
    const lifecycle = createAitLifecycleAdapter();
    const pause = vi.fn();
    const resume = vi.fn();
    lifecycle.onPause(pause);
    lifecycle.onResume(resume);
    globalEvents.dispatchEvent(new Event(aitLifecyclePauseEvent));
    visibilityState = 'hidden';
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    globalEvents.dispatchEvent(new Event(aitLifecycleResumeEvent));
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    visibilityState = 'visible';
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    expect(resume).toHaveBeenCalledOnce();
    globalEvents.dispatchEvent(new Event(aitLifecyclePauseEvent));
    globalEvents.dispatchEvent(new Event(aitLifecycleResumeEvent));
    expect(pause).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(2);
    await lifecycle.dispose?.();
    globalEvents.dispatchEvent(new Event('pagehide'));
    expect(pause).toHaveBeenCalledTimes(2);
  });
});
