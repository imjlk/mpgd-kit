import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env.MPGD_RUN_WECHAT_DEVTOOL !== '1') {
  console.log('WeChat DevTools smoke skipped; set MPGD_RUN_WECHAT_DEVTOOL=1 to opt in.');
} else {
  process.env.MPGD_PLATFORM_TARGETS_FILE ??= 'examples/phaser-starter/mpgd.targets.json';
  const { verifyTargetArtifacts } = await import('./verify-target-artifacts');
  verifyTargetArtifacts(['wechat']);
  const cli = resolveWechatDevtoolCli();
  const artifactRoot = resolve('examples/phaser-starter/artifacts/wechat');
  const result = spawnSync(cli, ['open', '--project', artifactRoot], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`WeChat DevTools CLI smoke failed with exit code ${String(result.status)}.`);
  }
}

function resolveWechatDevtoolCli(): string {
  const configured = process.env.MPGD_WECHAT_DEVTOOL_CLI?.trim();
  const candidates = [
    ...(configured === undefined || configured.length === 0 ? [] : [configured]),
    ...(process.platform === 'darwin'
      ? ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli']
      : []),
  ];

  for (const candidate of candidates) {
    const path = resolve(candidate);

    if (!existsSync(path)) {
      continue;
    }

    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {
      // Continue to the explicit install guidance below.
    }
  }

  throw new Error(
    'WeChat DevTools CLI was not found. Install WeChat DevTools and set '
      + 'MPGD_WECHAT_DEVTOOL_CLI to its official cli executable.',
  );
}
