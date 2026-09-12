import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createGameExecutionController } from '../../game-runtime/src/index.js';
import { bindPhaserGameScene, type GameplayScene } from './index.js';

function fakeScene(initial: 'creating' | 'running' | 'paused' | 'sleeping' | 'stopped' = 'running') {
  let state = initial;
  let visible = initial !== 'sleeping';
  const events = new EventEmitter();
  const input = { enabled: true, keyboard: { enabled: true }, gamepad: { enabled: true } };
  const sys = {
    events,
    isActive: () => state === 'running',
    isPaused: () => state === 'paused',
    isSleeping: () => state === 'sleeping',
    isVisible: () => visible,
    setVisible(value: boolean) {
      visible = value;
    },
    pause: vi.fn(() => {
      if (state === 'running') {
        state = 'paused';
        events.emit('pause');
      }
    }),
    // Deliberately reproduce Phaser's unsafe raw resume behavior for inactive scenes.
    resume: vi.fn(() => {
      state = 'running';
      events.emit('resume');
    }),
  };
  return {
    scene: { sys, input } as unknown as GameplayScene,
    sys,
    input,
    state: () => state,
    listenerCount: () => events.eventNames().reduce((total, event) => total + events.listenerCount(event), 0),
    stop() {
      state = 'stopped';
      events.emit('shutdown');
    },
    start() {
      state = 'running';
      visible = true;
    },
    created() {
      state = 'running';
      events.emit('create');
    },
    sleep() {
      state = 'sleeping';
      visible = false;
      events.emit('sleep');
    },
    wake() {
      state = 'running';
      visible = true;
      events.emit('wake');
    },
  };
}

function audioSink(initial = false) {
  let muted = initial;
  return {
    getMuted: () => muted,
    setMuted: vi.fn((value: boolean) => {
      muted = value;
    }),
  };
}

const gameplayChannels = ['simulation', 'gameplay-input'] as const;

describe('Phaser scene execution binding (headless fakes)', () => {
  it.each(['notification', 'dispose'] as const)('retries a failed owned unmute on %s', (retry) => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const audio = audioSink();
    const onError = vi.fn();
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, audio, onError,
      renderingPolicy: 'visibility', resetInput: vi.fn(), onUnsupportedState: vi.fn(),
    });
    const block = controller.acquireBlock({ reason: 'audio', channels: ['audio'] });
    const setMuted = audio.setMuted.getMockImplementation();
    let failOnce = true;
    audio.setMuted.mockImplementation((value) => {
      if (!value && failOnce) {
        failOnce = false;
        throw new Error('transient sink failure');
      }
      setMuted?.(value);
    });
    block.release();
    expect(audio.getMuted()).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    if (retry === 'dispose') {
      binding.dispose();
    } else {
      const other = controller.acquireBlock({ reason: 'diagnostic', channels: ['rendering'] });
      other.release();
    }
    expect(audio.getMuted()).toBe(false);
    binding.dispose();
  });

  it('still detaches listeners and scope when a custom controller throws during disposal', () => {
    const runtime = createGameExecutionController();
    let throwOnRead = false;
    const controller = {
      ...runtime,
      getSnapshot: () => {
        if (throwOnRead) {
          throw new Error('controller unavailable');
        }
        return runtime.getSnapshot();
      },
    };
    const gameplay = fakeScene();
    const scope = { dispose: vi.fn() };
    const onError = vi.fn();
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, uiScope: scope, onError,
      renderingPolicy: 'visibility', resetInput: vi.fn(), onUnsupportedState: vi.fn(),
    });
    runtime.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    throwOnRead = true;
    expect(() => binding.dispose()).not.toThrow();
    expect(gameplay.listenerCount()).toBe(0);
    expect(scope.dispose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('uses snapshot versions when an injected controller returns fresh snapshot objects', () => {
    const runtime = createGameExecutionController();
    const controller = { ...runtime, getSnapshot: () => ({ ...runtime.getSnapshot() }) };
    const gameplay = fakeScene();
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState: vi.fn(),
    });
    const token = runtime.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    expect(gameplay.state()).toBe('paused');
    token.release();
    expect(gameplay.state()).toBe('running');
    binding.dispose();
  });

  it('finishes teardown when a plugin enable setter throws', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const audio = audioSink();
    const scope = { dispose: vi.fn() };
    const onError = vi.fn();
    let enabled = true;
    Object.defineProperty(gameplay.input.keyboard, 'enabled', {
      get: () => enabled,
      set(value: boolean) {
        if (value) {
          throw new Error('plugin destroyed'); }
        enabled = value;
      },
    });
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, audio, uiScope: scope, onError,
      renderingPolicy: 'visibility', resetInput: vi.fn(), onUnsupportedState: vi.fn(),
    });
    controller.acquireBlock({ reason: 'all', channels: [...gameplayChannels, 'audio'] });
    expect(() => binding.dispose()).not.toThrow();
    expect(scope.dispose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(audio.getMuted()).toBe(false);
    expect(gameplay.input.enabled).toBe(true);
    expect(gameplay.input.gamepad.enabled).toBe(true);
    expect(gameplay.listenerCount()).toBe(0);
  });

  it('does not overwrite a new binding installed synchronously by a resume listener', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const audio = audioSink();
    const options = {
      controller, scene: gameplay.scene, audio,
      renderingPolicy: 'visibility' as const, resetInput: vi.fn(), onUnsupportedState: vi.fn(),
    };
    const binding = bindPhaserGameScene(options);
    const token = controller.acquireBlock({ reason: 'all', channels: [...gameplayChannels, 'rendering', 'audio'] });
    let next: ReturnType<typeof bindPhaserGameScene> | undefined;
    gameplay.sys.events.once('resume', () => {
      gameplay.stop();
      gameplay.start();
      next = bindPhaserGameScene(options);
    });
    binding.dispose();
    expect(gameplay.state()).toBe('paused');
    expect(gameplay.sys.isVisible()).toBe(false);
    expect(gameplay.input.enabled).toBe(false);
    expect(audio.getMuted()).toBe(true);
    token.release();
    expect(gameplay.state()).toBe('running');
    expect(gameplay.input.enabled).toBe(true);
    expect(audio.getMuted()).toBe(false);
    next?.dispose();
  });

  it('does not resume a replacement scene created by an audio restore callback', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const audio = audioSink();
    let next: ReturnType<typeof bindPhaserGameScene> | undefined;
    const options = {
      controller, scene: gameplay.scene, audio,
      renderingPolicy: 'visibility' as const, resetInput: vi.fn(), onUnsupportedState: vi.fn(),
    };
    const binding = bindPhaserGameScene(options);
    const token = controller.acquireBlock({ reason: 'all', channels: [...gameplayChannels, 'audio'] });
    const originalSetMuted = audio.setMuted.getMockImplementation();
    audio.setMuted.mockImplementation((value) => {
      originalSetMuted?.(value);
      if (!value && next === undefined) {
        gameplay.stop();
        gameplay.start();
        next = bindPhaserGameScene(options);
      }
    });
    binding.dispose();
    expect(gameplay.state()).toBe('paused');
    expect(gameplay.sys.resume).not.toHaveBeenCalled();
    token.release();
    expect(gameplay.state()).toBe('running');
    next?.dispose();
  });

  it('reconciles an external resume but preserves an observable externally retaken pause', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    gameplay.sys.events.once('resume', () => gameplay.sys.pause());
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState: vi.fn(),
    });
    const token = controller.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    gameplay.sys.resume();
    token.release();
    expect(gameplay.state()).toBe('paused');
    binding.dispose();
    expect(gameplay.state()).toBe('paused');

    const active = fakeScene();
    const next = bindPhaserGameScene({
      controller, scene: active.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState: vi.fn(),
    });
    const block = controller.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    active.sys.resume();
    expect(active.state()).toBe('paused');
    block.release();
    expect(active.state()).toBe('running');
    next.dispose();
  });

  it('reports each unsupported condition once until that condition clears', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const onUnsupportedState = vi.fn();
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState,
    });
    const audio = controller.acquireBlock({ reason: 'audio', channels: ['audio'] });
    const unrelated = controller.acquireBlock({ reason: 'rendering', channels: ['rendering'] });
    unrelated.release();
    expect(onUnsupportedState).toHaveBeenCalledTimes(1);
    audio.release();
    controller.acquireBlock({ reason: 'audio-again', channels: ['audio'] });
    expect(onUnsupportedState).toHaveBeenCalledTimes(2);
    binding.dispose();
  });

  it('applies startup blocks after SceneManager finishes create without polling an update', () => {
    const controller = createGameExecutionController();
    controller.acquireBlock({ reason: 'initial background', channels: gameplayChannels });
    const gameplay = fakeScene('creating');
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState: vi.fn(),
    });
    gameplay.created();
    expect(gameplay.state()).toBe('paused');
    expect(gameplay.input.enabled).toBe(false);
    binding.dispose();
  });
  it('keeps gameplay paused through settings/background overlap while the UI scene remains active', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const ui = fakeScene();
    const resetInput = vi.fn();
    const audio = audioSink();
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput,
      audio, onUnsupportedState: vi.fn(),
    });
    const settings = controller.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    const background = controller.acquireBlock({
      reason: 'background', channels: [...gameplayChannels, 'rendering', 'audio'],
    });
    expect(gameplay.state()).toBe('paused');
    expect(gameplay.sys.isVisible()).toBe(false);
    expect(audio.getMuted()).toBe(true);
    expect(ui.state()).toBe('running');
    expect(ui.input.enabled).toBe(true);
    background.release();
    expect(gameplay.state()).toBe('paused');
    expect(gameplay.sys.isVisible()).toBe(true);
    expect(audio.getMuted()).toBe(false);
    settings.release();
    expect(gameplay.state()).toBe('running');
    expect(resetInput).toHaveBeenCalledTimes(1);
    expect(gameplay.sys.resume).toHaveBeenCalledTimes(1);
    binding.dispose();
  });

  it('blocks pointer, keyboard, and gamepad input independently from simulation and preserves disabled baselines', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    gameplay.input.gamepad.enabled = false;
    const resetInput = vi.fn();
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput,
      onUnsupportedState: vi.fn(),
    });
    const first = controller.acquireBlock({ reason: 'input', channels: ['gameplay-input'] });
    const second = controller.acquireBlock({ reason: 'input', channels: ['gameplay-input'] });
    expect(gameplay.state()).toBe('running');
    expect(gameplay.input.enabled).toBe(false);
    expect(gameplay.input.keyboard.enabled).toBe(false);
    first.release();
    expect(resetInput).toHaveBeenCalledTimes(1);
    second.release();
    expect(gameplay.input.enabled).toBe(true);
    expect(gameplay.input.keyboard.enabled).toBe(true);
    expect(gameplay.input.gamepad.enabled).toBe(false);
    binding.dispose();
  });

  it.each(['paused', 'sleeping', 'stopped'] as const)('does not resume a preexisting %s scene', (initial) => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene(initial);
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState: vi.fn(),
    });
    const block = controller.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    block.release();
    binding.dispose();
    expect(gameplay.state()).toBe(initial);
    expect(gameplay.sys.resume).not.toHaveBeenCalled();
  });

  it('hides rendering without sleep and preserves a preexisting hidden scene and mute', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const audio = audioSink(true);
    gameplay.sys.setVisible(false);
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, audio, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState: vi.fn(),
    });
    const block = controller.acquireBlock({ reason: 'overlay', channels: ['rendering', 'audio'] });
    expect(gameplay.state()).toBe('running');
    block.release();
    expect(gameplay.sys.isVisible()).toBe(false);
    expect(audio.getMuted()).toBe(true);
    expect(audio.setMuted).not.toHaveBeenCalled();
    binding.dispose();
  });

  it('releases input disabled before external sleep when the scene wakes after unblock', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState: vi.fn(),
    });
    const block = controller.acquireBlock({ reason: 'input', channels: ['gameplay-input'] });
    gameplay.sleep();
    block.release();
    expect(gameplay.state()).toBe('sleeping');
    expect(gameplay.sys.resume).not.toHaveBeenCalled();
    gameplay.wake();
    expect(gameplay.input.enabled).toBe(true);
    binding.dispose();
  });

  it('reapplies remaining blocks on an external wake without waking a sleeping scene itself', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene('sleeping');
    const resetInput = vi.fn();
    const block = controller.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput,
      onUnsupportedState: vi.fn(),
    });
    expect(gameplay.state()).toBe('sleeping');
    gameplay.wake();
    expect(gameplay.state()).toBe('paused');
    expect(resetInput).toHaveBeenCalledTimes(1);
    block.release();
    expect(gameplay.state()).toBe('running');
    binding.dispose();
  });

  it('cleans each scene lifetime and scope without destroying the shared controller', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    for (let index = 0; index < 10; index += 1) {
      gameplay.start();
      const scope = { dispose: vi.fn() };
      const binding = bindPhaserGameScene({
        controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
        uiScope: scope, onUnsupportedState: vi.fn(),
      });
      const block = controller.acquireBlock({ reason: 'settings', channels: gameplayChannels });
      gameplay.stop();
      expect(gameplay.listenerCount()).toBe(0);
      expect(scope.dispose).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().status).toBe('active');
      block.release();
      expect(gameplay.state()).toBe('stopped');
      binding.dispose();
      expect(scope.dispose).toHaveBeenCalledTimes(1);
    }
    expect(gameplay.sys.resume).not.toHaveBeenCalled();
  });

  it('never resumes or unmutes in response to controller destruction', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const audio = audioSink();
    const scope = { dispose: vi.fn() };
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, audio, uiScope: scope,
      renderingPolicy: 'visibility', resetInput: vi.fn(), onUnsupportedState: vi.fn(),
    });
    const block = controller.acquireBlock({ reason: 'background', channels: [...gameplayChannels, 'audio'] });
    controller.destroy();
    block.release();
    binding.dispose();
    expect(gameplay.state()).toBe('paused');
    expect(audio.getMuted()).toBe(true);
    expect(gameplay.input.enabled).toBe(false);
    expect(gameplay.listenerCount()).toBe(0);
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });

  it('restores owned audio and input at scene shutdown without resuming a stopped scene', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const audio = audioSink();
    bindPhaserGameScene({
      controller, scene: gameplay.scene, audio,
      renderingPolicy: 'visibility', resetInput: vi.fn(), onUnsupportedState: vi.fn(),
    });
    controller.acquireBlock({ reason: 'operation', channels: [...gameplayChannels, 'audio'] });
    gameplay.stop();
    expect(audio.getMuted()).toBe(false);
    expect(gameplay.input.enabled).toBe(true);
    expect(gameplay.state()).toBe('stopped');
  });

  it('handles reset failures and reentrant disposal without applying stale engine commands', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const onError = vi.fn();
    const resetInput = vi.fn<() => void>(() => {
      throw new Error('input reset'); });
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput, onError,
      onUnsupportedState: vi.fn(),
    });
    const first = controller.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(gameplay.state()).toBe('paused');
    first.release();
    resetInput.mockImplementation(() => {
      binding.dispose(); });
    controller.acquireBlock({ reason: 'settings', channels: gameplayChannels });
    expect(gameplay.state()).toBe('running');
    expect(gameplay.input.enabled).toBe(true);
  });

  it('reports unsupported channel combinations explicitly', () => {
    const controller = createGameExecutionController();
    const gameplay = fakeScene();
    const onUnsupportedState = vi.fn();
    const binding = bindPhaserGameScene({
      controller, scene: gameplay.scene, renderingPolicy: 'visibility', resetInput: vi.fn(),
      onUnsupportedState,
    });
    const simulation = controller.acquireBlock({ reason: 'simulation', channels: ['simulation'] });
    expect(onUnsupportedState).toHaveBeenLastCalledWith(controller.getSnapshot(), 'simulation-requires-input-block');
    expect(gameplay.state()).toBe('running');
    simulation.release();
    controller.acquireBlock({ reason: 'audio', channels: ['audio'] });
    expect(onUnsupportedState).toHaveBeenLastCalledWith(controller.getSnapshot(), 'audio-sink-missing');
    binding.dispose();
  });
});
