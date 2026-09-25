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
  const assignments = [...clean.matchAll(/\bapplicationId\s*(?:=\s*)?["']([^"']+)["'](?=\s*(?:;|\r?\n|\}|$))/gu)]
    .map((match) => match[1]);
  const mentions = countGradleIdentityWrites(clean, 'applicationId');
  if (assignments.length === 0 || assignments.length !== mentions
    || assignments.some((value) => value !== expectedAppId)
    || hasAndroidReleaseIdSuffix(clean) || hasGradleBracketIdentityWrite(clean)) {
    throw new Error('Existing android project app ID differs or cannot be read safely.');
  }
}

function hasAndroidReleaseIdSuffix(source: string): boolean {
  const code = maskGradleStrings(source);
  const suffix = '(?:applicationIdSuffix|setApplicationIdSuffix)';
  const prefixes = [
    '\\bbuildTypes\\s*\\.\\s*release',
    '\\bbuildTypes\\s*\\[\\s*["\']release["\']\\s*\\]',
    '\\bbuildTypes\\s*\\.\\s*(?:getByName|named)\\s*\\(\\s*["\']release["\']\\s*\\)',
    '\\b(?:getByName|named)\\s*\\(\\s*["\']release["\']\\s*\\)',
    '\\brelease',
  ];
  const qualifiedSuffix = prefixes.some((prefix) => {
    const expression = new RegExp(`${prefix}\\s*\\.\\s*${suffix}\\b`, 'gu');
    return [...source.matchAll(expression)].some((match) => {
      const field = new RegExp(`${suffix}$`, 'u').exec(match[0])?.[0] ?? '';
      const offset = (match.index ?? 0) + match[0].lastIndexOf(field);
      return field !== '' && code.slice(offset, offset + field.length) === field;
    });
  });
  if (qualifiedSuffix) {
    return true;
  }
  const releaseBlocks = [
    /\brelease\s*\{/gu,
    /\brelease\s+by\s+getting\s*\{/gu,
    /\brelease\s*\.\s*(?:apply|configure)\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\.\s*(?:apply|configure)\s*\{/gu,
    /\bbuildTypes\s*\[\s*["']release["']\s*\]\s*\{/gu,
    /\bbuildTypes\s*\[\s*["']release["']\s*\]\s*\.\s*(?:apply|configure)\s*\{/gu,
  ];
  return releaseBlocks.some((expression) => [...source.matchAll(expression)]
    .some((match) => match.index !== undefined
      && code[(match.index ?? 0) + match[0].length - 1] === '{'
      && /\b(?:applicationIdSuffix|setApplicationIdSuffix)\b/u.test(maskGradleStrings(
        readBracedText(source, source.indexOf('{', match.index)),
      ))));
}

export function assertAndroidSettingsAppProject(source: string): void {
  const clean = stripGradleComments(source);
  const code = maskGradleStrings(clean);
  const includes = [...clean.matchAll(/\binclude\s*(?:\(([^)]*)\)|([^\r\n;]+))/gu)];
  const includesApp = includes.some((match) => code.slice(match.index, match.index + 7)
    === 'include' && /(?:^|,)\s*["']:app["']\s*(?:,|$)/u.test(match[1] ?? match[2] ?? ''));
  if (!includesApp) {
    throw new Error('Android settings must include :app at android/app without remapping it.');
  }
  assertAndroidSettingsNoAppRemap(clean);
}

export function assertAndroidSettingsNoAppRemap(source: string): void {
  const clean = stripGradleComments(source);
  const code = maskGradleStrings(clean);
  const appRemap = [...clean.matchAll(/\b(project|findProject)\s*\(\s*["']:app["']\s*\)/gu)]
    .some((match) => code.slice(match.index, match.index + (match[1]?.length ?? 0))
      === match[1]);
  if (appRemap) {
    throw new Error('Android settings must include :app at android/app without remapping it.');
  }
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

export function hasGradleIdentityMutation(source: string): boolean {
  const clean = stripGradleComments(source);
  const masked = maskGradleStrings(clean);
  if (hasGradlePropertySetter(clean) || hasGradleBracketIdentityWrite(clean)) {
    return true;
  }
  const setter = /\bset(?:ApplicationId|ApplicationIdSuffix|VersionCode|VersionName|VersionNameSuffix)\s*\(/u;
  const field = '(?:applicationId|applicationIdSuffix|versionCode|versionName|versionNameSuffix)';
  const assignment = new RegExp(
    `\\b${field}(?:\\s*(?:\\+?=|\\(|["'\\d]|\\.set\\s*\\()|[ \\t]+[A-Za-z_$])`,
    'u',
  );
  return setter.test(masked) || assignment.test(masked);
}

export function hasGradleBracketIdentityWrite(source: string): boolean {
  const clean = stripGradleComments(source);
  const code = maskGradleStrings(clean);
  const key = '(?:applicationId|applicationIdSuffix|versionCode|versionName|versionNameSuffix)';
  const bracketWrite = `\\[\\s*["']${key}["']\\s*\\]\\s*(?:\\+?=|\\.\\s*set\\s*\\(|\\()`;
  const expression = new RegExp(bracketWrite, 'gu');
  return [...clean.matchAll(expression)].some((match) => code[match.index] === '[');
}

export function hasAndroidDisplayNameResourceOverride(source: string): boolean {
  const clean = stripGradleComments(source);
  const code = maskGradleStrings(clean);
  return [...clean.matchAll(/\bresValue\b/gu)].some((match) => {
    if (code.slice(match.index, match.index + 8) !== 'resValue') {
      return false;
    }
    const tail = clean.slice(match.index);
    const literal = /^resValue\s*(?:\(\s*)?["'][^"']+["']\s*,\s*["']([^"']+)["']/u.exec(tail);
    return literal === null || literal[1] === 'app_name';
  });
}

export function hasAndroidResourceSourceSetOverride(source: string): boolean {
  const code = maskGradleStrings(stripGradleComments(source));
  return /\bsourceSets\b/u.test(code) && /\bres\b/u.test(code);
}

export function hasGradlePropertySetter(source: string): boolean {
  const clean = stripGradleComments(source);
  const masked = maskGradleStrings(clean);
  // A computed key can target any release identity; do not try to evaluate Groovy here.
  return /\bsetProperty\s*\(/u.test(masked);
}

export function countGradleIdentityWrites(source: string, key: string): number {
  const masked = maskGradleStrings(stripGradleComments(source));
  const expression = new RegExp(`\\b${key}\\b`, 'gu');
  return [...masked.matchAll(expression)].filter((match) => {
    const index = match.index ?? 0;
    const rest = masked.slice(index + key.length);
    if (masked[index - 1] === '.') {
      return /^\s*(?:\+?=|\(|\.set\s*\()/u.test(rest);
    }
    return /^\s*(?:\+?=|\(|["'\d]|[A-Za-z_$])/u.test(rest);
  }).length;
}

export function maskGradleStrings(clean: string): string {
  let masked = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index] ?? '';
    if (quote !== undefined) {
      if (character === '\\' && index + 1 < clean.length) {
        masked += '  ';
        index += 1;
      } else if (character === quote) {
        masked += character;
        quote = undefined;
      } else {
        masked += character === '\n' ? '\n' : ' ';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      masked += character;
    } else {
      masked += character;
    }
  }
  return masked;
}

function assertIosAppIdentity(source: string, expectedAppId: string): void {
  const listId = readIosAppConfigurationList(source);
  let actual = readIosReleaseBundleId(source, listId);
  if (actual === undefined || actual === '$(inherited)') {
    const projectListId = readIosProjectConfigurationList(source);
    if (projectListId === undefined) {
      throw new Error('Existing ios project inherited App ID has no project configuration.');
    }
    actual = readIosReleaseBundleId(source, projectListId);
  }
  if (actual !== expectedAppId) {
    throw new Error('Existing ios project app ID differs or cannot be read safely.');
  }
}

export function readIosReleaseInfoPlist(source: string): string {
  const target = readIosReleaseConfiguration(source, readIosAppConfigurationList(source));
  let value = readIosInfoPlistSetting(target);
  if (value === undefined) {
    if (/\bbaseConfigurationReference\s*=/u.test(target)) {
      throw new Error('Existing ios project Release Info.plist xcconfig cannot be read safely.');
    }
    const projectListId = readIosProjectConfigurationList(source);
    if (projectListId === undefined) {
      throw new Error('Existing ios project Release Info.plist has no project configuration.');
    }
    const project = readIosReleaseConfiguration(source, projectListId);
    value = readIosInfoPlistSetting(project);
    if (value === undefined && /\bbaseConfigurationReference\s*=/u.test(project)) {
      throw new Error('Existing ios project Release Info.plist xcconfig cannot be read safely.');
    }
  }
  if (value === undefined) {
    throw new Error('Existing ios project Release Info.plist cannot be read safely.');
  }
  return value;
}

export function assertIosReleaseProductName(source: string): void {
  const target = readIosReleaseConfiguration(source, readIosAppConfigurationList(source));
  let name = readIosProductName(target);
  if (name === undefined || name === '$(inherited)') {
    if (/\bbaseConfigurationReference\s*=/u.test(target)) {
      throw new Error('Existing ios project Release product name xcconfig is unsupported.');
    }
    const projectList = readIosProjectConfigurationList(source);
    if (projectList !== undefined) {
      const project = readIosReleaseConfiguration(source, projectList);
      name = readIosProductName(project);
      if ((name === undefined || name === '$(inherited)')
        && /\bbaseConfigurationReference\s*=/u.test(project)) {
        throw new Error('Existing ios project Release product name xcconfig is unsupported.');
      }
    }
  }
  if (name !== undefined && name !== '$(inherited)'
    && name !== 'App' && name !== '$(TARGET_NAME)') {
    throw new Error('Existing ios project Release PRODUCT_NAME must build App.app.');
  }
}

function readIosProductName(configuration: string): string | undefined {
  if (/(?:^|[\s{;])["']?PRODUCT_NAME(?:\[[^\]\r\n]+\])+["']?\s*=/u
    .test(configuration)) {
    throw new Error('Existing ios project conditional Release PRODUCT_NAME is unsupported.');
  }
  const values = [...configuration.matchAll(
    /(?:^|[\s{;])["']?PRODUCT_NAME["']?\s*=\s*([^;]+);/gu,
  )].map((match) => match[1]?.trim().replace(/^["']|["']$/gu, ''));
  if (values.length > 1) {
    throw new Error('Existing ios project Release PRODUCT_NAME is ambiguous.');
  }
  return values[0];
}

function readIosInfoPlistSetting(configuration: string): string | undefined {
  if (/(?:^|[\s{;])["']?INFOPLIST_FILE(?:\[[^\]\r\n]+\])+["']?\s*=/u.test(configuration)) {
    throw new Error('Existing ios project conditional Release Info.plist is unsupported.');
  }
  const values = [...configuration.matchAll(/(?:^|[\s{;])["']?INFOPLIST_FILE["']?\s*=\s*([^;]+);/gu)]
    .map((match) => match[1]?.trim().replace(/^["']|["']$/gu, ''));
  if (values.length > 1) {
    throw new Error('Existing ios project Release Info.plist is ambiguous.');
  }
  const value = values[0];
  if (value === undefined || value === '$(inherited)') {
    return undefined;
  }
  if (value.includes('$') || value.includes('\\') || pathIsUnsafe(value)) {
    throw new Error('Existing ios project Release Info.plist cannot be read safely.');
  }
  return value;
}

function pathIsUnsafe(value: string): boolean {
  return value.startsWith('/') || value.split('/').some((part) => part === '..' || part === '');
}

function readIosAppConfigurationList(source: string): string {
  const target = readPbxObject(source, readIosAppTargetId(source));
  const listId = /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u.exec(target)?.[1];
  if (listId === undefined) {
    throw new Error('Existing ios project App target configuration is missing.');
  }
  return listId;
}

export function readIosAppTargetId(source: string): string {
  const appTargets = [...source.matchAll(/\b([A-F0-9]+)\s*\/\*\s*App\s*\*\/\s*=\s*\{/gu)]
    .map((match) => match[1] ?? '')
    .filter((id) => {
      const block = readPbxObject(source, id);
      return /\bisa\s*=\s*PBXNativeTarget;/u.test(block)
        && /\bname\s*=\s*"?App"?\s*;/u.test(block);
    });
  if (appTargets.length !== 1) {
    throw new Error('Existing ios project App target could not be read safely.');
  }
  const targetId = appTargets[0] ?? '';
  const target = readPbxObject(source, targetId);
  const productId = /\bproductReference\s*=\s*([A-F0-9]+)\b/u.exec(target)?.[1];
  if (!/\bproductType\s*=\s*"?com\.apple\.product-type\.application"?\s*;/u.test(target)
    || productId === undefined) {
    throw new Error('Existing ios App target must produce an application.');
  }
  const product = readPbxObject(source, productId);
  if (!/\bisa\s*=\s*PBXFileReference\s*;/u.test(product)
    || !/\b(?:explicitFileType|lastKnownFileType)\s*=\s*wrapper\.application\s*;/u.test(product)
    || !/\bpath\s*=\s*"?App\.app"?\s*;/u.test(product)
    || !/\bsourceTree\s*=\s*BUILT_PRODUCTS_DIR\s*;/u.test(product)) {
    throw new Error('Existing ios App target product must be App.app.');
  }
  return targetId;
}

function readIosProjectConfigurationList(source: string): string | undefined {
  const projects = [...source.matchAll(/\b([A-F0-9]+)\s*\/\*[^*]+\*\/\s*=\s*\{/gu)]
    .map((match) => readPbxObject(source, match[1] ?? ''))
    .filter((block) => /\bisa\s*=\s*PBXProject;/u.test(block));
  return projects.length === 1
    ? /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u.exec(projects[0] ?? '')?.[1]
    : undefined;
}

function readIosReleaseBundleId(source: string, listId: string): string | undefined {
  const configuration = readIosReleaseConfiguration(source, listId);
  const hasBaseConfiguration = /\bbaseConfigurationReference\s*=/u.test(configuration);
  const conditionalId = /(?:^|[\s{;])["']?PRODUCT_BUNDLE_IDENTIFIER(?:\[[^\]\r\n]+\])+["']?\s*=/u;
  if (conditionalId.test(configuration)) {
    throw new Error('Existing ios project conditional Release bundle ID is unsupported.');
  }
  const values = [...configuration.matchAll(/(?:^|[\s{;])["']?PRODUCT_BUNDLE_IDENTIFIER["']?\s*=\s*([^;]+);/gu)]
    .map((match) => match[1]?.trim().replace(/^["']|["']$/gu, ''));
  if (values.length > 1) {
    throw new Error('Existing ios project Release bundle ID is ambiguous.');
  }
  if ((values[0] === undefined || values[0] === '$(inherited)') && hasBaseConfiguration) {
    throw new Error('Existing ios project Release xcconfig identity cannot be read safely.');
  }
  return values[0];
}

function readIosReleaseConfiguration(source: string, listId: string): string {
  const list = readPbxObject(source, listId);
  const configurations = /\bbuildConfigurations\s*=\s*\(([^)]*)\)/u.exec(list)?.[1];
  const releaseIds = configurations === undefined ? []
    : [...configurations.matchAll(/\b([A-F0-9]+)\s*\/\*\s*Release\s*\*\//gu)]
      .map((match) => match[1]);
  if (releaseIds.length !== 1) {
    throw new Error('Existing ios project App Release configuration is missing or ambiguous.');
  }
  return stripGradleComments(readPbxObject(source, releaseIds[0] ?? ''));
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
