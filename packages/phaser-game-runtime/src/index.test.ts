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
