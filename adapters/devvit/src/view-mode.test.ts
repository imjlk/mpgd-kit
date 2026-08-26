import { describe, expect, it, vi } from 'vitest';

import { startDevvitPreviewViewMode, startDevvitViewMode } from './view-mode';

describe('startDevvitPreviewViewMode', () => {
  it('mounts an inline preview without exposing or loading gameplay', async () => {
    const mountInlinePreview = vi.fn();
    const loadExpandedGame = vi.fn();

    await expect(
      startDevvitPreviewViewMode({
        client: { getWebViewMode: () => 'inline' },
        mountInlinePreview,
        loadExpandedGame,
      }),
    ).resolves.toEqual({ surface: 'inline-preview' });

    expect(mountInlinePreview).toHaveBeenCalledOnce();
    expect(loadExpandedGame).not.toHaveBeenCalled();
  });

  it('loads gameplay immediately in expanded mode', async () => {
    const mountInlinePreview = vi.fn();
    const loadExpandedGame = vi.fn();

    await expect(
      startDevvitPreviewViewMode({
        client: { getWebViewMode: () => 'expanded' },
        mountInlinePreview,
        loadExpandedGame,
      }),
    ).resolves.toEqual({ surface: 'expanded-game' });

    expect(mountInlinePreview).not.toHaveBeenCalled();
    expect(loadExpandedGame).toHaveBeenCalledOnce();
  });

  it('uses expanded gameplay as the local-browser fallback', async () => {
    const hostError = new ReferenceError('devvit is not defined');
    const onModeUnavailable = vi.fn();
    const loadExpandedGame = vi.fn();

    await expect(
      startDevvitPreviewViewMode({
        client: {
          getWebViewMode() {
            throw hostError;
          },
        },
        mountInlinePreview: vi.fn(),
        loadExpandedGame,
        onModeUnavailable,
      }),
    ).resolves.toEqual({ surface: 'expanded-game' });

    expect(onModeUnavailable).toHaveBeenCalledWith(hostError);
    expect(loadExpandedGame).toHaveBeenCalledOnce();
  });
});

describe('startDevvitViewMode', () => {
  it('mounts inline mode without loading gameplay eagerly', async () => {
    const mountInlineMode = vi.fn();
    const loadGameplay = vi.fn();

    const result = await startDevvitViewMode({
      client: { getWebViewMode: () => 'inline' },
      mountInlineMode,
      loadGameplay,
    });

    expect(result.mode).toBe('inline');
    expect(mountInlineMode).toHaveBeenCalledOnce();
    expect(loadGameplay).not.toHaveBeenCalled();
  });

  it('loads gameplay in inline mode only after the provided user action', async () => {
    let startGameplay: (() => Promise<void>) | undefined;
    const loadGameplay = vi.fn();

    const result = await startDevvitViewMode({
      client: { getWebViewMode: () => 'inline' },
      mountInlineMode(context) {
        startGameplay = context.startGameplay;
      },
      loadGameplay,
    });

    expect(result.mode).toBe('inline');
    expect(startGameplay).toBeDefined();

    await startGameplay?.();

    expect(loadGameplay).toHaveBeenCalledOnce();
    expect(loadGameplay).toHaveBeenCalledWith('inline');
  });

  it('deduplicates concurrent inline gameplay loads', async () => {
    let resolveLoad: (() => void) | undefined;
    const loadGameplay = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const result = await startDevvitViewMode({
      client: { getWebViewMode: () => 'inline' },
      mountInlineMode: vi.fn(),
      loadGameplay,
    });

    if (result.mode !== 'inline') {
      throw new Error('Expected inline mode.');
    }

    const first = result.startGameplay();
    const second = result.startGameplay();

    expect(first).toBe(second);
    await Promise.resolve();
    expect(loadGameplay).toHaveBeenCalledOnce();

    resolveLoad?.();
    await first;
  });

  it('allows an inline gameplay load to be retried after failure', async () => {
    const failure = new Error('gameplay failed');
    const loadGameplay = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const result = await startDevvitViewMode({
      client: { getWebViewMode: () => 'inline' },
      mountInlineMode: vi.fn(),
      loadGameplay,
    });

    if (result.mode !== 'inline') {
      throw new Error('Expected inline mode.');
    }

    await expect(result.startGameplay()).rejects.toBe(failure);
    await expect(result.startGameplay()).resolves.toBeUndefined();
    expect(loadGameplay).toHaveBeenCalledTimes(2);
  });

  it('loads gameplay immediately in expanded mode', async () => {
    const mountInlineMode = vi.fn();
    const loadGameplay = vi.fn();

    await expect(
      startDevvitViewMode({
        client: { getWebViewMode: () => 'expanded' },
        mountInlineMode,
        loadGameplay,
      }),
    ).resolves.toEqual({ mode: 'expanded' });

    expect(mountInlineMode).not.toHaveBeenCalled();
    expect(loadGameplay).toHaveBeenCalledOnce();
    expect(loadGameplay).toHaveBeenCalledWith('expanded');
  });

  it('uses expanded mode as the local-browser fallback', async () => {
    const hostError = new ReferenceError('devvit is not defined');
    const onModeUnavailable = vi.fn();
    const loadGameplay = vi.fn();

    await expect(
      startDevvitViewMode({
        client: {
          getWebViewMode() {
            throw hostError;
          },
        },
        mountInlineMode: vi.fn(),
        loadGameplay,
        onModeUnavailable,
      }),
    ).resolves.toEqual({ mode: 'expanded' });

    expect(onModeUnavailable).toHaveBeenCalledWith(hostError);
    expect(loadGameplay).toHaveBeenCalledWith('expanded');
  });
});
