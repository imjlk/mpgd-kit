import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { satisfies, valid, validRange } from 'semver';

import { stripGradleComments } from './native-shell-identity.js';
import { iosAppBundlesResource, type NativeShellPolicyIssue } from './native-shell-store-policy.js';

// `mpgd target init capacitor --providers crash-reporting`: Firebase
// Crashlytics in the game-owned Capacitor shell. The shell gets the native
// plugin `@capacitor-firebase/crashlytics`, and a freshly generated Android
// project gets the Crashlytics Gradle plugin. The game itself is unchanged:
// `@mpgd/adapter-capacitor` reaches the native plugin by its registered name
// and exposes it as `gateway.crashReporter` (docs/CRASH_REPORTING.md).

export const crashReportingProviderId = 'crash-reporting';
/** The native plugin installed into the shell. */
export const crashReportingPlugin = '@capacitor-firebase/crashlytics';
/** The plugin version this CLI installs when the shell does not list one yet. */
export const crashReportingPluginVersion = '8.5.2';
/**
 * The Crashlytics Gradle plugin, which writes the build ID the Crashlytics
 * Android SDK requires at startup and uploads R8 mapping files. 3.0.8 needs
 * AGP 8.1+, Gradle 8.0+, and the Google services plugin 4.4.1+
 * (https://firebase.google.com/docs/crashlytics/android/get-started).
 */
export const crashlyticsGradlePluginVersion = '3.0.8';
const crashlyticsGradleClasspath =
  `com.google.firebase:firebase-crashlytics-gradle:${crashlyticsGradlePluginVersion}`;
const crashlyticsGradlePluginId = 'com.google.firebase.crashlytics';

const androidRootGradle = 'android/build.gradle';
const androidAppGradle = 'android/app/build.gradle';

/** The manual Android steps for a shell whose Gradle files the CLI does not rewrite. */
export const crashReportingAndroidSteps: readonly string[] = Object.freeze([
  `In android/build.gradle, add classpath '${crashlyticsGradleClasspath}' to buildscript.dependencies, next to the google-services classpath (4.4.1 or later).`,
  `In android/app/build.gradle, add apply plugin: '${crashlyticsGradlePluginId}' right after apply plugin: 'com.google.gms.google-services', inside the same google-services.json check.`,
]);

/**
 * The iOS dSYM note: the plugin captures crashes once `GoogleService-Info.plist`
 * is in the App target, and readable native stack traces need the dSYMs
 * uploaded. `mpgd deploy run` records and uploads them for the archives it
 * builds; an archive made another way needs Firebase's run script or
 * `upload-symbols` (docs/CRASH_REPORTING.md#symbols).
 */
export const crashReportingIosSteps: readonly string[] = Object.freeze([
  'dSYMs: mpgd deploy run uploads them for every App Store build it makes (retry with mpgd '
    + 'deploy symbols). For an archive made in Xcode or another pipeline, add the Crashlytics run '
    + 'script build phase ("${BUILD_DIR%/Build/*}/SourcePackages/checkouts/firebase-ios-sdk/'
    + 'Crashlytics/run") as the last phase of the App target, or run upload-symbols after the '
    + 'archive; see docs/CRASH_REPORTING.md in mpgd-kit.',
]);

export interface PlannedCrashReporting {
  /** The plugin the plan installs into the shell, at the shell's version or this CLI's. */
  readonly shellPlugins: readonly { readonly packageName: string; readonly version: string }[];
  /** `mpgd.native-shell.json` `providers['crash-reporting']`. */
  readonly manifestEntry: Readonly<Record<string, unknown>>;
}

/**
 * Plan the crash-reporting provider before anything is written. Refused when
 * the game's adapter has no crash reporter, when the plugin version is outside
 * the adapter's peer range, or when the shell already has an Android project
 * without the Crashlytics Gradle plugin: the Crashlytics SDK throws at startup
 * without the build ID that plugin writes, so the plugin is never installed
 * into such a project.
 */
export function planCrashReportingProvider(input: {
  readonly gameRoot: string;
  readonly shellPath: string;
  readonly existingShellDependencies: Readonly<Record<string, unknown>> | undefined;
  readonly warnings: string[];
}): PlannedCrashReporting {
  const adapterFile = path.join(
    input.gameRoot,
    'node_modules/@mpgd/adapter-capacitor/package.json',
  );
  const adapter = JSON.parse(
    readFileSync(adapterFile, 'utf8'),
  ) as Readonly<Record<string, unknown>>;
  const adapterExports = adapter.exports;
  if (typeof adapterExports !== 'object' || adapterExports === null
    || (adapterExports as Readonly<Record<string, unknown>>)['./crash-reporting'] === undefined) {
    throw new Error(
      `--providers ${crashReportingProviderId} needs the crash reporter of @mpgd/adapter-capacitor, `
        + `which the game's ${String(adapter.version)} does not have; upgrade the game's kit `
        + 'packages (mpgd kit upgrade) first.',
    );
  }
  const listed = input.existingShellDependencies?.[crashReportingPlugin];
  if (listed !== undefined && (typeof listed !== 'string' || valid(listed) === null)) {
    throw new Error(
      `The shell lists ${crashReportingPlugin} as ${String(listed)}; pin an exact version before rerunning.`,
    );
  }
  const version = typeof listed === 'string' ? listed : crashReportingPluginVersion;
  const peers = typeof adapter.peerDependencies === 'object' && adapter.peerDependencies !== null
    ? adapter.peerDependencies as Readonly<Record<string, unknown>>
    : {};
  const range = peers[crashReportingPlugin];
  if (typeof range === 'string' && validRange(range) !== null
    && !satisfies(version, range, { includePrerelease: true })) {
    throw new Error(
      `@mpgd/adapter-capacitor ${String(adapter.version)} needs ${crashReportingPlugin} ${range}, `
        + `but the shell would get ${version}; align the shell's version before rerunning.`,
    );
  }
  const shellRoot = path.join(input.gameRoot, input.shellPath);
  if (existsSync(path.join(shellRoot, 'android'))
    && !androidShellHasCrashlytics(shellRoot)) {
    throw new Error(
      `--providers ${crashReportingProviderId} installs Firebase Crashlytics, whose Android SDK `
        + 'stops the app at startup unless the Crashlytics Gradle plugin is applied. The existing '
        + 'Android project is game-owned and is not rewritten; first:\n'
        + crashReportingAndroidSteps.map((step) => `- ${step}`).join('\n')
        + '\nthen rerun.',
    );
  }
  // Without the Firebase files Firebase does not start. Android then reports
  // not-configured; the iOS plugin only logs it and still calls Crashlytics,
  // so the plist must ship whenever the plugin does.
  for (const [file, platform] of [
    ['android/app/google-services.json', 'Android'],
    ['ios/App/App/GoogleService-Info.plist', 'iOS'],
  ] as const) {
    if (!existsSync(path.join(shellRoot, file))) {
      input.warnings.push(
        `${crashReportingProviderId}: ${platform} crash reports need ${input.shellPath}/${file} from the `
          + 'Firebase console (the same file notifications use); add it before a release build.',
      );
    }
  }
  const iosProject = path.join(shellRoot, 'ios/App/App.xcodeproj/project.pbxproj');
  if (!existsSync(iosProject) || !iosProjectUploadsCrashlyticsSymbols(readFileSync(iosProject, 'utf8'))) {
    input.warnings.push(`${crashReportingProviderId}: on iOS, ${crashReportingIosSteps.join(' ')}`);
  }
  return {
    shellPlugins: [{ packageName: crashReportingPlugin, version }],
    manifestEntry: {
      packages: { [crashReportingPlugin]: version },
      platforms: ['android', 'ios'],
    },
  };
}

/** Whether an Xcode project runs the Crashlytics dSYM upload script or `upload-symbols`. */
export function iosProjectUploadsCrashlyticsSymbols(project: string): boolean {
  return /Crashlytics\/run\b|\bupload-symbols\b/u.test(project);
}

/** A warning for a shell that still lists the plugin although crash reporting is not requested. */
export function crashReportingRemovalWarning(
  existingShellDependencies: Readonly<Record<string, unknown>>,
): string | undefined {
  return existingShellDependencies[crashReportingPlugin] === undefined
    ? undefined
    : `The shell still lists ${crashReportingPlugin} although ${crashReportingProviderId} is no `
      + 'longer requested; the initializer never removes a plugin, so remove it from the shell '
      + 'package (and the Crashlytics Gradle plugin) and resync if the game stopped reporting crashes.';
}

/** Whether both Android Gradle files apply the Crashlytics Gradle plugin (comments ignored). */
export function androidShellHasCrashlytics(shellRoot: string): boolean {
  const read = (relative: string): string | undefined => {
    const file = path.join(shellRoot, relative);
    return existsSync(file) && lstatSync(file).isFile() ? readFileSync(file, 'utf8') : undefined;
  };
  const root = read(androidRootGradle);
  const app = read(androidAppGradle);
  return root !== undefined && app !== undefined
    && androidRootGradleHasCrashlytics(root) && androidAppGradleHasCrashlytics(app);
}

export function androidRootGradleHasCrashlytics(source: string): boolean {
  return /['"]com\.google\.firebase:firebase-crashlytics-gradle:[^'"]+['"]|\bid\s*\(?\s*['"]com\.google\.firebase\.crashlytics['"]/u
    .test(stripGradleComments(source));
}

/**
 * Whether the app module applies the Crashlytics Gradle plugin: `apply
 * plugin:`, or a plugins-block `id` that is not declared `apply false` (that
 * only puts the plugin on the classpath, as the root project does).
 */
export function androidAppGradleHasCrashlytics(source: string): boolean {
  const clean = stripGradleComments(source);
  if (/\bapply\s+plugin\s*:\s*['"]com\.google\.firebase\.crashlytics['"]/u.test(clean)) {
    return true;
  }
  return clean.split('\n').some((line) =>
    /\bid\s*\(?\s*['"]com\.google\.firebase\.crashlytics['"]/u.test(line)
    && !/\bapply\s*\(?\s*false\b/u.test(line));
}

/**
 * Add the Crashlytics Gradle plugin classpath next to the Google services
 * classpath of the Capacitor template's root `build.gradle`. Returns the
 * source unchanged when it is already there, and `undefined` for a layout the
 * template does not produce.
 */
export function applyAndroidRootGradleCrashlytics(source: string): string | undefined {
  if (androidRootGradleHasCrashlytics(source)) {
    return source;
  }
  const anchor = /^([ \t]*)classpath[ \t]+(['"])com\.google\.gms:google-services:[^'"\n]+\2[ \t]*$/mu.exec(
    source,
  );
  if (anchor === null) {
    return undefined;
  }
  const end = anchor.index + anchor[0].length;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return `${source.slice(0, end)}${newline}${anchor[1] ?? ''}classpath '${crashlyticsGradleClasspath}'${
    source.slice(end)}`;
}

/**
 * Apply the Crashlytics Gradle plugin right after the Google services plugin
 * in the Capacitor template's app `build.gradle`, inside its
 * `google-services.json` check: without that file Firebase does not start, so
 * the Crashlytics SDK and its build ID check stay off too. Returns the source
 * unchanged when it is already applied, and `undefined` for another layout.
 */
export function applyAndroidAppGradleCrashlytics(source: string): string | undefined {
  if (androidAppGradleHasCrashlytics(source)) {
    return source;
  }
  const anchor = /^([ \t]*)apply[ \t]+plugin[ \t]*:[ \t]*(['"])com\.google\.gms\.google-services\2[ \t]*$/mu
    .exec(source);
  if (anchor === null) {
    return undefined;
  }
  const end = anchor.index + anchor[0].length;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return `${source.slice(0, end)}${newline}${anchor[1] ?? ''}apply plugin: '${crashlyticsGradlePluginId}'${
    source.slice(end)}`;
}

/**
 * Wire the Crashlytics Gradle plugin into a freshly generated Android project.
 * Both files are checked before either is written; a layout the template does
 * not produce is refused with the manual steps.
 */
export function materializeAndroidCrashlytics(shellRoot: string): void {
  const rootFile = path.join(shellRoot, androidRootGradle);
  const appFile = path.join(shellRoot, androidAppGradle);
  for (const file of [rootFile, appFile]) {
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      throw new Error(`The generated Android project has no ${path.relative(shellRoot, file)}.`);
    }
  }
  const rootSource = readFileSync(rootFile, 'utf8');
  const appSource = readFileSync(appFile, 'utf8');
  const nextRoot = applyAndroidRootGradleCrashlytics(rootSource);
  const nextApp = applyAndroidAppGradleCrashlytics(appSource);
  if (nextRoot === undefined || nextApp === undefined) {
    throw new Error(
      'The generated Android project has an unexpected Gradle layout; apply the Crashlytics '
        + 'Gradle plugin yourself:\n'
        + crashReportingAndroidSteps.map((step) => `- ${step}`).join('\n'),
    );
  }
  if (nextRoot !== rootSource) {
    writeFileSync(rootFile, nextRoot);
  }
  if (nextApp !== appSource) {
    writeFileSync(appFile, nextApp);
  }
}

/** Whether the shell's package.json installs the Crashlytics plugin (`--providers crash-reporting`). */
export function shellUsesCrashlytics(shellPackage: unknown): boolean {
  if (typeof shellPackage !== 'object' || shellPackage === null) {
    return false;
  }
  const { dependencies, devDependencies } = shellPackage as Readonly<Record<string, unknown>>;
  return [dependencies, devDependencies].some((entries) =>
    typeof entries === 'object' && entries !== null
    && (entries as Readonly<Record<string, unknown>>)[crashReportingPlugin] !== undefined);
}

/**
 * Store-policy preflight for a shell that installs the Crashlytics plugin.
 * Errors fail a production build (`reportNativeStorePolicy`); other profiles
 * print them.
 *
 * - Android: `android/app/google-services.json` must be present (without it
 *   Firebase does not start and the release reports nothing), and the app
 *   module must apply the Crashlytics Gradle plugin (without its build ID the
 *   Crashlytics SDK stops the app at startup once Firebase starts).
 * - iOS: the App target must bundle `GoogleService-Info.plist`; without it
 *   Firebase does not start and the plugin still calls Crashlytics.
 */
export function inspectCrashReportingShell(input: {
  readonly platform: 'android' | 'ios';
  readonly shellApp: string;
  readonly shellPackage: unknown;
  /** The App target's `project.pbxproj` source, for iOS. */
  readonly iosProject?: string;
}): readonly NativeShellPolicyIssue[] {
  if (!shellUsesCrashlytics(input.shellPackage)) {
    return [];
  }
  const issues: NativeShellPolicyIssue[] = [];
  if (input.platform === 'android') {
    const config = path.join(input.shellApp, 'android/app/google-services.json');
    if (!existsSync(config) || !lstatSync(config).isFile() || readFileSync(config, 'utf8').trim() === '') {
      issues.push({
        level: 'error',
        message: `The shell installs ${crashReportingPlugin}, but android/app/google-services.json is `
          + 'missing; Firebase does not start and the release reports no crashes. Download it from the '
          + 'Firebase console (the same file notifications use).',
      });
    }
    if (!androidShellHasCrashlytics(input.shellApp)) {
      issues.push({
        level: 'error',
        message: `The shell installs ${crashReportingPlugin}, but the Android project does not apply the `
          + 'Crashlytics Gradle plugin; the Crashlytics SDK stops the app at startup without the build ID '
          + `it writes. ${crashReportingAndroidSteps.join(' ')}`,
      });
    }
    return issues;
  }
  if (input.iosProject !== undefined && !iosAppBundlesResource(input.iosProject, 'GoogleService-Info.plist')) {
    issues.push({
      level: 'error',
      message: `The shell installs ${crashReportingPlugin}, but the iOS App target does not bundle `
        + 'GoogleService-Info.plist; Firebase does not start and the plugin still calls Crashlytics. '
        + 'Download it from the Firebase console and add it to the App target in Xcode.',
    });
  }
  return issues;
}
