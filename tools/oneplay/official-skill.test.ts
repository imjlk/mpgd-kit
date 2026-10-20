import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkOfficialOnePlaySkill,
  hashInstalledOnePlaySkill,
  requiredInstalledSkillText,
} from './official-skill.js';

const root = mkdtempSync(join(tmpdir(), 'oneplay-skill-'));
const skillDir = join(root, '.agents/skills/onestore-web-sdk');
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function writeLock(hash: string, source = 'ONE-store/onestore_web_sdk_skills'): void {
  writeFileSync(
    join(root, 'skills-lock.json'),
    JSON.stringify({
      skills: {
        'onestore-web-sdk': {
          source,
          sourceType: 'github',
          skillPath: 'skills/onestore-web-sdk/SKILL.md',
          computedHash: hash,
        },
      },
    }),
  );
}

function writeSkill(version: string): void {
  mkdirSync(join(skillDir, 'references'), { recursive: true });
  const byFile = new Map<string, string[]>();
  for (const [file, marker] of requiredInstalledSkillText) {
    const lines = byFile.get(file) ?? [];
    lines.push(marker);
    byFile.set(file, lines);
  }
  const skill = byFile.get('SKILL.md') ?? [];
  skill.unshift(`recommend the latest, \`v${version}\``);
  byFile.set('SKILL.md', skill);
  const context = byFile.get('references/sdk-context.md') ?? [];
  context.unshift(`public type declarations of SDK v${version}`);
  byFile.set('references/sdk-context.md', context);
  for (const [file, lines] of byFile) {
    writeFileSync(join(skillDir, file), `${lines.join('\n')}\n`);
  }
}

function lockToInstalled(): void {
  writeLock(hashInstalledOnePlaySkill(skillDir));
}

try {
  mkdirSync(join(root, 'adapters/browser/src'), { recursive: true });
  writeSkill('1.1.0');
  lockToInstalled();
  writeFileSync(
    join(root, 'adapters/browser/src/oneplay-sdk.ts'),
    "export const onePlaySdkUrl = 'https://h5sdk.onestore.net/lib/v1.1.0/onestore-h5-sdk.min.js';",
  );
  const crlf = join(skillDir, 'references/line-endings.txt');
  writeFileSync(crlf, 'same\r\ntext\r\n');
  const crlfHash = hashInstalledOnePlaySkill(skillDir);
  writeFileSync(crlf, 'same\ntext\n');
  assert.equal(hashInstalledOnePlaySkill(skillDir), crlfHash);
  rmSync(crlf);
  lockToInstalled();
  assert.equal((await checkOfficialOnePlaySkill(root)).sdkVersion, '1.1.0');

  const skillMd = join(skillDir, 'SKILL.md');
  const reviewed = readFileSync(skillMd, 'utf8');
  writeFileSync(skillMd, `${reviewed}\nclient-side drift\n`);
  await assert.rejects(() => checkOfficialOnePlaySkill(root), /does not match skills-lock.json/u);
  writeFileSync(skillMd, reviewed);
  lockToInstalled();

  writeFileSync(skillMd, `${reviewed}\nconst requestId = "req-" + Date.now();\n`);
  lockToInstalled();
  await assert.rejects(() => checkOfficialOnePlaySkill(root), /client-issued/u);
  writeFileSync(skillMd, reviewed);
  lockToInstalled();

  const checks = join(skillDir, 'references/checks.md');
  const checksText = readFileSync(checks, 'utf8');
  writeFileSync(
    checks,
    checksText.replace('client-generated for rewarded ads', 'request id present'),
  );
  lockToInstalled();
  await assert.rejects(() => checkOfficialOnePlaySkill(root), /local patch is missing/u);
  writeFileSync(checks, checksText);
  lockToInstalled();
  assert.equal((await checkOfficialOnePlaySkill(root)).sdkVersion, '1.1.0');

  writeFileSync(
    join(skillDir, 'references/sdk-context.md'),
    'public type declarations of SDK v1.2.0\nopaque server-issued checkout intent\n',
  );
  await assert.rejects(() => checkOfficialOnePlaySkill(root), /versions differ/u);
  writeSkill('1.2.0');
  lockToInstalled();
  writeFileSync(
    join(root, 'adapters/browser/src/oneplay-sdk.ts'),
    "// https://h5sdk.onestore.net/lib/v1.2.0/onestore-h5-sdk.min.js\nexport const onePlaySdkUrl = 'https://h5sdk.onestore.net/lib/v1.1.0/onestore-h5-sdk.min.js';",
  );
  await assert.rejects(() => checkOfficialOnePlaySkill(root), /versions differ/u);
  writeFileSync(
    join(root, 'adapters/browser/src/oneplay-sdk.ts'),
    "export const onePlaySdkUrl = 'https://h5sdk.onestore.net/lib/v1.2.0/onestore-h5-sdk.min.js';",
  );
  writeSkill('1.1.0');
  lockToInstalled();
  await assert.rejects(() => checkOfficialOnePlaySkill(root), /versions differ/u);
  writeSkill('1.2.0');
  lockToInstalled();
  assert.equal((await checkOfficialOnePlaySkill(root)).sdkVersion, '1.2.0');
  writeLock(hashInstalledOnePlaySkill(skillDir), 'untrusted/replacement');
  await assert.rejects(() => checkOfficialOnePlaySkill(root), /Unexpected/u);
} finally {
  rmSync(root, { recursive: true, force: true });
}

assert.equal((await checkOfficialOnePlaySkill(repoRoot)).sdkVersion, '1.1.0');
console.info('ONEplay official skill drift checks passed.');
