import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MiniGameTargetConfig } from './schemas';

export const wechatStagingAppId = 'wx0000000000000000';

export interface WriteWechatMiniGameProjectFilesInput {
  readonly artifactRoot: string;
  readonly targetName: string;
  readonly orientation: MiniGameTargetConfig['orientation'];
  readonly appId: string;
  readonly production: boolean;
}

export function writeWechatMiniGameProjectFiles(
  input: WriteWechatMiniGameProjectFilesInput,
): void {
  assertWechatAppId(input.appId, input.production);
  mkdirSync(input.artifactRoot, { recursive: true });
  writeFileSync(
    join(input.artifactRoot, 'game.js'),
    "require('./runtime.js');\nrequire('./game.bundle.js');\n",
  );
  writeJson(join(input.artifactRoot, 'game.json'), {
    deviceOrientation: input.orientation,
  });
  writeJson(join(input.artifactRoot, 'project.config.json'), {
    description: 'Experimental mpgd Phaser Canvas Mini Game validation build.',
    setting: {
      urlCheck: input.production,
      es6: true,
      postcss: false,
      minified: true,
      newFeature: true,
      uploadWithSourceMap: false,
    },
    compileType: 'game',
    appid: input.appId,
    projectname: input.targetName,
    simulatorType: 'wechat',
  });
}

export function assertWechatAppId(appId: string, production: boolean): void {
  if (
    production
    && (appId === wechatStagingAppId || !/^wx[0-9a-f]{16}$/iu.test(appId))
  ) {
    throw new Error('Production WeChat Mini Game builds require MPGD_WECHAT_APP_ID.');
  }

  if (!production && appId !== wechatStagingAppId && !/^wx[0-9a-f]{16}$/iu.test(appId)) {
    throw new Error('WeChat Mini Game app id must be a valid AppID or the staging placeholder.');
  }
}

function writeJson(path: string, input: unknown): void {
  writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`);
}
