import type Phaser from 'phaser';

/** Internal prepared resource. Playback/unlock remain game-owned. */
export interface PreparedPhaserPackAudio {
  readonly key: string;
  readonly pixels: 0;
  readonly decodedAudioBytes: number | null;
  readonly encodedAudioBytes: number;
  dispose(): void;
}

export async function preparePhaserPackAudio(
  scene: Phaser.Scene,
  blob: Blob,
  key: string,
  signal: AbortSignal,
  limits: { readonly maxDecodedAudioBytes: number; readonly maxAudioDuration: number },
): Promise<PreparedPhaserPackAudio> {
  const manager = scene.sound as unknown as {
    readonly context?: AudioContext;
    readonly override?: boolean;
    readonly locked?: boolean;
  };
  const cache = scene.cache.audio;
  const remove = (): void => {
    try {
      scene.sound.removeByKey(key);
    } finally {
      if (cache.exists(key)) {
        cache.remove(key);
      }
    }
  };
  const checkDuration = (duration: number): void => {
    if (!Number.isFinite(duration) || duration <= 0 || duration > limits.maxAudioDuration) {
      throw new Error('Audio duration exceeds the pack limit or is unavailable');
    }
  };
  signal.throwIfAborted();
  if (manager.context && typeof manager.context.decodeAudioData === 'function') {
    const bytes = await blob.arrayBuffer();
    signal.throwIfAborted();
    // Like image.decode, native audio decoding cannot be cancelled. The caller
    // rejects promptly but keeps its decode and byte permits until settlement.
    const buffer = await manager.context.decodeAudioData(bytes);
    signal.throwIfAborted();
    checkDuration(buffer.duration);
    const decodedAudioBytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(decodedAudioBytes) || decodedAudioBytes <= 0
      || decodedAudioBytes > limits.maxDecodedAudioBytes) {
      throw new Error('Decoded audio exceeds the pack sample-byte limit');
    }
    try {
      cache.add(key, buffer);
    } catch (error) {
      remove();
      throw error;
    }
    let disposed = false;
    return {
      key,
      pixels: 0,
      decodedAudioBytes,
      encodedAudioBytes: 0,
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        remove();
      },
    };
  }
  if (typeof manager.override !== 'boolean' || typeof Audio !== 'function') {
    throw new Error('Audio packs require an enabled Web Audio or HTML5 Audio sound manager');
  }
  const audio = new Audio();
  const url = URL.createObjectURL(blob);
  let retained = false;
  let disposed = false;
  const clear = (): void => {
    let failure: unknown;
    for (const action of [
      () => audio.pause(),
      () => audio.removeAttribute('src'),
      () => audio.load(),
      () => URL.revokeObjectURL(url),
    ]) {
      try {
        action();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const clean = (): void => {
        audio.removeEventListener('canplaythrough', ready);
        audio.removeEventListener('error', failed);
        signal.removeEventListener('abort', cancelled);
      };
      const ready = (): void => {
        clean();
        resolve();
      };
      const failed = (): void => {
        clean();
        reject(new Error('HTML5 Audio preparation failed'));
      };
      const cancelled = (): void => {
        clean();
        reject(signal.reason);
      };
      audio.addEventListener('canplaythrough', ready, { once: true });
      audio.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', cancelled, { once: true });
      try {
        audio.preload = 'auto';
        audio.src = url;
        audio.load();
        if (signal.aborted) {
          cancelled();
        }
      } catch (error) {
        clean();
        reject(error);
      }
    });
    signal.throwIfAborted();
    checkDuration(audio.duration);
    audio.dataset.name = `${key}00`;
    audio.dataset.used = 'false';
    audio.dataset.locked = manager.locked ? 'true' : 'false';
    cache.add(key, [audio]);
    retained = true;
    return {
      key,
      pixels: 0,
      decodedAudioBytes: null,
      encodedAudioBytes: blob.size,
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        try {
          remove();
        } finally {
          clear();
        }
      },
    };
  } catch (error) {
    remove();
    throw error;
  } finally {
    if (!retained) {
      // Preparation already rejected. Attempt every cleanup action without
      // replacing that error (or an engine remove error) with a media error.
      try {
        clear();
      } catch {
        // Disposal still surfaces cleanup errors through the loader.
      }
    }
  }
}
