import { describe, expect, it, vi } from 'vitest';

const { requestExpandedMode, showShareSheet } = vi.hoisted(() => ({
  requestExpandedMode: vi.fn<
    (event: MouseEvent, entry: string) => void | Promise<void>
  >(),
  showShareSheet: vi.fn<(options: {
    readonly data?: string;
    readonly title?: string;
    readonly text?: string;
  }) => Promise<void>>(),
}));

vi.mock('@devvit/web/client', () => ({
  getWebViewMode: () => 'inline',
  requestExpandedMode,
  showShareSheet,
}));

import { presentDevvitShareSheet, requestDevvitExpandedMode } from './web';

describe('requestDevvitExpandedMode', () => {
  it('normalizes the current synchronous Devvit request to a promise', async () => {
    const event = {} as MouseEvent;
    requestExpandedMode.mockReturnValueOnce(undefined);

    await expect(requestDevvitExpandedMode(event, 'game')).resolves.toBeUndefined();
    expect(requestExpandedMode).toHaveBeenCalledWith(event, 'game');
  });

  it('preserves asynchronous Devvit request failures', async () => {
    const failure = new Error('expanded mode rejected');
    requestExpandedMode.mockRejectedValueOnce(failure);

    await expect(requestDevvitExpandedMode({} as MouseEvent, 'game')).rejects.toBe(failure);
  });
});

describe('presentDevvitShareSheet', () => {
  it('reports presentation without claiming share completion', async () => {
    showShareSheet.mockResolvedValueOnce(undefined);

    await expect(
      presentDevvitShareSheet({
        data: 'challenge=abc',
        title: 'Challenge',
        text: 'Try this challenge',
      }),
    ).resolves.toEqual({
      status: 'shared',
      completion: 'presented',
    });
  });

  it('returns unavailable when Devvit cannot present the share surface', async () => {
    showShareSheet.mockRejectedValueOnce(new Error('share surface unavailable'));

    await expect(presentDevvitShareSheet({ text: 'Try this challenge' })).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('preserves cancellation when the share surface rejects with AbortError', async () => {
    showShareSheet.mockRejectedValueOnce(new DOMException('Share cancelled', 'AbortError'));

    await expect(presentDevvitShareSheet({ text: 'Try this challenge' })).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('recognizes cross-realm AbortError-shaped rejections', async () => {
    showShareSheet.mockRejectedValueOnce({ name: 'AbortError' });

    await expect(presentDevvitShareSheet({ text: 'Try this challenge' })).resolves.toEqual({
      status: 'cancelled',
    });
  });
});
