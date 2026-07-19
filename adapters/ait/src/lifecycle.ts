import type { LifecycleAdapter } from '@mpgd/platform';

export const aitLifecyclePauseEvent = 'mpgd:ait:pause';
export const aitLifecycleResumeEvent = 'mpgd:ait:resume';
const lifecycleEventDedupeWindowMs = 500;

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
  const target = globalThis;
  const documentTarget = target.document;
  const eventName = type === 'pause' ? aitLifecyclePauseEvent : aitLifecycleResumeEvent;
  let lastFiredAt = Number.NEGATIVE_INFINITY;
  const fire = (): void => {
    const now = Date.now();

    if (now - lastFiredAt < lifecycleEventDedupeWindowMs) {
      return;
    }

    lastFiredAt = now;
    callback();
  };
  const handleCustomEvent = (): void => fire();
  const handleVisibilityChange = (): void => {
    if (documentTarget?.visibilityState === (type === 'pause' ? 'hidden' : 'visible')) {
      fire();
    }
  };
  const handlePageTransition = (): void => fire();

  target.addEventListener?.(eventName, handleCustomEvent);
  documentTarget?.addEventListener('visibilitychange', handleVisibilityChange);
  target.addEventListener?.(type === 'pause' ? 'pagehide' : 'pageshow', handlePageTransition);

  return () => {
    target.removeEventListener?.(eventName, handleCustomEvent);
    documentTarget?.removeEventListener('visibilitychange', handleVisibilityChange);
    target.removeEventListener?.(type === 'pause' ? 'pagehide' : 'pageshow', handlePageTransition);
  };
}
