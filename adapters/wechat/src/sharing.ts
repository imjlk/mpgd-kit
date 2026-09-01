import { PlatformOperationError, type ShareAdapter, type ShareIntent } from '@mpgd/platform';

import type { WechatMiniGameApi, WechatMiniGameShareOptions } from './api.js';

export function createWechatSharingAdapter(api: WechatMiniGameApi): ShareAdapter | undefined {
  if (api.shareAppMessage === undefined) {
    return undefined;
  }

  return {
    async share(intent) {
      const options = createWechatShareOptions(intent);

      try {
        api.shareAppMessage?.(options);
      } catch {
        throw new PlatformOperationError({
          code: 'WECHAT_SHARE_PRESENTATION_FAILED',
          message: 'Failed to present the WeChat Mini Game share surface.',
          retryable: true,
        });
      }

      return {
        status: 'shared',
        completion: 'presented',
      };
    },
  };
}

export function createWechatShareOptions(intent: ShareIntent): WechatMiniGameShareOptions {
  const query = createShareQuery(intent);

  return {
    title: intent.title,
    ...(query.length === 0 ? {} : { query }),
    ...(intent.previewImageUrl === undefined ? {} : { imageUrl: intent.previewImageUrl }),
  };
}

function createShareQuery(intent: ShareIntent): string {
  const values: Array<readonly [string, string]> = [['kind', intent.kind]];

  if (intent.payload?.puzzleId !== undefined) {
    values.push(['puzzleId', intent.payload.puzzleId]);
  }
  if (intent.payload?.challengeToken !== undefined) {
    values.push(['challengeToken', intent.payload.challengeToken]);
  }

  return values
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}
