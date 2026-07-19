import type { LifecycleAdapter } from '@mpgd/platform';

export const aitLifecyclePauseEvent = 'mpgd:ait:pause';
export const aitLifecycleResumeEvent = 'mpgd:ait:resume';

export function createAitLifecycleAdapter(): LifecycleAdapter {
  return {
    onPause(callback) {
      return subscribeToAitLifecycle('pause', callback);
    },
    onResume(callback) {
      return subscribeToAitLifecycle('resume', callback);
    },
  };
}

export function dispatchAitLifecycleEvent(type: 'pause' | 'resume'): void {
  globalThis.dispatchEvent?.(
    new Event(type === 'pause' ? aitLifecyclePauseEvent : aitLifecycleResumeEvent),
  );
}

function subscribeToAitLifecycle(type: 'pause' | 'resume', callback: () => void): () => void {
  const eventName = type === 'pause' ? aitLifecyclePauseEvent : aitLifecycleResumeEvent;
  const handleCustomEvent = (): void => callback();
  const handleVisibilityChange = (): void => {
    if (globalThis.document?.visibilityState === (type === 'pause' ? 'hidden' : 'visible')) {
      callback();
    }
  };
  const handlePageTransition = (): void => callback();

  globalThis.addEventListener?.(eventName, handleCustomEvent);
  globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange);
  globalThis.addEventListener?.(type === 'pause' ? 'pagehide' : 'pageshow', handlePageTransition);

  return () => {
    globalThis.removeEventListener?.(eventName, handleCustomEvent);
    globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange);
    globalThis.removeEventListener?.(
      type === 'pause' ? 'pagehide' : 'pageshow',
      handlePageTransition,
    );
  };
}
