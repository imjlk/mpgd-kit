import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runMpgdCli } from '../src/index.js';

/**
 * `String.prototype.replaceAll` treats `$&`, `$'`, `` $` ``, and `$$` in a
 * string replacement as patterns. A display title must survive that, including
 * quotes and backslashes inside generated JSON, the web app manifest, and
 * JS string literals.
 */
const titles = [
  'Hit $&',
  "Hit $'",
  'Hit $`',
  'Hit $$',
  'Hit "Quote"',
  "Hit 'Quote'",
  'Hit \\path',
] as const;

const leftoverPlaceholder = new RegExp(
  [
    'GAME_TITLE(?:_TS_LITERAL)?',
    'GAME_NAME',
    'DEVVIT_APP_NAME',
    'PACKAGE_NAME',
    'LEGAL_LAST_UPDATED',
    'MPGD_DEPENDENCY_VERSION(?:_[A-Z0-9]+)?',
    'TSCONFIG_(?:EXTENDS_LINE|ROOT_DIR|WORKSPACE_INCLUDES|WORKSPACE_EXCLUDES)',
    'WORKSPACE_I18N_BUILD_PREFIX',
    'DEFAULT_KIT_PATH',
    'RECOMMENDED_MATRIX_TARGETS',
    'PNPM_WORKSPACE_KIT_PACKAGES',
    'PASCAL_NAME',
    'CAMEL_NAME',
  ].join('|'),
  'u',
);
const leftover = new RegExp(`__(?:${leftoverPlaceholder.source})__`, 'u');

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-game-title-'));

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

try {
  let index = 0;
  for (const template of ['phaser', 'lite'] as const) {
    for (const title of titles) {
      index += 1;
      const directory = path.join(root, `${template}-title-${index}`);
      await runMpgdCli([
        'game',
        'create',
        directory,
        '--template',
        template,
        '--title',
        title,
        '--providers',
        'notifications',
      ]);
      const files = walk(directory);
      assert.ok(files.length > 0, `${template} ${title}: generated files`);
      for (const file of files) {
        const relative = path.relative(directory, file);
        const content = readFileSync(file, 'utf8');
        assert.equal(
          leftover.test(content),
          false,
          `${template} ${JSON.stringify(title)} left a placeholder in ${relative}`,
        );
        // `.webmanifest` is JSON. Hosted PWA and Microsoft Store both parse it.
        if (!file.endsWith('.json') && !file.endsWith('.webmanifest')) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          assert.fail(`${relative} is not JSON for ${JSON.stringify(title)}: ${detail}`);
        }
        assert.equal(typeof parsed, 'object');
      }
      const deployment = JSON.parse(
        readFileSync(path.join(directory, 'notifications/deployment.json'), 'utf8'),
      ) as { readonly advertisingSender: { readonly name: string } };
      assert.equal(deployment.advertisingSender.name, title, `${template} deployment name`);
      const topics = JSON.parse(
        readFileSync(path.join(directory, 'notifications/topics.json'), 'utf8'),
      ) as {
        readonly notices: {
          readonly copy: {
            readonly en: Readonly<Record<string, { readonly title: string }>>;
          };
        };
      };
      const noticeTitle = topics.notices.copy.en['consent-result.advertising.granted']?.title;
      assert.equal(noticeTitle?.includes(title), true, `${template} topics.json title`);
      assert.equal(noticeTitle?.includes('__GAME_TITLE__'), false);
      const literal = `'${title.replaceAll('\\', () => '\\\\').replaceAll("'", () => "\\'")}'`;
      if (template === 'phaser') {
        const messages = readFileSync(path.join(directory, 'src/i18n/messages.ts'), 'utf8');
        assert.equal(messages.includes(`title: ${literal},`), true, 'phaser title literal');
      } else {
        const game = readFileSync(path.join(directory, 'src/runtime/createGame.ts'), 'utf8');
        assert.equal(game.includes(`title: ${literal}`), true, 'lite title literal');
      }
      const html = readFileSync(path.join(directory, 'index.html'), 'utf8');
      assert.equal(html.includes(`<title>${title}</title>`), true, `${template} html title`);
      if (template === 'phaser') {
        const manifest = JSON.parse(
          readFileSync(path.join(directory, 'public/manifest.webmanifest'), 'utf8'),
        ) as { readonly name: string; readonly description: string };
        assert.equal(manifest.name, title, 'phaser webmanifest name');
        assert.equal(manifest.description.includes(title), true, 'phaser webmanifest description');
      }
      const devvitVite = readFileSync(
        path.join(directory, 'apps/target-devvit/vite.config.ts'),
        'utf8',
      );
      assert.match(devvitVite, /from '@mpgd\/cli\/devvit'/u, `${template} devvit import`);
    }
  }

  const rejected = runMpgdCli([
    'game',
    'create',
    path.join(root, 'rejected-title'),
    '--title',
    'Hit <tag>',
  ]);
  await assert.rejects(rejected, /angle brackets/u);
} finally {
  rmSync(root, { recursive: true, force: true });
}
