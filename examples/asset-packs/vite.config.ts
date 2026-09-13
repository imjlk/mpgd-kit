import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

import type { AssetPack } from './src/packs.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const sources = [
  { id: 'shared', dependsOn: [], image: { id: 'pilot', file: 'pilot.svg', width: 32, height: 32 } },
  { id: 'grove', dependsOn: ['shared'], image: { id: 'ground', file: 'grove.svg', width: 160, height: 96 } },
  { id: 'dunes', dependsOn: ['shared'], image: { id: 'ground', file: 'dunes.svg', width: 160, height: 96 } },
];

export default defineConfig(({ mode }) => {
  const hybrid = mode === 'hybrid';
  const origin = new URL(process.env.ASSET_PACK_REMOTE_ORIGIN ?? 'http://127.0.0.1:5196/');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
  if (!(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback)) ||
      origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Asset origin requires HTTPS (or loopback HTTP), without credentials, query or fragment.');
  }
  if (!origin.pathname.endsWith('/')) origin.pathname += '/';
  const payloads = new Map<string, Buffer>();
  const catalog: AssetPack[] = sources.map((pack) => {
    const bytes = readFileSync(join(root, 'asset-source', pack.image.file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const revision = createHash('sha256').update(JSON.stringify({ ...pack, sha256 })).digest('hex');
    const path = `packs/${pack.id}/${revision}/${pack.image.file}`;
    payloads.set(path, bytes);
    return {
      id: pack.id, revision, dependsOn: pack.dependsOn,
      images: [{ id: pack.image.id, width: pack.image.width, height: pack.image.height, path, sha256, bytes: bytes.length }],
    };
  });
  const packaged = (id: string): boolean => !hybrid || id === 'shared';
  const report = {
    mode: hybrid ? 'hybrid' : 'bundled', remoteOrigin: origin.href,
    // Encoded file bytes, NOT measured wire traffic or process/GPU memory.
    packagedAssetBytes: catalog.filter((pack) => packaged(pack.id)).reduce((sum, pack) => sum + pack.images.reduce((n, image) => n + image.bytes, 0), 0),
    packs: catalog.map((pack) => ({ ...pack, packaged: packaged(pack.id),
      rgbaEstimate: pack.images.reduce((sum, image) => sum + image.width * image.height * 4, 0) })),
  };
  const plugin: Plugin = {
    name: 'private-asset-pack-sample',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1);
        if (!path.startsWith('packs/')) return next();
        const allowed = catalog.some((pack) => packaged(pack.id) && pack.images.some((image) => image.path === path));
        const bytes = allowed ? payloads.get(path) : undefined;
        response.statusCode = bytes ? 200 : 404;
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(bytes);
      });
    },
    generateBundle() {
      for (const pack of catalog.filter((entry) => packaged(entry.id))) {
        for (const image of pack.images) this.emitFile({ type: 'asset', fileName: image.path, source: payloads.get(image.path)! });
      }
      this.emitFile({ type: 'asset', fileName: 'asset-pack-report.json', source: JSON.stringify(report, null, 2) });
    },
    writeBundle() {
      if (!hybrid) return;
      // A separate, append-only local origin fixture. Never put remote packs in public/.
      for (const pack of catalog.filter((entry) => !packaged(entry.id))) {
        for (const image of pack.images) {
          const destination = join(root, 'artifacts/origin', image.path);
          const bytes = payloads.get(image.path)!;
          mkdirSync(dirname(destination), { recursive: true });
          if (existsSync(destination)) {
            if (!readFileSync(destination).equals(bytes)) throw new Error('Existing immutable revision has different bytes');
          } else writeFileSync(destination, bytes, { flag: 'wx' });
        }
      }
    },
  };
  return {
    root, base: './', publicDir: false,
    build: { outDir: join(root, 'dist', hybrid ? 'hybrid' : 'bundled'), emptyOutDir: true },
    plugins: [plugin],
    resolve: { alias: { '@mpgd/phaser-assets': fileURLToPath(new URL('../../packages/phaser-assets/src/index.ts', import.meta.url)) } },
    define: {
      __ASSET_PACK_CATALOG__: JSON.stringify(catalog),
      __ASSET_PACK_MODE__: JSON.stringify(report.mode),
      __ASSET_PACK_ORIGIN__: JSON.stringify(origin.href),
    },
  };
});
