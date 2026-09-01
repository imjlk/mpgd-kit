import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertWechatAppId,
  wechatStagingAppId,
  writeWechatMiniGameProjectFiles,
} from './minigame-project-files';

const root = mkdtempSync(join(tmpdir(), 'mpgd-wechat-project-'));

try {
  writeWechatMiniGameProjectFiles({
    artifactRoot: root,
    targetName: 'wechat',
    orientation: 'landscape',
    appId: wechatStagingAppId,
    production: false,
  });

  assert.equal(
    readFileSync(join(root, 'game.js'), 'utf8'),
    "require('./runtime.js');\nrequire('./game.bundle.js');\n",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'game.json'), 'utf8')), {
    deviceOrientation: 'landscape',
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'project.config.json'), 'utf8')), {
    description: 'Experimental mpgd Phaser Canvas Mini Game validation build.',
    setting: {
      urlCheck: false,
      es6: true,
      postcss: false,
      minified: true,
      newFeature: true,
      uploadWithSourceMap: false,
    },
    compileType: 'game',
    appid: wechatStagingAppId,
    projectname: 'wechat',
    simulatorType: 'wechat',
  });
  assert.doesNotThrow(() => assertWechatAppId('wx0123456789abcdef', true));
  assert.throws(() => assertWechatAppId(wechatStagingAppId, true), /require MPGD_WECHAT_APP_ID/u);
  assert.throws(() => assertWechatAppId('WX0123456789ABCDEF', true), /require MPGD_WECHAT_APP_ID/u);
  assert.throws(() => assertWechatAppId('placeholder', false), /valid AppID/u);
} finally {
  rmSync(root, { force: true, recursive: true });
}

console.log('WeChat Mini Game project file tests passed.');
