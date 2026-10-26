import assert from 'node:assert/strict';

import { iosSimulatorSmokeBuildSettings } from './ios-simulator-build-settings';

type Level = Readonly<Record<string, string>>;

/**
 * A small model of Xcode's build-setting resolution for this test: the
 * command line is the highest level and applies to every target, `$(NAME)`
 * expands recursively (including a name built from another setting),
 * `$(inherited)` is the same setting one level lower, and
 * `$(NAME:default=value)` falls back when NAME resolves empty.
 */
function resolve(setting: string, levels: readonly Level[], from = 0): string {
  for (let index = from; index < levels.length; index += 1) {
    const value = levels[index]?.[setting];
    if (value !== undefined) {
      return expand(value, setting, levels, index).trim();
    }
  }
  return '';
}

/** The first `character` at parenthesis depth zero from `start`, or the text length. */
function topLevelIndex(text: string, character: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === character && depth === 0) {
      return index;
    }
    if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;
    }
  }
  return text.length;
}

function expand(value: string, setting: string, levels: readonly Level[], level: number): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    if (!value.startsWith('$(', index)) {
      result += value[index];
      index += 1;
      continue;
    }
    const end = topLevelIndex(value, ')', index + 2);
    const body = value.slice(index + 2, end);
    const colon = topLevelIndex(body, ':', 0);
    const split = colon === body.length ? -1 : colon;
    const name = expand(split === -1 ? body : body.slice(0, split), setting, levels, level);
    let resolved = name === 'inherited'
      ? resolve(setting, levels, level + 1)
      : resolve(name, levels);
    const operator = split === -1 ? '' : body.slice(split + 1);
    if (operator.startsWith('default=') && resolved === '') {
      resolved = expand(operator.slice('default='.length), setting, levels, level);
    }
    result += resolved;
    index = end + 1;
  }
  return result;
}

function commandLine(settings: readonly string[]): Level {
  return Object.fromEntries(
    settings.map((setting) => {
      const equals = setting.indexOf('=');
      assert.ok(equals > 0, `${setting} is not SETTING=value`);
      return [setting.slice(0, equals), setting.slice(equals + 1)];
    }),
  );
}

const release = commandLine(iosSimulatorSmokeBuildSettings(['MPGD_SMOKE_NO_STORYBOARD']));
const app: Level = {
  TARGET_NAME: 'App',
  INFOPLIST_FILE: 'App/Info.plist',
  SWIFT_ACTIVE_COMPILATION_CONDITIONS: '',
  ASSETCATALOG_COMPILER_APPICON_NAME: 'AppIcon',
};
// The Swift package resource-bundle target that failed: Xcode looked for
// firebase-ios-sdk/App/Info-Smoke.plist while it was the only Info.plist path.
const firebaseBundle: Level = {
  TARGET_NAME: 'Firebase_FirebaseCore',
  INFOPLIST_FILE: 'Firebase_FirebaseCore_Info.plist',
  SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'SWIFT_PACKAGE',
  EXCLUDED_SOURCE_FILE_NAMES: 'Package.swift',
};

// The App target gets the smoke build.
assert.equal(resolve('INFOPLIST_FILE', [release, app]), 'App/Info-Smoke.plist');
assert.equal(
  resolve('EXCLUDED_SOURCE_FILE_NAMES', [release, app]),
  'Main.storyboard LaunchScreen.storyboard Assets.xcassets',
);
assert.equal(
  resolve('SWIFT_ACTIVE_COMPILATION_CONDITIONS', [release, app]),
  'MPGD_SMOKE_NO_STORYBOARD',
);
assert.equal(resolve('ASSETCATALOG_COMPILER_APPICON_NAME', [release, app]), '');

// Every other target keeps its own values.
assert.equal(
  resolve('INFOPLIST_FILE', [release, firebaseBundle]),
  'Firebase_FirebaseCore_Info.plist',
);
assert.equal(
  resolve('SWIFT_ACTIVE_COMPILATION_CONDITIONS', [release, firebaseBundle]),
  'SWIFT_PACKAGE',
);
assert.equal(resolve('EXCLUDED_SOURCE_FILE_NAMES', [release, firebaseBundle]), 'Package.swift');
assert.equal(resolve('INFOPLIST_FILE', [release, { TARGET_NAME: 'GoogleUtilities' }]), '');

// The Debug smoke keeps the App target's own conditions and adds none.
const debug = commandLine(iosSimulatorSmokeBuildSettings());
assert.equal(debug.SWIFT_ACTIVE_COMPILATION_CONDITIONS, undefined);
assert.equal(
  resolve('SWIFT_ACTIVE_COMPILATION_CONDITIONS', [
    debug,
    { ...app, SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG' },
  ]),
  'DEBUG',
);

// A Swift-package-wide override is exactly what broke Firebase shells: every
// setting a package target defines goes through $(TARGET_NAME) or $(inherited).
for (const [setting, value] of Object.entries(release)) {
  if (setting.startsWith('MPGD_SMOKE_') || setting === 'ASSETCATALOG_COMPILER_APPICON_NAME') {
    continue;
  }
  assert.match(value, /\$\(inherited\)/u, `${setting} must keep other targets' values`);
  assert.match(value, /\$\(TARGET_NAME\)/u, `${setting} must apply to the App target only`);
}

console.info('iOS simulator build settings passed.');
