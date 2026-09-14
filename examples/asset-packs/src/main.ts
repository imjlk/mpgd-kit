import Phaser from 'phaser';

import { createPhaserAssetPackLoader, type PhaserAssetPackLease as PackLease } from '@mpgd/phaser-assets/packs';
import { runZipWorkerSelfTest } from './zipWorkerSelfTest.js';
import type { DeliveryPack } from './packs.js';
import './style.css';

declare const __ASSET_PACK_CATALOG__: readonly DeliveryPack[];
declare const __ASSET_PACK_MODE__: 'bundled' | 'hybrid';
declare const __ASSET_PACK_ORIGIN__: string;

type Theme = 'grove' | 'dunes';
const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing sample control: ${id}`);
  return value as T;
};
const controls = Object.fromEntries(['grove', 'dunes', 'cancel', 'retry', 'unload'].map((id) => [id, element<HTMLButtonElement>(id)]));
const model = { phase: 'booting', requested: null as Theme | null, current: null as Theme | null, ready: 0, total: 0, error: '' };
let packs: ReturnType<typeof createPhaserAssetPackLoader> | undefined;
let pending: AbortController | undefined;
let sequence = 0;
let virtualTime = 0;

class Board extends Phaser.Scene {
  private layer!: Phaser.GameObjects.Container;
  private baselineTextures = new Set<string>();
  private hero: Phaser.GameObjects.Image | undefined;
  private lease: PackLease | undefined;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  constructor() { super('board'); }
  create(): void {
    this.layer = this.add.container();
    this.cursors = this.input.keyboard!.createCursorKeys();
    const localBase = new URL(import.meta.env.BASE_URL, window.location.href);
    const bundled = new Set(__ASSET_PACK_CATALOG__.filter((pack) => pack.packaged).map((pack) => pack.id));
    // Register consumer cleanup before the store's shutdown hook. No display
    // object may keep using a texture after its last owner returns the lease.
    this.events.once('shutdown', () => {
      ++sequence;
      pending?.abort();
      pending = undefined;
      this.clear();
      packs = undefined;
      Object.assign(model, { phase: 'booting', current: null, requested: null, ready: 0, total: 0, error: '' });
      renderStatus();
    });
    packs = createPhaserAssetPackLoader(this, __ASSET_PACK_CATALOG__, {
      resolveURL: (url, pack) => new URL(url, bundled.has(pack.packId) ? localBase : __ASSET_PACK_ORIGIN__).href,
      timeoutMs: 5_000,
      requestTimeoutMs: 2_000,
      maxConcurrentDownloads: 2,
      maxConcurrentDecodes: 1,
      maxBufferedBytes: 8 * 1024 * 1024,
      requestCache: new URLSearchParams(location.search).has('http-cache') ? 'default' : 'no-store',
    });
    model.phase = 'idle';
    this.showEmpty();
    this.baselineTextures = new Set(this.textures.getTextureKeys());
    renderStatus();
  }
  enter(lease: PackLease, theme: Theme): void {
    let nextLayer: Phaser.GameObjects.Container | undefined;
    let nextHero: Phaser.GameObjects.Image;
    try {
      const required = (pack: string, id: string): string => {
        const key = lease.key(pack, id);
        if (!key || !this.textures.exists(key)) throw new Error(`Missing prepared image: ${id}`);
        return key;
      };
      const ground = required(theme, 'ground');
      const pilot = required('shared', 'pilot');
      const groundFrame = theme === 'grove' ? 'ground' : undefined;
      if (theme === 'grove' && (!this.textures.get(ground).has('ground') || !this.textures.get(ground).has('stone'))) throw new Error('Missing required terrain frames');
      if (![0, 1, 2, 3].every((frame) => this.textures.get(pilot).has(String(frame)))) throw new Error('Missing explorer frames');
      const frame = this.textures.get(ground).get(groundFrame);
      if (frame.width <= 0 || frame.height <= 0) throw new Error('Invalid prepared ground dimensions');
      nextLayer = this.add.container().setVisible(false);
      // Construct the replacement before destroying any users of the old lease.
      // Prepared images avoid a first-frame TileSprite pattern cache.
      for (let y = 0; y < 540; y += frame.height) {
        for (let x = 0; x < 960; x += frame.width) nextLayer.add(this.add.image(x, y, ground, groundFrame).setOrigin(0));
      }
      if (theme === 'grove') nextLayer.add(this.add.image(210, 170, ground, 'stone').setDisplaySize(220, 120));
      nextLayer.add(this.add.rectangle(480, 488, 310, 42, 0x102226, .85));
      nextLayer.add(this.add.text(480, 488, theme === 'grove' ? 'THE GROVE' : 'THE DUNES', { fontFamily: 'monospace', fontSize: '16px', color: '#eef1d6' }).setOrigin(.5));
      nextHero = this.add.image(480, 270, pilot, 1).setScale(1.5);
      nextLayer.add(nextHero);
    } catch (error) {
      nextLayer?.destroy();
      lease.release();
      throw error;
    }
    this.clear();
    this.layer.destroy();
    this.layer = nextLayer;
    this.hero = nextHero;
    this.lease = lease;
    this.layer.setVisible(true);
  }
  clear(): void {
    // Destroy all image users before returning their resident resource lease.
    this.layer.removeAll(true);
    this.hero = undefined;
    this.lease?.release();
    this.lease = undefined;
  }
  showEmpty(): void {
    this.layer.add(this.add.text(480, 270, 'Choose a landscape to begin', { fontFamily: 'monospace', fontSize: '20px', color: '#9ab6ab' }).setOrigin(.5));
  }
  frames(pack: string, key: string): number {
    if (!this.lease) return 0;
    return this.textures.get(this.lease.key(pack, key)).getFrameNames().length;
  }
  textureCount(): number {
    const ui = new Set(this.layer.list.filter((object) => object instanceof Phaser.GameObjects.Text).map((object) => object.texture.key));
    return this.textures.getTextureKeys().filter((key) => !ui.has(key) && !this.baselineTextures.has(key)).length;
  }
  player() { return this.hero ? { x: this.hero.x, y: this.hero.y } : null; }
  override update(time: number, delta: number): void {
    if (model.phase !== 'playing' || !this.hero) return;
    const moving = this.cursors.right.isDown || this.cursors.left.isDown || this.cursors.up.isDown || this.cursors.down.isDown;
    this.hero.setFrame(moving ? Math.floor(time / 140) % 4 : 1);
    const distance = Math.min(delta, 50) * .18;
    this.hero.x = Phaser.Math.Clamp(this.hero.x + (Number(this.cursors.right.isDown) - Number(this.cursors.left.isDown)) * distance, 32, 928);
    this.hero.y = Phaser.Math.Clamp(this.hero.y + (Number(this.cursors.down.isDown) - Number(this.cursors.up.isDown)) * distance, 32, 448);
  }
}

const board = new Board();
let game: Phaser.Game;
const bootGame = (): void => {
  game = new Phaser.Game({
    type: new URLSearchParams(location.search).get('renderer') === 'canvas' ? Phaser.CANVAS : Phaser.WEBGL, width: 960, height: 540, parent: 'game', backgroundColor: '#142c31',
    pixelArt: true, scene: [board], audio: { noAudio: true },
    loader: { imageLoadType: 'HTMLImageElement' },
  });
};
if (new URLSearchParams(location.search).has('zip-worker')) {
  void runZipWorkerSelfTest();
} else {
  bootGame();
}

function statusText(): string {
  if (model.phase === 'error') return model.error;
  if (model.phase === 'preparing') return `Preparing ${model.requested}: ${model.ready} / ${model.total} textures`;
  if (model.phase === 'playing') return `${model.current} ready — explore with arrow keys`;
  return 'No level entered';
}

function renderStatus(): void {
  controls.grove!.disabled = controls.dunes!.disabled = model.phase === 'booting';
  controls.cancel!.disabled = model.phase !== 'preparing';
  controls.retry!.disabled = model.phase !== 'error';
  controls.unload!.disabled = model.phase === 'booting' || (model.phase === 'idle' && !model.current);
  element('delivery').textContent = __ASSET_PACK_MODE__ === 'bundled' ? 'ALL PACKS BUNDLED' : 'SHARED BUNDLED / THEMES ON STATIC ORIGIN';
  element('status').textContent = statusText();
  const progress = element<HTMLProgressElement>('progress');
  progress.max = Math.max(1, model.total);
  progress.value = model.ready;
  const resources = packs?.snapshot() ?? [];
  element('resident').textContent = String(resources.filter((resource) => resource.ready).length);
  element('memory').textContent = `RGBA estimate: ${resources.filter((resource) => resource.ready).reduce((sum, resource) => sum + resource.rgbaEstimate, 0).toLocaleString()} bytes`;
}

async function enter(theme: Theme): Promise<void> {
  if (!packs) return;
  if (!game.loop.running) game.loop.start(game.step.bind(game));
  const ticket = ++sequence;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  Object.assign(model, { phase: 'preparing', requested: theme, ready: 0, total: 0, error: '' });
  renderStatus();
  try {
    const lease = await packs.acquire(theme, { signal: controller.signal, onProgress(ready, total) {
      if (ticket !== sequence) return;
      Object.assign(model, { ready, total });
      renderStatus();
    } });
    if (ticket !== sequence) { lease.release(); return; }
    board.enter(lease, theme);
    Object.assign(model, { current: theme, phase: 'playing' });
  } catch (error) {
    if (ticket !== sequence) return;
    model.phase = 'error';
    model.error = error instanceof Error ? error.message : 'Asset preparation failed';
  } finally {
    if (ticket === sequence) { pending = undefined; renderStatus(); }
  }
}

controls.grove!.onclick = () => { void enter('grove'); };
controls.dunes!.onclick = () => { void enter('dunes'); };
controls.retry!.onclick = () => { if (model.requested) void enter(model.requested); };
controls.cancel!.onclick = () => {
  ++sequence;
  pending?.abort();
  pending = undefined;
  model.phase = model.current ? 'playing' : 'idle';
  model.ready = model.total = 0;
  renderStatus();
};
controls.unload!.onclick = () => {
  ++sequence;
  pending?.abort();
  pending = undefined;
  if (!packs) return;
  board.clear();
  board.showEmpty();
  Object.assign(model, { phase: 'idle', current: null, requested: null, ready: 0, total: 0, error: '' });
  renderStatus();
};

function state() {
  return { ...model, renderer: game.config.renderType === Phaser.WEBGL ? 'webgl' : 'canvas', mode: __ASSET_PACK_MODE__, coordinateSystem: 'origin top-left; x right; y down',
    groundFrames: model.current ? board.frames(model.current, 'ground') : 0,
    pilotFrames: model.current ? board.frames('shared', 'pilot') : 0,
    player: model.phase === 'booting' ? null : board.player(), resources: packs?.snapshot().map((entry) => ({ ...entry, pack: entry.packId, identity: entry.packId + '/' + entry.assetKey })) ?? [],
    textureCount: model.phase === 'booting' ? 0 : board.textureCount() };
}
declare global {
  interface Window { render_game_to_text: () => string; advanceTime: (milliseconds: number) => void; shutdownSample: () => number; }
}
window.render_game_to_text = () => JSON.stringify(state());
window.advanceTime = (milliseconds) => {
  game.loop.stop();
  virtualTime = Math.max(virtualTime, performance.now());
  for (let index = 0; index < Math.max(1, Math.round(milliseconds / (1000 / 60))); index++) {
    virtualTime += 1000 / 60;
    game.step(virtualTime, 1000 / 60);
  }
};

// SceneManager.stop emits shutdown synchronously; count after consumer and loader cleanup.
// Keep this direct manager call rather than queuing a ScenePlugin operation.
window.shutdownSample = () => { game.scene.stop('board'); return board.textureCount(); };
