import { describe, expect, it, vi } from 'vitest';

import { startDevvitSurface } from './surface';

describe('startDevvitSurface', () => {
  it('mounts only the lightweight preview in inline mode', async () => {
    const mountInlinePreview = vi.fn();
    const loadExpandedGame = vi.fn();

    await expect(
      startDevvitSurface({
        client: { getWebViewMode: () => 'inline' },
        mountInlinePreview,
        loadExpandedGame,
      }),
    ).resolves.toBe('inline-preview');

    expect(mountInlinePreview).toHaveBeenCalledOnce();
    expect(loadExpandedGame).not.toHaveBeenCalled();
  });

  it('loads only the game in expanded mode', async () => {
    const mountInlinePreview = vi.fn();
    const loadExpandedGame = vi.fn();

    await expect(
      startDevvitSurface({
        client: { getWebViewMode: () => 'expanded' },
        mountInlinePreview,
        loadExpandedGame,
      }),
    ).resolves.toBe('expanded-game');

    expect(mountInlinePreview).not.toHaveBeenCalled();
    expect(loadExpandedGame).toHaveBeenCalledOnce();
  });

  it('falls back to the expanded game when no Devvit host is present', async () => {
    const hostError = new ReferenceError('devvit is not defined');
    const onModeUnavailable = vi.fn();
    const loadExpandedGame = vi.fn();

    await expect(
      startDevvitSurface({
        client: {
          getWebViewMode() {
            throw hostError;
          },
        },
        mountInlinePreview: vi.fn(),
        loadExpandedGame,
        onModeUnavailable,
      }),
    ).resolves.toBe('expanded-game');

    expect(onModeUnavailable).toHaveBeenCalledWith(hostError);
    expect(loadExpandedGame).toHaveBeenCalledOnce();
  });

  it('awaits asynchronous inline and expanded loaders', async () => {
    const inlineOrder: string[] = [];
    const expandedOrder: string[] = [];

    await startDevvitSurface({
      client: { getWebViewMode: () => 'inline' },
      async mountInlinePreview() {
        await Promise.resolve();
        inlineOrder.push('mounted');
      },
      loadExpandedGame: vi.fn(),
    });
    await startDevvitSurface({
      client: { getWebViewMode: () => 'expanded' },
      mountInlinePreview: vi.fn(),
      async loadExpandedGame() {
        await Promise.resolve();
        expandedOrder.push('loaded');
      },
    });

    expect(inlineOrder).toEqual(['mounted']);
    expect(expandedOrder).toEqual(['loaded']);
  });
});
