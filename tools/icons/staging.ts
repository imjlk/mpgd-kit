import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import sharp from 'sharp';

import type { GeneratedTargetIcons, IconManifestOutput } from './types';

export function stageWebIconEvidence(result: GeneratedTargetIcons, gameDist: string): void {
  const iconDir = join(gameDist, 'icons');

  mkdirSync(iconDir, { recursive: true });
  copyFileSync(result.manifestPath, join(gameDist, 'mpgd-icon-manifest.json'));

  for (const output of result.manifest.outputs) {
    copyFileSync(cacheOutputPath(result, output), join(gameDist, output.path));
  }

  writeFileSync(
    join(gameDist, 'mpgd-icon-precache.json'),
    `${JSON.stringify(result.manifest.outputs.map((output) => `./${output.path}`), null, 2)}\n`,
  );

  if (result.profile.id === 'web-preview' || result.profile.id === 'microsoft-pwa') {
    stageWebManifest(result, gameDist);
    stageFaviconLink(result, gameDist);
  }
}

export function stageWrapperIcon(result: GeneratedTargetIcons, wrapperApp: string): void {
  const generatedDir = join(wrapperApp, 'generated');

  if (existsSync(generatedDir) && lstatSync(generatedDir).isSymbolicLink()) {
    throw new Error(`Wrapper icon staging directory may not be a symlink: ${generatedDir}`);
  }

  if (result.profile.id === 'devvit') {
    const output = requireOutput(result, 'app-icon');
    copyGeneratedFile(result, output, join(wrapperApp, 'generated/marketing-icon.png'));
    return;
  }

  if (result.profile.id === 'ait') {
    const output = requireOutput(result, 'console-icon');
    copyGeneratedFile(result, output, join(wrapperApp, 'generated/console-icon.png'));
  }
}

export async function stageNativeIconResources(
  result: GeneratedTargetIcons,
  shellApp: string,
): Promise<() => void> {
  const snapshots = new Map<string, Buffer | undefined>();
  const write = (path: string, contents: Buffer | string): void => {
    if (!snapshots.has(path)) {
      snapshots.set(path, existsSync(path) ? readFileSync(path) : undefined);
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };

  if (result.profile.id === 'android-adaptive') {
    await stageAndroid(result, shellApp, write);
  } else if (result.profile.id === 'ios-app-icon') {
    stageIos(result, shellApp, write);
  }

  return () => {
    for (const [path, contents] of [...snapshots.entries()].reverse()) {
      if (contents === undefined) {
        rmSync(path, { force: true });
      } else {
        writeFileSync(path, contents);
      }
    }
  };
}

async function stageAndroid(
  result: GeneratedTargetIcons,
  shellApp: string,
  write: (path: string, contents: Buffer | string) => void,
): Promise<void> {
  const res = join(shellApp, 'android/app/src/main/res');
  const foreground = cacheOutputPath(result, requireOutput(result, 'adaptive-foreground'));
  const background = cacheOutputPath(result, requireOutput(result, 'adaptive-background'));
  const monochrome = result.manifest.outputs.find(
    (output) => output.purpose === 'adaptive-monochrome',
  );
  const densities = [
    ['mdpi', 108, 48],
    ['hdpi', 162, 72],
    ['xhdpi', 216, 96],
    ['xxhdpi', 324, 144],
    ['xxxhdpi', 432, 192],
  ] as const;

  for (const [density, adaptiveSize, legacySize] of densities) {
    const dir = join(res, `mipmap-${density}`);
    const legacy = requireOutput(result, `legacy`, legacySize);
    const foregroundBytes = await resizePng(foreground, adaptiveSize);
    const backgroundBytes = await resizePng(background, adaptiveSize);

    write(join(dir, 'ic_launcher_foreground.png'), foregroundBytes);
    write(join(dir, 'ic_launcher_background.png'), backgroundBytes);
    write(join(dir, 'ic_launcher.png'), readFileSync(cacheOutputPath(result, legacy)));
    write(join(dir, 'ic_launcher_round.png'), readFileSync(cacheOutputPath(result, legacy)));

    if (monochrome !== undefined) {
      write(
        join(dir, 'ic_launcher_monochrome.png'),
        await resizePng(cacheOutputPath(result, monochrome), adaptiveSize),
      );
    }
  }

  const adaptiveXml = androidAdaptiveXml(monochrome !== undefined);
  write(join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), adaptiveXml);
  write(join(res, 'mipmap-anydpi-v26/ic_launcher_round.xml'), adaptiveXml);
}

function stageIos(
  result: GeneratedTargetIcons,
  shellApp: string,
  write: (path: string, contents: Buffer | string) => void,
): void {
  const appIconDir = join(shellApp, 'ios/App/App/Assets.xcassets/AppIcon.appiconset');
  const output = requireOutput(result, 'app-icon');

  write(join(appIconDir, 'AppIcon-512@2x.png'), readFileSync(cacheOutputPath(result, output)));
  write(join(appIconDir, 'Contents.json'), `${JSON.stringify({
    images: [{
      filename: 'AppIcon-512@2x.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    }],
    info: { author: 'xcode', version: 1 },
  }, null, 2)}\n`);
}

function stageWebManifest(result: GeneratedTargetIcons, gameDist: string): void {
  const sourcePath = join(result.gameRoot, 'public/manifest.webmanifest');
  const manifest = existsSync(sourcePath)
    ? JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>
    : {
        name: basename(result.gameRoot),
        short_name: basename(result.gameRoot),
        start_url: './',
        display: 'standalone',
      };

  manifest.icons = result.manifest.outputs
    .filter((output) => output.width >= 192)
    .map((output) => ({
      src: `./${output.path}`,
      sizes: `${output.width}x${output.height}`,
      type: 'image/png',
      purpose: output.purpose === 'maskable' ? 'maskable' : 'any',
    }));
  writeFileSync(join(gameDist, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function stageFaviconLink(result: GeneratedTargetIcons, gameDist: string): void {
  const favicon = result.manifest.outputs.find((output) => output.purpose === 'favicon')
    ?? result.manifest.outputs.find((output) => output.width === 192);
  const indexPath = join(gameDist, 'index.html');

  if (favicon === undefined || !existsSync(indexPath)) {
    return;
  }

  const html = readFileSync(indexPath, 'utf8');
  const link = `<link rel="icon" type="image/png" href="./${favicon.path}">`;

  if (!html.includes(link)) {
    writeFileSync(indexPath, html.replace('</head>', `  ${link}\n</head>`));
  }
}

function androidAdaptiveXml(hasMonochrome: boolean): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>${hasMonochrome ? '\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>' : ''}
</adaptive-icon>
`;
}

async function resizePng(path: string, size: number): Promise<Buffer> {
  return sharp(path).resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, effort: 10 }).toBuffer();
}

function cacheOutputPath(result: GeneratedTargetIcons, output: IconManifestOutput): string {
  return resolve(result.outputDir, basename(output.path));
}

function copyGeneratedFile(
  result: GeneratedTargetIcons,
  output: IconManifestOutput,
  destination: string,
): void {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(cacheOutputPath(result, output), destination);
}

function requireOutput(
  result: GeneratedTargetIcons,
  purpose: string,
  width?: number,
): IconManifestOutput {
  const output = result.manifest.outputs.find(
    (candidate) => candidate.purpose === purpose && (width === undefined || candidate.width === width),
  );

  if (output === undefined) {
    throw new Error(
      `Missing generated ${purpose}${width === undefined ? '' : ` ${width}px`} icon.`,
    );
  }

  return output;
}
