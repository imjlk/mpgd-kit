import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import sharp from 'sharp';

import type { PlatformTargetConfig } from '../target/schemas';
import {
  generateTargetIcons,
  verifyExistingTargetIcons,
  verifyGeneratedTargetIcons,
} from './generator';
import { stageNativeIconResources, stageWebIconEvidence } from './staging';

const root = mkdtempSync(join(tmpdir(), 'mpgd-icons-'));

try {
  await testSvgAndTargetMatrix(root);
  await testPngAndOverrides(root);
  await testInvalidInputs(root);
  await testPathEscapes(root);
  console.log('Icon pipeline tests passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function testSvgAndTargetMatrix(parent: string): Promise<void> {
  const gameRoot = join(parent, 'svg-game');
  writeGame(gameRoot, 'assets/icon.svg', simpleSvg('#2563eb'));
  const targets = createTargets(gameRoot);
  const results = await Promise.all(
    Object.entries(targets).map(([targetName, target]) =>
      generateTargetIcons({ gameRoot, targetName, target, profile: 'development' }),
    ),
  );
  const sourceDigests = new Set(results.map((result) => result.manifest.canonicalSource.sha256));

  assert.equal(sourceDigests.size, 1);

  for (const result of results) {
    verifyGeneratedTargetIcons(result);
  }

  const microsoft = requireResult(results, 'microsoft-store');
  const firstDigests = microsoft.manifest.outputs.map((output) => output.sha256);
  const repeated = await generateTargetIcons({
    gameRoot,
    targetName: 'microsoft-store',
    target: requireTarget(targets, 'microsoft-store'),
    profile: 'development',
  });

  assert.deepEqual(
    repeated.manifest.outputs.map((output) => output.sha256),
    firstDigests,
  );

  writeFileSync(join(repeated.outputDir, 'icon-any-192.png'), 'stale');
  await assert.rejects(
    verifyExistingTargetIcons({
      gameRoot,
      targetName: 'microsoft-store',
      target: requireTarget(targets, 'microsoft-store'),
      profile: 'development',
    }),
    /Stale generated icon output/u,
  );
  await generateTargetIcons({
    gameRoot,
    targetName: 'microsoft-store',
    target: requireTarget(targets, 'microsoft-store'),
    profile: 'development',
  });

  const dist = join(gameRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html><head></head><body></body></html>');
  stageWebIconEvidence(repeated, dist);
  const webManifest = JSON.parse(
    await readUtf8(join(dist, 'manifest.webmanifest')),
  ) as { readonly icons: readonly { readonly purpose: string; readonly sizes: string }[] };

  assert.deepEqual(
    new Set(webManifest.icons.map((icon) => icon.purpose)),
    new Set(['any', 'maskable']),
  );
  assert.deepEqual(
    new Set(webManifest.icons.map((icon) => icon.sizes)),
    new Set(['192x192', '512x512']),
  );

  const devvit = requireResult(results, 'reddit');
  const devvitOutput = requireFirstOutput(devvit);
  assert.equal(devvitOutput.width, 1024);
  assert.equal(devvitOutput.height, 1024);

  const ait = requireFirstOutput(requireResult(results, 'ait'));
  assert.equal(ait.width, 600);
  assert.equal(ait.opaque, true);
  await assertOpaque(join(requireResult(results, 'ait').outputDir, 'console-icon-600.png'));

  const ios = requireFirstOutput(requireResult(results, 'ios'));
  assert.equal(ios.width, 1024);
  assert.equal(ios.opaque, true);
  await assertOpaque(join(requireResult(results, 'ios').outputDir, 'AppIcon-1024.png'));

  const android = requireResult(results, 'android');
  const shell = join(gameRoot, 'native-shell');
  const restore = await stageNativeIconResources(android, shell);
  const adaptiveXml = await readUtf8(
    join(shell, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'),
  );

  assert.match(adaptiveXml, /adaptive-icon/u);
  assert.match(adaptiveXml, /ic_launcher_foreground/u);
  restore();
}

async function testPngAndOverrides(parent: string): Promise<void> {
  const gameRoot = join(parent, 'png-game');
  mkdirSync(join(gameRoot, 'assets'), { recursive: true });
  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#dc2626' },
  }).png().toFile(join(gameRoot, 'assets/icon.bin'));
  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#16a34a' },
  }).png().toFile(join(gameRoot, 'assets/maskable.png'));
  writeFileSync(join(gameRoot, 'mpgd.game.json'), `${JSON.stringify({
    brand: {
      appIcon: {
        source: 'assets/icon.bin',
        backgroundColor: '#ffffff',
      },
    },
  })}\n`);
  const target: PlatformTargetConfig = {
    kind: 'web',
    gameApp: '.',
    adapter: 'browser',
    output: 'artifacts/ms',
    icon: {
      profile: 'microsoft-pwa',
      variants: { maskable: 'assets/maskable.png' },
    },
  };
  const first = await generateTargetIcons({
    gameRoot,
    targetName: 'microsoft-store',
    target,
    profile: 'production',
  });
  const maskable = first.manifest.outputs.find((output) => output.purpose === 'maskable');

  assert.ok(maskable);
  assert.equal(maskable.opaque, true);

  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#7c3aed' },
  }).png().toFile(join(gameRoot, 'assets/icon.bin'));
  await assert.rejects(
    verifyExistingTargetIcons({
      gameRoot,
      targetName: 'microsoft-store',
      target,
      profile: 'production',
    }),
    /Generated icons are missing/u,
  );
  const changed = await generateTargetIcons({
    gameRoot,
    targetName: 'microsoft-store',
    target,
    profile: 'production',
  });

  assert.notEqual(changed.manifest.canonicalSource.sha256, first.manifest.canonicalSource.sha256);
  assert.notDeepEqual(
    changed.manifest.outputs.map((output) => output.sha256),
    first.manifest.outputs.map((output) => output.sha256),
  );
}

async function testInvalidInputs(parent: string): Promise<void> {
  const gameRoot = join(parent, 'invalid-game');
  mkdirSync(join(gameRoot, 'assets'), { recursive: true });
  const target = requireTarget(createTargets(gameRoot), 'web-preview');

  await sharp({
    create: { width: 1024, height: 512, channels: 4, background: '#000000' },
  }).png().toFile(join(gameRoot, 'assets/icon.png'));
  writeGameConfig(gameRoot, 'assets/icon.png');
  await assert.rejects(
    generateTargetIcons({
      gameRoot,
      targetName: 'web-preview',
      target,
      profile: 'production',
    }),
    /must be square/u,
  );

  await sharp({
    create: { width: 512, height: 512, channels: 4, background: '#000000' },
  }).png().toFile(join(gameRoot, 'assets/icon.png'));
  await assert.rejects(
    generateTargetIcons({
      gameRoot,
      targetName: 'web-preview',
      target,
      profile: 'production',
    }),
    /at least 1024x1024/u,
  );

  writeFileSync(join(gameRoot, 'assets/icon.png'), 'not an image');
  await assert.rejects(
    generateTargetIcons({
      gameRoot,
      targetName: 'web-preview',
      target,
      profile: 'production',
    }),
    /PNG or SVG/u,
  );

  writeFileSync(join(gameRoot, 'assets/icon.png'), animatedPng());
  await assert.rejects(
    generateTargetIcons({
      gameRoot,
      targetName: 'web-preview',
      target,
      profile: 'production',
    }),
    /Animated or multi-page/u,
  );

  writeFileSync(
    join(gameRoot, 'assets/icon.png'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><image href="https://example.com/icon.png"/></svg>',
  );
  await assert.rejects(
    generateTargetIcons({
      gameRoot,
      targetName: 'web-preview',
      target,
      profile: 'production',
    }),
    /external references/u,
  );
}

async function testPathEscapes(parent: string): Promise<void> {
  const gameRoot = join(parent, 'escape-game');
  const outside = join(parent, 'outside.svg');
  writeFileSync(outside, simpleSvg('#000000'));
  mkdirSync(join(gameRoot, 'assets'), { recursive: true });
  const target = requireTarget(createTargets(gameRoot), 'web-preview');

  writeGameConfig(gameRoot, '../outside.svg');
  await assert.rejects(
    generateTargetIcons({
      gameRoot,
      targetName: 'web-preview',
      target,
      profile: 'production',
    }),
    /escapes the game root/u,
  );

  symlinkSync(outside, join(gameRoot, 'assets/link.svg'));
  writeGameConfig(gameRoot, 'assets/link.svg');
  await assert.rejects(
    generateTargetIcons({
      gameRoot,
      targetName: 'web-preview',
      target,
      profile: 'production',
    }),
    /symlink escapes the game root/u,
  );

  writeFileSync(join(gameRoot, 'assets/icon.svg'), simpleSvg('#ffffff'));
  writeGameConfig(gameRoot, 'assets/icon.svg');
  mkdirSync(join(parent, 'outside-generated'), { recursive: true });
  symlinkSync(join(parent, 'outside-generated'), join(gameRoot, '.mpgd'));
  await assert.rejects(
    generateTargetIcons({
      gameRoot,
      targetName: 'web-preview',
      target,
      profile: 'production',
    }),
    /may not traverse a symlink/u,
  );
}

function createTargets(_gameRoot: string): Record<string, PlatformTargetConfig> {
  return {
    'web-preview': { kind: 'web', gameApp: '.', adapter: 'browser', output: 'artifacts/web' },
    'microsoft-store': { kind: 'web', gameApp: '.', adapter: 'browser', output: 'artifacts/ms' },
    reddit: {
      kind: 'devvit-web',
      gameApp: '.',
      adapter: 'devvit',
      wrapperApp: 'apps/devvit',
      webDir: 'apps/devvit/dist/client',
      artifact: 'devvit',
    },
    ait: {
      kind: 'apps-in-toss',
      gameApp: '.',
      adapter: 'ait',
      wrapperApp: 'apps/ait',
      webDir: 'apps/ait/public/game',
      artifact: '.ait',
    },
    android: {
      kind: 'capacitor-android',
      gameApp: '.',
      adapter: 'capacitor',
      shellApp: 'apps/mobile',
      webDir: 'apps/mobile/www',
      artifact: 'aab',
    },
    ios: {
      kind: 'capacitor-ios',
      gameApp: '.',
      adapter: 'capacitor',
      shellApp: 'apps/mobile',
      webDir: 'apps/mobile/www',
      artifact: 'ipa',
    },
  };
}

function writeGame(gameRoot: string, source: string, contents: string): void {
  const sourcePath = join(gameRoot, source);
  mkdirSync(join(sourcePath, '..'), { recursive: true });
  writeFileSync(sourcePath, contents);
  writeGameConfig(gameRoot, source);
  mkdirSync(join(gameRoot, 'public'), { recursive: true });
  writeFileSync(
    join(gameRoot, 'public/manifest.webmanifest'),
    JSON.stringify({
      name: 'Fixture',
      short_name: 'Fixture',
      description: 'Fixture game',
      start_url: './',
      scope: './',
      display: 'standalone',
    }),
  );
}

function writeGameConfig(gameRoot: string, source: string): void {
  mkdirSync(gameRoot, { recursive: true });
  writeFileSync(join(gameRoot, 'mpgd.game.json'), `${JSON.stringify({
    brand: { appIcon: { source, backgroundColor: '#ffffff' } },
  })}\n`);
}

function simpleSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${color}"/><circle cx="512" cy="512" r="256" fill="#ffffff"/></svg>`;
}

function requireResult(
  results: readonly Awaited<ReturnType<typeof generateTargetIcons>>[],
  target: string,
): Awaited<ReturnType<typeof generateTargetIcons>> {
  const result = results.find((candidate) => candidate.target === target);
  assert.ok(result);
  return result;
}

function requireTarget(
  targets: Record<string, PlatformTargetConfig>,
  target: string,
): PlatformTargetConfig {
  const config = targets[target];
  assert.ok(config);
  return config;
}

function requireFirstOutput(
  result: Awaited<ReturnType<typeof generateTargetIcons>>,
): Awaited<ReturnType<typeof generateTargetIcons>>['manifest']['outputs'][number] {
  const output = result.manifest.outputs[0];
  assert.ok(output);
  return output;
}

async function readUtf8(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

async function assertOpaque(path: string): Promise<void> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });

  for (let index = info.channels - 1; index < data.length; index += info.channels) {
    assert.equal(data[index], 255, `${path} contains a non-opaque pixel.`);
  }
}

function animatedPng(): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(2, 0);
  const firstControl = frameControl(0);
  const secondControl = frameControl(1);
  const firstFrame = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  const secondFrameData = deflateSync(Buffer.from([0, 0, 0, 255, 255]));
  const secondFrame = Buffer.alloc(secondFrameData.length + 4);
  secondFrame.writeUInt32BE(2, 0);
  secondFrameData.copy(secondFrame, 4);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('acTL', animationControl),
    pngChunk('fcTL', firstControl),
    pngChunk('IDAT', firstFrame),
    pngChunk('fcTL', secondControl),
    pngChunk('fdAT', secondFrame),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function frameControl(sequence: number): Buffer {
  const control = Buffer.alloc(26);
  control.writeUInt32BE(sequence, 0);
  control.writeUInt32BE(1, 4);
  control.writeUInt32BE(1, 8);
  control.writeUInt16BE(1, 20);
  control.writeUInt16BE(10, 22);
  return control;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;

  for (const byte of input) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}
