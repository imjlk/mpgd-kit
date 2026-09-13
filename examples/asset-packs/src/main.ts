import Phaser from 'phaser';

import { createPackLeases, type PackLease } from './leases.js';
import type { DeliveryPack } from './packs.js';
import { createImagePreparer, PACK_TEXTURE_PREFIX } from './phaser-images.js';
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
let packs: ReturnType<typeof createPackLeases> | undefined;
let pending: AbortController | undefined;
let sequence = 0;
let virtualTime = 0;

class Board extends Phaser.Scene {
  private layer!: Phaser.GameObjects.Container;
  private hero: Phaser.GameObjects.Image | undefined;
  private lease: PackLease | undefined;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  constructor() { super('board'); }
  create(): void {
    this.layer = this.add.container();
    this.cursors = this.input.keyboard!.createCursorKeys();
    const localBase = new URL(import.meta.env.BASE_URL, window.location.href);
    const bundled = new Set(__ASSET_PACK_CATALOG__.filter((pack) => pack.packaged).map((pack) => pack.id));
    packs = createPackLeases(__ASSET_PACK_CATALOG__, createImagePreparer(this, (image) =>
      new URL(image.path, bundled.has(image.packId) ? localBase : __ASSET_PACK_ORIGIN__)));
    model.phase = 'idle';
    this.showEmpty();
    renderStatus();
  }
  enter(lease: PackLease, theme: Theme): void {
    let nextLayer: Phaser.GameObjects.Container | undefined;
    let nextHero: Phaser.GameObjects.Image;
    try {
      const required = (id: string): string => {
        const key = lease.textures.get(id);
        if (!key || !this.textures.exists(key)) throw new Error(`Missing prepared image: ${id}`);
        return key;
      };
      const ground = required(`${theme}/ground`);
      const pilot = required('shared/pilot');
      const frame = this.textures.get(ground).get();
      if (frame.width <= 0 || frame.height <= 0) throw new Error('Invalid prepared ground dimensions');
      nextLayer = this.add.container().setVisible(false);
      // Construct the replacement before destroying any users of the old lease.
      // Prepared images avoid a first-frame TileSprite pattern cache.
      for (let y = 0; y < 540; y += frame.height) {
        for (let x = 0; x < 960; x += frame.width) nextLayer.add(this.add.image(x, y, ground).setOrigin(0));
      }
      nextLayer.add(this.add.rectangle(480, 488, 310, 42, 0x102226, .85));
      nextLayer.add(this.add.text(480, 488, theme === 'grove' ? 'THE GROVE' : 'THE DUNES', { fontFamily: 'monospace', fontSize: '16px', color: '#eef1d6' }).setOrigin(.5));
      nextHero = this.add.image(480, 270, pilot).setScale(2);
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
  player() { return this.hero ? { x: this.hero.x, y: this.hero.y } : null; }
  override update(_time: number, delta: number): void {
    if (model.phase !== 'playing' || !this.hero) return;
    const distance = Math.min(delta, 50) * .18;
    this.hero.x = Phaser.Math.Clamp(this.hero.x + (Number(this.cursors.right.isDown) - Number(this.cursors.left.isDown)) * distance, 32, 928);
    this.hero.y = Phaser.Math.Clamp(this.hero.y + (Number(this.cursors.down.isDown) - Number(this.cursors.up.isDown)) * distance, 32, 448);
  }
}

const board = new Board();
const game = new Phaser.Game({
  type: Phaser.CANVAS, width: 960, height: 540, parent: 'game', backgroundColor: '#142c31',
  pixelArt: true, scene: [board], audio: { noAudio: true },
  loader: { imageLoadType: 'HTMLImageElement' },
});

function statusText(): string {
  if (model.phase === 'error') return model.error;
  if (model.phase === 'preparing') return `Preparing ${model.requested}: ${model.ready} / ${model.total} images`;
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
  element('resident').textContent = String(resources.filter((resource) => resource.state === 'ready').length);
  element('memory').textContent = `RGBA estimate: ${resources.filter((resource) => resource.state === 'ready').reduce((sum, resource) => sum + resource.rgbaEstimate, 0).toLocaleString()} bytes`;
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
    const lease = await packs.acquire(theme, { signal: controller.signal, progress(ready, total) {
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
  board.clear();
  board.showEmpty();
  Object.assign(model, { phase: 'idle', current: null, requested: null, ready: 0, total: 0, error: '' });
  renderStatus();
};

function state() {
  return { ...model, mode: __ASSET_PACK_MODE__, coordinateSystem: 'origin top-left; x right; y down',
    player: model.phase === 'booting' ? null : board.player(), resources: packs?.snapshot() ?? [],
    textureCount: model.phase === 'booting' ? 0 : board.textures.getTextureKeys().filter((key) => key.startsWith(PACK_TEXTURE_PREFIX)).length };
}
declare global {
  interface Window { render_game_to_text: () => string; advanceTime: (milliseconds: number) => void; }
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
