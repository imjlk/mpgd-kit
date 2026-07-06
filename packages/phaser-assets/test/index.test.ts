import { describe, expect, it } from 'vitest';

import { definePhaserAssetManifest } from '../src/index';

describe('phaser asset manifest helpers', () => {
  it('preserves valid manifests', () => {
    const manifest = definePhaserAssetManifest([
      {
        kind: 'image',
        key: 'demo.marker',
        url: new URL('../fixtures/marker.svg', import.meta.url).href,
      },
      {
        kind: 'json',
        key: 'demo.config',
        url: new URL('../fixtures/config.json', import.meta.url).href,
      },
    ] as const);

    expect(manifest[0]?.key).toBe('demo.marker');
    expect(manifest[0]?.url).toContain('/fixtures/marker.svg');
  });

  it('rejects duplicate asset keys early', () => {
    expect(() => {
      definePhaserAssetManifest([
        {
          kind: 'image',
          key: 'demo.marker',
          url: 'marker-a.svg',
        },
        {
          kind: 'image',
          key: 'demo.marker',
          url: 'marker-b.svg',
        },
      ] as const);
    }).toThrow('Duplicate Phaser asset key: demo.marker');
  });
});
