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
  readonly canvas: unknown;
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
const installingGames = new WeakSet<object>();
const installingGlobals = new WeakSet<MiniGameGlobalInstallation>();

function readGamePausedState(game: MiniGamePhaserGame): boolean {
  return game.isPaused === true;
}

function readLoopRunningState(loop: PhaserTimeStep): boolean {
  return loop.running;
}

class MiniGamePhaserRuntimeInstallationImpl implements MiniGamePhaserRuntimeInstallation {
  readonly game: MiniGamePhaserGame;
  readonly host: MiniGameHost;
  readonly #globals: MiniGameGlobalInstallation;
  readonly #onFrameError: (error: unknown) => void;
  readonly #raf: PhaserAnimationFrameController;
  readonly #originalStep: (time: number) => void;
  readonly #patchedStep: (time: number) => void;
  readonly #unsubscribers: Array<() => void> = [];
  readonly #onDestroy: () => void;
  #releaseGlobalsDisposalGuard: () => void = () => undefined;
  #installing = true;
  #destroyedDuringInstallation = false;
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
    this.#onFrameError = onFrameError;
    assertCanvasRenderer(game, globals.canvas);
    assertLifecycleHookPair(this.host);

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
        this.#onFrameError(failure);
      }
    };

    this.#onDestroy = () => {
      if (this.#installing) {
        this.#destroyedDuringInstallation = true;
        this.#disposed = true;
        return;
      }

      this.dispose();
    };
    let rafPatchAttempted = false;

    try {
      this.#releaseGlobalsDisposalGuard = globals.registerDisposalGuard(() => {
        throw new MiniGameRuntimeError(
          'MINIGAME_PHASER_RUNTIME_ACTIVE',
          'Dispose the Phaser mini-game runtime before disposing mini-game globals.',
        );
      });
      game.events?.once('destroy', this.#onDestroy);
      this.#assertInstallationAlive();
      rafPatchAttempted = true;

      if (wasRunning) {
        raf.stop();
        this.#assertInstallationAlive();
      }

      raf.step = this.#patchedStep;

      if (wasRunning) {
        raf.start(callback, false, delay);
        this.#assertInstallationAlive();
      }

      if (this.host.onPause !== undefined) {
        const unsubscribePause = this.host.onPause(() => this.#pause());
        this.#unsubscribers.push(assertUnsubscribe(unsubscribePause, 'onPause'));
        this.#assertInstallationAlive();
      }

      if (this.host.onResume !== undefined) {
        const unsubscribeResume = this.host.onResume(() => this.#resume());
        this.#unsubscribers.push(assertUnsubscribe(unsubscribeResume, 'onResume'));
        this.#assertInstallationAlive();
      }

      this.#installing = false;
    } catch (error) {
      this.#installing = false;
      this.#disposed = true;
      const cleanup = runCleanupSteps([
        () => {
          if (this.#hasHostPauseState()) {
            this.#restoreHostPauseState(true);
          }
        },
        () => runLifecycleUnsubscribers(this.#unsubscribers.splice(0)),
        () => {
          this.game.events?.off?.('destroy', this.#onDestroy);
        },
        () => {
          if (!rafPatchAttempted || this.game.loop.raf !== raf) {
            return;
          }

          raf.stop();
          raf.step = this.#originalStep;

          if (wasRunning) {
            raf.start(callback, false, delay);
          }
        },
        () => this.#releaseGlobalsDisposalGuard(),
      ]);

      if (!cleanup.ok) {
        reportCleanupError(cleanup.error);
      }

      throw error;
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  hasCompatibleOptions(
    globals: MiniGameGlobalInstallation,
    onFrameError: (error: unknown) => void,
  ): boolean {
    return this.#globals === globals && this.#onFrameError === onFrameError;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    const cleanup = runCleanupSteps([
      () => {
        if (this.#hasHostPauseState()) {
          this.#restoreHostPauseState(true);
        }
      },
      () => runLifecycleUnsubscribers(this.#unsubscribers.splice(0)),
      () => {
        this.game.events?.off?.('destroy', this.#onDestroy);
      },
      () => {
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
      },
      () => this.#releaseGlobalsDisposalGuard(),
    ]);

    installedGames.delete(this.game as object);

    if (installedGlobals.get(this.#globals) === this) {
      installedGlobals.delete(this.#globals);
    }

    if (!cleanup.ok) {
      throw cleanup.error;
    }
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
        this.#gamePausedByHost = readGamePausedState(this.game);
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
        this.#loopSleptByHost = !readLoopRunningState(this.game.loop);
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

    this.#restoreHostPauseState(false);
  }

  #restoreHostPauseState(allowDisposed: boolean): void {
    this.#pausedByHost = false;
    const shouldWakeLoop = this.#loopSleptByHost;
    this.#loopSleptByHost = false;
    this.#globals.document.hidden = false;
    this.#globals.document.visibilityState = 'visible';
    let restorationFailure: unknown;
    let restorationFailed = false;

    if (shouldWakeLoop && this.game.loop.started && !this.game.loop.running) {
      try {
        this.game.loop.wake();
      } catch (error) {
        if (!allowDisposed) {
          this.#pausedByHost = true;
          this.#loopSleptByHost = true;
          this.#globals.document.hidden = true;
          this.#globals.document.visibilityState = 'hidden';
          throw error;
        }

        restorationFailed = true;
        restorationFailure = error;
      }
    }

    if ((!allowDisposed && this.#disposed) || this.#pausedByHost) {
      return;
    }

    const shouldResumeGame = this.#gamePausedByHost;
    this.#gamePausedByHost = false;

    if (shouldResumeGame) {
      try {
        this.game.resume?.();
      } catch (error) {
        this.#gamePausedByHost = readGamePausedState(this.game);

        if (!allowDisposed && this.#gamePausedByHost) {
          this.#pausedByHost = true;
          this.#globals.document.hidden = true;
          this.#globals.document.visibilityState = 'hidden';
          throw error;
        }

        if (!restorationFailed) {
          restorationFailed = true;
          restorationFailure = error;
        }

        if (allowDisposed) {
          this.#gamePausedByHost = false;
        }
      }
    }

    if ((!allowDisposed && this.#disposed) || this.#pausedByHost) {
      return;
    }

    this.#globals.document.dispatchEvent(new MiniGameEvent('visibilitychange'));

    if (restorationFailed) {
      throw restorationFailure;
    }
  }

  #hasHostPauseState(): boolean {
    return this.#pausedByHost || this.#gamePausedByHost || this.#loopSleptByHost;
  }

  #assertInstallationAlive(): void {
    if (this.#destroyedDuringInstallation) {
      throw new MiniGameRuntimeError(
        'MINIGAME_PHASER_DESTROYED_DURING_INSTALL',
        'Phaser game was destroyed while the mini-game runtime was installing.',
      );
    }
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
  const globals = options.globals ?? getInstalledMiniGameGlobals();
  const onFrameError = options.onFrameError ?? reportPhaserFrameError;
  const existing = installedGames.get(game as object);

  if (existing !== undefined && !existing.disposed) {
    if (globals === undefined || !existing.hasCompatibleOptions(globals, onFrameError)) {
      throw new MiniGameRuntimeError(
        'MINIGAME_PHASER_OPTIONS_MISMATCH',
        'Phaser mini-game runtime is already installed with different runtime options.',
      );
    }

    return existing;
  }

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

  const gameIdentity = game as object;

  if (installingGames.has(gameIdentity) || installingGlobals.has(globals)) {
    throw new MiniGameRuntimeError(
      'MINIGAME_PHASER_INSTALL_REENTRANT',
      'Phaser mini-game runtime installation cannot reenter lifecycle setup.',
    );
  }

  installingGames.add(gameIdentity);
  installingGlobals.add(globals);

  try {
    const installation = new MiniGamePhaserRuntimeInstallationImpl(game, globals, onFrameError);
    installedGames.set(gameIdentity, installation);
    installedGlobals.set(globals, installation);
    return installation;
  } finally {
    installingGames.delete(gameIdentity);
    installingGlobals.delete(globals);
  }
}

function assertCanvasRenderer(
  game: MiniGamePhaserGame,
  primaryCanvas: MiniGameGlobalInstallation['canvas'],
): void {
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

  if (game.canvas !== primaryCanvas) {
    throw new MiniGameRuntimeError(
      'MINIGAME_PHASER_CANVAS_MISMATCH',
      'Mini-game Phaser runtime must use the globals installation primary canvas.',
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

function assertLifecycleHookPair(host: MiniGameHost): void {
  const hasPause = host.onPause !== undefined;
  const hasResume = host.onResume !== undefined;

  if (hasPause !== hasResume) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INCOMPLETE_LIFECYCLE_HOOKS',
      'Mini-game hosts must provide onPause and onResume together.',
    );
  }
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

type CleanupResult = Readonly<{ readonly ok: true }> | Readonly<{
  readonly ok: false;
  readonly error: unknown;
}>;

function runCleanupSteps(steps: readonly (() => void)[]): CleanupResult {
  let failed = false;
  let failure: unknown;

  for (const step of steps) {
    try {
      step();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }

  return failed ? { ok: false, error: failure } : { ok: true };
}

function reportCleanupError(error: unknown): void {
  try {
    console.error('Mini-game runtime rollback encountered a cleanup error.', error);
  } catch {
    // The original installation failure remains authoritative.
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
