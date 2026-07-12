import { describe, expect, it, vi } from 'vitest';

const { requestExpandedMode } = vi.hoisted(() => ({
  requestExpandedMode: vi.fn<
    (event: MouseEvent, entry: string) => void | Promise<void>
  >(),
}));

vi.mock('@devvit/web/client', () => ({
  getWebViewMode: () => 'inline',
  requestExpandedMode,
}));

import { requestDevvitExpandedMode } from './web';

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
