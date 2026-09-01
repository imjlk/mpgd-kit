import { MiniGameEvent } from './events.js';
import { getInstalledMiniGameGlobals, type MiniGameGlobalInstallation } from './globals.js';
import { MiniGameRuntimeError, type MiniGameHost } from './host.js';

/** Phaser 4.2.0's public `Phaser.CANVAS` renderer constant. */
export const miniGamePhaserCanvasRenderer = 1 as const;

interface PhaserAnimationFrameController {
  isRunning: boolean;
  isSetTimeOut: boolean;
  timeOutID: number | null;
  delay: number;
  callback: (time: number) => void;
  step: (time: number) => void;
  start(callback: (time: number) => void, forceSetTimeOut: boolean, delay: number): void;
  stop(): void;
}

interface PhaserTimeStep {
  started: boolean;
  running: boolean;
  forceSetTimeOut: boolean;
  raf: PhaserAnimationFrameController | null;
  sleep(): void;
  wake(seamless?: boolean): void;
}

interface PhaserEventEmitterLike {
  once(event: string, callback: () => void): unknown;
  off?(event: string, callback: () => void): unknown;
}

export interface MiniGamePhaserGame {
  readonly config?: Readonly<{ readonly renderType?: number }>;
  readonly renderer?: Readonly<{ readonly type?: number }> | null;
  readonly loop: PhaserTimeStep;
  readonly events?: PhaserEventEmitterLike;
  isPaused?: boolean;
  pause?(): void;
  resume?(): void;
}

export interface MiniGamePhaserRuntimeOptions {
  readonly globals?: MiniGameGlobalInstallation;
  readonly onFrameError?: (error: unknown) => void;
}

export interface MiniGamePhaserRuntimeInstallation {
  readonly game: MiniGamePhaserGame;
  readonly host: MiniGameHost;
  readonly disposed: boolean;
  dispose(): void;
}

export interface MiniGamePhaserConfigOverrides {
  readonly type: typeof miniGamePhaserCanvasRenderer;
  /** Runtime wrapper that fulfills Phaser's HTMLCanvasElement contract at the compatibility boundary. */
  readonly canvas: MiniGameGlobalInstallation['canvas'] & HTMLCanvasElement;
  readonly loader: Readonly<Record<string, unknown>>;
  readonly audio: Readonly<Record<string, unknown>>;
}

const installedGames = new WeakMap<object, MiniGamePhaserRuntimeInstallationImpl>();
const installedGlobals = new WeakMap<
  MiniGameGlobalInstallation,
  MiniGamePhaserRuntimeInstallationImpl
>();

class MiniGamePhaserRuntimeInstallationImpl implements MiniGamePhaserRuntimeInstallation {
  readonly game: MiniGamePhaserGame;
  readonly host: MiniGameHost;
  readonly #globals: MiniGameGlobalInstallation;
  readonly #raf: PhaserAnimationFrameController;
  readonly #originalStep: (time: number) => void;
  readonly #patchedStep: (time: number) => void;
  readonly #unsubscribers: Array<() => void> = [];
  readonly #onDestroy: () => void;
  #releaseGlobalsDisposalGuard: () => void = () => undefined;
  #disposed = false;
  #pausedByHost = false;
  #gamePausedByHost = false;
  #loopSleptByHost = false;

  constructor(
    game: MiniGamePhaserGame,
    globals: MiniGameGlobalInstallation,
    onFrameError: (error: unknown) => void,
  ) {
    this.game = game;
    this.host = globals.host;
    this.#globals = globals;
    assertCanvasRenderer(game);

    if (game.loop.forceSetTimeOut) {
      throw new MiniGameRuntimeError(
        'MINIGAME_PHASER_TIMEOUT_LOOP_UNSUPPORTED',
        'Mini-game Phaser builds must use the host requestAnimationFrame loop.',
      );
    }

    const raf = game.loop.raf;

    if (raf === null) {
      throw new MiniGameRuntimeError(
        'MINIGAME_PHASER_LOOP_UNAVAILABLE',
        'Phaser game loop is unavailable or already destroyed.',
      );
    }

    this.#raf = raf;
    this.#originalStep = raf.step;
    const wasRunning = raf.isRunning;
    const callback = raf.callback;
    const delay = raf.delay;

    if (wasRunning) {
      raf.stop();
    }

    this.#patchedStep = (time: number) => {
      let failed = false;
      let failure: unknown;

      try {
        raf.callback(time);
      } catch (error) {
        failed = true;
        failure = error;
      }

      if (raf.isRunning && raf.step === this.#patchedStep) {
        raf.timeOutID = globalThis.requestAnimationFrame(this.#patchedStep);
      }

      if (failed) {
        onFrameError(failure);
      }
    };
    raf.step = this.#patchedStep;

    if (wasRunning) {
      raf.start(callback, false, delay);
    }

    this.#onDestroy = () => this.dispose();

    try {
      this.#releaseGlobalsDisposalGuard = globals.registerDisposalGuard(() => {
        throw new MiniGameRuntimeError(
          'MINIGAME_PHASER_RUNTIME_ACTIVE',
          'Dispose the Phaser mini-game runtime before disposing mini-game globals.',
        );
      });

      if (this.host.onPause !== undefined) {
        const unsubscribePause = this.host.onPause(() => this.#pause());
        this.#unsubscribers.push(assertUnsubscribe(unsubscribePause, 'onPause'));
      }

      if (this.host.onResume !== undefined) {
        const unsubscribeResume = this.host.onResume(() => this.#resume());
        this.#unsubscribers.push(assertUnsubscribe(unsubscribeResume, 'onResume'));
      }

      game.events?.once('destroy', this.#onDestroy);
    } catch (error) {
      this.#disposed = true;

      if (this.#pausedByHost) {
        this.#restoreHostPauseState();
      }

      runLifecycleUnsubscribers(this.#unsubscribers.splice(0));

      raf.stop();
      raf.step = this.#originalStep;

      if (wasRunning) {
        raf.start(callback, false, delay);
      }

      this.#releaseGlobalsDisposalGuard();

      throw error;
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    if (this.#pausedByHost) {
      this.#restoreHostPauseState();
    }

    runLifecycleUnsubscribers(this.#unsubscribers.splice(0));

    this.game.events?.off?.('destroy', this.#onDestroy);
    const raf = this.game.loop.raf;

    if (raf === this.#raf && raf.step === this.#patchedStep) {
      const wasRunning = raf.isRunning;
      const callback = raf.callback;
      const delay = raf.delay;
      raf.stop();
      raf.step = this.#originalStep;

      if (wasRunning) {
        raf.start(callback, false, delay);
      }
    }

    installedGames.delete(this.game as object);

    if (installedGlobals.get(this.#globals) === this) {
      installedGlobals.delete(this.#globals);
    }

    this.#releaseGlobalsDisposalGuard();
  }

  #pause(): void {
    if (this.#disposed || this.#pausedByHost) {
      return;
    }

    this.#pausedByHost = true;
    this.#globals.document.hidden = true;
    this.#globals.document.visibilityState = 'hidden';
    this.#globals.document.dispatchEvent(new MiniGameEvent('visibilitychange'));

    if (this.#disposed || !this.#pausedByHost) {
      return;
    }

    if (this.game.isPaused !== true && this.game.pause !== undefined) {
      this.#gamePausedByHost = true;

      try {
        this.game.pause();
      } catch (error) {
        this.#gamePausedByHost = false;
        throw error;
      }

      if (this.#disposed || !this.#pausedByHost) {
        return;
      }
    }

    if (this.game.loop.started && this.game.loop.running) {
      this.#loopSleptByHost = true;

      try {
        this.game.loop.sleep();
      } catch (error) {
        this.#loopSleptByHost = false;
        throw error;
      }

      if (this.#disposed || !this.#pausedByHost) {
        this.#loopSleptByHost = false;

        if (!this.game.loop.running) {
          this.game.loop.wake();
        }
      }
    }
  }

  #resume(): void {
    if (this.#disposed || !this.#pausedByHost) {
      return;
    }

    this.#restoreHostPauseState();
  }

  #restoreHostPauseState(): void {
    this.#pausedByHost = false;
    const shouldWakeLoop = this.#loopSleptByHost;
    const shouldResumeGame = this.#gamePausedByHost;
    this.#loopSleptByHost = false;
    this.#gamePausedByHost = false;
    this.#globals.document.hidden = false;
    this.#globals.document.visibilityState = 'visible';

    if (shouldWakeLoop && this.game.loop.started && !this.game.loop.running) {
      this.game.loop.wake();
    }

    if (shouldResumeGame) {
      this.game.resume?.();
    }

    this.#globals.document.dispatchEvent(new MiniGameEvent('visibilitychange'));
  }
}

export function createMiniGamePhaserConfig<T extends Readonly<Record<string, unknown>>>(
  config: T,
  globals = getInstalledMiniGameGlobals(),
): T & MiniGamePhaserConfigOverrides {
  if (globals === undefined || globals.disposed) {
    throw new MiniGameRuntimeError(
      'MINIGAME_GLOBALS_REQUIRED',
      'Install mini-game globals before creating a Phaser game config.',
    );
  }

  if (config.type !== undefined && config.type !== miniGamePhaserCanvasRenderer) {
    throw new MiniGameRuntimeError(
      'MINIGAME_CANVAS_RENDERER_REQUIRED',
      'Mini-game Phaser builds require the explicit Canvas renderer; AUTO and WEBGL are not supported.',
    );
  }

  const loader = assertOptionalConfigRecord(config.loader, 'loader');
  const audio = assertOptionalConfigRecord(config.audio, 'audio');

  return {
    ...config,
    type: miniGamePhaserCanvasRenderer,
    canvas: globals.canvas as MiniGamePhaserConfigOverrides['canvas'],
    loader: {
      ...loader,
      imageLoadType: 'HTMLImageElement',
    },
    audio: {
      ...audio,
      noAudio: true,
    },
  } as T & MiniGamePhaserConfigOverrides;
}

export function installPhaserMiniGameRuntime(
  game: MiniGamePhaserGame,
  options: MiniGamePhaserRuntimeOptions = {},
): MiniGamePhaserRuntimeInstallation {
  const existing = installedGames.get(game as object);

  if (existing !== undefined && !existing.disposed) {
    return existing;
  }

  const globals = options.globals ?? getInstalledMiniGameGlobals();

  if (globals === undefined || globals.disposed) {
    throw new MiniGameRuntimeError(
      'MINIGAME_GLOBALS_REQUIRED',
      'Install mini-game globals before installing the Phaser runtime patch.',
    );
  }

  const globalsInstallation = installedGlobals.get(globals);

  if (globalsInstallation !== undefined && !globalsInstallation.disposed) {
    throw new MiniGameRuntimeError(
      'MINIGAME_MULTIPLE_PHASER_GAMES_UNSUPPORTED',
      'Mini-game globals can host only one active Phaser game runtime at a time.',
    );
  }

  const installation = new MiniGamePhaserRuntimeInstallationImpl(
    game,
    globals,
    options.onFrameError ?? reportPhaserFrameError,
  );
  installedGames.set(game as object, installation);
  installedGlobals.set(globals, installation);
  return installation;
}

function assertCanvasRenderer(game: MiniGamePhaserGame): void {
  const configuredType = game.config?.renderType;
  const rendererType = game.renderer?.type;

  if (
    configuredType !== miniGamePhaserCanvasRenderer
    || (rendererType !== undefined && rendererType !== miniGamePhaserCanvasRenderer)
  ) {
    throw new MiniGameRuntimeError(
      'MINIGAME_CANVAS_RENDERER_REQUIRED',
      'Mini-game Phaser runtime can only be installed on an explicit Canvas renderer game.',
    );
  }
}

function assertUnsubscribe(input: unknown, source: string): () => void {
  if (typeof input !== 'function') {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_LIFECYCLE_SUBSCRIPTION',
      `Mini-game host ${source} must return an unsubscribe function.`,
    );
  }

  return input as () => void;
}

function runLifecycleUnsubscribers(unsubscribers: readonly (() => void)[]): void {
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      try {
        console.error('Mini-game lifecycle unsubscription failed; cleanup continues.', error);
      } catch {
        // Cleanup must continue even when host logging is unavailable.
      }
    }
  }
}

function assertOptionalConfigRecord(
  input: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (input === undefined) {
    return {};
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_PHASER_CONFIG',
      `Phaser ${label} config must be an object.`,
    );
  }

  return input as Readonly<Record<string, unknown>>;
}

function reportPhaserFrameError(error: unknown): void {
  console.error('Phaser mini-game frame failed; the next host frame remains scheduled.', error);
}
