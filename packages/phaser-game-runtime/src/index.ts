import type Phaser from 'phaser';

import type { GameExecutionController, GameExecutionSnapshot } from '@mpgd/game-runtime';

export interface GameplayAudioSink {
  getMuted(): boolean;
  setMuted(muted: boolean): void;
}

/** Only this scene's built-in pointer, keyboard, and gamepad plugins are affected. */
export type GameplayScene = Pick<Phaser.Scene, 'sys' | 'input'>;

export interface PhaserGameRuntimeBinding {
  dispose(): void;
}

export type UnsupportedPhaserExecutionState =
  | 'simulation-requires-input-block'
  | 'audio-sink-missing';

export interface BindPhaserGameSceneInput {
  readonly controller: GameExecutionController;
  readonly scene: GameplayScene;
  readonly resetInput: () => void;
  readonly renderingPolicy: 'visibility';
  readonly audio?: GameplayAudioSink;
  readonly uiScope?: { dispose(): void };
  /** Phaser pause also suspends input: simulation-only blocking cannot preserve active input. */
  readonly onUnsupportedState: (
    snapshot: GameExecutionSnapshot,
    reason: UnsupportedPhaserExecutionState,
  ) => void | Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export function bindPhaserGameScene(input: BindPhaserGameSceneInput): PhaserGameRuntimeBinding {
  const { scene, controller, resetInput, audio, uiScope, onUnsupportedState, onError } = input;
  if (input.renderingPolicy !== 'visibility' || typeof onUnsupportedState !== 'function') {
    throw new TypeError('Choose visibility rendering and provide an unsupported-state observer.');
  }
  if (typeof resetInput !== 'function') {
    throw new TypeError('Provide a gameplay input reset callback.');
  }
  if (controller.getSnapshot().status === 'destroyed') {
    throw new Error('Cannot bind a destroyed game execution controller.');
  }
  let disposed = false;
  let sceneEnded = false;
  let reportedSimulation = false;
  let reportedAudio = false;
  let applying = false;
  let dirty = false;
  let ownedPause = false;
  let ownedVisibility = false;
  let ownedAudio = false;
  let inputBlocked = false;
  const ownedInput = new Set<{ enabled: boolean }>();
  let unsubscribe = () => {};

  function report(error: unknown): void {
    try {
      const result = onError?.(error);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Diagnostics cannot interrupt teardown.
    }
  }

  function attempt(callback: () => void | Promise<void>): void {
    try {
      const result = callback();
      if (result !== undefined) {
        void Promise.resolve(result).catch(report);
      }
    } catch (error) {
      report(error);
    }
  }

  function restore(resumeScene: boolean): void {
    const shouldResume = resumeScene && ownedPause;
    ownedPause = false;
    for (const plugin of ownedInput) {
      attempt(() => {
        plugin.enabled = true;
      });
    }
    ownedInput.clear();
    if (resumeScene && !sceneEnded && ownedVisibility && (scene.sys.isActive() || scene.sys.isPaused())) {
      attempt(() => {
        scene.sys.setVisible(true);
      });
    }
    ownedVisibility = false;
    if (ownedAudio) {
      attempt(() => audio?.setMuted(false));
    }
    ownedAudio = false;
    // Resume last: its listeners may synchronously restart the scene and install a new binding.
    if (shouldResume && !sceneEnded && controller.getSnapshot().status === 'active' && scene.sys.isPaused()) {
      attempt(() => {
        scene.sys.resume();
      });
    }
  }

  function dispose(mode: 'restore' | 'shutdown' | 'terminal' = 'restore'): void {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribe();
    // Keep shutdown observation installed while restoration calls into consumer/engine code.
    if (mode !== 'terminal' && controller.getSnapshot().status === 'active') {
      restore(mode === 'restore');
    }
    for (const event of ['shutdown', 'destroy']) {
      scene.sys.events.off(event, onShutdown);
    }
    scene.sys.events.off('sleep', onSleep);
    scene.sys.events.off('wake', onWake);
    scene.sys.events.off('pause', onPause);
    scene.sys.events.off('resume', onResume);
    scene.sys.events.off('create', apply);
    attempt(() => uiScope?.dispose());
    ownedInput.clear();
  }

  function onShutdown(): void {
    sceneEnded = true;
    dispose('shutdown');
  }

  function onPause(): void {
    if (!disposed && !applying) {
      ownedPause = false;
    }
  }

  function onResume(): void {
    if (!disposed && !applying) {
      ownedPause = false;
      apply();
    }
  }

  function onSleep(): void {
    // External sleep owns activity/visibility until an external wake. Never wake it ourselves.
    ownedPause = false;
    ownedVisibility = false;
  }

  function onWake(): void {
    if (controller.getSnapshot().blocked['gameplay-input']) {
      inputBlocked = false;
    }
    apply();
  }

  function apply(): void {
    dirty = true;
    if (disposed || applying) {
      return;
    }
    applying = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        const snapshot = controller.getSnapshot();
        if (snapshot.status === 'destroyed') {
          // Terminal runtime teardown must not request gameplay resume or unmute.
          dispose('terminal');
          break;
        }
        const blocked = snapshot.blocked;
        const simulationUnsupported = blocked.simulation && !blocked['gameplay-input'];
        const audioUnsupported = blocked.audio && audio === undefined;
        const notifySimulation = simulationUnsupported && !reportedSimulation;
        const notifyAudio = audioUnsupported && !reportedAudio;
        reportedSimulation = simulationUnsupported;
        reportedAudio = audioUnsupported;
        if (notifySimulation) {
          attempt(() => onUnsupportedState(snapshot, 'simulation-requires-input-block'));
        }
        if (notifyAudio) {
          attempt(() => onUnsupportedState(snapshot, 'audio-sink-missing'));
        }
        if (simulationUnsupported) {
          continue;
        }
        if (audio !== undefined) {
          attempt(() => {
            if (blocked.audio && !audio.getMuted()) {
              ownedAudio = true;
              audio.setMuted(true);
            } else if (!blocked.audio && ownedAudio) {
              ownedAudio = false;
              audio.setMuted(false);
            }
          });
        }
        if (disposed) {
          break;
        }
        if (controller.getSnapshot().version !== snapshot.version) {
          dirty = true;
          continue;
        }
        // Stopped, destroyed, and sleeping scenes belong to their external lifecycle owner.
        if (!scene.sys.isActive() && !scene.sys.isPaused()) {
          continue;
        }
        if (blocked['gameplay-input'] && !inputBlocked) {
          inputBlocked = true;
          for (const plugin of [scene.input, scene.input.keyboard, scene.input.gamepad]) {
            if (plugin !== null && plugin !== undefined && plugin.enabled) {
              ownedInput.add(plugin);
              attempt(() => {
                plugin.enabled = false;
              });
            }
          }
          attempt(resetInput);
          if (disposed) {
            break;
          }
          if (controller.getSnapshot().version !== snapshot.version) {
            dirty = true;
            continue;
          }
        } else if (!blocked['gameplay-input'] && inputBlocked) {
          inputBlocked = false;
          for (const plugin of ownedInput) {
            attempt(() => {
              plugin.enabled = true;
            });
          }
          ownedInput.clear();
        }
        if (blocked.rendering && scene.sys.isVisible()) {
          ownedVisibility = true;
          scene.sys.setVisible(false);
        } else if (!blocked.rendering && ownedVisibility) {
          ownedVisibility = false;
          scene.sys.setVisible(true);
        }
        if (blocked.simulation && scene.sys.isActive()) {
          ownedPause = true;
          scene.sys.pause();
        } else if (!blocked.simulation && ownedPause) {
          ownedPause = false;
          if (scene.sys.isPaused()) {
            scene.sys.resume();
          }
        }
      }
    } catch (error) {
      report(error);
    } finally {
      applying = false;
    }
  }

  try {
    for (const event of ['shutdown', 'destroy']) {
      scene.sys.events.on(event, onShutdown);
    }
    scene.sys.events.on('sleep', onSleep);
    scene.sys.events.on('wake', onWake);
    scene.sys.events.on('pause', onPause);
    scene.sys.events.on('resume', onResume);
    // SceneManager sets RUNNING after scene.create() returns; apply before its first update.
    scene.sys.events.on('create', apply);
    unsubscribe = controller.subscribe(apply);
    apply();
  } catch (error) {
    dispose('shutdown');
    throw error;
  }
  return Object.freeze({ dispose: () => dispose() });
}
