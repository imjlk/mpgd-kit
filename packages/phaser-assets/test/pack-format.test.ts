import { describe, expect, it } from 'vitest';

import {
  parsePhaserPackEntryPath,
  PHASER_PACK_DELIVERY_FORMAT,
  PHASER_PACK_DELIVERY_VERSION,
  phaserPackMediaTypeForPath,
  validatePhaserPackBuildConfig,
  validatePhaserPackDeliveryManifest,
  type PhaserPackDeliveryManifest,
} from '../src/pack-format.js';

const digest = (character: string): string => character.repeat(64);
const buildConfig = (): unknown => ({
  root: 'assets',
  packs: [
    {
      id: 'shared', revision: '1', delivery: 'files', assets: [{
        kind: 'spritesheet', key: 'pilot', file: 'shared/pilot.png', frameConfig: {
          frameWidth: 64, frameHeight: 64,
        },
      }],
    },
    {
      id: 'grove', revision: '3', dependsOn: ['shared'], delivery: 'zip', assets: [{
        kind: 'atlas', key: 'ground', texture: 'grove/grove.png', atlas: 'grove/grove.json',
      }],
    },
  ],
});
const manifest = (): PhaserPackDeliveryManifest => ({
  format: PHASER_PACK_DELIVERY_FORMAT,
  version: PHASER_PACK_DELIVERY_VERSION,
  packs: [
    {
      packId: 'shared', revision: '1', dependencies: [], delivery: 'files', assets: [{
        assetKey: 'pilot', kind: 'spritesheet', frameConfig: {
          frameWidth: 64, frameHeight: 64,
        }, files: [{
          role: 'texture', mediaType: 'image/png', bytes: 3, sha256: digest('a'), path: 'packs/shared@1/shared/pilot.png',
        }],
      }],
    },
    {
      packId: 'grove', revision: '3', dependencies: [{ packId: 'shared', revision: '1' }], delivery: 'zip',
      assets: [{
        assetKey: 'ground', kind: 'atlas', files: [
          {
            role: 'texture', mediaType: 'image/png', bytes: 4, sha256: digest('b'), path: 'grove/grove.png', method: 'store',
          },
          {
            role: 'atlas', mediaType: 'application/json', bytes: 2, sha256: digest('c'), path: 'grove/grove.json', method: 'deflate',
          },
        ],
      }],
      archive: {
        path: 'packs/grove@3.zip', bytes: 9, sha256: digest('d'), entryCount: 2,
      },
    },
  ],
});

describe('entry paths', () => {
  it('accepts normalized relative paths unchanged', () => {
    expect(parsePhaserPackEntryPath('a/b/c.png')).toBe('a/b/c.png');
    expect(parsePhaserPackEntryPath('c.png')).toBe('c.png');
  });
  it.each([
    '', '/abs.png', 'C:/x.png', 'c\\x.png', 'a/./b.png', 'a/../b.png', 'a//b.png', 'a/b/',
    'a/b\0.png', 'a/b\n.png', 'http:/x.png', 'a/b:c.png', 'cafe\u0301.png',
  ])('rejects unsafe or non-canonical path %j', (path) => {
    expect(() => parsePhaserPackEntryPath(path)).toThrow('path');
  });
});

describe('media types', () => {
  it('maps supported extensions to media types and default methods', () => {
    expect(phaserPackMediaTypeForPath('a/b.PNG')).toEqual({
      mediaType: 'image/png',
      defaultMethod: 'store',
    });
    expect(phaserPackMediaTypeForPath('x.jpeg')).toEqual({
      mediaType: 'image/jpeg',
      defaultMethod: 'store',
    });
    expect(phaserPackMediaTypeForPath('x.webp')).toEqual({
      mediaType: 'image/webp',
      defaultMethod: 'store',
    });
    expect(phaserPackMediaTypeForPath('x.svg')).toEqual({
      mediaType: 'image/svg+xml',
      defaultMethod: 'deflate',
    });
    expect(phaserPackMediaTypeForPath('x.json')).toEqual({
      mediaType: 'application/json',
      defaultMethod: 'deflate',
    });
    expect(phaserPackMediaTypeForPath('x.gif')).toBeNull();
  });
});

describe('build config validation', () => {
  it('accepts a valid config and preserves configured order', () => {
    const validated = validatePhaserPackBuildConfig(buildConfig());
    expect(validated.packs.map((pack) => pack.id)).toEqual(['shared', 'grove']);
    expect(validated.packs[1]!.assets[0]!.kind).toBe('atlas');
  });
  it.each([
    ['missing root', (config: Record<string, unknown>) => {
      delete config.root;
    }],
    ['duplicate pack id', (config: Record<string, unknown>) => {
      config.packs = [...config.packs as object[], {
        ...(config.packs as object[])[1]!, id: 'shared',
      }];
    }],
    ['duplicate asset key', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[0]!;
      pack.assets = [...pack.assets as object[], {
        ...(pack.assets as object[])[0]!, key: 'pilot',
      }];
    }],
    ['duplicate file in one pack', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[0]!;
      (pack.assets as Record<string, unknown>[])[0]!.file = 'shared/other.png';
      pack.assets = [...pack.assets as object[], {
        kind: 'image', key: 'other', file: 'shared/other.png',
      }];
    }],
    ['unknown delivery', (config: Record<string, unknown>) => {
      (config.packs as Record<string, unknown>[])[0]!.delivery = 'tar';
    }],
    ['id with path separators', (config: Record<string, unknown>) => {
      (config.packs as Record<string, unknown>[])[0]!.id = 'a/b';
    }],
    ['revision with separators', (config: Record<string, unknown>) => {
      (config.packs as Record<string, unknown>[])[1]!.revision = 'r@1';
    }],
    ['unknown compression', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[0]!;
      (pack.assets as Record<string, unknown>[])[0]!.compression = 'brotli';
    }],
    ['zip pack without assets', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[1]!;
      pack.assets = [];
    }],
    ['unknown dependency', (config: Record<string, unknown>) => {
      (config.packs as Record<string, unknown>[])[1]!.dependsOn = ['nope'];
    }],
    ['cyclic dependency', (config: Record<string, unknown>) => {
      (config.packs as Record<string, unknown>[])[0]!.dependsOn = ['grove'];
    }],
    ['spritesheet without frame config', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[0]!;
      (pack.assets as Record<string, unknown>[])[0]!.frameConfig = undefined;
    }],
    ['zero frame width', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[0]!;
      ((pack.assets as Record<string, unknown>[])[0]!.frameConfig as Record<string, unknown>).frameWidth = 0;
    }],
    ['escaping file path', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[0]!;
      (pack.assets as Record<string, unknown>[])[0]!.file = '../pilot.png';
    }],
    ['non-NFC file path', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[0]!;
      (pack.assets as Record<string, unknown>[])[0]!.file = 'shared/cafe\u0301.png';
    }],
    ['atlas without atlas file', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[1]!;
      delete (pack.assets as Record<string, unknown>[])[0]!.atlas;
    }],
    ['case-colliding pack ids', (config: Record<string, unknown>) => {
      (config.packs as Record<string, unknown>[])[1]!.id = 'SHARED';
    }],
    ['case-colliding file paths in one pack', (config: Record<string, unknown>) => {
      const pack = (config.packs as Record<string, unknown>[])[0]!;
      pack.assets = [
        ...(pack.assets as object[]),
        { kind: 'image', key: 'upper', file: 'SHARED/other.png' },
        { kind: 'image', key: 'lower', file: 'shared/other.png' },
      ];
    }],
  ])('rejects %s', (_name, mutate) => {
    const config = buildConfig() as Record<string, unknown>;
    mutate(config);
    expect(() => validatePhaserPackBuildConfig(config)).toThrow(/Invalid/u);
  });
});

describe('delivery manifest validation', () => {
  it('accepts a valid mixed manifest unchanged', () => {
    const value = manifest();
    expect(validatePhaserPackDeliveryManifest(value)).toEqual(value);
  });
  it.each([
    ['wrong format id', (value: Record<string, unknown>) => {
      value.format = 'other';
    }],
    ['unsupported version', (value: Record<string, unknown>) => {
      value.version = 2;
    }],
    ['uppercase digest', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      ((pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[])[0]!.sha256 = digest('A');
    }],
    ['short digest', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      ((pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[])[0]!.sha256 = 'abc';
    }],
    ['zero bytes', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      ((pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[])[0]!.bytes = 0;
    }],
    ['missing zip entry method', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      const files = (pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[];
      delete files[0]!.method;
    }],
    ['method on files delivery', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      const files = (pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[];
      files[0]!.method = 'store';
    }],
    ['atlas with missing atlas role', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      const asset = (pack.assets as Record<string, unknown>[])[0]!;
      asset.files = [(asset.files as object[])[0]!];
      pack.archive = {
        ...(pack.archive as Record<string, unknown>), entryCount: 1,
      };
    }],
    ['stale dependency revision', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      (pack.dependencies as Record<string, unknown>[])[0]!.revision = '2';
    }],
    ['unknown dependency', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      (pack.dependencies as Record<string, unknown>[])[0]!.packId = 'nope';
    }],
    ['duplicate entry path in one pack', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      const files = (pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[];
      files[1]!.path = files[0]!.path as string;
    }],
    ['case-colliding entry paths in one pack', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      const files = (pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[];
      files[1]!.path = 'grove/GROVE.PNG';
    }],
    ['duplicate pack id', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      pack.packId = 'shared';
      (pack.dependencies as unknown[]).length = 0;
    }],
    ['case-colliding pack ids', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      pack.packId = 'SHARED';
      (pack.dependencies as unknown[]).length = 0;
      (pack.archive as Record<string, unknown>).path = 'packs/SHARED@3.zip';
    }],
    ['cyclic dependencies', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      pack.dependencies = [{ packId: 'grove', revision: '3' }];
    }],
    ['case-colliding archive paths', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      pack.delivery = 'zip';
      const files = (pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[];
      files[0]!.method = 'store';
      pack.archive = {
        path: 'packs/GROVE@3.zip', bytes: 1, sha256: digest('e'), entryCount: 1,
      };
    }],
    ['zip delivery without archive', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[1]!;
      delete pack.archive;
    }],
    ['files delivery with archive', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      pack.archive = {
        path: 'packs/shared.zip', bytes: 1, sha256: digest('e'), entryCount: 1,
      };
    }],
    ['duplicate archive path', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      pack.delivery = 'zip';
      const files = (pack.assets as Record<string, unknown>[])[0]!.files as Record<string, unknown>[];
      files[0]!.method = 'store';
      pack.archive = {
        path: 'packs/grove@3.zip', bytes: 1, sha256: digest('e'), entryCount: 1,
      };
    }],
    ['spritesheet without frame config', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      delete (pack.assets as Record<string, unknown>[])[0]!.frameConfig;
    }],
    ['frame config on an image', (value: Record<string, unknown>) => {
      const pack = (value.packs as Record<string, unknown>[])[0]!;
      const asset = (pack.assets as Record<string, unknown>[])[0]!;
      asset.kind = 'image';
      asset.files = [(asset.files as object[])[0]!];
    }],
  ])('rejects %s', (_name, mutate) => {
    const value = manifest() as unknown as Record<string, unknown>;
    mutate(value);
    expect(() => validatePhaserPackDeliveryManifest(value)).toThrow(
      /Invalid asset pack delivery manifest/u,
    );
  });
});
