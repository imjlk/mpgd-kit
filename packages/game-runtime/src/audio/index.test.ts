import { describe, expect, it, vi } from 'vitest';
import { createGameExecutionController } from '../index.js';
import { createFullScreenPresentationScope } from '../presentation/index.js';
import { bindGameAudio } from './index.js';

describe('game-owned audio projection', () => {
  it('keeps background mute after native closure and preserves the initial user mute', () => {
    const execution = createGameExecutionController();
    let muted = false;
    const binding = bindGameAudio({
      execution,
      sink: {
        getMuted: () => muted,
        setMuted: (value) => {
          muted = value;
        },
      },
    });
    const presentation = createFullScreenPresentationScope({ execution });
    const native = presentation.acquire({ kind: 'rewarded', invocationId: 'a' });
    native.markStarted();
    expect(muted).toBe(true);
    const background = execution.acquireBlock({ reason: 'background', channels: ['audio'] });
    native.confirmClosed();
    expect(muted).toBe(true);
    background.release();
    expect(muted).toBe(false);
    binding.dispose();
    muted = true;
    const preMuted = bindGameAudio({
      execution,
      sink: {
        getMuted: () => muted,
        setMuted: (value) => {
          muted = value;
        },
      },
    });
    const block = execution.acquireBlock({ reason: 'native', channels: ['audio'] });
    block.release();
    expect(muted).toBe(true);
    preMuted.dispose();
  });
  it('does not unmute live unknown presentation when the observer or game is disposed', () => {
    const execution = createGameExecutionController();
    let muted = false;
    const setMuted = vi.fn((value: boolean) => {
      muted = value;
    });
    const audio = bindGameAudio({ execution, sink: { getMuted: () => muted, setMuted } });
    const presentation = createFullScreenPresentationScope({ execution });
    const lease = presentation.acquire({ kind: 'interstitial', invocationId: 'unknown' });
    lease.markUnknown();
    audio.dispose();
    expect(muted).toBe(true);
    execution.destroy();
    lease.confirmClosed();
    expect(muted).toBe(true);
    expect(setMuted).toHaveBeenCalledTimes(1);
  });
});
