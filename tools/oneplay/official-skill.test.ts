import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOfficialOnePlaySkill } from './official-skill.js';
const root = mkdtempSync(join(tmpdir(), 'oneplay-skill-'));
try {
  mkdirSync(join(root, '.agents/skills/onestore-web-sdk/references'), { recursive: true });
  mkdirSync(join(root, 'adapters/browser/src'), { recursive: true });
  const lock = {
    skills: {
      'onestore-web-sdk': {
        source: 'ONE-store/onestore_web_sdk_skills',
        sourceType: 'github',
        skillPath: 'skills/onestore-web-sdk/SKILL.md',
        computedHash: 'a'.repeat(64),
      },
    },
  };
  writeFileSync(join(root, 'skills-lock.json'), JSON.stringify(lock));
  writeFileSync(
    join(root, '.agents/skills/onestore-web-sdk/references/sdk-context.md'),
    'public type declarations of SDK v1.1.0',
  );
  writeFileSync(
    join(root, 'adapters/browser/src/oneplay-sdk.ts'),
    "export const url = 'https://h5sdk.onestore.net/lib/v1.1.0/onestore-h5-sdk.min.js';",
  );
  assert.equal(checkOfficialOnePlaySkill(root).sdkVersion, '1.1.0');
  writeFileSync(
    join(root, '.agents/skills/onestore-web-sdk/references/sdk-context.md'),
    'public type declarations of SDK v1.2.0',
  );
  assert.throws(() => checkOfficialOnePlaySkill(root), /versions differ/u);
  lock.skills['onestore-web-sdk'].source = 'untrusted/replacement';
  writeFileSync(join(root, 'skills-lock.json'), JSON.stringify(lock));
  assert.throws(() => checkOfficialOnePlaySkill(root), /Unexpected/u);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('ONEplay official skill drift checks passed.');
