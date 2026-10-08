import type { LifecycleAdapter } from '@mpgd/platform';

export const aitLifecyclePauseEvent = 'mpgd:ait:pause';
export const aitLifecycleResumeEvent = 'mpgd:ait:resume';

/** Legacy SDK presentation, page lifetime, and visibility are independent owners. */
export function createAitLifecycleAdapter(): LifecycleAdapter {
  const target = globalThis;
  const documentTarget = target.document;
  const pauses = new Set<() => void>();
  const resumes = new Set<() => void>();
  let nativePaused = false;
  let pageActive = true;
  let attached = false;
  let active = documentTarget?.visibilityState !== 'hidden';
  const notify = (callback: () => void) => {
    try {
      void Promise.resolve(callback()).catch(() => undefined);
    } catch { /* Keep lifecycle observation alive. */ }
  };
  function reconcile(): void {
    const next = !nativePaused && pageActive && documentTarget?.visibilityState !== 'hidden';
    if (next === active) {
      return;
    }
    active = next;
    for (const callback of [...(active ? resumes : pauses)]) {
      notify(callback);
    }
  }
  const nativePause = () => {
    nativePaused = true;
    reconcile();
  };
  const nativeResume = () => {
    nativePaused = false;
    reconcile();
  };
  const pageHide = () => {
    pageActive = false;
    reconcile();
  };
  const pageShow = () => {
    pageActive = true;
    reconcile();
  };
  function attach(): void {
    if (attached) {
      return;
    }
    attached = true;
    target.addEventListener?.(aitLifecyclePauseEvent, nativePause);
    target.addEventListener?.(aitLifecycleResumeEvent, nativeResume);
    target.addEventListener?.('pagehide', pageHide);
    target.addEventListener?.('pageshow', pageShow);
    documentTarget?.addEventListener('visibilitychange', reconcile);
  }
  function detach(): void {
    if (!attached) {
      return;
    }
    attached = false;
    target.removeEventListener?.(aitLifecyclePauseEvent, nativePause);
    target.removeEventListener?.(aitLifecycleResumeEvent, nativeResume);
    target.removeEventListener?.('pagehide', pageHide);
    target.removeEventListener?.('pageshow', pageShow);
    documentTarget?.removeEventListener('visibilitychange', reconcile);
  }
  function subscribe(callbacks: Set<() => void>, callback: () => void): () => void {
    callbacks.add(callback);
    attach();
    if (callbacks === pauses && !active) {
      notify(callback);
    }
    return () => {
      callbacks.delete(callback);
      if (pauses.size + resumes.size === 0) {
        detach();
      }
    };
  }
  return {
    onPause: (callback) => subscribe(pauses, callback),
    onResume: (callback) => subscribe(resumes, callback),
    async dispose() {
      pauses.clear();
      resumes.clear();
      detach();
    },
  };
}

export function dispatchAitLifecycleEvent(type: 'pause' | 'resume'): void {
  globalThis.dispatchEvent?.(
    new Event(type === 'pause' ? aitLifecyclePauseEvent : aitLifecycleResumeEvent),
  );
}
