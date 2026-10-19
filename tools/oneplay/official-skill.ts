import { stripTypeScriptTypes } from 'node:module';
import { parse } from 'acorn';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Offline drift check after explicitly refreshing the official skill. It is not a live latest-version claim. */
export async function checkOfficialOnePlaySkill(root: string): Promise<{ sdkVersion: string; skillHash: string }> {
  const lock: unknown = JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8'));
  if (!object(lock) || !object(lock.skills) || !object(lock.skills['onestore-web-sdk'])) {
    throw new Error('Install the official ONEstore skill first.');
  }
  const skill = lock.skills['onestore-web-sdk'];
  if (skill.source !== 'ONE-store/onestore_web_sdk_skills' || skill.sourceType !== 'github' || skill.skillPath !== 'skills/onestore-web-sdk/SKILL.md'
    || typeof skill.computedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(skill.computedHash)) {
    throw new Error('Unexpected ONEstore skill source or lock format.');
  }
  const reference = readFileSync(
    join(root, '.agents/skills/onestore-web-sdk/references/sdk-context.md'),
    'utf8',
  );
  const version = /public type declarations of SDK v(\d+\.\d+\.\d+)/u.exec(reference)?.[1];
  const entry = readFileSync(join(root, '.agents/skills/onestore-web-sdk/SKILL.md'), 'utf8');
  const entryVersion = /recommend the latest, `v(\d+\.\d+\.\d+)`/u.exec(entry)?.[1];
  const adapter = readFileSync(join(root, 'adapters/browser/src/oneplay-sdk.ts'), 'utf8');
  const program = parse(stripTypeScriptTypes(adapter), {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
  let runtimeUrl: unknown;
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') {
      continue;
    }
    for (const declaration of statement.declaration.declarations) {
      if (declaration.id.type === 'Identifier' && declaration.id.name === 'onePlaySdkUrl'
        && declaration.init?.type === 'Literal') {
        runtimeUrl = declaration.init.value;
      }
    }
  }
  // Only the exported literal counts; comments and legacy fallback URLs do not.
  if (!version || entryVersion !== version || runtimeUrl !== `https://h5sdk.onestore.net/lib/v${version}/onestore-h5-sdk.min.js`) {
    throw new Error(
      'Official skill and adapter SDK versions differ. Review upstream changes before updating the adapter.',
    );
  }
  return { sdkVersion: version, skillHash: skill.computedHash };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await checkOfficialOnePlaySkill(process.cwd()))}\n`);
}
