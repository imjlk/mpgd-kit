import type PhaserType from 'phaser';
import { afterEach, describe, expect, it } from 'vitest';

import { definePhaserAssetManifest, loadPhaserAssets } from '../../phaser-assets/src/index.js';
import {
  createMiniGamePhaserConfig,
  getInstalledMiniGameGlobals,
  installMiniGameGlobals,
  installPhaserMiniGameRuntime,
} from '../src/index.js';
import { encodeText, FakeMiniGameHost } from './fake-host.js';

afterEach(() => {
  getInstalledMiniGameGlobals()?.dispose();
});

describe('Phaser 4.2 mini-game integration', () => {
  it('boots Canvas Phaser, loads PNG/JSON/binary assets, transitions scenes, and cleans up', async () => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/config.json', encodeText('{"title":"mini-game"}'));
    host.localFiles.set('assets/data.bin', new Uint8Array([7, 8, 9]).buffer);
    host.localFiles.set('assets/atlas.json', encodeText(JSON.stringify({
      frames: {
        dot: {
          frame: { x: 0, y: 0, w: 1, h: 1 },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 },
          sourceSize: { w: 1, h: 1 },
        },
      },
      meta: { image: 'atlas.png', size: { w: 2, h: 2 }, scale: '1' },
    })));
    const globals = installMiniGameGlobals(host);
    const Phaser = (await import('phaser')).default;
    const sceneState = {
      bootCreated: false,
      playCreated: false,
      frames: 0,
      pointerDown: false,
    };
    const assets = definePhaserAssetManifest([
      {
        kind: 'image',
        key: 'marker',
        url: 'assets/marker.png',
      },
      {
        kind: 'json',
        key: 'config',
        url: 'assets/config.json',
      },
      {
        kind: 'binary',
        key: 'data',
        url: 'assets/data.bin',
      },
      {
        kind: 'spritesheet',
        key: 'sheet',
        url: 'assets/sheet.png',
        frameConfig: { frameWidth: 1, frameHeight: 1 },
      },
      {
        kind: 'atlas',
        key: 'atlas',
        textureUrl: 'assets/atlas.png',
        atlasUrl: 'assets/atlas.json',
      },
    ] as const);

    class BootScene extends Phaser.Scene {
      constructor() {
        super('Boot');
      }

      preload(): void {
        loadPhaserAssets(this, assets);
      }

      create(): void {
        sceneState.bootCreated = true;
        expect(this.textures.exists('marker')).toBe(true);
        expect(this.textures.exists('sheet')).toBe(true);
        expect(this.textures.exists('atlas')).toBe(true);
        expect(this.cache.json.get('config')).toEqual({ title: 'mini-game' });
        expect([...new Uint8Array(this.cache.binary.get('data') as ArrayBuffer)]).toEqual([7, 8, 9]);
        this.scene.start('Play');
      }
    }

    class PlayScene extends Phaser.Scene {
      constructor() {
        super('Play');
      }

      create(): void {
        sceneState.playCreated = true;
        this.input.on('pointerdown', () => {
          sceneState.pointerDown = true;
        });
      }

      override update(): void {
        sceneState.frames += 1;
      }
    }

    const config = createMiniGamePhaserConfig({
      type: Phaser.CANVAS,
      width: 800,
      height: 450,
      parent: null,
      banner: false,
      scene: [BootScene, PlayScene],
      input: {
        keyboard: false,
        mouse: false,
        gamepad: false,
        touch: true,
        windowEvents: false,
      },
      scale: {
        mode: Phaser.Scale.NONE,
        width: 800,
        height: 450,
      },
    }, globals) satisfies PhaserType.Types.Core.GameConfig;
    const game = new Phaser.Game(config);
    const runtime = installPhaserMiniGameRuntime(game, { globals });

    await driveGameUntil(host, () => sceneState.playCreated && sceneState.frames >= 2);
    expect(sceneState.bootCreated).toBe(true);
    expect(sceneState.playCreated).toBe(true);
    expect(sceneState.frames).toBeGreaterThanOrEqual(2);
    expect(game.renderer.type).toBe(Phaser.CANVAS);

    host.emitTouch('start', [{ identifier: 1, clientX: 400, clientY: 225 }]);
    host.flushFrame(96);
    expect(sceneState.pointerDown).toBe(true);

    host.emitPause();
    expect(game.isPaused).toBe(true);
    expect(game.loop.running).toBe(false);
    host.emitResume();
    expect(game.isPaused).toBe(false);
    expect(game.loop.running).toBe(true);

    game.destroy(true);
    host.flushFrame(112);
    expect(runtime.disposed).toBe(true);
    expect(host.pendingFrameCount).toBe(0);
    expect(host.touchListenerCount).toBe(4);

    globals.dispose();
    expect(host.touchListenerCount).toBe(0);
  });
});

async function driveGameUntil(
  host: FakeMiniGameHost,
  predicate: () => boolean,
  attempts = 40,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    host.flushFrame(index * 16);

    if (predicate()) {
      return;
    }
  }

  throw new Error('Phaser mini-game integration did not reach the expected state.');
}
