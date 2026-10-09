import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPhaserAssetPackLoader,
  definePhaserAssetPacks,
  type PhaserAssetPack,
} from '../src/packs.js';

const catalog: readonly PhaserAssetPack[] = [
  { id: 'sound', revision: '1', assets: [{ kind: 'audio', key: 'theme', url: '/theme.wav' }] },
];
const buffer = (samples = 16, channels = 2, duration = 1): AudioBuffer => ({
  length: samples,
  numberOfChannels: channels,
  duration,
}) as AudioBuffer;
function fixture(decode = vi.fn(async () => buffer())) {
  const values = new Map<string, unknown>();
  const cache = {
    exists: (key: string) => values.has(key),
    add: vi.fn((key: string, value: unknown) => values.set(key, value)),
    remove: vi.fn((key: string) => values.delete(key)),
  };
  const removeByKey = vi.fn();
  const scene = {
    events: new EventEmitter(),
    cache: { audio: cache },
    sound: { context: { decodeAudioData: decode }, removeByKey },
  } as unknown as Phaser.Scene;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'audio/wav' },
      }),
    ),
  );
  return { scene, cache, values, decode, removeByKey };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('owned audio pack resources', () => {
  it('attempts HTML5 source/URL cleanup even when pausing the media element throws', async () => {
    const f = fixture();
    Object.assign(f.scene.sound, { context: undefined, override: true, locked: false });
    const removeSource = vi.fn();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.stubGlobal('Audio', class extends EventTarget {
      duration = 1;
      preload = '';
      src = '';
      dataset: Record<string, string> = {};
      pause() { throw new Error('pause cleanup failed'); }
      removeAttribute() { removeSource(); this.src = ''; }
      load() {
        if (this.src) {
          queueMicrotask(() => this.dispatchEvent(new Event('canplaythrough')));
        }
      }
    });
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const lease = await loader.acquire('sound');
    lease.release();
    expect(f.values.size).toBe(0);
    expect(removeSource).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(loader.takeCleanupErrors()).toHaveLength(1);
  });
  it('decodes once, shares a cache key and removes sound/cache only after the last lease', async () => {
    const f = fixture();
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const [a, b] = await Promise.all([loader.acquire('sound'), loader.acquire('sound')]);
    expect(f.decode).toHaveBeenCalledTimes(1);
    expect(a.key('sound', 'theme')).toBe(b.key('sound', 'theme'));
    expect(loader.snapshot()[0]).toMatchObject({ owners: 2, rgbaEstimate: 0, decodedAudioBytes: 128, encodedAudioBytes: 0 });
    a.release();
    expect(f.values.size).toBe(1);
    expect(f.removeByKey).not.toHaveBeenCalled();
    b.release();
    b.release();
    expect(f.values.size).toBe(0);
    expect(f.removeByKey).toHaveBeenCalledTimes(1);
  });
  it('does not register audio when native decode settles after all owners cancel', async () => {
    let finish!: (value: AudioBuffer) => void;
    const f = fixture(vi.fn(() => new Promise<AudioBuffer>((resolve) => { finish = resolve; })));
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const controller = new AbortController();
    const pending = loader.acquire('sound', { signal: controller.signal });
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    finish(buffer());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.cache.add).not.toHaveBeenCalled();
    expect(loader.snapshot()).toEqual([]);
  });
  it('one cancelled acquisition preserves an independent owner of the same decoding audio', async () => {
    let finish!: (value: AudioBuffer) => void;
    const f = fixture(vi.fn(() => new Promise<AudioBuffer>((resolve) => { finish = resolve; })));
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const controller = new AbortController();
    const a = loader.acquire('sound', { signal: controller.signal });
    const b = loader.acquire('sound');
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalled());
    controller.abort();
    await expect(a).rejects.toThrow('cancelled');
    finish(buffer());
    const lease = await b;
    expect(f.values.size).toBe(1);
    lease.release();
  });
  it.each([{ samples: 100, channels: 2, duration: 1, message: 'sample-byte' }, { samples: 16, channels: 2, duration: 301, message: 'duration' }])('rejects audio outside $message bounds before caching', async ({ samples, channels, duration, message }) => {
    const f = fixture(vi.fn(async () => buffer(samples, channels, duration)));
    const loader = createPhaserAssetPackLoader(f.scene, catalog, { maxDecodedAudioBytes: 128 });
    await expect(loader.acquire('sound')).rejects.toThrow(message);
    expect(f.cache.add).not.toHaveBeenCalled();
    expect(loader.snapshot()).toEqual([]);
  });
  it('requires audio integrity in the audio slot, and an audio media type', () => {
    expect(() => definePhaserAssetPacks([{ id: 'a', revision: '1', assets: [{ kind: 'audio', key: 'a', url: '/a.wav', mediaType: 'image/png' }] }])).toThrow('media type');
    expect(() => definePhaserAssetPacks([{ id: 'a', revision: '1', assets: [{ kind: 'audio', key: 'a', url: '/a.wav', integrity: { texture: { bytes: 1, sha256: 'a'.repeat(64) } } }] }])).toThrow('inapplicable integrity');
  });
  it('fails clearly when audio is disabled instead of reporting readiness', async () => {
    const f = fixture();
    Object.assign(f.scene.sound, { context: undefined });
    await expect(createPhaserAssetPackLoader(f.scene, catalog).acquire('sound')).rejects.toThrow('enabled Web Audio or HTML5');
  });
  it('cleans the audio cache even if engine sound destruction throws', async () => {
    const f = fixture();
    f.removeByKey.mockImplementation(() => { throw new Error('sound cleanup'); });
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const lease = await loader.acquire('sound');
    lease.release();
    expect(f.values.size).toBe(0);
    expect(loader.takeCleanupErrors()).toMatchObject([{ packId: 'sound', assetKey: 'theme' }]);
  });
  it('prepares HTML5 Audio without playback, retains its Blob until last-owner cleanup and reports unknown decoder memory', async () => {
    const f = fixture();
    Object.assign(f.scene.sound, { context: undefined, override: true, locked: true });
    const pause = vi.fn();
    const play = vi.fn();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.stubGlobal('Audio', class extends EventTarget {
      duration = 1; preload = ''; src = ''; dataset: Record<string, string> = {};
      pause = pause; play = play;
      removeAttribute() { this.src = ''; }
      load() {
        if (this.src) {
          queueMicrotask(() => this.dispatchEvent(new Event('canplaythrough')));
        }
      }
    });
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const lease = await loader.acquire('sound');
    expect(play).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(loader.snapshot()[0]).toMatchObject({ decodedAudioBytes: null, encodedAudioBytes: 3 });
    const tags = f.values.get(lease.key('sound', 'theme')) as HTMLAudioElement[];
    expect(tags[0]?.dataset.locked).toBe('true');
    lease.release();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
