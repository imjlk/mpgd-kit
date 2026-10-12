import { describe, expect, it, vi } from 'vitest';

const { requestExpandedMode, showShareSheet, purchase } = vi.hoisted(() => ({
  requestExpandedMode: vi.fn<
    (event: MouseEvent, entry: string) => void | Promise<void>
  >(),
  showShareSheet: vi.fn<(options: {
    readonly data?: string;
    readonly title?: string;
    readonly text?: string;
  }) => Promise<void>>(),
  purchase: vi.fn<(skuOrSkus: string | readonly string[]) => Promise<{
    readonly status: number;
    readonly orderId?: string;
    readonly errorCode?: number;
    readonly errorMessage?: string;
  }>>(),
}));

vi.mock('@devvit/web/client', () => ({
  getWebViewMode: () => 'inline',
  requestExpandedMode,
  showShareSheet,
  purchase,
}));

import {
  createDevvitWebPaymentsClient,
  presentDevvitShareSheet,
  requestDevvitExpandedMode,
  startDevvitPreviewWebView,
  startDevvitWebView,
  toDevvitCheckoutResult,
} from './web';

describe('createDevvitWebPaymentsClient', () => {
  it('opens one SKU checkout and maps the Reddit order result', async () => {
    const client = createDevvitWebPaymentsClient();
    purchase.mockResolvedValueOnce({ status: 1, orderId: 'order-1' });

    await expect(client.purchase('coins_100')).resolves.toEqual({
      status: 'completed',
      orderId: 'order-1',
    });
    expect(purchase).toHaveBeenCalledWith('coins_100');
    await expect(client.purchase(' ')).rejects.toThrow(/non-empty SKU/u);
  });

  it('keeps an unfinished or unknown checkout open and never grants', () => {
    expect(toDevvitCheckoutResult({ status: 1 })).toEqual({ status: 'pending' });
    expect(toDevvitCheckoutResult({ status: 'STATUS_SUCCESS', orderId: ' order-2 ' })).toEqual({
      status: 'completed',
      orderId: 'order-2',
    });
    expect(toDevvitCheckoutResult({ status: 0 })).toEqual({
      status: 'cancelled',
      error: { code: 'USER_CANCELLED', storeCode: 'DEVVIT_CHECKOUT_CANCELLED', retryable: false },
    });
    expect(toDevvitCheckoutResult({ status: 2, errorCode: 7, errorMessage: 'declined' })).toEqual({
      status: 'failed',
      error: { code: '7', storeCode: '7', message: 'declined' },
    });
    expect(toDevvitCheckoutResult({ status: 2 })).toEqual({
      status: 'failed',
      error: { code: 'DEVVIT_CHECKOUT_FAILED', storeCode: 'DEVVIT_CHECKOUT_FAILED' },
    });
    expect(toDevvitCheckoutResult({ status: 99, orderId: 'order-3' })).toEqual({
      status: 'pending',
      orderId: 'order-3',
    });
  });
});

describe('startDevvitPreviewWebView', () => {
  it('uses the Devvit client while keeping the inline entry preview-only', async () => {
    const mountInlinePreview = vi.fn();
    const loadExpandedGame = vi.fn();

    await expect(
      startDevvitPreviewWebView({ mountInlinePreview, loadExpandedGame }),
    ).resolves.toEqual({ surface: 'inline-preview' });

    expect(mountInlinePreview).toHaveBeenCalledOnce();
    expect(loadExpandedGame).not.toHaveBeenCalled();
  });
});

describe('startDevvitWebView', () => {
  it('uses the Devvit client view mode and defers inline gameplay', async () => {
    const loadGameplay = vi.fn();
    const result = await startDevvitWebView({
      mountInlineMode: vi.fn(),
      loadGameplay,
    });

    expect(result.mode).toBe('inline');
    expect(loadGameplay).not.toHaveBeenCalled();

    if (result.mode === 'inline') {
      await result.startGameplay();
    }

    expect(loadGameplay).toHaveBeenCalledWith('inline');
  });
});

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
