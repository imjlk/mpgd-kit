import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import type { DeliveryPack } from './src/packs.js';
import type { PhaserPackAsset } from '@mpgd/phaser-assets/packs';

const root = fileURLToPath(new URL('.', import.meta.url));
/** Workspace subpaths the example consumes from package source, so a
 * fresh checkout builds without a prior package build step. */
const PHASER_ASSETS_SUBPATHS = [
  'packs',
  'pack-format',
  'archives',
  'delivery',
  'test-utils',
  'archive-worker',
] as const;
const sources = [
  {
    id: 'shared',
    dependsOn: [],
    files: [{ name: 'pilot.png', width: 256, height: 64, mediaType: 'image/png' }],
  },
  {
    id: 'grove',
    dependsOn: ['shared'],
    files: [
      { name: 'grove.png', width: 2048, height: 1024, mediaType: 'image/png' },
      { name: 'grove.json', width: 0, height: 0, mediaType: 'application/json' },
    ],
  },
  {
    id: 'dunes',
    dependsOn: ['shared'],
    files: [{ name: 'dunes.png', width: 1024, height: 1024, mediaType: 'image/png' }],
  },
];
export default defineConfig(({ mode }) => {
  const hybrid = mode === 'hybrid';
  const origin = new URL(process.env.ASSET_PACK_REMOTE_ORIGIN ?? 'http://127.0.0.1:5196/');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
  if (!(origin.protocol === 'https:' || origin.protocol === 'http:' && loopback) || origin.username || origin.password || origin.search || origin.hash) throw new Error('Asset origin requires HTTPS (or loopback HTTP), without credentials, query or fragment.');
  if (!origin.pathname.endsWith('/')) origin.pathname += '/';
  const payloads = new Map<string, Buffer>();
  const catalog: DeliveryPack[] = sources.map((source) => {
    const input = source.files.map((file) => {
      const bytes = readFileSync(join(root, 'asset-source', file.name));
      return { ...file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const revision = createHash('sha256').update(JSON.stringify(input.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length })))).digest('hex');
    const files = input.map(({ name, bytes, ...file }) => {
      const path = `packs/${source.id}/${revision}/${name}`;
      payloads.set(path, bytes);
      return { ...file, path, bytes: bytes.length };
    });
    const png = files.filter((file) => file.mediaType === 'image/png');
    const json = files.filter((file) => file.mediaType === 'application/json');
    const image = png[0];
    if (png.length !== 1 || !image || (source.id === 'grove' && json.length !== 1)) throw new Error(`Pack ${source.id} requires one PNG and, for an atlas, one JSON file`);
    const texture = { bytes: image.bytes, sha256: image.sha256 };
    let asset: PhaserPackAsset;
    if (source.id === 'shared') asset = { kind: 'spritesheet', key: 'pilot', url: image.path, frameConfig: { frameWidth: 64, frameHeight: 64 }, integrity: { texture } };
    else if (source.id === 'grove') {
      const atlas = json[0];
      if (!atlas) throw new Error('Missing grove atlas metadata');
      asset = { kind: 'atlas', key: 'ground', textureUrl: image.path, atlasUrl: atlas.path, integrity: { texture, atlas: { bytes: atlas.bytes, sha256: atlas.sha256 } } };
    } else asset = { kind: 'image', key: 'ground', url: image.path, integrity: { texture } };
    return { id: source.id, revision, dependsOn: source.dependsOn, packaged: !hybrid || source.id === 'shared', assets: [asset], files };
  });
  const report = {
    mode: hybrid ? 'hybrid' : 'bundled', remoteOrigin: origin.href,
    packagedAssetBytes: catalog.filter((pack) => pack.packaged).reduce((sum, pack) => sum + pack.files.reduce((n, file) => n + file.bytes, 0), 0),
    packs: catalog.map((pack) => ({ ...pack, rgbaEstimate: pack.files.reduce((sum, file) => sum + file.width * file.height * 4, 0) })),
  };
  const plugin: Plugin = {
    name: 'private-asset-pack-sample',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1);
        if (!path.startsWith('packs/')) return next();
        const file = catalog.flatMap((pack) => pack.packaged ? pack.files : []).find((entry) => entry.path === path);
        response.statusCode = file ? 200 : 404;
        response.setHeader('Content-Type', file?.mediaType ?? 'text/plain');
        response.end(file ? payloads.get(path) : undefined);
      });
    },
    generateBundle() {
      for (const pack of catalog.filter((entry) => entry.packaged)) for (const file of pack.files) this.emitFile({ type: 'asset', fileName: file.path, source: payloads.get(file.path)! });
      this.emitFile({ type: 'asset', fileName: 'asset-pack-report.json', source: JSON.stringify(report, null, 2) });
    },
    writeBundle() {
      if (!hybrid) return;
      for (const pack of catalog.filter((entry) => !entry.packaged)) for (const file of pack.files) {
        const destination = join(root, 'artifacts/origin', file.path);
        const bytes = payloads.get(file.path)!;
        mkdirSync(dirname(destination), { recursive: true });
        if (existsSync(destination)) {
          if (!readFileSync(destination).equals(bytes)) throw new Error('Existing immutable revision has different bytes');
        } else writeFileSync(destination, bytes, { flag: 'wx' });
      }
    },
  };
  return {
    root, base: './', publicDir: false,
    server: { watch: { ignored: ['**/dist/**', '**/artifacts/**'] } },
    build: { outDir: join(root, 'dist', hybrid ? 'hybrid' : 'bundled'), emptyOutDir: true }, plugins: [plugin],
    resolve: { alias: PHASER_ASSETS_SUBPATHS.map((subpath) => ({
      find: new RegExp(`^@mpgd/phaser-assets/${subpath}$`),
      replacement: fileURLToPath(new URL(`../../packages/phaser-assets/src/${subpath}.ts`, import.meta.url)),
    })) },
    define: { __ASSET_PACK_CATALOG__: JSON.stringify(catalog), __ASSET_PACK_MODE__: JSON.stringify(report.mode), __ASSET_PACK_ORIGIN__: JSON.stringify(origin.href) },
  };
});
