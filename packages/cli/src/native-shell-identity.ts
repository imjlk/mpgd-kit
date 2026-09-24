/** Inspect only the effective App target, not unrelated Xcode extensions. */
export function assertNativeShellIdentity(
  platform: 'android' | 'ios',
  source: string,
  expectedAppId: string,
): void {
  if (platform === 'android') {
    assertAndroidIdentity(source, expectedAppId);
  } else {
    assertIosAppIdentity(source, expectedAppId);
  }
}

function assertAndroidIdentity(source: string, expectedAppId: string): void {
  const clean = stripGradleComments(source);
  const assignments = [...clean.matchAll(/\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/gu)]
    .map((match) => match[1]);
  const mentions = [...clean.matchAll(/\bapplicationId\b/gu)].length;
  if (assignments.length === 0 || assignments.length !== mentions
    || assignments.some((value) => value !== expectedAppId)
    || hasAndroidReleaseIdSuffix(clean)) {
    throw new Error('Existing android project app ID differs or cannot be read safely.');
  }
}

function hasAndroidReleaseIdSuffix(source: string): boolean {
  if (/\bbuildTypes\s*\.\s*release\s*\.\s*applicationIdSuffix\b/u.test(source)
    || /\bbuildTypes\s*\.\s*(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\.\s*applicationIdSuffix\b/u
      .test(source)
    || /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\.\s*applicationIdSuffix\b/u
      .test(source)
    || /\brelease\s*\.\s*applicationIdSuffix\b/u.test(source)) {
    return true;
  }
  const releaseBlocks = [
    /\brelease\s*\{/gu,
    /\brelease\s+by\s+getting\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
  ];
  return releaseBlocks.some((expression) => [...source.matchAll(expression)]
    .some((match) => match.index !== undefined
      && /\bapplicationIdSuffix\b/u.test(readBracedText(
        source,
        source.indexOf('{', match.index),
      ))));
}

export function stripGradleComments(source: string): string {
  let output = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1];
    if (quote !== undefined) {
      output += character;
      if (character === '\\' && next !== undefined) {
        output += next;
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function assertIosAppIdentity(source: string, expectedAppId: string): void {
  const appTargets = [...source.matchAll(/\b([A-F0-9]+)\s*\/\*\s*App\s*\*\/\s*=\s*\{/gu)]
    .map((match) => readPbxObject(source, match[1] ?? ''))
    .filter((block) => /\bisa\s*=\s*PBXNativeTarget;/u.test(block)
      && /\bname\s*=\s*"?App"?\s*;/u.test(block));
  if (appTargets.length !== 1) {
    throw new Error('Existing ios project App target could not be read safely.');
  }
  const listId = /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u.exec(appTargets[0] ?? '')?.[1];
  if (listId === undefined) {
    throw new Error('Existing ios project App target configuration is missing.');
  }
  let actual = readIosReleaseBundleId(source, listId);
  if (actual === undefined || actual === '$(inherited)') {
    const projects = [...source.matchAll(/\b([A-F0-9]+)\s*\/\*[^*]+\*\/\s*=\s*\{/gu)]
      .map((match) => readPbxObject(source, match[1] ?? ''))
      .filter((block) => /\bisa\s*=\s*PBXProject;/u.test(block));
    const projectListId = projects.length === 1
      ? /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u.exec(projects[0] ?? '')?.[1]
      : undefined;
    if (projectListId === undefined) {
      throw new Error('Existing ios project inherited App ID has no project configuration.');
    }
    actual = readIosReleaseBundleId(source, projectListId);
  }
  if (actual !== expectedAppId) {
    throw new Error('Existing ios project app ID differs or cannot be read safely.');
  }
}

function readIosReleaseBundleId(source: string, listId: string): string | undefined {
  const list = readPbxObject(source, listId);
  const configurations = /\bbuildConfigurations\s*=\s*\(([^)]*)\)/u.exec(list)?.[1];
  const releaseIds = configurations === undefined ? []
    : [...configurations.matchAll(/\b([A-F0-9]+)\s*\/\*\s*Release\s*\*\//gu)]
      .map((match) => match[1]);
  if (releaseIds.length !== 1) {
    throw new Error('Existing ios project App Release configuration is missing or ambiguous.');
  }
  const configuration = stripGradleComments(readPbxObject(source, releaseIds[0] ?? ''));
  const hasBaseConfiguration = /\bbaseConfigurationReference\s*=/u.test(configuration);
  if (/\bPRODUCT_BUNDLE_IDENTIFIER\s*(?:\[[^\]\r\n]+\])+["']?\s*=/u.test(configuration)) {
    throw new Error('Existing ios project conditional Release bundle ID is unsupported.');
  }
  const values = [...configuration.matchAll(/\bPRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/gu)]
    .map((match) => match[1]?.trim().replace(/^["']|["']$/gu, ''));
  if (values.length > 1) {
    throw new Error('Existing ios project Release bundle ID is ambiguous.');
  }
  if ((values[0] === undefined || values[0] === '$(inherited)') && hasBaseConfiguration) {
    throw new Error('Existing ios project Release xcconfig identity cannot be read safely.');
  }
  return values[0];
}

function readPbxObject(source: string, id: string): string {
  const marker = new RegExp(`\\b${id}\\s*\\/\\*[^*]+\\*\\/\\s*=\\s*\\{`, 'u').exec(source);
  if (marker?.index === undefined) {
    throw new Error(`Existing ios project object ${id} could not be read safely.`);
  }
  const opening = source.indexOf('{', marker.index);
  return readBracedText(source, opening);
}

function readBracedText(source: string, opening: number): string {
  if (opening < 0) {
    throw new Error('Existing native project block is missing.');
  }
  let depth = 0;
  let quote = false;
  let blockComment = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = false;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (character === '"') {
      quote = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(opening, index + 1);
      }
    }
  }
  throw new Error('Existing native project block is incomplete.');
}
