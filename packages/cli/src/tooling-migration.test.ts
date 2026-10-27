import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyToolingMigration, planToolingMigration } from './tooling-migration.js';

const template = path.resolve('packages/cli/templates/phaser-game');
const currentRunner = readFileSync(path.join(template, 'tools/run-game-acceptance.ts'), 'utf8');
const legacyCommands = {
  accept: 'node ./tools/run-game-acceptance.mjs',
  check: 'ttsc --noEmit -p tsconfig.json',
  lint: 'ttsc --noEmit -p tsconfig.json',
  format: 'ttsc format',
  fix: 'ttsc fix',
};
function fixture(): { root: string; game: string; read: (file: string) => string; write: (file: string, text: string) => void; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mpgd-tooling-migration-')));
  const game = path.join(root, 'game with spaces');
  mkdirSync(path.join(game, 'tools'), { recursive: true });
  const write = (file: string, text: string): void => writeFileSync(path.join(game, file), text);
  write('package.json', JSON.stringify({
    name: 'migration-game', type: 'module', scripts: { ...legacyCommands, custom: 'keep me' },
    devDependencies: { ttsc: '0.30.4', '@ttsc/unplugin': '0.30.4', typescript: '7.0.2', '@types/node': '^24.0.0' },
  }, null, 2) + '\n');
  write('tsconfig.json', '{"compilerOptions":{"strict":true}}\n');
  write(
    'tools/run-game-acceptance.mjs',
    currentRunner.replace("'__DEFAULT_KIT_PATH__'", "'../../kit with spaces'"),
  );
  write('pnpm-lock.yaml', '# original lock\n');
  return {
    root,
    game,
    read: (file) => readFileSync(path.join(game, file), 'utf8'),
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

await test('preview is read-only; application preserves kit paths, aligns tools and is idempotent', () => {
  const f = fixture();
  try {
    const before = f.read('package.json');
    const plan = planToolingMigration(f.game, template);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.updateLockfile, true);
    assert.equal(f.read('package.json'), before);
    assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.ts')), false);
    let refreshed = 0;
    applyToolingMigration(plan, (cwd) => {
      assert.equal(cwd, f.game);
      refreshed++;
      f.write('pnpm-lock.yaml', '# updated lock\n');
    });
    assert.equal(refreshed, 1);
    assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.mjs')), false);
    assert.match(f.read('tools/run-game-acceptance.ts'), /\.\.\/\.\.\/kit with spaces/);
    const manifest = JSON.parse(f.read('package.json'));
    assert.equal(manifest.scripts.custom, 'keep me');
    assert.equal(manifest.devDependencies.ttsc, '0.34.2');
    assert.equal(manifest.devDependencies['@ttsc/unplugin'], '0.34.2');
    assert.equal(JSON.parse(f.read('tsconfig.tools.json')).compilerOptions.strict, true);
    const again = planToolingMigration(f.game, template);
    assert.deepEqual(again.edits, []);
    assert.deepEqual(again.blockers, []);
    assert.deepEqual(
      applyToolingMigration(again, () => assert.fail('No second lockfile update')),
      [],
    );
  } finally {
    f.cleanup();
  }
});

await test('preserves customized scripts, source, and tools config by blocking automatic apply', () => {
  for (const customize of [
    (f: ReturnType<typeof fixture>) => { const m = JSON.parse(f.read('package.json')); m.scripts.check = 'custom-check'; f.write('package.json', JSON.stringify(m)); },
    (f: ReturnType<typeof fixture>) => f.write('tools/run-game-acceptance.mjs', f.read('tools/run-game-acceptance.mjs') + '\n// user note\n'),
    (f: ReturnType<typeof fixture>) => f.write('tools/run-game-acceptance.mjs', f.read('tools/run-game-acceptance.mjs').replace('process.argv.slice(2)', '[]')),
    (f: ReturnType<typeof fixture>) => f.write('tsconfig.tools.json', '{"include":["custom/**/*.ts"]}'),
  ]) {
    const f = fixture();
    try {
      customize(f);
      const source = f.read('tools/run-game-acceptance.mjs');
      const manifest = f.read('package.json');
      const plan = planToolingMigration(f.game, template);
      assert.ok(plan.blockers.length > 0);
      assert.throws(() => applyToolingMigration(plan), /blocked/);
      assert.equal(f.read('package.json'), manifest);
      assert.equal(f.read('tools/run-game-acceptance.mjs'), source);
    } finally { f.cleanup(); }
  }
});

await test('rejects stale plans, concurrent migrations and overlapping old/new runners', () => {
  const f = fixture();
  try {
    const plan = planToolingMigration(f.game, template);
    f.write('pnpm-lock.yaml', '# user changed lock\n');
    assert.throws(() => applyToolingMigration(plan), /changed after planning/);
    const fresh = planToolingMigration(f.game, template);
    f.write('.mpgd-tooling-migration.lock', 'another process');
    assert.throws(() => applyToolingMigration(fresh), /EEXIST/);
    assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.ts')), false);
    rmSync(path.join(f.game, '.mpgd-tooling-migration.lock'));
    f.write('tools/run-game-acceptance.ts', 'export {};');
    assert.match(
      planToolingMigration(f.game, template).blockers.join('\n'),
      /Both acceptance runners/,
    );
  } finally {
    f.cleanup();
  }
});

await test('recognizes only canonical existing TypeScript runners and preserves customized runners', () => {
  for (const suffix of ['', '\n// user note\n', '\nexport const custom: boolean = true;\n']) {
    const f = fixture();
    try {
      const runner = f.read('tools/run-game-acceptance.mjs') + suffix;
      rmSync(path.join(f.game, 'tools/run-game-acceptance.mjs'));
      f.write('tools/run-game-acceptance.ts', runner);
      const manifest = f.read('package.json');
      const plan = planToolingMigration(f.game, template);
      if (suffix) {
        assert.match(plan.blockers.join('\n'), /TypeScript acceptance runner is customized/);
        assert.throws(() => applyToolingMigration(plan), /blocked/);
        assert.equal(f.read('package.json'), manifest);
        assert.equal(f.read('pnpm-lock.yaml'), '# original lock\n');
        assert.equal(existsSync(path.join(f.game, 'tsconfig.tools.json')), false);
      } else {
        assert.deepEqual(plan.blockers, []);
        applyToolingMigration(plan, () => {});
      }
      assert.equal(f.read('tools/run-game-acceptance.ts'), runner);
    } finally {
      f.cleanup();
    }
  }
});

await test('preserves another install lockfile when a managed-file write fails before lockfile updates', (context) => {
  for (const needsUpgrade of [false, true]) {
    const f = fixture();
    const rename = fs.renameSync;
    try {
      if (!needsUpgrade) {
        f.write('package.json', f.read('package.json').replaceAll('0.30.4', '0.34.2'));
      }
      const manifest = f.read('package.json');
      const runner = f.read('tools/run-game-acceptance.mjs');
      const plan = planToolingMigration(f.game, template);
      assert.equal(plan.updateLockfile, needsUpgrade);
      let failed = false;
      context.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
        if (!failed && String(args[1]) === path.join(f.game, 'tsconfig.tools.json')) {
          failed = true;
          f.write('pnpm-lock.yaml', '# concurrent install\n');
          throw new Error('managed-file write failed');
        }
        return rename(...args);
      });
      syncBuiltinESMExports();
      assert.throws(
        () => applyToolingMigration(plan, () => assert.fail('Lockfile updater must not run')),
        /Managed files restored; lockfile untouched/,
      );
      assert.equal(f.read('pnpm-lock.yaml'), '# concurrent install\n');
      assert.equal(f.read('package.json'), manifest);
      assert.equal(f.read('tools/run-game-acceptance.mjs'), runner);
      assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.ts')), false);
      assert.equal(existsSync(path.join(f.game, 'tsconfig.tools.json')), false);
      assert.equal(existsSync(path.join(f.game, '.mpgd-tooling-migration.lock')), false);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      f.cleanup();
    }
  }
});

await test('preserves changed lockfiles after installation failure for manual inspection', () => {
  for (const hasLock of [true, false]) {
    const f = fixture();
    try {
      if (!hasLock) {
        rmSync(path.join(f.game, 'pnpm-lock.yaml'));
      }
      const before = f.read('package.json');
      const runner = f.read('tools/run-game-acceptance.mjs');
      const plan = planToolingMigration(f.game, template);
      assert.throws(
        () =>
          applyToolingMigration(plan, () => {
            f.write('pnpm-lock.yaml', 'partial lock');
            throw new Error('registry unavailable');
          }),
        /Rollback incomplete: pnpm-lock.yaml/,
      );
      assert.equal(f.read('package.json'), before);
      assert.equal(f.read('tools/run-game-acceptance.mjs'), runner);
      assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.ts')), false);
      assert.equal(existsSync(path.join(f.game, 'tsconfig.tools.json')), false);
      assert.equal(f.read('pnpm-lock.yaml'), 'partial lock');
      assert.equal(existsSync(path.join(f.game, '.mpgd-tooling-migration.lock')), false);
    } finally {
      f.cleanup();
    }
  }
});

await test('does not upgrade parent workspaces or follow symlinks outside a game', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.root, 'pnpm-workspace.yaml'), 'packages: ["*"]\n');
    assert.match(
      planToolingMigration(f.game, template).blockers.join('\n'),
      /parent pnpm workspace/,
    );
    const external = path.join(f.root, 'external.json');
    writeFileSync(external, f.read('package.json'));
    rmSync(path.join(f.game, 'package.json'));
    symlinkSync(external, path.join(f.game, 'package.json'));
    assert.throws(() => planToolingMigration(f.game, template), /linked migration path/);
    assert.match(readFileSync(external, 'utf8'), /0.30.4/);
  } finally {
    f.cleanup();
  }
});

await test('blocks parent-workspace games even when local pins are already aligned', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.root, 'pnpm-workspace.yaml'), 'packages: ["*"]\n');
    f.write('package.json', f.read('package.json').replaceAll('0.30.4', '0.34.2'));
    const plan = planToolingMigration(f.game, template);
    assert.match(plan.blockers.join('\n'), /parent pnpm workspace/);
    assert.equal(plan.updateLockfile, false);
    assert.throws(() => applyToolingMigration(plan), /blocked/);
  } finally {
    f.cleanup();
  }
});

await test('the packaged CLI previews migration without installing or writing files', () => {
  const f = fixture();
  try {
    const before = f.read('package.json');
    const result = spawnSync(
      process.execPath,
      ['packages/cli/dist/bin.js', 'kit', 'migrate-tools', '--game', f.game, '--json'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.plan.edits.length > 0);
    assert.equal(report.result, null);
    assert.equal(f.read('package.json'), before);
  } finally {
    f.cleanup();
  }
});

await test('rechecks inputs under the lock without rolling back a concurrent writer', (context) => {
  const f = fixture();
  const write = fs.writeFileSync;
  try {
    const plan = planToolingMigration(f.game, template);
    context.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof write>) => {
      write(...args);
      if (String(args[0]).endsWith('.mpgd-tooling-migration.lock')) {
        write(path.join(f.game, 'package.json'), '{"concurrent":"keep"}');
      }
    });
    syncBuiltinESMExports();
    assert.throws(() => applyToolingMigration(plan), /File changed after planning/);
    assert.equal(f.read('package.json'), '{"concurrent":"keep"}');
    assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.ts')), false);
    assert.equal(existsSync(path.join(f.game, '.mpgd-tooling-migration.lock')), false);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

await test('blocks duplicate non-dev toolchain declarations and incompatible peer plugins', () => {
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of ['ttsc', 'typescript', '@types/node', '@ttsc/unplugin']) {
      if (name.startsWith('@ttsc/') && section !== 'peerDependencies') {
        continue;
      }
      const f = fixture();
      try {
        const manifest = JSON.parse(f.read('package.json'));
        manifest[section] = { [name]: '0.30.4' };
        f.write('package.json', JSON.stringify(manifest));
        const before = f.read('package.json');
        const plan = planToolingMigration(f.game, template);
        assert.ok(plan.blockers.some((blocker) => blocker.includes(`${section}.${name}`)));
        assert.throws(() => applyToolingMigration(plan), /blocked/);
        assert.equal(f.read('package.json'), before);
        assert.equal(f.read('pnpm-lock.yaml'), '# original lock\n');
      } finally {
        f.cleanup();
      }
    }
  }
});

await test('blocks mismatched child toolchains and applies after child pins are aligned', () => {
  const f = fixture();
  try {
    f.write('pnpm-workspace.yaml', 'packages: [apps/*]\n');
    mkdirSync(path.join(f.game, 'apps/target-ait'), { recursive: true });
    mkdirSync(path.join(f.game, 'apps/target-devvit'), { recursive: true });
    f.write('apps/target-ait/package.json', '{"devDependencies":{"ttsc":"0.30.4"}}');
    f.write('apps/target-devvit/package.json', '{"devDependencies":{"@ttsc/unplugin":"0.30.4"}}');
    const before = f.read('package.json');
    const blocked = planToolingMigration(f.game, template);
    assert.ok(blocked.blockers.some((message) => message.includes('target-ait')));
    assert.ok(blocked.blockers.some((message) => message.includes('target-devvit')));
    assert.throws(() => applyToolingMigration(blocked), /blocked/);
    assert.equal(f.read('package.json'), before);
    assert.equal(f.read('pnpm-lock.yaml'), '# original lock\n');
    for (const target of ['target-ait', 'target-devvit']) {
      const file = `apps/${target}/package.json`;
      f.write(file, f.read(file).replaceAll('0.30.4', '0.34.2'));
    }
    const ready = planToolingMigration(f.game, template);
    assert.deepEqual(ready.blockers, []);
    applyToolingMigration(ready, () => {});
  } finally {
    f.cleanup();
  }
});

await test('detects child-package and workspace changes after preview', () => {
  for (const change of ['new', 'modified', 'workspace']) {
    const f = fixture();
    try {
      mkdirSync(path.join(f.game, 'custom/nested'), { recursive: true });
      if (change === 'modified') {
        f.write('custom/nested/package.json', '{"devDependencies":{"ttsc":"0.34.2"}}');
      }
      const plan = planToolingMigration(f.game, template);
      const before = f.read('package.json');
      if (change === 'workspace') {
        f.write('pnpm-workspace.yaml', 'packages: [custom/*]\n');
      } else {
        f.write('custom/nested/package.json', '{"devDependencies":{"ttsc":"0.30.4"}}');
      }
      assert.throws(() => applyToolingMigration(plan), /changed after planning/);
      assert.equal(f.read('package.json'), before);
      assert.equal(f.read('pnpm-lock.yaml'), '# original lock\n');
    } finally {
      f.cleanup();
    }
  }
});

await test('rejects a removed or changed base project without writing migration outputs', () => {
  for (const remove of [false, true]) {
    const f = fixture();
    try {
      const before = f.read('package.json');
      const plan = planToolingMigration(f.game, template);
      if (remove) {
        rmSync(path.join(f.game, 'tsconfig.json'));
      } else {
        f.write('tsconfig.json', '{"include":["custom/**/*.ts"]}');
      }
      assert.throws(() => applyToolingMigration(plan), /File changed after planning: tsconfig.json/);
      assert.equal(f.read('package.json'), before);
      assert.equal(f.read('pnpm-lock.yaml'), '# original lock\n');
      assert.equal(existsSync(path.join(f.game, 'tsconfig.tools.json')), false);
      assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.ts')), false);
      assert.equal(existsSync(path.join(f.game, 'tsconfig.json')), !remove);
      if (!remove) {
        assert.equal(f.read('tsconfig.json'), '{"include":["custom/**/*.ts"]}');
      }
    } finally {
      f.cleanup();
    }
  }
});

await test('does not restore an untouched later file when an earlier write fails', (context) => {
  const f = fixture();
  const rename = fs.renameSync;
  try {
    const plan = planToolingMigration(f.game, template);
    context.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
      if (String(args[1]) === path.join(f.game, 'tools/run-game-acceptance.ts')) {
        f.write('package.json', '{"concurrent":"keep"}');
        throw new Error('first write failed');
      }
      return rename(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => applyToolingMigration(plan), /Tooling migration failed/);
    assert.equal(f.read('package.json'), '{"concurrent":"keep"}');
    assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.ts')), false);
    assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.mjs')), true);
    assert.equal(f.read('pnpm-lock.yaml'), '# original lock\n');
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

await test('preserves concurrent output edits during rollback', () => {
  const f = fixture();
  try {
    const plan = planToolingMigration(f.game, template);
    assert.throws(
      () =>
        applyToolingMigration(plan, () => {
          f.write('package.json', '{"concurrent":"keep"}');
          throw new Error('install failed');
        }),
      /Rollback incomplete: package.json/,
    );
    assert.equal(f.read('package.json'), '{"concurrent":"keep"}');
    assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.ts')), false);
    assert.equal(existsSync(path.join(f.game, 'tools/run-game-acceptance.mjs')), true);
  } finally {
    f.cleanup();
  }
});

await test('provides manual recovery for interrupted migration locks', () => {
  const f = fixture();
  try {
    const plan = planToolingMigration(f.game, template);
    f.write('.mpgd-tooling-migration.lock', 'interrupted legacy run');
    assert.throws(
      () => applyToolingMigration(plan),
      /verify its process and pnpm child have exited/,
    );
    assert.equal(f.read('.mpgd-tooling-migration.lock'), 'interrupted legacy run');
    rmSync(path.join(f.game, '.mpgd-tooling-migration.lock'));
    applyToolingMigration(plan, () => {
      const owner = JSON.parse(f.read('.mpgd-tooling-migration.lock'));
      assert.equal(owner.pid, process.pid);
      assert.equal(typeof owner.host, 'string');
      assert.equal(typeof owner.token, 'string');
      assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
    });
    assert.equal(existsSync(path.join(f.game, '.mpgd-tooling-migration.lock')), false);
  } finally {
    f.cleanup();
  }
});
