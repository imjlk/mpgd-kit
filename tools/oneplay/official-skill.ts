import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { parse } from 'acorn';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const installedSkillDir = '.agents/skills/onestore-web-sdk';

/**
 * Text that must remain after an upstream skill refresh.
 * A12-1 / section 4 require a server-issued opaque payload. A10 / B6 require a
 * server-issued request id. There is no separate doctor runner in tools/oneplay;
 * this list is what keeps that checklist wording from being reverted.
 */
export const requiredInstalledSkillText: ReadonlyArray<readonly [string, string]> = [
  ['SKILL.md', 'server-issued opaque developerPayload'],
  ['SKILL.md', 'Do not generate requestId on the client'],
  ['references/game-template.html.txt', 'async function issueCheckoutIntent()'],
  [
    'references/game-template.html.txt',
    'throw new Error("Checkout intent backend is not connected");',
  ],
  ['references/game-template.html.txt', 'async function issueRewardRequest()'],
  [
    'references/game-template.html.txt',
    'throw new Error("Reward request backend is not connected");',
  ],
  ['references/game-template.html.txt', 'developerPayload: intent.developerPayload'],
  ['references/checks.md', 'opaque developerPayload bound to an authenticated intent'],
  ['references/checks.md', 'issued by the game server and bound to the authenticated session'],
  ['references/checks.md', 'client-generated for rewarded ads'],
  ['references/sdk-context.md', 'opaque server-issued checkout intent'],
  ['LOCAL_PATCHES.md', 'reviewed SHA-256 of this installed skill directory'],
];

/** Upstream examples that must not return. The user-identifier phrase may wrap. */
export const forbiddenInstalledSkillText: ReadonlyArray<RegExp> = [
  /Date\.now\s*\(/u,
  /your user ID/u,
  /such as a\s+user identifier/iu,
  /server-issued \/ generated on the client/u,
];

/**
 * SHA-256 of the reviewed installed skill tree.
 *
 * `npx skills` (vercel-labs/skills project lock, version 1) writes `computedHash`
 * with `computeSkillFolderHash`: every regular file, skipping `.git` and
 * `node_modules`, sorted by host `localeCompare`, path UTF-8 then raw bytes.
 * This digest keeps that concatenation, sorts with `localeCompare(..., 'en')`
 * so it does not depend on the host locale, and normalizes CRLF to LF.
 * `LOCAL_PATCHES.md` is included. The lock records this reviewed digest after
 * local patches, not the raw upstream folder hash.
 */
export function hashInstalledOnePlaySkill(skillDir: string): string {
  const files = collectSkillFiles(skillDir);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest('hex');
}

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
  const skillDir = join(root, installedSkillDir);
  const reference = readFileSync(join(skillDir, 'references/sdk-context.md'), 'utf8');
  const version = /public type declarations of SDK v(\d+\.\d+\.\d+)/u.exec(reference)?.[1];
  const entry = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
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
  const installedHash = hashInstalledOnePlaySkill(skillDir);
  if (installedHash !== skill.computedHash) {
    throw new Error(
      `Installed ONEstore skill hash ${installedHash} does not match skills-lock.json computedHash.`,
    );
  }
  assertInstalledSkillPatch(skillDir);
  return { sdkVersion: version, skillHash: skill.computedHash };
}

function assertInstalledSkillPatch(skillDir: string): void {
  const files = collectSkillFiles(skillDir);
  for (const file of files) {
    const text = file.content.toString('utf8');
    for (const pattern of forbiddenInstalledSkillText) {
      if (pattern.test(text)) {
        throw new Error(
          `ONEstore skill still documents a client-issued payload or request id (${pattern.source} in ${file.relativePath}).`,
        );
      }
    }
  }
  for (const [file, marker] of requiredInstalledSkillText) {
    const match = files.find((entry) => entry.relativePath === file);
    if (match === undefined || !match.content.toString('utf8').includes(marker)) {
      throw new Error(`ONEstore skill local patch is missing from ${file}.`);
    }
  }
}

function collectSkillFiles(skillDir: string): Array<{ relativePath: string; content: Buffer }> {
  const results: Array<{ relativePath: string; content: Buffer }> = [];
  walkSkill(skillDir, skillDir, results);
  if (results.length === 0) {
    throw new Error('Installed ONEstore skill directory is missing.');
  }
  return results;
}

function walkSkill(
  baseDir: string,
  currentDir: string,
  results: Array<{ relativePath: string; content: Buffer }>,
): void {
  if (!existsSync(currentDir)) {
    throw new Error('Installed ONEstore skill directory is missing.');
  }
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      walkSkill(baseDir, join(currentDir, entry.name), results);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const fullPath = join(currentDir, entry.name);
    const relativePath = relative(baseDir, fullPath).split('\\').join('/');
    results.push({ relativePath, content: normalizedSkillBytes(readFileSync(fullPath)) });
  }
}

function normalizedSkillBytes(content: Buffer): Buffer {
  return Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await checkOfficialOnePlaySkill(process.cwd()))}\n`);
}
