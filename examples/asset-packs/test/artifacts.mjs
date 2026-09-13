import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

export async function auditArtifacts(outputRoot = join(root, 'dist')) {
  const reports = [];
  for (const mode of ['bundled', 'hybrid']) {
    const directory = join(outputRoot, mode);
    const report = JSON.parse(await readFile(join(directory, 'asset-pack-report.json'), 'utf8'));
    const payloadFiles = await files(join(directory, 'packs'));
    const expectedFiles = report.packs.filter((pack) => mode === 'bundled' || pack.id === 'shared').flatMap((pack) => pack.images.map((image) => join(directory, image.path)));
    assert.deepEqual(payloadFiles.sort(), expectedFiles.sort(), 'Actual packaged files must follow the selected policy');
    let packagedBytes = 0;
    const gameHashes = new Set(await Promise.all((await files(directory)).map(async (file) => createHash('sha256').update(await readFile(file)).digest('hex'))));
    for (const pack of report.packs) {
      const packaged = mode === 'bundled' || pack.id === 'shared';
      assert.equal(pack.packaged, packaged);
      for (const image of pack.images) {
        const location = packaged ? join(directory, image.path) : join(root, 'artifacts/origin', image.path);
        const bytes = await readFile(location);
        assert.equal(bytes.length, image.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
        if (packaged) packagedBytes += bytes.length;
        else assert.equal(gameHashes.has(image.sha256), false, 'A remote-only payload must not be copied elsewhere in the game artifact');
      }
    }
    assert.equal(report.packagedAssetBytes, packagedBytes);
    reports.push(report);
  }
  assert.ok(reports[1].packagedAssetBytes < reports[0].packagedAssetBytes);
  return reports;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reports = await auditArtifacts();
  console.log(JSON.stringify(reports.map(({ mode, packagedAssetBytes }) => ({ mode, packagedAssetBytes })), null, 2));
}
