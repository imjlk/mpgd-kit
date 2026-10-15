import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mpgd-typescript-tools-')));
const compiler = join(kitRoot, 'node_modules/ttsc/lib/launcher/ttsc.js');
const runner = join(kitRoot, 'node_modules/ttsc/lib/launcher/ttsx.js');
const cli = join(kitRoot, 'packages/cli/dist/bin.js');
assert.ok(existsSync(cli), 'Build packages before testing the generated game tools.');

function run(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180_000 });
}

function passed(result: SpawnSyncReturns<string>): void {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

try {
  for (const template of ['phaser', 'lite']) {
    for (const workspace of template === 'lite' ? [true] : [false, true]) {
      // Spaces exercise both argv handling and the generated project's rootDir.
      const gameRoot = join(
        fixtureRoot,
        'games with spaces',
        `${template}-${workspace ? 'workspace' : 'standalone'}`,
      );
      passed(
        run(
          [
            cli,
            'game',
            'create',
            gameRoot,
            '--template',
            template,
            '--kit-path',
            kitRoot,
            ...(workspace ? ['--workspace'] : []),
          ],
          kitRoot,
        ),
      );
      assert.ok(existsSync(join(gameRoot, 'tools/run-game-acceptance.ts')));
      assert.equal(existsSync(join(gameRoot, 'tools/run-game-acceptance.mjs')), false);
      const manifest = JSON.parse(readFileSync(join(gameRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      assert.equal(
        manifest.scripts.accept,
        'ttsx --project tsconfig.tools.json tools/run-game-acceptance.ts --',
      );
      for (const command of ['check', 'lint', 'format', 'fix']) {
        assert.match(manifest.scripts[command] ?? '', /-p tsconfig\.tools\.json/u);
      }

      // Link only the dependencies of the tools project. Do not borrow an entire
      // node_modules tree or install the generated game's unrelated target SDKs.
      for (const [name, source] of [
        ['@types/node', 'node_modules/@types/node'],
        ['@mpgd/cli', 'packages/cli'],
        ['ttsc', 'node_modules/ttsc'],
        ['typescript', 'node_modules/typescript'],
      ] as const) {
        const destination = join(gameRoot, 'node_modules', name);
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(
          resolve(kitRoot, source),
          destination,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      const projectArgs = ['--project', 'tsconfig.tools.json'];
      passed(run([compiler, '--noEmit', ...projectArgs], gameRoot));
      const help = run(
        [runner, ...projectArgs, 'tools/run-game-acceptance.ts', '--', '--help'],
        gameRoot,
      );
      passed(help);
      assert.match(help.stdout, /mpgd game accept/u, 'ttsx must preserve application help.');
      assert.doesNotMatch(help.stdout, /TypeScript runner provided by ttsc/u);

      const nestedTool = join(gameRoot, 'tools/nested/typecheck-canary.ts');
      mkdirSync(dirname(nestedTool), { recursive: true });
      writeFileSync(
        nestedTool,
        "export const count: number = 'invalid';\nexport function missingType(value) { return value; }\n",
      );
      const invalid = run([compiler, '--noEmit', ...projectArgs], gameRoot);
      assert.ifError(invalid.error);
      assert.equal(invalid.signal, null);
      assert.notEqual(invalid.status, 0, 'New nested tools must participate in type checking.');
      assert.match(`${invalid.stdout}\n${invalid.stderr}`, /typecheck-canary\.ts/u);
      assert.match(`${invalid.stdout}\n${invalid.stderr}`, /TS2322/u);
      assert.match(`${invalid.stdout}\n${invalid.stderr}`, /TS7006/u);
      rmSync(nestedTool);

      const assertionTool = join(gameRoot, 'tools/assertion-canary.ts');
      writeFileSync(assertionTool, [
        "import assert from 'node:assert/strict';",
        "assert.equal(1, process.argv.includes('--expect-failure') ? 2 : 1, 'TEMPLATE_ASSERTION_CANARY');",
        "process.stdout.write('TEMPLATE_ASSERTION_PASSED\\n');",
      ].join('\n'));
      passed(run([runner, ...projectArgs, 'tools/assertion-canary.ts'], gameRoot));
      const failure = run(
        [runner, ...projectArgs, 'tools/assertion-canary.ts', '--', '--expect-failure'],
        gameRoot,
      );
      assert.ifError(failure.error);
      assert.equal(failure.signal, null);
      assert.notEqual(failure.status, 0);
      assert.match(failure.stderr, /TEMPLATE_ASSERTION_CANARY/u);
      assert.doesNotMatch(failure.stdout, /TEMPLATE_ASSERTION_PASSED/u);
      console.info(
        `${template} ${workspace ? 'workspace' : 'standalone'}: typed tools, CLI arguments, and assertion failure passed`,
      );
    }
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
