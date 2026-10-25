import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runMpgdCli } from './index.js';
import { admobAppAdsTxtLine, resolveAppAdsTxt } from './legal-site-output.js';

const page = (title: string): string =>
  `<!doctype html>\n<html lang="en"><head><title>${title}</title></head><body><p>${title}</p></body></html>\n`;

function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function writeLegalSources(legalDir: string): void {
  mkdirSync(legalDir, { recursive: true });
  writeFileSync(path.join(legalDir, 'privacy.html'), page('Privacy'));
  writeFileSync(path.join(legalDir, 'support.html'), page('Support'));
  writeFileSync(path.join(legalDir, 'terms.html'), page('Terms'));
}

async function inProject(project: string, run: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  process.chdir(project);
  try {
    await run();
  } finally {
    process.chdir(previous);
  }
}

function outsidePrivacy(outside: string): string {
  return path.join(outside, 'privacy', 'index.html');
}

await test('refuses legal site writes through a symlinked artifacts directory', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-link-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  try {
    writeLegalSources(path.join(project, 'legal'));
    mkdirSync(outside);
    linkDirectory(outside, path.join(project, 'artifacts'));
    await inProject(project, async () => {
      await assert.rejects(
        runMpgdCli(['legal', 'build']),
        /symbolic link|must be inside the project root/u,
      );
    });
    assert.equal(existsSync(outsidePrivacy(outside)), false);
    assert.equal(existsSync(path.join(project, 'artifacts', 'legal-site', 'privacy', 'index.html')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses a legal out-dir whose canonical path leaves the project', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-out-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  try {
    writeLegalSources(path.join(project, 'legal'));
    mkdirSync(outside);
    linkDirectory(outside, path.join(project, 'linked-out'));
    await inProject(project, async () => {
      await assert.rejects(
        runMpgdCli(['legal', 'build', '--out-dir', 'linked-out']),
        /symbolic link|must be inside the project root/u,
      );
    });
    assert.equal(existsSync(outsidePrivacy(outside)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses a legal page file that is a symlink to an outside file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-page-link-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'secret.html');
  const source = path.join(project, 'legal', 'privacy.html');
  try {
    writeLegalSources(path.join(project, 'legal'));
    writeFileSync(outside, page('Outside secret'));
    rmSync(source);
    symlinkSync(outside, source);
    await inProject(project, async () => {
      await assert.rejects(
        runMpgdCli(['legal', 'build', '--out-dir', 'site']),
        /symbolic link|must be inside the project root/u,
      );
    });
    assert.equal(existsSync(path.join(project, 'site', 'privacy', 'index.html')), false);
    assert.equal(readFileSync(outside, 'utf8').includes('Outside secret'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses legal sources reached through a symlink', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-src-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside-legal');
  try {
    writeLegalSources(outside);
    mkdirSync(project);
    linkDirectory(outside, path.join(project, 'legal'));
    await inProject(project, async () => {
      await assert.rejects(
        runMpgdCli(['legal', 'build', '--out-dir', 'site']),
        /symbolic link|must be inside the project root/u,
      );
    });
    assert.equal(existsSync(path.join(project, 'site', 'privacy', 'index.html')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses an in-project symlink component on the legal out-dir', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-inside-link-'));
  const project = path.join(root, 'project');
  const realOut = path.join(project, 'real-out');
  try {
    writeLegalSources(path.join(project, 'legal'));
    mkdirSync(realOut);
    symlinkSync(realOut, path.join(project, 'linked-out'), 'dir');
    await inProject(project, async () => {
      await assert.rejects(
        runMpgdCli(['legal', 'build', '--out-dir', 'linked-out']),
        /symbolic link/u,
      );
    });
    assert.equal(existsSync(path.join(realOut, 'privacy', 'index.html')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('builds a legal site inside the project and replaces it without staging leftovers', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-ok-'));
  const project = path.join(root, 'project');
  try {
    writeLegalSources(path.join(project, 'legal'));
    await inProject(project, async () => {
      await runMpgdCli(['legal', 'build', '--out-dir', 'artifacts/legal-site']);
      await runMpgdCli(['legal', 'check', '--out-dir', 'artifacts/legal-site']);
      const privacy = readPrivacy(project);
      assert.match(privacy, /<title>Privacy<\/title>/u);
      await runMpgdCli(['legal', 'build', '--out-dir', 'artifacts/legal-site']);
      assert.equal(readPrivacy(project), privacy);
    });
    const names = readdirSync(project);
    assert.equal(names.some((name) => name.startsWith('.mpgd-legal-')), false);
    assert.equal(existsSync(path.join(project, 'artifacts', 'legal-site', '_headers')), true);
    assert.equal(existsSync(path.join(project, 'artifacts', 'legal-site', 'legal-site.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('still rejects a legal out-dir that lexically leaves the project', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-lexical-'));
  const project = path.join(root, 'project');
  try {
    writeLegalSources(path.join(project, 'legal'));
    await inProject(project, async () => {
      await assert.rejects(
        runMpgdCli(['legal', 'build', '--out-dir', '../outside']),
        /must be inside the project root/u,
      );
    });
    assert.equal(lstatSync(project).isDirectory(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('stages a new legal site on the destination directory filesystem', async () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-stage-new-'));
  const project = path.join(root, 'project');
  const artifacts = path.join(project, 'artifacts');
  try {
    writeLegalSources(path.join(project, 'legal'));
    mkdirSync(artifacts);
    // The project root cannot accept the old cwd staging directory. A
    // destination ancestor that is a mount would fail the same way with EXDEV.
    chmodSync(project, 0o555);
    await inProject(project, async () => {
      await runMpgdCli(['legal', 'build', '--out-dir', 'artifacts/legal-site']);
    });
    assert.match(readPrivacy(project), /<title>Privacy<\/title>/u);
    assert.equal(existsSync(path.join(project, 'artifacts', 'legal-site', '_headers')), true);
    assert.equal(readdirSync(artifacts).some((name) => name.startsWith('.mpgd-legal-')), false);
  } finally {
    chmodSync(project, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

await test('stages into an existing legal out-dir instead of its parent filesystem', async () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-stage-mount-'));
  const project = path.join(root, 'project');
  const artifacts = path.join(project, 'artifacts');
  const outDir = path.join(artifacts, 'legal-site');
  try {
    writeLegalSources(path.join(project, 'legal'));
    mkdirSync(outDir, { recursive: true });
    chmodSync(artifacts, 0o555);
    chmodSync(project, 0o555);
    await inProject(project, async () => {
      await runMpgdCli(['legal', 'build', '--out-dir', 'artifacts/legal-site']);
    });
    assert.match(
      readFileSync(path.join(outDir, 'privacy', 'index.html'), 'utf8'),
      /<title>Privacy<\/title>/u,
    );
    assert.equal(readdirSync(outDir).some((name) => name.startsWith('.mpgd-legal-')), false);
  } finally {
    chmodSync(project, 0o755);
    chmodSync(artifacts, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

function readPrivacy(project: string): string {
  return readFileSync(
    path.join(project, 'artifacts', 'legal-site', 'privacy', 'index.html'),
    'utf8',
  );
}

await test('serves app-ads.txt from the AdMob publisher ID or a game-owned file', async () => {
  assert.equal(
    admobAppAdsTxtLine('pub-1234567890123456'),
    'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0',
  );
  assert.throws(() => admobAppAdsTxtLine('ca-app-pub-1234567890123456'), /pub-0000000000000000/u);
  assert.equal(resolveAppAdsTxt({}), undefined);
  assert.equal(resolveAppAdsTxt({ gameConfig: { brand: {} } }), undefined);
  assert.equal(resolveAppAdsTxt({ ownFile: 'example.com, 1, DIRECT' }), 'example.com, 1, DIRECT\n');
  assert.throws(() => resolveAppAdsTxt({ ownFile: '  \n' }), /empty/u);
  assert.throws(
    () => resolveAppAdsTxt({ gameConfig: { ads: { admob: { publisherId: 7 } } } }),
    /must be a string/u,
  );
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-legal-app-ads-'));
  const project = path.join(root, 'project');
  try {
    writeLegalSources(path.join(project, 'legal'));
    writeFileSync(
      path.join(project, 'mpgd.game.json'),
      JSON.stringify({ ads: { admob: { publisherId: 'pub-1234567890123456' } } }),
    );
    const appAds = path.join(project, 'artifacts', 'legal-site', 'app-ads.txt');
    await inProject(project, async () => {
      await runMpgdCli(['legal', 'build']);
      assert.equal(
        readFileSync(appAds, 'utf8'),
        'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n',
      );
      await runMpgdCli(['legal', 'check']);
      writeFileSync(path.join(project, 'legal', 'app-ads.txt'), 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\nexample.com, 42, RESELLER\n');
      await assert.rejects(runMpgdCli(['legal', 'check']), /stale/u);
      await runMpgdCli(['legal', 'build']);
      assert.match(readFileSync(appAds, 'utf8'), /example\.com, 42, RESELLER/u);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
