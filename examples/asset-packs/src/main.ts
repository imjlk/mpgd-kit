import Phaser from 'phaser';

import { createPhaserAssetPackLoader, type PhaserAssetPackLease as PackLease } from '@mpgd/phaser-assets/packs';
import {
  createPhaserPackDelivery,
  PhaserPackDeliveryError,
  readCappedDeliveryBody,
  type PhaserPackDelivery,
  type PhaserPackDeliveryErrorDetails,
  type PhaserPackDeliveryEvent,
  type PhaserPackPreparationPlan,
} from '@mpgd/phaser-assets/delivery';
import { ArtifactCache, type WarmReport } from './artifact-cache.js';
import type { DeliveryPack } from './packs.js';
import './style.css';

declare const __ASSET_PACK_CATALOG__: readonly DeliveryPack[];
declare const __ASSET_PACK_MODE__: 'bundled' | 'hybrid';
declare const __ASSET_PACK_ORIGIN__: string;

type Theme = 'grove' | 'dunes';
/** Delivery tuning next to the loader limits: the sample's staging
 * contract — 32 MiB of archive+expanded bytes, a 15 s whole-prepare
 * deadline, 4 s per HTTP attempt, 32 MiB per files-delivery file. */
const DELIVERY_STAGING_BUDGET_BYTES = 32 * 1024 * 1024;
const DELIVERY_PREPARE_TIMEOUT_MS = 15_000;
const DELIVERY_REQUEST_TIMEOUT_MS = 4_000;
const DELIVERY_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** The manifest is application data, not an asset: a small explicit cap
 * bounds what a misconfigured origin can push into the page. */
const DELIVERY_MANIFEST_BYTE_CAP = 4 * 1024 * 1024;

/** Loader limits shared by both transports so files and ZIP delivery
 * behave identically. */
const loaderOptions = {
  timeoutMs: 5_000,
  maxConcurrentDownloads: 2,
  maxConcurrentDecodes: 1,
  maxBufferedBytes: 8 * 1024 * 1024,
};

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing sample control: ${id}`);
  return value as T;
};
const controls = Object.fromEntries(['grove', 'dunes', 'cancel', 'retry', 'unload'].map((id) => [id, element<HTMLButtonElement>(id)]));
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Artifact layout shared with test/build-delivery.ts and test/browser.mjs:
 * <origin>/delivery/<variant>/asset-pack-delivery.json. */
const DELIVERY_MANIFEST_PATH = (variant: string): string => `delivery/${variant}/asset-pack-delivery.json`;

const params = new URLSearchParams(location.search);
/** One HTTP cache policy for the page: the documented http-cache=1 flag
 * covers the files loader, the manifest fetch and delivery requests. */
const requestCache: 'default' | 'no-store' = params.has('http-cache') ? 'default' : 'no-store';
/** Private experiment flag: persistent artifact reuse through IndexedDB
 * and managed Blob URLs (see artifact-cache.ts). Off by default; the
 * acceptance runs it explicitly. */
const persistentCache = params.has('idcache');
const deliveryParam = params.get('delivery');
const deliveryMode: 'zip' | 'mixed' | null = deliveryParam === 'zip' || deliveryParam === 'mixed' ? deliveryParam : null;
/** Delivery observation view: what the UI shows is exactly what the
 * delivery observed — no polling, no message parsing. Stale operations
 * (an older prepare's late events) never overwrite this state. */
interface ObservedDelivery {
  operationId: number;
  phase: string;
  packId: string;
  progress: string;
  terminal: string;
  fileRead: string;
}
const observed: ObservedDelivery = {
  operationId: 0, phase: '', packId: '', progress: '', terminal: '', fileRead: '',
};
const resetObserved = (): ObservedDelivery => Object.assign(observed, {
  operationId: 0, phase: '', packId: '', progress: '', terminal: '', fileRead: '',
});
const byteText = (bytes: number | undefined): string => bytes === undefined ? '?' : String(bytes);
const progressTextOf = (event: PhaserPackDeliveryEvent): string => {
  const progress = event.progress;
  if (progress === undefined) return '';
  if (progress.entriesVerified !== undefined || progress.expectedEntries !== undefined) {
    return `entries ${progress.entriesVerified ?? 0} / ${progress.expectedEntries ?? '?'} (${byteText(progress.entryBytes)} bytes)`;
  }
  if (progress.bodyBytes !== undefined) {
    return `body ${progress.bodyBytes} / ${byteText(progress.expectedBodyBytes)} bytes`;
  }
  return '';
};
const failureTextOf = (event: PhaserPackDeliveryEvent): string => {
  const error = event.error;
  if (error === undefined) return '';
  const extras: string[] = [];
  if (error.details.stage !== undefined) extras.push(`stage ${error.details.stage}`);
  if (error.details.httpStatus !== undefined) extras.push(`HTTP ${error.details.httpStatus}`);
  if (error.details.decoderStatus !== undefined) extras.push(`decoder ${error.details.decoderStatus}`);
  if (error.details.decoderCode !== undefined) extras.push(`code ${error.details.decoderCode}`);
  return [error.code, ...extras].join(' · ');
};
/** Safe structured summary for error text: codes and counts, never URLs
 * or messages that might embed them. */
const detailSummary = (details: PhaserPackDeliveryErrorDetails): string => {
  const extras: string[] = [];
  if (details.stage !== undefined) extras.push(details.stage);
  if (details.httpStatus !== undefined) extras.push(`HTTP ${details.httpStatus}`);
  if (details.decoderStatus !== undefined) extras.push(details.decoderStatus);
  if (details.decoderCode !== undefined) extras.push(details.decoderCode);
  return extras.length === 0 ? '' : ` [${extras.join(', ')}]`;
};
/** Read-only cost summary from inspectPreparation, computed once per
 * selection — never per frame. The display explains the budget; the
 * prepare's own admission stays authoritative either way. */
const planTextOf = (plan: PhaserPackPreparationPlan | null): string => {
  if (plan === null) return '';
  const budget = `${plan.projectedStagingBytes} / ${plan.stagingBudgetBytes} B`;
  return `${plan.closure.length} packs · ${plan.coldObjectCount} objects · `
    + `${plan.coldBodyBytes} B artifacts · staging ${budget}${plan.fitsBudget ? '' : ' · OVER BUDGET'}`;
};
const onDeliveryEvent = (event: PhaserPackDeliveryEvent): void => {
  if (event.kind === 'prepare') {
    if (event.phase === 'planning') {
      observed.operationId = event.operationId;
      observed.progress = '';
      observed.terminal = '';
    }
    // Late events from a superseded prepare never reach the display.
    if (event.operationId !== observed.operationId) return;
    observed.phase = event.phase;
    observed.packId = event.packId;
    // Terminals carry no progress fields; the last measured numbers stay
    // visible instead of being wiped by the terminal event.
    const progress = progressTextOf(event);
    if (progress !== '') {
      observed.progress = progress;
    }
    if (event.phase === 'failed' || event.phase === 'cancelled' || event.phase === 'disposed') {
      observed.terminal = failureTextOf(event);
    }
  } else {
    observed.fileRead = `${event.packId}/${event.assetKey ?? '?'} · ${event.phase} · ${progressTextOf(event)}`;
  }
  renderStatus();
};
const model = {
  phase: 'booting', requested: null as Theme | null, current: null as Theme | null, ready: 0, total: 0, error: '',
  lastPrepareMs: null as number | null,
  observed,
  plan: null as PhaserPackPreparationPlan | null,
  cache: null as { report: WarmReport } | { error: string } | null,
};
let packs: ReturnType<typeof createPhaserAssetPackLoader> | undefined;
let delivery: PhaserPackDelivery | undefined;
let unsubscribeDelivery: (() => void) | undefined;
/** Blob URL bridge for the persistent-reuse experiment; opened during
 * delivery boot when idcache=1. Manifest metadata for warm inputs. */
let artifactCache: ArtifactCache | undefined;
let artifactMeta = new Map<string, { sha256: string; bytes: number; mediaType: string }>();
let deliveryOriginBase = '';
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
      ++deliveryBootTicket;
      pending?.abort();
      pending = undefined;
      this.clear();
      // Closing the sample detaches the observer first (idempotent):
      // stopping to watch is not the same act as cancelling a prepare,
      // which only the explicit cancel control and this full teardown do.
      unsubscribeDelivery?.();
      unsubscribeDelivery = undefined;
      artifactCache?.close();
      artifactCache = undefined;
      delivery?.dispose();
      delivery = undefined;
      packs = undefined;
      resetObserved();
      Object.assign(model, { phase: 'booting', current: null, requested: null, ready: 0, total: 0, error: '', lastPrepareMs: null, plan: null, cache: null });
      renderStatus();
    });
    this.showEmpty();
    this.baselineTextures = new Set(this.textures.getTextureKeys());
    if (deliveryMode === null) {
      packs = createPhaserAssetPackLoader(this, __ASSET_PACK_CATALOG__, {
        ...loaderOptions,
        resolveURL: (url, pack) => new URL(url, bundled.has(pack.packId) ? localBase : __ASSET_PACK_ORIGIN__).href,
        requestTimeoutMs: 2_000,
        requestCache,
      });
      model.phase = 'idle';
    } else {
      // ZIP delivery boots asynchronously: the CLI-built delivery manifest
      // is fetched, validated and turned into the loader catalog + prepared
      // file source before the sample becomes interactive.
      void initDelivery(this);
    }
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
let game: Phaser.Game | undefined;
const bootedGame = (): Phaser.Game => {
  if (game === undefined) {
    throw new Error('The sample game is not booted on this page');
  }
  return game;
};
const bootGame = (): void => {
  game = new Phaser.Game({
    type: new URLSearchParams(location.search).get('renderer') === 'canvas' ? Phaser.CANVAS : Phaser.WEBGL, width: 960, height: 540, parent: 'game', backgroundColor: '#142c31',
    pixelArt: true, scene: [board], audio: { noAudio: true },
    loader: { imageLoadType: 'HTMLImageElement' },
  });
};
const failSelfTest = (reason: string): void => {
  window.__zip_worker_result = (): string => JSON.stringify({
    status: 'failed', error: reason,
  });
};
if (new URLSearchParams(location.search).has('zip-worker')) {
  void import('./zipWorkerSelfTest.js').then(
    (module) => module.runZipWorkerSelfTest(),
    (error) => failSelfTest(`Could not load the worker self test: ${String(error)}`),
  ).catch((error) => failSelfTest(`The worker self test rejected: ${String(error)}`));
} else {
  bootGame();
  wireSampleControls();
  wireWindowHooks();
}

function statusText(): string {
  if (model.phase === 'error') return model.error;
  if (model.phase === 'preparing') {
    // Two distinct stages, never conflated: delivery staging (what the
    // delivery observed) and loader texture preparation (the loader's
    // own progress). "prepared" here means staging only.
    const staging = observed.phase === ''
      ? 'staging not started'
      : `${observed.phase}${observed.progress === '' ? '' : ` · ${observed.progress}`}${observed.terminal === '' ? '' : ` · ${observed.terminal}`}`;
    const plan = planTextOf(model.plan);
    return `Preparing ${model.requested} [delivery: ${staging}]${plan === '' ? '' : ` · plan ${plan}`} — textures ${model.ready} / ${model.total}`;
  }
  if (model.phase === 'playing') {
    const staging = observed.phase === 'prepared' ? 'staged' : observed.phase;
    return `${model.current} ready (${staging}) — explore with arrow keys`;
  }
  return 'No level entered';
}

function renderStatus(): void {
  controls.grove!.disabled = controls.dunes!.disabled = model.phase === 'booting' || !packs;
  controls.cancel!.disabled = model.phase !== 'preparing';
  controls.retry!.disabled = model.phase !== 'error';
  controls.unload!.disabled = model.phase === 'booting' || (model.phase === 'idle' && !model.current);
  const deliveryLabels: Record<string, string> = {
    zip: 'ZIP DELIVERY / REAL MODULE WORKER',
    mixed: 'MIXED FILES + ZIP DELIVERY',
  };
  element('delivery').textContent = deliveryLabels[deliveryMode ?? '']
    ?? (__ASSET_PACK_MODE__ === 'bundled' ? 'ALL PACKS BUNDLED' : 'SHARED BUNDLED / THEMES ON STATIC ORIGIN');
  element('status').textContent = statusText();
  const progress = element<HTMLProgressElement>('progress');
  progress.max = Math.max(1, model.total);
  progress.value = model.ready;
  const resources = packs?.snapshot() ?? [];
  element('resident').textContent = String(resources.filter((resource) => resource.ready).length);
  element('memory').textContent = `RGBA estimate: ${resources.filter((resource) => resource.ready).reduce((sum, resource) => sum + resource.rgbaEstimate, 0).toLocaleString()} bytes`;
}

function enter(theme: Theme): void {
  if (!packs) return;
  const active = bootedGame();
    if (!active.loop.running) active.loop.start(active.step.bind(active));
  const ticket = ++sequence;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  resetObserved();
  // One read-only inspection per selection: what a cold prepare of this
  // closure costs and whether it fits the staging budget. It reserves
  // nothing; prepare re-checks admission itself.
  model.plan = delivery === undefined ? null : delivery.inspectPreparation(theme);
  Object.assign(model, { phase: 'preparing', requested: theme, ready: 0, total: 0, error: '', lastPrepareMs: null });
  renderStatus();
  // Enters run one at a time: a superseded enter finishes (or aborts)
  // before the next begins, so overlapping transitions never surface the
  // delivery's single-flight busy error to the user.
  enterChain = enterChain.then(() => runEnter(theme, ticket, controller)).catch((error) => {
    // runEnter handles its own failures; reaching here is a real bug and
    // must stay visible in the console the browser acceptance monitors.
    console.error('Unexpected sample enter failure', error);
    if (ticket === sequence) {
      model.phase = 'error';
      model.error = error instanceof Error ? error.message : String(error);
      renderStatus();
    }
  });
}

let enterChain: Promise<void> = Promise.resolve();

async function runEnter(theme: Theme, ticket: number, controller: AbortController): Promise<void> {
  if (!packs || ticket !== sequence) return;
  const acquireOptions = { signal: controller.signal, onProgress(ready: number, total: number) {
    if (ticket !== sequence) return;
    Object.assign(model, { ready, total });
    renderStatus();
  } };
  try {
    let lease: PackLease;
    if (delivery === undefined) {
      lease = await packs.acquire(theme, acquireOptions);
    } else {
      // Persistent-reuse experiment: warm the cache in the async phase
      // (IndexedDB reads, verification, bounded origin acquisition) so
      // the delivery's resolveURL only ever maps finished Blob URLs.
      // A warm failure degrades to the delivery's own origin fetch —
      // local acquisition and delivery outcomes stay separate.
      if (artifactCache !== undefined && model.plan !== null) {
        artifactCache.revokeAll();
        const encodedPathOf = (path: string): string =>
          path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
        const warmList = model.plan.coldArtifacts.flatMap((artifact) => {
          const meta = artifactMeta.get(artifact.path);
          if (meta === undefined) return [];
          const encodedPath = encodedPathOf(artifact.path);
          return [{
            encodedPath,
            sha256: meta.sha256,
            bytes: meta.bytes,
            mediaType: meta.mediaType,
            originUrl: new URL(encodedPath, deliveryOriginBase).href,
          }];
        });
        model.cache = await artifactCache.warm(warmList, controller.signal).then(
          (report): { report: WarmReport } => ({ report }),
          (error: unknown): { error: string } => ({ error: String(error) }),
        );
        renderStatus();
      }
      // Pack preparation precedes the loader: staging (download + worker
      // decode) is returned as soon as the loader has decoded the files;
      // registered textures survive the staging release.
      const startedAt = performance.now();
      const prepared = await delivery.prepare(theme, { signal: controller.signal });
      model.lastPrepareMs = Math.round(performance.now() - startedAt);
      try {
        lease = await packs.acquire(theme, acquireOptions);
      } finally {
        prepared.release();
      }
    }
    if (ticket !== sequence) { lease.release(); return; }
    board.enter(lease, theme);
    Object.assign(model, { current: theme, phase: 'playing' });
  } catch (error) {
    if (ticket !== sequence) return;
    model.phase = 'error';
    if (error instanceof PhaserPackDeliveryError) {
      model.error = `${error.code}${detailSummary(error.details)}`;
    } else {
      model.error = error instanceof Error ? error.message : 'Asset preparation failed';
    }
  } finally {
    if (ticket === sequence) { pending = undefined; renderStatus(); }
  }
}

let deliveryBootTicket = 0;

async function initDelivery(scene: Phaser.Scene): Promise<void> {
  if (deliveryMode === null) throw new Error('Delivery boot requires a delivery mode');
  const bootTicket = ++deliveryBootTicket;
  const bootStillCurrent = (): boolean => bootTicket === deliveryBootTicket;
  // Retry replaces a half-built or failed boot: any older instance is
  // disposed before a new one is created, and the visible state returns to
  // booting so stale error text and timings cannot leak into evidence.
  unsubscribeDelivery?.();
  unsubscribeDelivery = undefined;
  artifactCache?.close();
  artifactCache = undefined;
  delivery?.dispose();
  delivery = undefined;
  packs = undefined;
  resetObserved();
  Object.assign(model, { phase: 'booting', current: null, requested: null, ready: 0, total: 0, error: '', lastPrepareMs: null, plan: null, cache: null });
  renderStatus();
  try {
    const stagingParam = Number(params.get('staging') ?? DELIVERY_STAGING_BUDGET_BYTES);
    // The delivery manifest is application data: the sample fetches it
    // itself and hands the parsed document to the public delivery API,
    // which validates and freezes it.
    // The manifest fetch gets the same attempt deadline as every artifact
    // request: a hung response must surface as a boot error, not an
    // indefinite 'booting' phase.
    const manifestUrl = new URL(DELIVERY_MANIFEST_PATH(deliveryMode), __ASSET_PACK_ORIGIN__).href;
    // The documented http-cache=1 flag covers delivery mode too: the
    // manifest fetch and artifact requests share the same policy.
    const manifestResponse = await fetch(
      manifestUrl,
      { cache: requestCache, signal: AbortSignal.timeout(DELIVERY_REQUEST_TIMEOUT_MS) },
    ).catch((error: unknown): never => {
      throw new Error(`Delivery manifest request failed: ${errorText(error)}`);
    });
    if (!manifestResponse.ok) {
      // Cancel the abandoned body so its connection returns to the pool
      // instead of lingering until the deadline or GC.
      await manifestResponse.body?.cancel().catch(() => undefined);
      throw new Error(`Delivery manifest request failed with HTTP ${manifestResponse.status}`);
    }
    const manifestBytes = await readCappedDeliveryBody(manifestResponse, DELIVERY_MANIFEST_BYTE_CAP, {
      describeOverrun: (): string => `Delivery manifest exceeds ${DELIVERY_MANIFEST_BYTE_CAP} bytes`,
    });
    let manifestDocument: unknown;
    try {
      manifestDocument = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch (error) {
      throw new Error(`Delivery manifest is not valid JSON: ${errorText(error)}`);
    }
    deliveryOriginBase = manifestUrl;
    if (persistentCache) {
      // The experiment bridge opens here; resolveURL below performs only
      // synchronous Blob URL lookups from completed warm phases.
      const opened = await ArtifactCache.open();
      if (opened === 'unavailable') {
        artifactCache = undefined;
      } else {
        artifactCache = opened;
      }
    }
    const booted = createPhaserPackDelivery(manifestDocument, {
      ...(artifactCache === undefined
        ? { baseUrl: manifestUrl }
        : {
          resolveURL: (path): string => artifactCache?.resolve(path)
            ?? new URL(path, manifestUrl).href,
        }),
      createWorker: (): Worker => new Worker(new URL('./archive-decode-worker.ts', import.meta.url), { type: 'module' }),
      stagingBudgetBytes: stagingParam,
      prepareTimeoutMs: DELIVERY_PREPARE_TIMEOUT_MS,
      requestTimeoutMs: DELIVERY_REQUEST_TIMEOUT_MS,
      maxFileBytes: DELIVERY_MAX_FILE_BYTES,
      requestCache,
    });
    if (!bootStillCurrent()) {
      // A stale boot must not leak its cache connection either.
      artifactCache?.close();
      artifactCache = undefined;
      booted.dispose();
      return;
    }
    // Warm inputs are extracted only after the delivery validated the
    // manifest: the cast below reads a shape the public API already
    // accepted, and an invalid manifest failed above with its own error.
    {
      const manifestPacks = (manifestDocument as {
        packs: readonly {
          archive?: { path: string; bytes: number; sha256: string };
          delivery: 'files' | 'zip';
          assets: readonly { files: readonly { path: string; bytes: number; sha256: string; mediaType: string }[] }[];
        }[];
      }).packs;
      artifactMeta = new Map(manifestPacks.flatMap((pack) => {
        if (pack.delivery === 'zip' && pack.archive !== undefined) {
          return [[pack.archive.path, {
            sha256: pack.archive.sha256, bytes: pack.archive.bytes, mediaType: 'application/zip',
          }] as const];
        }
        return pack.assets.flatMap((asset) => asset.files.map((file) => [
          file.path,
          { sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType },
        ] as const));
      }));
    }
    // createPhaserAssetPackLoader is synchronous: the ticket cannot change
    // between the check above and the publish below.
    delivery = booted;
    unsubscribeDelivery = booted.subscribe(onDeliveryEvent);
    packs = createPhaserAssetPackLoader(scene, booted.catalog, {
      ...loaderOptions,
      fileSource: booted.fileSource,
    });
    model.phase = 'idle';
  } catch (error) {
    if (!bootStillCurrent()) return;
    model.phase = 'error';
    if (error instanceof PhaserPackDeliveryError) {
      // The supported programmatic surface is code + details; the sample
      // displays exactly those stable fields, never the message text.
      model.error = `${error.code}${detailSummary(error.details)}`;
    } else if (error instanceof Error) {
      model.error = error.message;
    } else {
      model.error = 'Delivery initialization failed';
    }
  }
  renderStatus();
}

function wireSampleControls(): void {
  controls.grove!.onclick = () => { enter('grove'); };
  controls.dunes!.onclick = () => { enter('dunes'); };
  controls.retry!.onclick = () => {
    if (deliveryMode !== null && !packs) { void initDelivery(board); return; }
    if (model.requested) enter(model.requested);
  };
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
    artifactCache?.revokeAll();
    board.clear();
    board.showEmpty();
    Object.assign(model, { phase: 'idle', current: null, requested: null, ready: 0, total: 0, error: '', lastPrepareMs: null, plan: null, cache: null });
    renderStatus();
  };
}

  declare global {
    interface Window {
      render_game_to_text: () => string;
      advanceTime: (milliseconds: number) => void;
      shutdownSample: () => number;
      /** Experiment-only acceptance hooks (private example, not product). */
      __artifact_cache_faults: () => Record<string, boolean>;
      __artifact_cache_set_fault: (name: string) => void;
      __artifact_cache_usage: () => Promise<{ records: number; totalBytes: number }>;
      __artifact_cache_delete: (identity: string) => Promise<boolean>;
      __artifact_cache_present: () => boolean;
    }
}
  function state() {
    return { ...model, delivery: deliveryMode ?? 'files', staging: delivery?.snapshot() ?? null, renderer: bootedGame().config.renderType === Phaser.WEBGL ? 'webgl' : 'canvas', mode: __ASSET_PACK_MODE__, coordinateSystem: 'origin top-left; x right; y down',
      groundFrames: model.current ? board.frames(model.current, 'ground') : 0,
      pilotFrames: model.current ? board.frames('shared', 'pilot') : 0,
      player: model.phase === 'booting' ? null : board.player(), resources: packs?.snapshot().map((entry) => ({ ...entry, pack: entry.packId, identity: entry.packId + '/' + entry.assetKey })) ?? [],
      textureCount: model.phase === 'booting' ? 0 : board.textureCount() };
}
function wireWindowHooks(): void {
  window.render_game_to_text = () => JSON.stringify(state());
  window.__artifact_cache_faults = (): Record<string, boolean> => ({ ...(artifactCache?.faults ?? {}) });
  window.__artifact_cache_set_fault = (name: string): void => {
    if (artifactCache !== undefined) {
      (artifactCache.faults as Record<string, boolean>)[name] = true;
    }
  };
  window.__artifact_cache_usage = (): Promise<{ records: number; totalBytes: number }> =>
    artifactCache?.usage() ?? Promise.resolve({ records: -1, totalBytes: -1 });
  window.__artifact_cache_delete = (identity: string): Promise<boolean> =>
    artifactCache?.deleteRecord(identity) ?? Promise.resolve(false);
  window.__artifact_cache_present = (): boolean => artifactCache !== undefined;
  window.advanceTime = (milliseconds) => {
  bootedGame().loop.stop();
  virtualTime = Math.max(virtualTime, performance.now());
  for (let index = 0; index < Math.max(1, Math.round(milliseconds / (1000 / 60))); index++) {
    virtualTime += 1000 / 60;
    bootedGame().step(virtualTime, 1000 / 60);
  }
};

  // SceneManager.stop emits shutdown synchronously; count after consumer and loader cleanup.
  // Keep this direct manager call rather than queuing a ScenePlugin operation.
  window.shutdownSample = () => { bootedGame().scene.stop('board'); return board.textureCount(); };
}
