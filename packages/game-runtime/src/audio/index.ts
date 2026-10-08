import type { GameExecutionController } from '../index.js';
import { observe, type ObserverErrorHandler } from '../observers.js';

export interface GameAudioSink {
  getMuted(): boolean;
  setMuted(muted: boolean): void;
}
/** One game owns audio projection; scene teardown cannot release a live native lease. */
export function bindGameAudio(input: {
  readonly execution: GameExecutionController;
  readonly sink: GameAudioSink;
  readonly onError?: ObserverErrorHandler;
}): { dispose(): void } {
  let owned = false;
  let disposed = false;
  const apply = () => {
    if (disposed) {
      return;
    }
    const snapshot = input.execution.getSnapshot();
    observe(() => {
      if (snapshot.blocked.audio && !input.sink.getMuted()) {
        owned = true;
        input.sink.setMuted(true);
      } else if (!snapshot.blocked.audio && owned) {
        input.sink.setMuted(false);
        owned = false;
      }
    }, input.onError);
  };
  const unsubscribe = input.execution.subscribe(apply);
  apply();
  return { dispose() {
    if (disposed) { return; }
    disposed = true; unsubscribe();
    // Detaching an observer does not close UI or remove another pause owner.
    if (owned && !input.execution.getSnapshot().blocked.audio) {
      observe(() => { input.sink.setMuted(false); owned = false; }, input.onError);
    }
  } };
}
