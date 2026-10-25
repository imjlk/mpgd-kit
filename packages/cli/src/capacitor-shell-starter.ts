import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { satisfies, valid, validRange } from 'semver';

import {
  capacitorGatewayRegistersNotifications,
  conflictingPushPlugin,
  notificationsCapacitorGatewayModules,
  notificationsCapacitorGateways,
  notificationsCapacitorSupportFiles,
  notificationsCapacitorTemplateSupportFiles,
  notificationsCapacitorTemplateSupportImporters,
  notificationsGameDependencies,
  notificationsMessagingFirebaseRange,
  notificationsMessagingPlugin,
  notificationsProviderId,
  notificationsShellPlugins,
  sourceReferencesRelativeModule,
  wireCapacitorGatewayNotifications,
} from './notifications-starter.js';
import {
  applyAndroidManifestOrientation,
  applyIosInfoPlistOrientation,
  applyIosInfoPlistStorePolicy,
  applyIosProjectDeviceFamily,
  readGameNativeOrientation,
  readIosDeviceFamily,
  type IosDeviceFamily,
  type NativeShellOrientation,
} from './native-shell-store-policy.js';
import { isNonPublicServiceHostname } from './production-target-readiness.js';
import {
  assertAndroidSettingsAppProject,
  assertAndroidSettingsNoAppRemap,
  assertIosReleaseInfoPlistExpansion,
  assertIosReleasePackagingSettings,
  assertIosReleaseProductName,
  assertNativeShellIdentity,
  hasAndroidDisplayNameResourceOverride,
  hasAndroidManifestSourceSetOverride,
  hasAndroidResourceSourceSetOverride,
  hasGradleIdentityMutation,
  hasGradleTaskAction,
  maskGradleStrings,
  readIosAppTargetId,
  readIosReleaseInfoPlist,
  stripGradleComments,
} from './native-shell-identity.js';

const shellPath = 'apps/mobile-capacitor';
const webPath = `${shellPath}/www`;
const referenceShellPath = '${MPGD_KIT_PATH}/apps/mobile-capacitor';
const providerIdPattern = /^[a-z][a-z0-9-]*$/u;
const appIdPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u;
const javaKeywords = new Set(`
  abstract assert boolean break byte case catch char class const continue default do double
  else enum extends final finally float for goto if implements import instanceof int interface
  long native new package private protected public return short static strictfp super switch
  synchronized this throw throws transient try void volatile while true false null record sealed
  permits var yield
`.trim().split(/\s+/u));

interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * A provider id that names a kit native store plugin. `--providers` installs
 * the plugin package into the game-owned shell (where `cap add` or `cap sync`
 * registers its native code), declares it in the game (where the Vite bundle
 * imports it from the gateway file), and wires the gateway when the game still
 * has the unwired template gateway; any other id stays selection metadata.
 */
export interface CapacitorShellProviderPlugin {
  readonly id: string;
  readonly packageName: string;
  /** The plugin's directory in a kit checkout, read when the game has not installed it yet. */
  readonly packageDir: string;
  /** The native platform, which is also the canonical `mpgd.targets.json` target name. */
  readonly platform: 'android' | 'ios';
  /** The game gateway file expected to register the plugin's service provider. */
  readonly gatewayFile: string;
  readonly gatewayFactory: string;
  /**
   * Gateway sources the initializer may replace with the template's wired
   * gateway: the unwired gateway earlier templates generated. Any other
   * source is game-owned and only checked.
   */
  readonly legacyGatewaySources: readonly string[];
}

const unwiredCapacitorGateway = (target: 'android' | 'ios'): string => [
  "import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';",
  "import type { PlatformGateway } from '@mpgd/platform';",
  '',
  "import type { RuntimeConfig } from '../runtimeDetector';",
  '',
  'export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {',
  '  return createCapacitorPlatformGateway({',
  `    target: '${target}',`,
  '    appVersion: runtime.appVersion,',
  '    buildId: runtime.buildId,',
  '  });',
  '}',
  '',
].join('\n');

export const capacitorShellProviderPlugins: readonly CapacitorShellProviderPlugin[] = Object.freeze(
  [
    {
      id: 'play-billing',
      packageName: '@mpgd/capacitor-play-billing',
      packageDir: 'native-plugins/capacitor-play-billing',
      platform: 'android',
      gatewayFile: 'src/platform/buildGateways/capacitorAndroid.ts',
      gatewayFactory: 'createCapacitorPlayBillingServiceProvider',
      legacyGatewaySources: [unwiredCapacitorGateway('android')],
    },
    {
      id: 'storekit',
      packageName: '@mpgd/capacitor-storekit',
      packageDir: 'native-plugins/capacitor-storekit',
      platform: 'ios',
      gatewayFile: 'src/platform/buildGateways/capacitorIos.ts',
      gatewayFactory: 'createCapacitorStoreKitServiceProvider',
      legacyGatewaySources: [unwiredCapacitorGateway('ios')],
    },
  ],
);

/**
 * Game modules the wired template gateways import. They are written next to a
 * replaced legacy gateway when missing; a game-owned copy that differs from
 * the template keeps the legacy gateway in place.
 */
export const capacitorShellProviderSupportFiles: readonly string[] = Object.freeze([
  'src/platform/commerceProducts.ts',
  'src/platform/commerceAccountBinding.ts',
]);

/** A plugin the plan installs, with the exact version the shell and the game pin. */
export interface CapacitorShellPlannedProviderPlugin extends CapacitorShellProviderPlugin {
  readonly version: string;
  /** `installed`: the game's copy; `kit`: the version this CLI release ships with. */
  readonly versionSource: 'installed' | 'kit';
}

export interface CapacitorShellStarterInput {
  readonly gameRoot: string;
  readonly appId: string;
  readonly displayName: string;
  readonly iconSource?: string;
  readonly backendUrl?: string;
  /**
   * Requested provider ids. The ids in `capacitorShellProviderPlugins`
   * (`play-billing`, `storekit`) install their native plugin package into the
   * shell and the game; other ids are recorded as selection metadata only.
   */
  readonly providerIds?: readonly string[];
  /**
   * The CLI's game template. With it a legacy, unwired Android or iOS gateway
   * is replaced by the template's store-provider wiring; without it the plan
   * only checks the gateway and warns.
   */
  readonly templateRoot?: string;
}

export interface CapacitorShellStarterPlan {
  readonly gameRoot: string;
  readonly input: CapacitorShellStarterInput;
  readonly changedFiles: readonly string[];
  readonly nativePlatformsToAdd: readonly ('android' | 'ios')[];
  readonly files: readonly PlannedFile[];
  /** Native store plugins the plan installs into the shell and declares in the game. */
  readonly providerPlugins: readonly CapacitorShellPlannedProviderPlugin[];
  /**
   * The notifications plugins (`--providers notifications`) the plan installs
   * into the shell, for Android and iOS, at the game's versions; empty when
   * notifications are not requested.
   */
  readonly notificationPlugins: readonly { readonly packageName: string; readonly version: string }[];
  /**
   * Store wiring the plan could not write or confirm: a missing or game-owned
   * gateway that does not register the plugin, or a store plugin the shell
   * keeps although it is no longer requested. Printed; game source is never
   * rewritten for these.
   */
  readonly warnings: readonly string[];
}

/**
 * Produce the complete game-owned shell change list before writing anything.
 * Existing Android/iOS projects, signing files, and custom controllers are
 * never rewritten by this initializer.
 */
export function planCapacitorShellStarter(input: CapacitorShellStarterInput): CapacitorShellStarterPlan {
  if (!existsSync(input.gameRoot)) {
    throw new Error(`Game root does not exist: ${input.gameRoot}`);
  }
  const gameRoot = realpathSync(input.gameRoot);
  if (!lstatSync(gameRoot).isDirectory()) {
    throw new Error('Capacitor shell game root must be a directory.');
  }
  assertCapacitorAppId(input.appId);
  if (input.displayName.trim() !== input.displayName
    || input.displayName.length === 0 || input.displayName.length > 80) {
    throw new Error('Capacitor display name must be 1-80 characters without outer whitespace.');
  }
  if (/\$\(|\$\{/u.test(input.displayName)) {
    throw new Error('Capacitor display name cannot contain Xcode build-setting expansions.');
  }
  if (/[\t\n]/u.test(input.displayName)) {
    throw new Error('Capacitor display name cannot contain native whitespace controls.');
  }
  for (const scalar of input.displayName) {
    const point = scalar.codePointAt(0) ?? 0;
    if (point !== 0x9 && point !== 0xa
      && !(point >= 0x20 && point <= 0xd7ff)
      && !(point >= 0xe000 && point <= 0xfffd)
      && !(point >= 0x10000 && point <= 0x10ffff)) {
      throw new Error('Capacitor display name contains a character invalid in native XML.');
    }
  }
  const providerIds = [...new Set(input.providerIds ?? [])].sort();
  if (providerIds.some((id) => !providerIdPattern.test(id))) {
    throw new Error('Capacitor provider IDs must be lowercase hyphenated names.');
  }
  const backendUrl = input.backendUrl === undefined
    ? undefined
    : normalizeBackendUrl(input.backendUrl);
  const iconSource = input.iconSource === undefined
    ? undefined
    : relativeGameFile(gameRoot, input.iconSource);
  for (const managedPath of [
    'mpgd.targets.json',
    shellPath,
    `${shellPath}/package.json`,
    `${shellPath}/capacitor.config.ts`,
    `${shellPath}/mpgd.native-shell.json`,
    `${shellPath}/README.md`,
    `${shellPath}/www/index.html`,
    `${shellPath}/android`,
    `${shellPath}/ios`,
  ]) {
    safeDestination(gameRoot, managedPath);
  }
  const gamePackageFile = path.join(gameRoot, 'package.json');
  if (!existsSync(gamePackageFile)) {
    throw new Error('Game root must contain package.json.');
  }
  const gamePackage = readJsonObject(gamePackageFile);
  const gamePackageName = requireString(gamePackage.name, 'game package name');
  const gameDependencies = requireObject(gamePackage.dependencies, 'game dependencies');
  const capacitorVersion = requireString(gameDependencies['@capacitor/core'], '@capacitor/core');
  const appVersion = requireString(gameDependencies['@capacitor/app'], '@capacitor/app');
  if (!/^\d+\.\d+\.\d+$/u.test(capacitorVersion)
    || !/^\d+\.\d+\.\d+$/u.test(appVersion)) {
    throw new Error('Capacitor shell requires exact @capacitor/core and @capacitor/app versions.');
  }
  if (!capacitorVersion.startsWith('8.') || !appVersion.startsWith('8.')) {
    throw new Error('Capacitor shell requires Capacitor 8.x for core and app.');
  }
  const adapterFile = path.join(gameRoot, 'node_modules/@mpgd/adapter-capacitor/package.json');
  if (!existsSync(adapterFile)) {
    throw new Error('Install game dependencies before initializing the Capacitor shell.');
  }
  const adapter = readJsonObject(adapterFile);
  const adapterDependencies = requireObject(adapter.dependencies, 'Capacitor adapter dependencies');
  const pluginRequirement = requireString(
    adapterDependencies['@mpgd/capacitor-game-services'],
    '@mpgd/capacitor-game-services',
  );
  const pluginVersion = resolveInstalledPluginVersion(gameRoot, pluginRequirement);

  const targetsFile = path.join(gameRoot, 'mpgd.targets.json');
  if (!existsSync(targetsFile)) {
    throw new Error('Game root must contain mpgd.targets.json.');
  }
  const targets = readJsonObject(targetsFile);
  const cliPackage = readJsonObject(fileURLToPath(new URL('../package.json', import.meta.url)));
  const cliDevelopmentDependencies = requireObject(
    cliPackage.devDependencies,
    'CLI dev dependencies',
  );
  const typescriptVersion = requireString(
    cliDevelopmentDependencies.typescript,
    'CLI TypeScript version',
  );
  const targetMap = requireObject(targets.targets, 'targets');
  // Fail before anything is installed or generated when the store-facing
  // native settings are invalid; they are applied after `cap add`.
  readNativeShellSettings(gameRoot);
  for (const plugin of capacitorShellProviderPlugins) {
    if (providerIds.includes(plugin.id) && targetMap[plugin.platform] === undefined) {
      throw new Error(
        `--providers ${plugin.id} installs the ${plugin.platform} store plugin into the native `
          + `shell, but mpgd.targets.json has no ${plugin.platform} target. Add the `
          + `capacitor-${plugin.platform} target before requesting store providers.`,
      );
    }
  }
  for (const [targetName, kind, identityKey] of [
    ['android', 'capacitor-android', 'packageId'],
    ['ios', 'capacitor-ios', 'bundleId'],
  ] as const) {
    if (targetMap[targetName] === undefined) {
      throw new Error(
        `Capacitor initialization requires the canonical ${targetName} target name used by the build CLI.`,
      );
    }
    const target = requireObject(targetMap[targetName], `${targetName} target`);
    if (target.kind !== kind) {
      throw new Error(`${targetName} must be a ${kind} target.`);
    }
    const configuredGame = requireString(target.gameApp, `${targetName}.gameApp`);
    if (path.resolve(gameRoot, configuredGame) !== gameRoot) {
      throw new Error(`${targetName}.gameApp must select this game root.`);
    }
    if (requireString(target.adapter, `${targetName}.adapter`) !== 'capacitor') {
      throw new Error(`${targetName}.adapter must be capacitor.`);
    }
    const configuredShell = requireString(target.shellApp, `${targetName}.shellApp`);
    if (configuredShell !== shellPath && configuredShell !== referenceShellPath) {
      throw new Error(`${targetName} already points at another shell; refusing to replace it.`);
    }
    const metadata = target.metadata === undefined
      ? {}
      : requireObject(target.metadata, `${targetName}.metadata`);
    if (metadata[identityKey] !== undefined && metadata[identityKey] !== input.appId) {
      throw new Error(`${targetName} ${identityKey} conflicts with the requested app ID.`);
    }
    if (metadata.displayName !== undefined && metadata.displayName !== input.displayName) {
      throw new Error(`${targetName} display name conflicts with the requested name.`);
    }
    const expectedArtifact = targetName === 'android' ? 'aab' : 'ipa';
    if (target.artifact === undefined) {
      target.artifact = expectedArtifact;
    } else if (target.artifact !== expectedArtifact) {
      throw new Error(`${targetName}.artifact must be ${expectedArtifact} for this native shell.`);
    }
    target.shellApp = shellPath;
    target.webDir = webPath;
    target.metadata = { ...metadata, [identityKey]: input.appId, displayName: input.displayName };
    if (iconSource !== undefined) {
      const icon = target.icon === undefined
        ? {}
        : requireObject(target.icon, `${targetName}.icon`);
      target.icon = { ...icon, source: iconSource };
    }
  }

  const packageFile = path.join(gameRoot, shellPath, 'package.json');
  const configFile = path.join(gameRoot, shellPath, 'capacitor.config.ts');
  const manifestFile = path.join(gameRoot, shellPath, 'mpgd.native-shell.json');
  const packageContent = readExisting(packageFile);
  const configContent = readExisting(configFile);
  const manifestContent = readExisting(manifestFile);
  const existingManifest = manifestContent === undefined
    ? undefined
    : parseJsonObject(manifestContent, 'existing native shell manifest');
  if (existingManifest !== undefined && existingManifest.schemaVersion !== 1) {
    throw new Error(
      'Existing native shell manifest schema is unsupported; refusing to downgrade it.',
    );
  }
  if (existingManifest !== undefined
    && (existingManifest.appId !== input.appId
      || existingManifest.displayName !== input.displayName)) {
    throw new Error('Existing native shell identity differs; refusing to overwrite it.');
  }
  const requestedProviderIds: readonly string[] = input.providerIds === undefined
    && Array.isArray(existingManifest?.requestedProviderIds)
    ? existingManifest.requestedProviderIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : providerIds;
  const requestedBackendUrl = backendUrl ?? (typeof existingManifest?.backendUrl === 'string'
    ? existingManifest.backendUrl : undefined);
  // Store plugins are pinned to one exact version in the shell and the game:
  // the game's installed copy when it has one, otherwise the version this CLI
  // release ships with, which the plan adds to the game as well. The Vite
  // bundle imports the plugin from the gateway file, and its native code must
  // match that JavaScript.
  const providerPlugins: CapacitorShellPlannedProviderPlugin[] = capacitorShellProviderPlugins
    .filter((plugin) => requestedProviderIds.includes(plugin.id))
    .map((plugin) => resolveProviderPlugin(gameRoot, gameDependencies, cliDevelopmentDependencies, plugin));
  const warnings: string[] = [];
  const storeGatewayFiles = planProviderGatewayWiring(
    gameRoot,
    input.templateRoot,
    providerPlugins,
    warnings,
  );
  const notifications = requestedProviderIds.includes(notificationsProviderId)
    ? planNotificationsProvider({
        gameRoot,
        templateRoot: input.templateRoot,
        displayName: input.displayName,
        gameDependencies,
        existingShellPackage: packageContent,
        plannedGateways: storeGatewayFiles,
        warnings,
      })
    : undefined;
  // The notifications wiring builds on the store wiring of the same gateway.
  const gatewayFiles = [
    ...storeGatewayFiles.filter((file) =>
      notifications?.files.some((planned) => planned.path === file.path) !== true),
    ...(notifications?.files ?? []),
  ];
  const notificationPlugins = notifications?.shellPlugins ?? [];
  if (packageContent !== undefined) {
    const existingShellDependencies = requireObject(
      parseJsonObject(packageContent, 'existing shell package').dependencies,
      'existing shell dependencies',
    );
    for (const plugin of capacitorShellProviderPlugins) {
      if (
        existingShellDependencies[plugin.packageName] !== undefined
        && !providerPlugins.some((planned) => planned.id === plugin.id)
      ) {
        warnings.push(
          `The shell still lists ${plugin.packageName} although ${plugin.id} is no longer `
            + 'requested; the initializer never removes a store plugin, so remove it from the '
            + 'shell package and resync if the game stopped selling there.',
        );
      }
    }
    if (notifications === undefined) {
      for (const name of notificationsShellPlugins) {
        if (existingShellDependencies[name] !== undefined) {
          warnings.push(
            `The shell still lists ${name} although ${notificationsProviderId} is no longer `
              + 'requested; the initializer never removes a plugin, so remove it from the shell '
              + 'package and resync if the game stopped sending notifications.',
          );
        }
      }
    }
  }
  if (notifications !== undefined) {
    // The starter exposes notifications on both platforms; the provider still
    // reports its own readiness (no plugin, no Firebase files), which the
    // target config follows. A state the game set itself is kept.
    for (const targetName of ['android', 'ios'] as const) {
      const target = requireObject(targetMap[targetName], `${targetName} target`);
      const integrations = target.integrations === undefined
        ? {}
        : requireObject(target.integrations, `${targetName}.integrations`);
      if (integrations.notifications === undefined) {
        target.integrations = { ...integrations, notifications: 'available' };
      } else if (
        integrations.notifications !== 'available'
        && integrations.notifications !== 'action-required'
      ) {
        warnings.push(
          `mpgd.targets.json keeps ${targetName}.integrations.notifications at `
            + `${String(integrations.notifications)}, which hides notifications from the game; set it `
            + 'to available once the shell is configured.',
        );
      }
    }
  }
  const shellDependencies: Record<string, string> = {
    '@capacitor/android': capacitorVersion,
    '@capacitor/app': appVersion,
    '@capacitor/core': capacitorVersion,
    '@capacitor/ios': capacitorVersion,
    '@mpgd/capacitor-game-services': pluginVersion,
    ...Object.fromEntries(providerPlugins.map((plugin) => [plugin.packageName, plugin.version])),
    ...Object.fromEntries(notificationPlugins.map((plugin) => [plugin.packageName, plugin.version])),
  };
  if (packageContent !== undefined) {
    assertCompatibleExistingPackage(
      packageContent,
      shellDependencies,
      capacitorVersion,
      typescriptVersion,
    );
  }
  if (configContent !== undefined) {
    const safeConfig = requireStaticCapacitorConfig(configContent);
    const existingAppId = readCapacitorConfigLiteral(safeConfig, 'appId');
    if (existingAppId === undefined) {
      throw new Error('Existing Capacitor shell app ID could not be read safely.');
    }
    if (existingAppId !== input.appId) {
      throw new Error('Existing Capacitor shell app ID differs; refusing to overwrite it.');
    }
    const existingAppName = readCapacitorConfigLiteral(safeConfig, 'appName');
    if (existingAppName === undefined) {
      throw new Error('Existing Capacitor shell display name could not be read safely.');
    }
    if (existingAppName !== input.displayName) {
      throw new Error('Existing Capacitor shell display name differs; refusing to overwrite it.');
    }
    const existingWebDir = readCapacitorConfigLiteral(safeConfig, 'webDir');
    if (existingWebDir !== 'www') {
      throw new Error('Existing Capacitor shell webDir differs; refusing to overwrite it.');
    }
  }
  const requestedFiles: PlannedFile[] = [
    { path: 'mpgd.targets.json', content: json(targets) },
    {
      path: `${shellPath}/package.json`,
      content: packageContent === undefined
        ? json({
            name: `${gamePackageName}-native-shell`,
            private: true,
            version: '0.0.0',
            type: 'module',
            scripts: {
              cap: 'cap',
              'sync:android': 'cap sync android',
              'sync:ios': 'cap sync ios',
            },
            dependencies: shellDependencies,
            devDependencies: {
              '@capacitor/cli': capacitorVersion,
              typescript: typescriptVersion,
            },
          })
        : withPackageDependencies(packageContent, [...providerPlugins, ...notificationPlugins]),
    },
    {
      path: `${shellPath}/capacitor.config.ts`,
      content: configContent ?? [
        "import type { CapacitorConfig } from '@capacitor/cli';",
        '',
        'const config: CapacitorConfig = {',
        `  appId: ${JSON.stringify(input.appId)},`,
        `  appName: ${JSON.stringify(input.displayName)},`,
        "  webDir: 'www',",
        "  server: { androidScheme: 'https' },",
        "  ios: { contentInset: 'automatic' },",
        '  android: { allowMixedContent: false },',
        '};',
        '',
        'export default config;',
        '',
      ].join('\n'),
    },
    {
      path: `${shellPath}/mpgd.native-shell.json`,
      content: json({
        schemaVersion: 1,
        appId: input.appId,
        displayName: input.displayName,
        requestedProviderIds,
        ...(providerPlugins.length === 0 && notificationPlugins.length === 0
          ? {}
          : {
              providers: {
                ...Object.fromEntries(providerPlugins.map((plugin) => [
                  plugin.id,
                  {
                    package: plugin.packageName,
                    version: plugin.version,
                    platform: plugin.platform,
                  },
                ])),
                ...(notificationPlugins.length === 0
                  ? {}
                  : {
                      [notificationsProviderId]: {
                        packages: Object.fromEntries(
                          notificationPlugins.map((plugin) => [plugin.packageName, plugin.version]),
                        ),
                        platforms: ['android', 'ios'],
                      },
                    }),
              },
            }),
        ...(requestedBackendUrl === undefined ? {} : { backendUrl: requestedBackendUrl }),
      }),
    },
    {
      path: `${shellPath}/README.md`,
      content: readExisting(path.join(gameRoot, shellPath, 'README.md')) ?? [
        '# Game-owned Capacitor shell',
        '',
        'This private shell belongs to this game. The initializer installs game',
        'dependencies and uses the pinned Capacitor CLI to add missing Android',
        'and iOS projects. Rerun it after an interrupted dependency install.',
        'If cap add left an incomplete native directory, repair or remove only',
        'that game-owned directory before retrying; it is never overwritten.',
        'Existing native files, signing settings, and custom',
        'ViewControllers are never replaced by mpgd target init capacitor.',
        '',
        'requestedProviderIds is selection metadata, except play-billing and',
        'storekit: those install the kit store plugin into this shell and the game',
        'and register it with cap sync; notifications installs',
        '@capacitor-firebase/messaging and @capacitor/local-notifications (never',
        `${conflictingPushPlugin}, which claims the same iOS push handler).`,
        'Notifications also need the Firebase files (google-services.json,',
        'GoogleService-Info.plist) and the iOS Push Notifications capability; see',
        'the mpgd-kit Firebase guide. A plugin never reports a feature as',
        'available on its own; the gateway registers the store provider, and the',
        'store answers configuration-required until the plugin and products exist.',
        'Production builds require a real game-owned backend when grants are enabled.',
        '',
      ].join('\n'),
    },
    {
      path: `${shellPath}/www/index.html`,
      content: readExisting(path.join(gameRoot, shellPath, 'www/index.html')) ?? [
        '<!doctype html>',
        '<html lang="en"><head><meta charset="utf-8"><title>Native shell setup</title></head>',
        '<body>Run mpgd target build to replace this setup page with the game bundle.</body></html>',
        '',
      ].join('\n'),
    },
  ];
  if (requestedBackendUrl !== undefined) {
    safeDestination(gameRoot, '.env.production');
    safeDestination(gameRoot, '.env.production.local');
    const validatedBackendUrl = normalizeBackendUrl(requestedBackendUrl);
    const localEnv = readExisting(path.join(gameRoot, '.env.production.local')) ?? '';
    const localDefinitions = [...localEnv.replace(/^\uFEFF/u, '').matchAll(
      /^[ \t]*(?:export[ \t]+)?VITE_MPGD_GAME_SERVICES_URL[ \t]*=[ \t]*(.*)$/gmu,
    )];
    if (localDefinitions.length > 1) {
      throw new Error('Duplicate production-local Game Services URLs are not allowed.');
    }
    if (localDefinitions[0]?.[1] !== undefined
      && normalizeBackendUrl(readDotenvValue(localDefinitions[0][1] ?? ''))
        !== validatedBackendUrl) {
      throw new Error('Production-local Game Services URL conflicts with the requested shell.');
    }
    const envFile = path.join(gameRoot, '.env.production');
    const current = readExisting(envFile) ?? '';
    const definitions = [...current.replace(/^\uFEFF/u, '').matchAll(
      /^[ \t]*(?:export[ \t]+)?VITE_MPGD_GAME_SERVICES_URL[ \t]*=[ \t]*(.*)$/gmu,
    )];
    if (definitions.length > 1) {
      throw new Error('Duplicate production Game Services URLs are not allowed.');
    }
    const existing = definitions[0]?.[1] === undefined
      ? undefined
      : readDotenvValue(definitions[0][1] ?? '');
    if (existing !== undefined && normalizeBackendUrl(existing) !== validatedBackendUrl) {
      throw new Error('Existing production Game Services URL differs; refusing to overwrite it.');
    }
    requestedFiles.push({
      path: '.env.production',
      content: existing === undefined
        ? appendEnvLine(current, `VITE_MPGD_GAME_SERVICES_URL=${validatedBackendUrl}`)
        : current,
    });
  }
  requestedFiles.push(...gatewayFiles);
  // The game bundle imports the plugin from its gateway file, so the game
  // declares it too, at the shell's exact version; the materializer's game
  // install picks it up.
  const missingGameDependencies = [
    ...providerPlugins.map((plugin) => [plugin.packageName, plugin.version] as const),
    ...Object.entries(notifications?.gameDependencies ?? {}),
  ].filter(([name]) => gameDependencies[name] === undefined);
  const gameScripts = gamePackage.scripts === undefined
    ? {}
    : requireObject(gamePackage.scripts, 'game scripts');
  const validatorPresent = notifications !== undefined
    && (notifications.files.some((file) => file.path === 'tools/validate-notifications.ts')
      || readExisting(safeDestination(gameRoot, 'tools/validate-notifications.ts')) !== undefined);
  const missingScripts = !validatorPresent || gameScripts['validate:notifications'] !== undefined
    ? {}
    : {
        'validate:notifications': 'ttsx --project tsconfig.tools.json tools/validate-notifications.ts',
      };
  if (missingGameDependencies.length > 0 || Object.keys(missingScripts).length > 0) {
    safeDestination(gameRoot, 'package.json');
    requestedFiles.push({
      path: 'package.json',
      content: json({
        ...gamePackage,
        ...(Object.keys(missingScripts).length === 0
          ? {}
          : { scripts: { ...gameScripts, ...missingScripts } }),
        dependencies: {
          ...gameDependencies,
          ...Object.fromEntries(missingGameDependencies),
        },
      }),
    });
  }
  const nativePlatformsToAdd = (['android', 'ios'] as const).filter((platform) => {
    const nativeDirectory = path.join(gameRoot, shellPath, platform);
    if (!existsSync(nativeDirectory)) {
      return true;
    }
    assertNativePlatformComplete(gameRoot, platform, input.appId, input.displayName);
    return false;
  });
  const smokePath = `${shellPath}/ios/App/App/Info-Smoke.plist`;
  safeDestination(gameRoot, smokePath);
  if (readExisting(path.join(gameRoot, smokePath)) === undefined) {
    requestedFiles.push({ path: smokePath, content: smokeInfoPlist(input.displayName) });
  }
  const files = requestedFiles.filter(
    (file) => readExisting(path.join(gameRoot, file.path)) !== file.content,
  );
  return {
    gameRoot,
    input: {
      ...input,
      gameRoot,
      ...(input.providerIds === undefined ? {} : { providerIds: [...input.providerIds] }),
    },
    files,
    changedFiles: files.map((file) => file.path),
    nativePlatformsToAdd,
    providerPlugins,
    notificationPlugins,
    warnings,
  };
}

export function assertCapacitorAppId(appId: string): void {
  if (!appIdPattern.test(appId)) {
    throw new Error('Capacitor app ID must be a lowercase reverse-domain identifier.');
  }
  if (appId.split('.').some((segment) => javaKeywords.has(segment))) {
    throw new Error('Capacitor app ID cannot contain Java keyword segments.');
  }
}

export function applyCapacitorShellStarter(
  plan: CapacitorShellStarterPlan,
  installStagedFile: (temporary: string, destination: string) => void = renameSync,
): void {
  const staged = plan.files.filter((file) => !plan.nativePlatformsToAdd.some((platform) =>
    file.path.startsWith(`${shellPath}/${platform}/`))).map((file) => {
    const destination = safeDestination(plan.gameRoot, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    assertNotSymlink(destination);
    const previous = existsSync(destination) ? lstatSync(destination) : undefined;
    if (previous !== undefined && !previous.isFile()) {
      throw new Error(`Managed shell destination must be a file: ${destination}`);
    }
    const temporary = `${destination}.mpgd-${randomUUID()}.tmp`;
    return {
      destination,
      temporary,
      previousMode: previous === undefined ? undefined : previous.mode & 0o7777,
      content: file.content,
    };
  });
  const installed: { destination: string; backup?: string }[] = [];
  try {
    for (const file of staged) {
      writeFileSync(file.temporary, file.content, {
        flag: 'wx',
        mode: file.previousMode ?? 0o666,
      });
      if (file.previousMode !== undefined) {
        chmodSync(file.temporary, file.previousMode);
      }
    }
    for (const file of staged) {
      const entry: { destination: string; backup?: string } = { destination: file.destination };
      if (file.previousMode !== undefined) {
        entry.backup = `${file.destination}.mpgd-${randomUUID()}.backup`;
        renameSync(file.destination, entry.backup);
      }
      installed.push(entry);
      installStagedFile(file.temporary, file.destination);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const entry of installed.reverse()) {
      try {
        if (existsSync(entry.destination)) {
          unlinkSync(entry.destination);
        }
        if (entry.backup !== undefined && existsSync(entry.backup)) {
          renameSync(entry.backup, entry.destination);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'Capacitor shell rollback failed.');
    }
    throw error;
  } finally {
    for (const file of staged) {
      if (existsSync(file.temporary)) {
        unlinkSync(file.temporary);
      }
    }
  }
  for (const entry of installed) {
    if (entry.backup !== undefined) {
      unlinkSync(entry.backup);
    }
  }
}

function safeDestination(gameRoot: string, relative: string): string {
  if (relative === '' || path.isAbsolute(relative)) {
    throw new Error('Managed shell path must be relative to the game.');
  }
  const canonicalRoot = realpathSync(gameRoot);
  const destination = path.resolve(canonicalRoot, relative);
  const within = path.relative(canonicalRoot, destination);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error('Managed shell path must stay inside the game.');
  }
  let current = canonicalRoot;
  for (const segment of within.split(path.sep)) {
    current = path.join(current, segment);
    assertNotSymlink(current);
  }
  return destination;
}

export interface CapacitorShellCommandRunner {
  run(command: string, args: readonly string[], cwd: string): void;
}

/** Materialize only missing native projects after the non-destructive plan is applied. */
export function materializeCapacitorShellStarter(
  plan: CapacitorShellStarterPlan,
  runner: CapacitorShellCommandRunner = { run: runCommand },
): void {
  applyCapacitorShellStarter(plan);
  // Native projects are generated by the pinned Capacitor CLI within the
  // game workspace. An existing game may exclude the new shell from its
  // workspace globs. Always retry its standalone install: a CLI shim alone
  // does not prove that an interrupted dependency install completed.
  runner.run('pnpm', ['install', '--no-frozen-lockfile'], plan.gameRoot);
  runner.run(
    'pnpm',
    ['--dir', shellPath, 'install', '--ignore-workspace', '--no-frozen-lockfile'],
    plan.gameRoot,
  );
  for (const platform of plan.nativePlatformsToAdd) {
    const generatedNow = !existsSync(path.join(plan.gameRoot, shellPath, platform));
    if (generatedNow) {
      runner.run('pnpm', ['--dir', shellPath, 'cap', 'add', platform], plan.gameRoot);
    }
    const manifest = readJsonObject(path.join(plan.gameRoot, shellPath, 'mpgd.native-shell.json'));
    if (platform === 'android' && generatedNow) {
      materializeAndroidBackupPolicy(plan.gameRoot);
      if (plan.notificationPlugins.length > 0) {
        materializeAndroidInexactAlarms(plan.gameRoot);
      }
    }
    if (platform === 'ios' && generatedNow) {
      materializeIosStorePolicy(plan.gameRoot);
    }
    if (platform === 'android' && generatedNow) {
      materializeAndroidStorePolicy(plan.gameRoot);
    }
    if (platform === 'ios') {
      materializeIosArchiveScheme(plan.gameRoot);
      const relative = `${shellPath}/ios/App/App/Info-Smoke.plist`;
      const destination = safeDestination(plan.gameRoot, relative);
      if (!existsSync(destination)) {
        const planned = plan.files.find((file) => file.path === relative);
        if (planned === undefined) {
          throw new Error('New ios project simulator Info.plist was not planned.');
        }
        writeFileSync(destination, planned.content, { flag: 'wx' });
      }
    }
    assertNativePlatformComplete(
      plan.gameRoot,
      platform,
      requireString(manifest.appId, 'shell app ID'),
      requireString(manifest.displayName, 'shell display name'),
    );
  }
  // `cap add` syncs a new project itself; a preserved project needs an explicit
  // sync so the store plugin's native code joins the shell.
  for (const platform of ['android', 'ios'] as const) {
    if (
      (plan.providerPlugins.some((plugin) => plugin.platform === platform)
        || plan.notificationPlugins.length > 0)
      && !plan.nativePlatformsToAdd.includes(platform)
      && existsSync(path.join(plan.gameRoot, shellPath, platform))
    ) {
      runner.run('pnpm', ['--dir', shellPath, 'cap', 'sync', platform], plan.gameRoot);
    }
  }
  const afterInstall = planCapacitorShellStarter(plan.input);
  if (afterInstall.changedFiles.length > 0 || afterInstall.nativePlatformsToAdd.length > 0) {
    throw new Error('Capacitor shell changed during installation; rerun the initializer.');
  }
}

const androidToolsNamespace = 'http://schemas.android.com/tools';
const androidBackupDomains = ['root', 'file', 'database', 'sharedpref', 'external'] as const;
const androidBackupExcludes = androidBackupDomains
  .map((domain) => `<exclude domain="${domain}" path="." />`);

/**
 * Backup rules for API < 31 (android:fullBackupContent). Every data domain is
 * excluded so nothing from the app's private storage reaches a backup even
 * if a game later turns android:allowBackup back on.
 */
export const androidBackupRulesXml = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<!--',
  '  Generated by mpgd target init capacitor. WebView storage and the',
  '  game-services SharedPreferences save store hold player data, so the whole',
  '  private data tree stays out of Android backups.',
  '-->',
  '<full-backup-content>',
  ...androidBackupExcludes.map((line) => `    ${line}`),
  '</full-backup-content>',
  '',
].join('\n');

/**
 * Data extraction rules for API 31+ (android:dataExtractionRules). Android 12
 * ignores android:allowBackup="false" for device-to-device transfer on some
 * devices, so cloud backup and device transfer each exclude every domain.
 */
export const androidDataExtractionRulesXml = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<!--',
  '  Generated by mpgd target init capacitor. WebView storage and the',
  '  game-services SharedPreferences save store hold player data, so neither',
  '  cloud backup nor Android 12+ device-to-device transfer may copy them.',
  '-->',
  '<data-extraction-rules>',
  '    <cloud-backup>',
  ...androidBackupExcludes.map((line) => `        ${line}`),
  '    </cloud-backup>',
  '    <device-transfer>',
  ...androidBackupExcludes.map((line) => `        ${line}`),
  '    </device-transfer>',
  '</data-extraction-rules>',
  '',
].join('\n');

/** Manifest application attributes that opt the shell out of backups. */
export const androidManifestBackupAttributes: readonly (readonly [string, string])[] = [
  ['android:allowBackup', 'false'],
  ['android:fullBackupContent', '@xml/backup_rules'],
  ['android:dataExtractionRules', '@xml/data_extraction_rules'],
  ['tools:targetApi', 's'],
];

/**
 * Opt a freshly generated Android project out of cloud backups and Android
 * 12+ device-to-device transfers. The Capacitor template enables
 * android:allowBackup, which would copy WebView storage and the game-services
 * SharedPreferences save store into Google backups; only a project created by
 * this run is touched, never an existing game-owned shell.
 */
function materializeAndroidBackupPolicy(gameRoot: string): void {
  const manifestFile = safeDestination(
    gameRoot,
    `${shellPath}/android/app/src/main/AndroidManifest.xml`,
  );
  if (!existsSync(manifestFile) || !lstatSync(manifestFile).isFile()) {
    return;
  }
  const resources: readonly (readonly [string, string])[] = [
    ['backup_rules.xml', androidBackupRulesXml],
    ['data_extraction_rules.xml', androidDataExtractionRulesXml],
  ];
  for (const [name, content] of resources) {
    const resource = safeDestination(gameRoot, `${shellPath}/android/app/src/main/res/xml/${name}`);
    if (!existsSync(resource)) {
      mkdirSync(path.dirname(resource), { recursive: true });
      writeFileSync(resource, content);
    }
  }
  const source = readFileSync(manifestFile, 'utf8');
  const hardened = applyAndroidManifestBackupPolicy(source);
  if (hardened !== source) {
    writeFileSync(manifestFile, hardened);
  }
}

function xmlAttributePattern(name: string): RegExp {
  return new RegExp(`(\\s*)${name.replaceAll('.', '\\.')}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'u');
}

/**
 * Set the backup opt-out attributes on the manifest application node and bind
 * the tools namespace on the manifest root. Existing values are replaced in
 * place; the attribute group keeps the indentation of the first attribute so
 * the result is stable across repeated runs.
 */
export function applyAndroidManifestBackupPolicy(manifest: string): string {
  const root = /<manifest\b[^>]*?>/u.exec(manifest);
  const application = /<application\b[^>]*?\/?>/u.exec(manifest);
  if (root === null || application === null || application.index < root.index) {
    return manifest;
  }
  let rootTag = root[0];
  if (!/\sxmlns:tools\s*=/u.test(rootTag)) {
    const androidNamespace = /\sxmlns:android\s*=\s*(?:"[^"]*"|'[^']*')/u.exec(rootTag);
    const toolsNamespace = ` xmlns:tools="${androidToolsNamespace}"`;
    rootTag = androidNamespace === null
      ? rootTag.replace(/^<manifest\b/u, `<manifest${toolsNamespace}`)
      : `${rootTag.slice(0, androidNamespace.index + androidNamespace[0].length)}${
        toolsNamespace}${rootTag.slice(androidNamespace.index + androidNamespace[0].length)}`;
  }
  let applicationTag = application[0];
  const existing = xmlAttributePattern('android:allowBackup').exec(applicationTag);
  const separator = existing?.[1] !== undefined && existing[1] !== ''
    ? existing[1]
    : (/^<application(\s+)\S/u.exec(applicationTag)?.[1] ?? ' ');
  for (const [name] of androidManifestBackupAttributes) {
    applicationTag = applicationTag.replace(xmlAttributePattern(name), '');
  }
  const attributes = androidManifestBackupAttributes
    .map(([name, value]) => `${separator}${name}="${value}"`)
    .join('');
  applicationTag = applicationTag.replace(/^<application\b/u, `<application${attributes}`);
  return `${manifest.slice(0, root.index)}${rootTag}${
    manifest.slice(root.index + root[0].length, application.index)}${applicationTag}${
    manifest.slice(application.index + application[0].length)}`;
}

/**
 * Store-facing Info.plist keys for a freshly generated iOS project only
 * (`applyIosInfoPlistStorePolicy`); an existing game-owned project is left
 * alone and the production build reports what it lacks.
 */
function materializeIosStorePolicy(gameRoot: string): void {
  const settings = readNativeShellSettings(gameRoot);
  const plistFile = safeDestination(gameRoot, `${shellPath}/ios/App/App/Info.plist`);
  if (existsSync(plistFile) && lstatSync(plistFile).isFile()) {
    const source = readFileSync(plistFile, 'utf8');
    let next = applyIosInfoPlistStorePolicy(source);
    if (settings.orientation !== undefined) {
      next = applyIosInfoPlistOrientation(next, settings.orientation);
    }
    if (next !== source) {
      writeFileSync(plistFile, next);
    }
  }
  if (settings.iosDeviceFamily !== undefined) {
    const projectFile = safeDestination(
      gameRoot,
      `${shellPath}/ios/App/App.xcodeproj/project.pbxproj`,
    );
    const source = readFileSync(projectFile, 'utf8');
    const next = applyIosProjectDeviceFamily(source, settings.iosDeviceFamily);
    if (next !== source) {
      writeFileSync(projectFile, next);
    }
  }
}

/**
 * Orientation of a freshly generated Android project's launcher activity and
 * `android:appCategory="game"`; an existing project is only reported by the
 * production build.
 */
function materializeAndroidStorePolicy(gameRoot: string): void {
  const manifestFile = safeDestination(
    gameRoot,
    `${shellPath}/android/app/src/main/AndroidManifest.xml`,
  );
  if (!existsSync(manifestFile) || !lstatSync(manifestFile).isFile()) {
    return;
  }
  const source = readFileSync(manifestFile, 'utf8');
  const next = applyAndroidManifestOrientation(
    source,
    readNativeShellSettings(gameRoot).orientation ?? 'any',
  );
  if (next !== source) {
    writeFileSync(manifestFile, next);
  }
}

/** The game's design orientation (mpgd.game.json) and iOS device family (ios target metadata). */
function readNativeShellSettings(gameRoot: string): {
  readonly orientation?: NativeShellOrientation;
  readonly iosDeviceFamily?: IosDeviceFamily;
} {
  const gameConfigFile = path.join(gameRoot, 'mpgd.game.json');
  const orientation = existsSync(gameConfigFile)
    ? readGameNativeOrientation(
        parseJsonObject(readFileSync(gameConfigFile, 'utf8'), 'mpgd.game.json'),
      )
    : undefined;
  const targets = readJsonObject(path.join(gameRoot, 'mpgd.targets.json'));
  const ios = isRecordValue(targets.targets) ? targets.targets.ios : undefined;
  const iosDeviceFamily = readIosDeviceFamily(isRecordValue(ios) ? ios.metadata : undefined);
  return {
    ...(orientation === undefined ? {} : { orientation }),
    ...(iosDeviceFamily === undefined ? {} : { iosDeviceFamily }),
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function materializeIosArchiveScheme(gameRoot: string): void {
  const schemeRelative = `${shellPath}/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`;
  const schemeFile = safeDestination(gameRoot, schemeRelative);
  if (existsSync(schemeFile)) {
    return;
  }
  const projectRelative = `${shellPath}/ios/App/App.xcodeproj/project.pbxproj`;
  const projectFile = safeDestination(gameRoot, projectRelative);
  const appTargetId = readIosAppTargetId(readFileSync(projectFile, 'utf8'));
  const scheme = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Scheme LastUpgradeVersion="2600" version="1.7">',
    '<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">',
    '<BuildActionEntries>',
    '<BuildActionEntry buildForTesting="YES" buildForRunning="YES"',
    ' buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">',
    `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${appTargetId}"`,
    ' BuildableName="App.app" BlueprintName="App"',
    ' ReferencedContainer="container:App.xcodeproj"/>',
    '</BuildActionEntry>',
    '</BuildActionEntries>',
    '</BuildAction>',
    '<ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>',
    '</Scheme>',
  ].join('\n');
  mkdirSync(path.dirname(schemeFile), { recursive: true });
  writeFileSync(schemeFile, `${scheme}\n`, { flag: 'wx' });
}

function assertNativePlatformComplete(
  gameRoot: string,
  platform: 'android' | 'ios',
  expectedAppId: string,
  expectedDisplayName: string,
): void {
  const nativeDirectory = path.join(gameRoot, shellPath, platform);
  if (!existsSync(nativeDirectory) || !lstatSync(nativeDirectory).isDirectory()) {
    throw new Error(
      `Existing ${platform} project is incomplete; repair or remove only that game-owned directory before retrying.`,
    );
  }
  const required = platform === 'android'
    ? requireOneNativeFile(nativeDirectory, ['app/build.gradle', 'app/build.gradle.kts'], platform)
    : requireOneNativeFile(nativeDirectory, ['App/App.xcodeproj/project.pbxproj'], platform);
  if (platform === 'android') {
    const rootBuild = requireOneNativeFile(
      nativeDirectory,
      ['build.gradle', 'build.gradle.kts'],
      platform,
    );
    const settings = requireOneNativeFile(
      nativeDirectory,
      ['settings.gradle', 'settings.gradle.kts'],
      platform,
    );
    const rootSource = stripGradleComments(
      readFileSync(path.join(nativeDirectory, rootBuild), 'utf8'),
    );
    const settingsSource = stripGradleComments(
      readFileSync(path.join(nativeDirectory, settings), 'utf8'),
    );
    assertAndroidSettingsAppProject(settingsSource);
    const rootCode = maskGradleStrings(rootSource);
    const settingsCode = maskGradleStrings(settingsSource);
    if (/\b(?:afterEvaluate|projectsEvaluated)\b/u.test(rootCode)
      && /\b(?:project|subprojects|allprojects|android)\b/u.test(rootCode)) {
      throw new Error('Existing android project has unsupported root Gradle app callbacks.');
    }
    if (/\b(?:beforeProject|afterProject|beforeEvaluate|afterEvaluate|projectsEvaluated)\b/u
      .test(settingsCode)) {
      throw new Error('Existing android project has unsupported settings Gradle callbacks.');
    }
    const visited = new Set<string>();
    const inspectedScripts = new Set<string>();
    for (const script of [settings, rootBuild, required]) {
      const ownerDirectory = script === required
        ? path.join(nativeDirectory, 'app')
        : nativeDirectory;
      assertAppliedGradleScripts(
        nativeDirectory,
        script,
        visited,
        inspectedScripts,
        script === settings,
        ownerDirectory,
      );
    }
    for (const script of inspectedScripts) {
      const source = stripGradleComments(readFileSync(path.join(nativeDirectory, script), 'utf8'));
      if (hasAndroidDisplayNameResourceOverride(source)) {
        throw new Error('Existing android project generates an unsupported app_name resource.');
      }
      if (hasAndroidResourceSourceSetOverride(source)) {
        throw new Error('Existing android project custom resource sourceSets are unsupported.');
      }
      if (hasAndroidManifestSourceSetOverride(source)) {
        throw new Error('Existing android project custom manifest sourceSets are unsupported.');
      }
      if (hasGradleTaskAction(source)) {
        throw new Error('Existing android project Gradle task actions are unsupported.');
      }
      if (script === required) {
        continue;
      }
      if (/\bproductFlavors\b/u.test(maskGradleStrings(source))) {
        throw new Error('Existing android project product flavors are unsupported by the builder.');
      }
      if (hasGradleIdentityMutation(source)) {
        throw new Error(
          `Existing android project applied Gradle script changes identity: ${script}`,
        );
      }
    }
  } else {
    const hasSpm = isNativeFile(nativeDirectory, 'App/CapApp-SPM/Package.swift');
    if (!hasSpm) {
      throw new Error('Existing ios project is incomplete; SPM files are required by the builder.');
    }
  }
  const additional = platform === 'android'
    ? [
        'gradlew',
        'gradle/wrapper/gradle-wrapper.jar',
        'gradle/wrapper/gradle-wrapper.properties',
        'app/src/main/AndroidManifest.xml',
      ]
    : ['App/App/AppDelegate.swift'];
  if (additional.some((relative) => !isNativeFile(nativeDirectory, relative))) {
    throw new Error(
      `Existing ${platform} project is incomplete; required native files are missing.`,
    );
  }
  if (platform === 'android' && process.platform !== 'win32'
    && (lstatSync(path.join(nativeDirectory, 'gradlew')).mode & 0o111) === 0) {
    throw new Error('Existing android project Gradle wrapper is not executable.');
  }
  const content = readFileSync(path.join(nativeDirectory, required), 'utf8');
  assertNativeShellIdentity(platform, content, expectedAppId);
  if (platform === 'ios') {
    assertIosReleaseProductName(content);
    assertIosReleaseInfoPlistExpansion(content);
    assertIosReleasePackagingSettings(content);
    const infoPlist = readIosReleaseInfoPlist(content);
    const infoRelative = path.join('App', infoPlist);
    if (!isNativeFile(nativeDirectory, infoRelative)) {
      throw new Error('Existing ios project Release Info.plist is missing or unsafe.');
    }
    const compiledSources = assertReferencedIosFiles(nativeDirectory, content, infoRelative);
    assertNativeDisplayName(nativeDirectory, platform, expectedDisplayName, infoRelative);
    assertIosReleasePlistIdentity(readFileSync(path.join(nativeDirectory, infoRelative), 'utf8'));
    assertNoIosLocalizedDisplayNameOverride(nativeDirectory, content);
    assertIosArchiveScheme(path.join(gameRoot, shellPath));
    const smokeRelative = 'App/App/Info-Smoke.plist';
    if (existsSync(path.join(nativeDirectory, smokeRelative))) {
      if (!isNativeFile(nativeDirectory, smokeRelative)) {
        throw new Error('Existing ios project simulator Info.plist is unsafe.');
      }
      const smoke = readFileSync(path.join(nativeDirectory, smokeRelative), 'utf8');
      assertSmokeInfoPlist(smoke, expectedDisplayName);
      assertSceneDelegateFiles(nativeDirectory, smoke, 'simulator', compiledSources);
    } else {
      const generatedSmoke = smokeInfoPlist(expectedDisplayName);
      assertSceneDelegateFiles(nativeDirectory, generatedSmoke, 'simulator', compiledSources);
    }
  } else {
    if (/\bproductFlavors\b/u.test(maskGradleStrings(stripGradleComments(content)))) {
      throw new Error('Existing android project product flavors are unsupported by the builder.');
    }
    assertAndroidManifestResources(nativeDirectory);
    assertNativeDisplayName(nativeDirectory, platform, expectedDisplayName);
    assertAndroidLauncherClasses(nativeDirectory, content);
  }
}

function assertAndroidLauncherClasses(nativeDirectory: string, gradle: string): void {
  const application = readAndroidApplication(
    path.join(nativeDirectory, 'app/src/main/AndroidManifest.xml'),
  );
  if (application === undefined) {
    throw new Error('Existing android project launcher activity is missing.');
  }
  assertAndroidLauncherEnabled(application, 'main application');
  const manifestRoot = application.parentNode as Element | null;
  const manifestPackage = manifestRoot?.getAttribute('package');
  const namespace = /\bnamespace\s*(?:=\s*)?["']([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)["']/u
    .exec(stripGradleComments(gradle))?.[1]
    ?? (manifestPackage === null || manifestPackage === '' ? undefined : manifestPackage);
  const releaseFile = path.join(nativeDirectory, 'app/src/release/AndroidManifest.xml');
  const release = existsSync(releaseFile) ? readAndroidApplication(releaseFile, false) : undefined;
  if (release !== undefined) {
    assertAndroidLauncherEnabled(release, 'Release application');
  }
  assertAndroidApplicationClasses(nativeDirectory, application, release, namespace);
  const launchers = [
    ...readAndroidLaunchers(application).map((element) => ({ element, release: false })),
    ...(release === undefined ? [] : readAndroidLaunchers(release)
      .map((element) => ({ element, release: true }))),
  ];
  if (launchers.length === 0) {
    throw new Error('Existing android project launcher activity is missing.');
  }
  for (const { element: launcher, release: releaseLauncher } of launchers) {
    assertAndroidLauncherEnabled(launcher, 'launcher');
    const isAlias = launcher.tagName === 'activity-alias';
    const attribute = isAlias ? 'android:targetActivity' : 'android:name';
    const name = launcher.getAttribute(attribute) ?? undefined;
    if (name === undefined || (name.startsWith('.') || !name.includes('.'))
      && namespace === undefined) {
      throw new Error('Existing android project launcher class cannot be resolved.');
    }
    let qualified = name;
    if (name.startsWith('.')) {
      qualified = `${namespace}${name}`;
    } else if (!name.includes('.')) {
      qualified = `${namespace}.${name}`;
    }
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/u.test(qualified)) {
      throw new Error('Existing android project launcher class cannot be resolved.');
    }
    const launcherName = qualifyAndroidActivityName(
      launcher.getAttribute('android:name'),
      namespace,
    );
    const inheritedExported = releaseLauncher
      ? readAndroidLaunchers(application).find((item) => qualifyAndroidActivityName(
        item.getAttribute('android:name'),
        namespace,
      ) === launcherName)?.getAttribute('android:exported')
      : null;
    if ((launcher.getAttribute('android:exported') ?? inheritedExported) !== 'true') {
      throw new Error('Existing android project launcher must declare android:exported="true".');
    }
    if (isAlias) {
      const targetInRelease = release === undefined ? [] : childElements(release)
        .filter((activity) => activity.tagName === 'activity');
      const changedTarget = targetInRelease.some((activity) =>
        qualifyAndroidActivityName(activity.getAttribute('android:name'), namespace) === qualified
        && hasAndroidMergerDirectiveDeep(activity));
      if (changedTarget) {
        throw new Error(
          `Existing android launcher alias target ${qualified} is changed by Release.`,
        );
      }
      const activities = childElements(application)
        .concat(release === undefined ? [] : childElements(release));
      const declared = activities.some((activity) => {
        const activityName = activity.getAttribute('android:name');
        if (activity.tagName !== 'activity' || activityName === null
          || hasAndroidMergerDirective(activity)) {
          return false;
        }
        const resolved = qualifyAndroidActivityName(activityName, namespace);
        return resolved === qualified;
      });
      if (!declared) {
        throw new Error(`Existing android launcher alias target ${qualified} is undeclared.`);
      }
    }
    const sourceSets = releaseLauncher ? ['main', 'release'] : ['main'];
    const sources = [...new Set(sourceSets.flatMap((sourceSet) =>
      ['java', 'kotlin'].flatMap((language) =>
        ['.java', '.kt'].flatMap((extension) => listNativeFiles(
          nativeDirectory,
          `app/src/${sourceSet}/${language}`,
          extension,
        )))))];
    const validActivity = resolvesAndroidClass(
      nativeDirectory,
      qualified,
      sources,
      new Set(),
      androidActivityBases,
      true,
    );
    if (!validActivity) {
      throw new Error(
        `Existing android project launcher class ${qualified} is missing or not an Android Activity.`,
      );
    }
  }
}

const androidActivityBases = new Set([
  'android.app.Activity',
  'com.getcapacitor.BridgeActivity',
  'androidx.activity.ComponentActivity',
  'androidx.appcompat.app.AppCompatActivity',
  'androidx.fragment.app.FragmentActivity',
]);

const androidApplicationBases = new Set([
  'android.app.Application',
  'androidx.multidex.MultiDexApplication',
]);

function assertAndroidApplicationClasses(
  nativeDirectory: string,
  main: Element,
  release: Element | undefined,
  namespace: string | undefined,
): void {
  const variants = [
    { application: main, sourceSets: ['main'] },
    ...(release === undefined ? [] : [
      { application: release, sourceSets: ['main', 'release'] },
    ]),
  ];
  for (const { application, sourceSets } of variants) {
    const name = application.getAttribute('android:name');
    if (name === null) {
      continue;
    }
    const qualified = qualifyAndroidActivityName(name, namespace);
    if (qualified === undefined) {
      throw new Error('Existing android project Application class cannot be resolved.');
    }
    const sources = [...new Set(sourceSets.flatMap((sourceSet) =>
      ['java', 'kotlin'].flatMap((language) =>
        ['.java', '.kt'].flatMap((extension) => listNativeFiles(
          nativeDirectory, `app/src/${sourceSet}/${language}`, extension,
        )))))];
    const validApplication = resolvesAndroidClass(
      nativeDirectory,
      qualified,
      sources,
      new Set(),
      androidApplicationBases,
      true,
    );
    if (!validApplication) {
      throw new Error(
        `Existing android project Application class ${qualified} is missing or invalid.`,
      );
    }
  }
}

function resolvesAndroidClass(
  nativeDirectory: string,
  qualified: string,
  sourceFiles: readonly string[],
  visited: Set<string>,
  bases: ReadonlySet<string>,
  manifestClass = false,
): boolean {
  if (bases.has(qualified)) {
    return true;
  }
  if (visited.has(qualified)) {
    return false;
  }
  visited.add(qualified);
  const separator = qualified.lastIndexOf('.');
  const packageName = qualified.slice(0, separator);
  const className = qualified.slice(separator + 1);
  for (const relative of sourceFiles) {
    if (!isNativeFile(nativeDirectory, relative)) {
      continue;
    }
    const source = stripSourceCommentsAndStrings(
      readFileSync(path.join(nativeDirectory, relative), 'utf8'),
    );
    const declaredPackage = /\bpackage\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\s*;?/u
      .exec(source)?.[1];
    if (declaredPackage !== packageName) {
      continue;
    }
    const declaration = readTopLevelAndroidSuperclass(source, className);
    if (declaration === undefined) {
      continue;
    }
    if (manifestClass && (relative.endsWith('.java')
      ? !/\bpublic\b/u.test(declaration.modifiers)
        || /\babstract\b/u.test(declaration.modifiers)
      : /\b(?:abstract|private|protected)\b/u.test(declaration.modifiers))) {
      return false;
    }
    const base = declaration.base;
    const imported = [...source.matchAll(/\bimport\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\s*;?/gu)]
      .map((match) => match[1] ?? '')
      .find((name) => name.endsWith(`.${base}`));
    const resolved = base.includes('.') ? base : (imported ?? `${packageName}.${base}`);
    if (resolvesAndroidClass(nativeDirectory, resolved, sourceFiles, visited, bases)) {
      return true;
    }
  }
  return false;
}

function readTopLevelAndroidSuperclass(
  source: string,
  className: string,
): { base: string; modifiers: string } | undefined {
  const expression = new RegExp(`\\bclass\\s+${className}\\b([^{};\\r\\n]*)(?:\\{|$)`, 'gmu');
  for (const match of source.matchAll(expression)) {
    let depth = 0;
    for (const character of source.slice(0, match.index)) {
      depth += character === '{' ? 1 : character === '}' ? -1 : 0;
    }
    if (depth !== 0) {
      continue;
    }
    const header = match[1] ?? '';
    const base = /\bextends\s+([A-Za-z_][\w.]*)/u.exec(header)?.[1]
      ?? /:\s*([A-Za-z_][\w.]*)\s*\(/u.exec(header)?.[1];
    if (base === undefined) {
      return undefined;
    }
    const before = source.slice(0, match.index);
    const modifiers = before.slice(Math.max(
      before.lastIndexOf('\n'),
      before.lastIndexOf(';'),
      before.lastIndexOf('}'),
    ) + 1);
    return { base, modifiers };
  }
  return undefined;
}

function qualifyAndroidActivityName(
  name: string | null,
  namespace: string | undefined,
): string | undefined {
  if (name === null) {
    return undefined;
  }
  if (name.startsWith('.')) {
    return namespace === undefined ? undefined : `${namespace}${name}`;
  }
  return name.includes('.') ? name : namespace === undefined ? undefined : `${namespace}.${name}`;
}

function listNativeFiles(
  nativeDirectory: string,
  relativeRoot: string,
  extension: string,
): string[] {
  const pending = [relativeRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const relative = pending.pop() ?? '';
    const full = path.join(nativeDirectory, relative);
    if (!existsSync(full) || lstatSync(full).isSymbolicLink()) {
      continue;
    }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(child);
        if (files.length > 10_000) {
          throw new Error('Existing native project has too many source files to inspect.');
        }
      }
    }
  }
  return files;
}

function assertAndroidLauncherEnabled(element: Element, label: string): void {
  for (const attribute of ['android:enabled', 'android:exported']) {
    const value = element.getAttribute(attribute);
    if (value !== null && value !== 'true') {
      throw new Error(`Existing android project ${label} ${attribute} is unsupported.`);
    }
  }
}

function stripSourceCommentsAndStrings(source: string): string {
  let output = '';
  let quote: '"' | "'" | undefined;
  let blockComment = false;
  let lineComment = false;
  let rawString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        output += '  ';
        index += 1;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (rawString) {
      if (source.startsWith('"""', index)) {
        rawString = false;
        output += '   ';
        index += 2;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === '\\' && next !== '') {
        output += '  ';
        index += 1;
      } else if (character === quote) {
        quote = undefined;
        output += ' ';
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      output += '  ';
      index += 1;
    } else if (source.startsWith('"""', index)) {
      rawString = true;
      output += '   ';
      index += 2;
    } else if (character === '"' || character === "'") {
      quote = character;
      output += ' ';
    } else {
      output += character;
    }
  }
  return output;
}

function assertSmokeInfoPlist(source: string, expectedDisplayName: string): void {
  const values = parsePlistDictionary(source, 'simulator');
  const required: readonly [string, string][] = [
    ['CFBundleDisplayName', expectedDisplayName],
    ['CFBundleExecutable', '$(EXECUTABLE_NAME)'],
    ['CFBundleIdentifier', '$(PRODUCT_BUNDLE_IDENTIFIER)'],
    ['CFBundleName', '$(PRODUCT_NAME)'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '$(MARKETING_VERSION)'],
    ['CFBundleVersion', '$(CURRENT_PROJECT_VERSION)'],
  ];
  for (const [key, expected] of required) {
    const actual = values.get(key);
    if (actual?.tagName !== 'string' || actual.textContent !== expected) {
      throw new Error(`Existing ios project simulator Info.plist ${key} differs or is missing.`);
    }
  }
  if ([...values.keys()].some((key) => ['UIMainStoryboardFile', 'UILaunchStoryboardName']
    .some((name) => key === name || key.startsWith(`${name}~`) || key.startsWith(`${name}-`)))) {
    throw new Error('Existing ios project simulator Info.plist references excluded storyboards.');
  }
}

function parseXml(source: string, label: string): Document {
  try {
    return new DOMParser({
      onError(_level, message) { throw new Error(message); },
    }).parseFromString(source, 'application/xml');
  } catch {
    throw new Error(`Existing ${label} is malformed.`);
  }
}

function childElements(element: Element): Element[] {
  return Array.from(element.childNodes)
    .filter((node): node is Element => node.nodeType === 1);
}

function parsePlistDictionary(source: string, label: string): Map<string, Element> {
  const plist = parseXml(source, `ios project ${label} Info.plist`).documentElement;
  const children = plist === null ? [] : childElements(plist);
  const dictionary = children[0];
  if (plist?.tagName !== 'plist' || children.length !== 1
    || dictionary?.tagName !== 'dict' || hasNonWhitespaceText(plist)) {
    throw new Error(`Existing ios project ${label} Info.plist is malformed.`);
  }
  return parsePlistEntries(dictionary, label);
}

/** Fail closed when a Release plist hardcodes values independently of Xcode build settings. */
export function assertIosReleasePlistIdentity(source: string): void {
  const values = parsePlistDictionary(source, 'Release');
  const required: readonly [string, string][] = [
    ['CFBundleExecutable', '$(EXECUTABLE_NAME)'],
    ['CFBundleIdentifier', '$(PRODUCT_BUNDLE_IDENTIFIER)'],
    ['CFBundleName', '$(PRODUCT_NAME)'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '$(MARKETING_VERSION)'],
    ['CFBundleVersion', '$(CURRENT_PROJECT_VERSION)'],
  ];
  for (const [key, expected] of required) {
    const value = values.get(key);
    if (value?.tagName !== 'string' || value.textContent !== expected) {
      throw new Error(`Existing ios project Release Info.plist ${key} differs or is missing.`);
    }
  }
}

function parsePlistEntries(dictionary: Element, label: string): Map<string, Element> {
  const children = childElements(dictionary);
  if (children.length % 2 !== 0 || hasNonWhitespaceText(dictionary)) {
    throw new Error(`Existing ios project ${label} Info.plist is malformed.`);
  }
  const entries = new Map<string, Element>();
  for (let index = 0; index < children.length; index += 2) {
    const key = children[index];
    const value = children[index + 1];
    const name = key?.textContent ?? '';
    if (key?.tagName !== 'key' || childElements(key).length > 0
      || value === undefined || name.length === 0
      || entries.has(name)) {
      throw new Error(`Existing ios project ${label} Info.plist is malformed.`);
    }
    assertPlistValue(value, label);
    entries.set(name, value);
  }
  return entries;
}

function assertPlistValue(value: Element, label: string): void {
  if (value.tagName === 'dict') {
    parsePlistEntries(value, label);
    return;
  }
  if (value.tagName === 'array') {
    if (hasNonWhitespaceText(value)) {
      throw new Error(`Existing ios project ${label} Info.plist is malformed.`);
    }
    for (const child of childElements(value)) {
      assertPlistValue(child, label);
    }
    return;
  }
  if (childElements(value).length === 0) {
    const text = value.textContent ?? '';
    if (value.tagName === 'string') {
      return;
    }
    if (value.tagName === 'integer' && /^-?\d+$/u.test(text)) {
      return;
    }
    if (value.tagName === 'real'
      && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)
      && Number.isFinite(Number(text))) {
      return;
    }
    if (value.tagName === 'date'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(text)
      && Number.isFinite(Date.parse(text))) {
      return;
    }
    if (value.tagName === 'data'
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(text.replace(/\s+/gu, ''))) {
      return;
    }
    if ((value.tagName === 'true' || value.tagName === 'false') && text === '') {
      return;
    }
  }
  throw new Error(`Existing ios project ${label} Info.plist has an unsupported value node.`);
}

function hasNonWhitespaceText(element: Element): boolean {
  return Array.from(element.childNodes).some((node) =>
    (node.nodeType === 3 || node.nodeType === 4)
    && (node.textContent?.trim().length ?? 0) > 0);
}

function assertReferencedIosFiles(
  nativeDirectory: string,
  project: string,
  infoRelative: string,
): Set<string> {
  const compiledSources = assertAppBuildPhaseInputs(nativeDirectory, project);
  const references: readonly [RegExp, string][] = [
    [/\/\*\s*SceneDelegate\.swift in Sources\s*\*\//u, 'App/App/SceneDelegate.swift'],
    [/\/\*\s*Main\.storyboard in Resources\s*\*\//u, 'App/App/Base.lproj/Main.storyboard'],
    [
      /\/\*\s*LaunchScreen\.storyboard in Resources\s*\*\//u,
      'App/App/Base.lproj/LaunchScreen.storyboard',
    ],
    [/\/\*\s*Assets\.xcassets in Resources\s*\*\//u, 'App/App/Assets.xcassets/Contents.json'],
  ];
  for (const [marker, relative] of references) {
    if (marker.test(project) && !isNativeFile(nativeDirectory, relative)) {
      throw new Error(
        `Existing ios project is incomplete; referenced app file ${relative} is missing.`,
      );
    }
  }
  const info = readFileSync(path.join(nativeDirectory, infoRelative), 'utf8');
  assertSceneDelegateFiles(nativeDirectory, info, 'Release', compiledSources);
  return compiledSources;
}

function assertAppBuildPhaseInputs(nativeDirectory: string, project: string): Set<string> {
  const parentGroups = readPbxParentGroups(project);
  const compiledSources = new Set<string>();
  const targetId = readIosAppTargetId(project);
  assertNoIosTargetScriptPhases(project, targetId, new Set());
  const target = readPbxObjectBody(project, targetId);
  const phaseIds = readPbxIds(target, 'buildPhases');
  for (const phaseId of phaseIds) {
    const phase = readPbxObjectBody(project, phaseId);
    if (/\bisa\s*=\s*PBXShellScriptBuildPhase\s*;/u.test(phase)) {
      throw new Error('Existing ios project App shell script build phases are unsupported.');
    }
    const isSources = /\bisa\s*=\s*PBXSourcesBuildPhase\s*;/u.test(phase);
    if (/\bisa\s*=\s*PBXFrameworksBuildPhase\s*;/u.test(phase)) {
      const linked = readPbxIds(phase, 'files').map((buildId) => {
        const build = readPbxObjectBody(project, buildId);
        return /\bfileRef\s*=\s*([A-F0-9]+)\b/u.exec(build)?.[1];
      });
      const otherProducts = [...project.matchAll(
        /\b([A-F0-9]+)\s*(?:\/\*[^*]*\*\/)?\s*=\s*\{([^{}]*)\};/gu,
      )].filter((match) => match[1] !== targetId
        && /\bisa\s*=\s*PBXNativeTarget\s*;/u.test(match[2] ?? ''))
        .map((match) => /\bproductReference\s*=\s*([A-F0-9]+)\b/u.exec(match[2] ?? '')?.[1]);
      if (linked.some((reference) => reference !== undefined
        && otherProducts.includes(reference))) {
        throw new Error('Existing ios project implicit App target dependencies are unsupported.');
      }
    }
    if (!isSources && !/\bisa\s*=\s*PBXResourcesBuildPhase\s*;/u.test(phase)) {
      continue;
    }
    for (const buildId of readPbxIds(phase, 'files')) {
      const build = readPbxObjectBody(project, buildId);
      const referenceId = /\bfileRef\s*=\s*([A-F0-9]+)\b/u.exec(build)?.[1];
      if (referenceId === undefined) {
        throw new Error('Existing ios project App build input has no file reference.');
      }
      const files = assertPbxFileReference(nativeDirectory, project, referenceId, parentGroups);
      if (isSources) {
        files.forEach((file) => compiledSources.add(file));
      }
    }
  }
  return compiledSources;
}

function assertNoIosTargetScriptPhases(
  project: string,
  targetId: string,
  visited: Set<string>,
): void {
  if (visited.has(targetId)) {
    return;
  }
  visited.add(targetId);
  const target = readPbxObjectBody(project, targetId);
  if (!/\bisa\s*=\s*PBX(?:Native|Aggregate)Target\s*;/u.test(target)) {
    throw new Error('Existing ios project App target dependency is unsupported.');
  }
  if (readPbxIds(target, 'buildRules').length > 0) {
    throw new Error('Existing ios project App executable build rules are unsupported.');
  }
  for (const phaseId of readPbxIds(target, 'buildPhases')) {
    const phase = readPbxObjectBody(project, phaseId);
    if (/\bisa\s*=\s*PBXShellScriptBuildPhase\s*;/u.test(phase)) {
      throw new Error('Existing ios project App shell script build phases are unsupported.');
    }
  }
  for (const dependencyId of readPbxIds(target, 'dependencies')) {
    const dependency = readPbxObjectBody(project, dependencyId);
    const childId = /\btarget\s*=\s*([A-F0-9]+)\b/u.exec(dependency)?.[1];
    if (!/\bisa\s*=\s*PBXTargetDependency\s*;/u.test(dependency)
      || childId === undefined) {
      throw new Error('Existing ios project App target dependency is unsupported.');
    }
    assertNoIosTargetScriptPhases(project, childId, visited);
  }
}

function readPbxObjectBody(project: string, id: string): string {
  const marker = new RegExp(`\\b${id}\\s*(?:/\\*[^*]*\\*/)?\\s*=\\s*\\{([\\s\\S]*?)\\};`, 'u');
  const body = marker.exec(project)?.[1];
  if (body === undefined) {
    throw new Error(`Existing ios project build object ${id} is missing.`);
  }
  return body;
}

function readPbxIds(object: string, key: string): string[] {
  const list = new RegExp(`\\b${key}\\s*=\\s*\\(([^)]*)\\)\\s*;`, 'u').exec(object)?.[1];
  const uncommented = list?.replace(/\/\*[\s\S]*?\*\//gu, '') ?? '';
  return [...uncommented.matchAll(/\b([A-F0-9]{8,24})\b/gu)]
    .map((match) => match[1] ?? '');
}

function readPbxParentGroups(project: string): Map<string, string> {
  const parents = new Map<string, string>();
  const groupObjectPattern = /\b([A-F0-9]+)\s*(?:\/\*[^*]*\*\/)?\s*=\s*\{([\s\S]*?)\};/gu;
  const objects = project.matchAll(groupObjectPattern);
  for (const match of objects) {
    const id = match[1] ?? '';
    const body = match[2] ?? '';
    if (!/\bisa\s*=\s*PBX(?:Variant)?Group\s*;/u.test(body)) {
      continue;
    }
    for (const child of readPbxIds(body, 'children')) {
      if (parents.has(child)) {
        throw new Error(`Existing ios project build input ${child} has ambiguous groups.`);
      }
      parents.set(child, id);
    }
  }
  return parents;
}

function readPbxGroupPath(
  project: string,
  parents: Map<string, string>,
  referenceId: string,
): string | undefined {
  const chain: string[] = [];
  const seen = new Set<string>();
  let parent = parents.get(referenceId);
  if (parent === undefined) {
    return undefined;
  }
  while (parent !== undefined) {
    if (seen.has(parent)) {
      throw new Error('Existing ios project build input group cycle is unsupported.');
    }
    seen.add(parent);
    chain.unshift(parent);
    parent = parents.get(parent);
  }
  const parts: string[] = [];
  for (const groupId of chain) {
    const group = readPbxObjectBody(project, groupId);
    const sourceTree = /\bsourceTree\s*=\s*(?:"([^"]+)"|([^;]+))\s*;/u.exec(group);
    const tree = (sourceTree?.[1] ?? sourceTree?.[2])?.trim();
    if (tree === 'SOURCE_ROOT') {
      parts.length = 0;
    } else if (tree !== undefined && tree !== '<group>') {
      throw new Error('Existing ios project build input group sourceTree is unsupported.');
    }
    const groupPath = /\bpath\s*=\s*(?:"([^"]+)"|([^;]+))\s*;/u.exec(group);
    const value = (groupPath?.[1] ?? groupPath?.[2])?.trim();
    if (value !== undefined) {
      if (value.includes('$') || path.isAbsolute(value)) {
        throw new Error('Existing ios project build input group path is unsupported.');
      }
      parts.push(value);
    }
  }
  return parts.join('/');
}

function assertPbxFileReference(
  nativeDirectory: string,
  project: string,
  referenceId: string,
  parentGroups: Map<string, string>,
): string[] {
  const reference = readPbxObjectBody(project, referenceId);
  if (/\bisa\s*=\s*PBXVariantGroup\s*;/u.test(reference)) {
    const files: string[] = [];
    for (const child of readPbxIds(reference, 'children')) {
      files.push(...assertPbxFileReference(nativeDirectory, project, child, parentGroups));
    }
    return files;
  }
  if (!/\bisa\s*=\s*PBXFileReference\s*;/u.test(reference)) {
    throw new Error('Existing ios project App build input has an unsupported file reference.');
  }
  const relative = /\bpath\s*=\s*(?:"([^"]+)"|([^;]+))\s*;/u.exec(reference);
  const filePath = (relative?.[1] ?? relative?.[2])?.trim();
  if (filePath === undefined || filePath.includes('$') || path.isAbsolute(filePath)) {
    throw new Error('Existing ios project App build input path is unsupported.');
  }
  if (filePath === 'public' || filePath === 'capacitor.config.json') {
    return []; // cap sync creates these inputs in the staged shell.
  }
  const sourceTree = /\bsourceTree\s*=\s*(?:"([^"]+)"|([^;]+))\s*;/u.exec(reference);
  const tree = (sourceTree?.[1] ?? sourceTree?.[2])?.trim();
  if (tree !== undefined && tree !== '<group>' && tree !== 'SOURCE_ROOT') {
    throw new Error('Existing ios project App build input sourceTree is unsupported.');
  }
  const groupPath = readPbxGroupPath(project, parentGroups, referenceId);
  let candidates: string[];
  if (tree === 'SOURCE_ROOT') {
    candidates = [`App/${filePath}`];
  } else if (groupPath === undefined) {
    candidates = [`App/App/${filePath}`, `App/${filePath}`];
  } else {
    candidates = [`App/${groupPath}/${filePath}`];
  }
  const resolved = candidates.find((candidate) => isNativeEntry(nativeDirectory, candidate));
  if (resolved === undefined) {
    throw new Error(`Existing ios project App build input ${filePath} is missing.`);
  }
  return [resolved];
}

function isNativeEntry(directory: string, relative: string): boolean {
  const file = path.resolve(directory, relative);
  const within = path.relative(directory, file);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    return false;
  }
  let current = directory;
  for (const segment of within.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
      return false;
    }
  }
  return lstatSync(file).isFile() || lstatSync(file).isDirectory();
}

function assertSceneDelegateFiles(
  nativeDirectory: string,
  source: string,
  label: string,
  compiledSources: Set<string>,
): void {
  const values = parsePlistDictionary(source, label);
  const delegates: string[] = [];
  const visit = (value: Element): void => {
    if (value.tagName === 'dict') {
      for (const [key, child] of parsePlistEntries(value, label)) {
        if (key === 'UISceneDelegateClassName') {
          if (child.tagName !== 'string') {
            throw new Error(`Existing ios project ${label} scene delegate is invalid.`);
          }
          delegates.push(child.textContent ?? '');
        } else {
          visit(child);
        }
      }
    } else if (value.tagName === 'array') {
      childElements(value).forEach(visit);
    }
  };
  [...values.values()].forEach(visit);
  const sources = listNativeFiles(nativeDirectory, 'App/App', '.swift');
  for (const delegate of delegates) {
    const className = /^(?:\$\(PRODUCT_MODULE_NAME\)|[A-Za-z_]\w*)\.([A-Za-z_]\w*)$/u
      .exec(delegate)?.[1];
    if (className === undefined || !sources.some((relative) => {
      if (!compiledSources.has(relative)) {
        return false;
      }
      const text = stripSourceCommentsAndStrings(
        readFileSync(path.join(nativeDirectory, relative), 'utf8'),
      );
      return hasUsableTopLevelSwiftSceneDelegate(text, className);
    })) {
      throw new Error(
        `Existing ios project ${label} scene delegate ${delegate} is missing from App Sources.`,
      );
    }
  }
}

function hasUsableTopLevelSwiftSceneDelegate(source: string, className: string): boolean {
  const declaration = new RegExp(`\\bclass\\s+${className}\\b([^{};]*)\\{`, 'gu');
  let cursor = 0;
  let depth = 0;
  for (const match of source.matchAll(declaration)) {
    const index = match.index ?? 0;
    for (; cursor < index; cursor += 1) {
      depth += source[cursor] === '{' ? 1 : source[cursor] === '}' ? -1 : 0;
    }
    const inheritance = match[1] ?? '';
    const supported = /:\s*(?:UIResponder|NSObject)\s*,\s*(?:UIWindowSceneDelegate|UISceneDelegate)(?:\s*,|\s*$)/u
      .test(inheritance.trim());
    if (depth === 0 && supported) {
      return true;
    }
  }
  return false;
}

function assertAndroidManifestResources(nativeDirectory: string): void {
  const manifestFiles = ['main', 'release']
    .map((sourceSet) => path.join(nativeDirectory, `app/src/${sourceSet}/AndroidManifest.xml`))
    .filter((file) => existsSync(file));
  const resourceRoots = ['main', 'release']
    .map((sourceSet) => path.join(nativeDirectory, `app/src/${sourceSet}/res`));
  const references = manifestFiles.flatMap((file) => {
    const manifest = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/gu, '');
    return [...manifest.matchAll(/(?<![\w+])@([a-z]+)\/([A-Za-z_][A-Za-z0-9_.]*)/gu)];
  });
  for (const reference of references) {
    const type = reference[1] ?? '';
    const name = reference[2] ?? '';
    const found = resourceRoots.some((resourceRoot) => {
      if (!existsSync(resourceRoot)) {
        return false;
      }
      const folders = readdirSync(resourceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      return folders.some((folder) => {
        const densityFallback = (type === 'mipmap' || type === 'drawable')
          && new RegExp(`^${type}-(?:ldpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi|nodpi|anydpi)$`, 'u')
            .test(folder);
        if (folder === type || densityFallback) {
          return readdirSync(path.join(resourceRoot, folder)).some((file) =>
            file === `${name}.xml` || file.startsWith(`${name}.`));
        }
        if (folder !== 'values') {
          return false;
        }
        return readdirSync(path.join(resourceRoot, folder)).some((file) =>
          file.endsWith('.xml') && readAndroidValueResource(
            path.join(resourceRoot, folder, file), type, name,
          ).length > 0);
      });
    });
    if (!found) {
      throw new Error(`Existing android project manifest resource @${type}/${name} is missing.`);
    }
  }
}

function smokeInfoPlist(displayName: string): string {
  const name = displayName.replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleDisplayName</key>', `<string>${name}</string>`,
    '<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>',
    '<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
    '<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>',
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>',
    '<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>',
    '<key>UIApplicationSceneManifest</key><dict>',
    '<key>UIApplicationSupportsMultipleScenes</key><false/>',
    '<key>UISceneConfigurations</key><dict>',
    '<key>UIWindowSceneSessionRoleApplication</key><array><dict>',
    '<key>UISceneConfigurationName</key><string>Default Configuration</string>',
    '<key>UISceneDelegateClassName</key><string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>',
    '</dict></array></dict></dict>',
    '<key>UILaunchScreen</key><dict/>',
    '</dict></plist>',
    '',
  ].join('\n');
}

function assertAppliedGradleScripts(
  nativeDirectory: string,
  script: string,
  visited: Set<string>,
  inspectedScripts: Set<string>,
  isSettingsScript: boolean,
  ownerDirectory: string,
): void {
  const visitKey = `${ownerDirectory}\0${isSettingsScript}\0${script}`;
  if (visited.has(visitKey)) {
    return;
  }
  visited.add(visitKey);
  inspectedScripts.add(script);
  if (!isNativeFile(nativeDirectory, script)) {
    throw new Error(
      `Existing android project is incomplete; applied Gradle script ${script} is missing.`,
    );
  }
  const source = stripGradleComments(readFileSync(path.join(nativeDirectory, script), 'utf8'));
  const code = maskGradleStrings(source);
  if (/(?:^|[\s;{])apply\s*\{/u.test(code)) {
    throw new Error('Existing android project has an unsupported Gradle apply expression.');
  }
  if (isSettingsScript) {
    assertAndroidSettingsNoAppRemap(source);
  }
  const expressions = [
    /\bapply\s+from\s*:\s*["']([^"']+)["']/gu,
    /\bapply\s*\(\s*from\s*=\s*["']([^"']+)["']\s*\)/gu,
    /\bapply\s+from\s*:\s*file\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bapply\s*\(\s*from\s*=\s*file\s*\(\s*["']([^"']+)["']\s*\)\s*\)/gu,
  ];
  const matched = new Set<number>();
  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) {
      if (match.index === undefined || code.slice(match.index, match.index + 5) !== 'apply') {
        continue;
      }
      matched.add(match.index);
      const requested = match[1] ?? '';
      // Gradle resolves nested script paths against the owning project or settings directory.
      const resolved = path.resolve(ownerDirectory, requested);
      const relative = path.relative(nativeDirectory, resolved);
      if (requested.includes('$') || relative === '' || relative.startsWith('..')
        || path.isAbsolute(relative)) {
        throw new Error('Existing android project has an unsupported applied Gradle script path.');
      }
      assertAppliedGradleScripts(
        nativeDirectory,
        relative,
        visited,
        inspectedScripts,
        isSettingsScript,
        ownerDirectory,
      );
    }
  }
  const applyExpressions = [/\bapply\s+from\s*:/gu, /\bapply\s*\(/gu];
  if (applyExpressions.some((expression) => [...source.matchAll(expression)]
    .some((match) => match.index !== undefined
      && code.slice(match.index, match.index + 5) === 'apply'
      && !matched.has(match.index)))) {
    throw new Error('Existing android project has an unsupported Gradle apply expression.');
  }
}

function assertNativeDisplayName(
  nativeDirectory: string,
  platform: 'android' | 'ios',
  expectedDisplayName: string,
  iosInfoRelative?: string,
): void {
  const relative = iosInfoRelative ?? 'App/App/Info.plist';
  if (platform === 'ios' && !isNativeFile(nativeDirectory, relative)) {
    throw new Error(
      `Existing ${platform} project is incomplete; native display name resource is missing.`,
    );
  }
  const source = platform === 'ios'
    ? readFileSync(path.join(nativeDirectory, relative), 'utf8')
    : '';
  const labels = platform === 'ios'
    ? [parsePlistDictionary(source, 'Release').get('CFBundleDisplayName')]
      .filter((value) => value?.tagName === 'string')
      .map((value) => value?.textContent ?? '')
    : [];
  if (platform === 'ios' && (labels.length !== 1 || labels[0] !== expectedDisplayName)) {
    throw new Error(`Existing ${platform} project display name differs or cannot be read safely.`);
  }
  if (platform === 'android') {
    const main = readAndroidApplication(
      path.join(nativeDirectory, 'app/src/main/AndroidManifest.xml'),
    );
    if (main === undefined) {
      throw new Error('Existing android project application label is missing.');
    }
    const label = main.getAttribute('android:label');
    if (label === null) {
      throw new Error('Existing android project application label is missing.');
    }
    const effective = resolveAndroidLabel(nativeDirectory, label);
    if (effective !== expectedDisplayName) {
      throw new Error(
        'Existing android project application label differs from the requested name.',
      );
    }
    const launchers = readAndroidLaunchers(main);
    for (const launcher of launchers) {
      const launcherLabel = launcher.getAttribute('android:label');
      if (launcherLabel !== null
        && resolveAndroidLabel(nativeDirectory, launcherLabel) !== expectedDisplayName) {
        throw new Error('Existing android project launcher label differs from the requested name.');
      }
    }
    const overlayFile = path.join(nativeDirectory, 'app/src/release/AndroidManifest.xml');
    if (existsSync(overlayFile)) {
      const release = readAndroidApplication(overlayFile, false);
      if (release !== undefined) {
        if (hasAndroidMergerDirective(release)) {
          throw new Error('Existing android Release manifest changes the application node.');
        }
        const releaseLabel = release.getAttribute('android:label');
        if (releaseLabel !== null
          && resolveAndroidLabel(nativeDirectory, releaseLabel) !== expectedDisplayName) {
          throw new Error(
            'Existing android Release application label differs from the requested name.',
          );
        }
        const appBuildFile = ['app/build.gradle', 'app/build.gradle.kts']
          .map((relative) => path.join(nativeDirectory, relative))
          .find((file) => existsSync(file));
        const appGradle = appBuildFile === undefined ? '' : readFileSync(appBuildFile, 'utf8');
        const manifestPackage = (main.parentNode as Element | null)?.getAttribute('package');
        const namespace = /\bnamespace\s*(?:=\s*)?["']([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)["']/u
          .exec(stripGradleComments(appGradle))?.[1]
          ?? (manifestPackage === null || manifestPackage === '' ? undefined : manifestPackage);
        const launcherNames = new Set<string>();
        for (const launcher of launchers) {
          const qualified = qualifyAndroidActivityName(
            launcher.getAttribute('android:name'),
            namespace,
          );
          if (qualified !== undefined) {
            launcherNames.add(qualified);
          }
        }
        const releaseLaunchers = readAndroidLaunchers(release);
        for (const activity of childElements(release)) {
          if (activity.tagName !== 'activity' && activity.tagName !== 'activity-alias') {
            continue;
          }
          const releaseName = qualifyAndroidActivityName(
            activity.getAttribute('android:name'),
            namespace,
          );
          const sameLauncher = releaseName !== undefined && launcherNames.has(releaseName);
          const activityLabel = activity.getAttribute('android:label');
          if (sameLauncher && activity.tagName === 'activity-alias'
            && activity.hasAttribute('android:targetActivity')) {
            throw new Error(
              'Existing android Release launcher alias target override is unsupported.',
            );
          }
          if ((sameLauncher || releaseLaunchers.includes(activity))
            && hasAndroidMergerDirectiveDeep(activity)) {
            throw new Error('Existing android Release manifest changes a launcher node.');
          }
          if (sameLauncher || releaseLaunchers.includes(activity)) {
            assertAndroidLauncherEnabled(activity, 'Release launcher');
          }
          if ((sameLauncher || releaseLaunchers.includes(activity)) && activityLabel !== null
            && resolveAndroidLabel(nativeDirectory, activityLabel) !== expectedDisplayName) {
            throw new Error(
              'Existing android Release launcher label differs from the requested name.',
            );
          }
        }
      }
    }
  }
}

export function assertAndroidReleaseDisplayName(
  shellApp: string,
  expectedDisplayName: string,
): void {
  const nativeDirectory = path.join(shellApp, 'android');
  assertAndroidManifestResources(nativeDirectory);
  assertNativeDisplayName(nativeDirectory, 'android', expectedDisplayName);
}

export function assertAndroidReleaseLauncherIntegrity(shellApp: string): void {
  const nativeDirectory = path.join(shellApp, 'android');
  const gradleRelative = requireOneNativeFile(
    nativeDirectory,
    ['app/build.gradle', 'app/build.gradle.kts'],
    'android',
  );
  const gradle = readFileSync(path.join(nativeDirectory, gradleRelative), 'utf8');
  assertAndroidLauncherClasses(nativeDirectory, gradle);
}

export function assertIosReleaseDisplayName(
  shellApp: string,
  expectedDisplayName: string,
): void {
  const nativeDirectory = path.join(shellApp, 'ios');
  const projectFile = path.join(nativeDirectory, 'App/App.xcodeproj/project.pbxproj');
  const project = readFileSync(projectFile, 'utf8');
  const infoRelative = path.join('App', readIosReleaseInfoPlist(project));
  if (!isNativeFile(nativeDirectory, infoRelative)) {
    throw new Error('Existing ios project Release Info.plist is missing or unsafe.');
  }
  assertNativeDisplayName(nativeDirectory, 'ios', expectedDisplayName, infoRelative);
  assertNoIosLocalizedDisplayNameOverride(nativeDirectory, project);
  assertReferencedIosFiles(nativeDirectory, project, infoRelative);
}

function assertNoIosLocalizedDisplayNameOverride(
  nativeDirectory: string,
  project: string,
): void {
  const files = listNativeFiles(nativeDirectory, 'App/App', '.strings');
  if (/\bInfoPlist\.strings\b/u.test(project)
    || isNativeFile(nativeDirectory, 'App/InfoPlist.strings')
    || files.some((relative) => path.basename(relative) === 'InfoPlist.strings')) {
    throw new Error('Existing ios project localized InfoPlist.strings overrides are unsupported.');
  }
}

export function assertIosArchiveScheme(shellApp: string): void {
  const nativeDirectory = path.join(shellApp, 'ios');
  const projectRelative = 'App/App.xcodeproj/project.pbxproj';
  const schemeRelative = 'App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme';
  if (!isNativeFile(nativeDirectory, projectRelative)
    || !isNativeFile(nativeDirectory, schemeRelative)) {
    throw new Error('Existing ios project shared App archive scheme is missing or unsafe.');
  }
  const project = readFileSync(path.join(nativeDirectory, projectRelative), 'utf8');
  const appTargetId = readIosAppTargetId(project);
  const schemeSource = readFileSync(path.join(nativeDirectory, schemeRelative), 'utf8');
  const scheme = parseXml(schemeSource, 'ios project App archive scheme').documentElement;
  if (scheme?.tagName !== 'Scheme') {
    throw new Error('Existing ios project App archive scheme is malformed.');
  }
  const actions = childElements(scheme);
  const build = actions.filter((item) => item.tagName === 'BuildAction');
  const archive = actions.filter((item) => item.tagName === 'ArchiveAction');
  const entryGroups = build.length === 1
    ? childElements(build[0] as Element)
      .filter((item) => item.tagName === 'BuildActionEntries')
    : [];
  const entries = entryGroups.length === 1
    ? childElements(entryGroups[0] as Element)
      .filter((item) => item.tagName === 'BuildActionEntry'
        && item.getAttribute('buildForArchiving') === 'YES')
    : [];
  const references = entries.length === 1 ? childElements(entries[0] as Element) : [];
  const reference = references.length === 1 ? references[0] : undefined;
  const hasSchemeActions = (element: Element): boolean => childElements(element).some((item) =>
    item.tagName === 'PreActions' || item.tagName === 'PostActions' || hasSchemeActions(item));
  if ((build[0] !== undefined && hasSchemeActions(build[0]))
    || (archive[0] !== undefined && hasSchemeActions(archive[0]))) {
    throw new Error('Existing ios project App archive scheme actions are unsupported.');
  }
  if (archive.length !== 1 || archive[0]?.getAttribute('buildConfiguration') !== 'Release'
    || reference?.tagName !== 'BuildableReference'
    || reference.getAttribute('BlueprintIdentifier') !== appTargetId
    || reference.getAttribute('BlueprintName') !== 'App'
    || reference.getAttribute('BuildableName') !== 'App.app'
    || reference.getAttribute('ReferencedContainer') !== 'container:App.xcodeproj') {
    throw new Error('Existing ios App archive scheme does not select the App target.');
  }
}

function hasAndroidMergerDirective(element: Element): boolean {
  return ['tools:node', 'tools:remove', 'tools:replace']
    .some((attribute) => element.hasAttribute(attribute));
}

function hasAndroidMergerDirectiveDeep(element: Element): boolean {
  return hasAndroidMergerDirective(element)
    || childElements(element).some(hasAndroidMergerDirectiveDeep);
}

function readAndroidApplication(file: string, required = true): Element | undefined {
  const root = parseXml(readFileSync(file, 'utf8'), 'android manifest').documentElement;
  const application = root === null
    ? undefined
    : childElements(root).find((element) => element.tagName === 'application');
  if (root?.tagName !== 'manifest' || (required && application === undefined)) {
    throw new Error('Existing android project manifest application is missing.');
  }
  return application;
}

function readAndroidLaunchers(application: Element): Element[] {
  return childElements(application).filter((activity) => {
    if (activity.tagName !== 'activity' && activity.tagName !== 'activity-alias') {
      return false;
    }
    return childElements(activity).some((filter) => filter.tagName === 'intent-filter'
      && childElements(filter).some((item) => item.tagName === 'action'
        && item.getAttribute('android:name') === 'android.intent.action.MAIN')
      && childElements(filter).some((item) => item.tagName === 'category'
        && item.getAttribute('android:name') === 'android.intent.category.LAUNCHER'));
  });
}

function resolveAndroidLabel(nativeDirectory: string, label: string): string {
  if (label.startsWith('@string/')) {
    return readAndroidString(nativeDirectory, label.slice('@string/'.length));
  }
  if (label.startsWith('@')) {
    throw new Error('Existing android project application label resource is unsupported.');
  }
  return label;
}

function readAndroidString(nativeDirectory: string, key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    throw new Error('Existing android project application label is unsupported.');
  }
  const overlay = path.join(nativeDirectory, 'app/src/release/res/values');
  const overlayValues = existsSync(overlay) && lstatSync(overlay).isDirectory()
    ? readdirSync(overlay).filter((file) => file.endsWith('.xml'))
      .flatMap((file) => readAndroidValueResource(path.join(overlay, file), 'string', key))
    : [];
  const main = path.join(nativeDirectory, 'app/src/main/res/values');
  const mainValues = existsSync(main) && lstatSync(main).isDirectory()
    ? readdirSync(main).filter((file) => file.endsWith('.xml'))
      .flatMap((file) => readAndroidValueResource(path.join(main, file), 'string', key))
    : [];
  const values = overlayValues.length > 0 ? overlayValues : mainValues;
  if (values.length !== 1) {
    throw new Error('Existing android project application label resource is missing or ambiguous.');
  }
  const qualified = ['main', 'release'].flatMap((sourceSet) =>
    listNativeFiles(nativeDirectory, `app/src/${sourceSet}/res`, '.xml')
      .filter((relative) => /^values-[^/]+$/u.test(path.basename(path.dirname(relative))))
      .flatMap((relative) => readAndroidValueResource(
        path.join(nativeDirectory, relative),
        'string',
        key,
      )));
  if (qualified.some((value) => value !== values[0])) {
    throw new Error('Existing android project configuration-qualified application label differs.');
  }
  return values[0] ?? '';
}

function readAndroidValueResource(file: string, type: string, name: string): string[] {
  const root = parseXml(readFileSync(file, 'utf8'), 'android values resource').documentElement;
  if (root?.tagName !== 'resources') {
    throw new Error('Existing android values resource is malformed.');
  }
  return childElements(root)
    .filter((element) => (element.tagName === type
      || element.tagName === 'item' && element.getAttribute('type') === type)
      && element.getAttribute('name') === name)
    .map((element) => type === 'string'
      ? decodeAndroidStringResource(element.textContent ?? '')
      : (element.textContent ?? ''));
}

export function decodeAndroidStringResource(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const source = quoted ? trimmed.slice(1, -1) : trimmed;
  let decoded = '';
  let unquotedWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (character !== '\\') {
      if (!quoted && /\s/u.test(character)) {
        if (!unquotedWhitespace) {
          decoded += ' ';
        }
        unquotedWhitespace = true;
      } else {
        decoded += character;
        unquotedWhitespace = false;
      }
      continue;
    }
    unquotedWhitespace = false;
    const next = source[index + 1];
    if (next === 'u' && /^[0-9a-fA-F]{4}$/u.test(source.slice(index + 2, index + 6))) {
      decoded += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
      index += 5;
      continue;
    }
    const escapes: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      '\\': '\\',
      "'": "'",
      '"': '"',
      '@': '@',
      '?': '?',
      ' ': ' ',
    };
    if (next === undefined || !Object.hasOwn(escapes, next)) {
      throw new Error('Existing android string resource has an unsupported escape.');
    }
    decoded += escapes[next] ?? '';
    index += 1;
  }
  return decoded;
}

function decodeXmlLabel(value: string): string {
  const trimmed = value.trim();
  let unsupported = false;
  const decoded = trimmed.replace(/&([^;]+);/gu,
    (_match, entity: string) => {
      const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
      };
      if (entity.startsWith('#')) {
        const point = entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (Number.isInteger(point) && point > 0 && point <= 0x10ffff
          && !(point >= 0xd800 && point <= 0xdfff)) {
          return String.fromCodePoint(point);
        }
      }
      if (Object.hasOwn(named, entity)) {
        return named[entity] ?? '';
      }
      unsupported = true;
      return '';
    });
  if (unsupported || trimmed.replace(/&[^;]+;/gu, '').includes('&')) {
    throw new Error('Existing native display name contains an unsupported XML entity.');
  }
  return decoded;
}

function requireOneNativeFile(
  directory: string,
  candidates: readonly string[],
  platform: 'android' | 'ios',
): string {
  const present = candidates.filter((relative) => isNativeFile(directory, relative));
  if (present.length !== 1) {
    throw new Error(
      `Existing ${platform} project is incomplete or ambiguous: ${candidates.join(', ')}.`,
    );
  }
  return present[0] ?? '';
}

function isNativeFile(directory: string, relative: string): boolean {
  const file = path.resolve(directory, relative);
  const within = path.relative(directory, file);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    return false;
  }
  let current = directory;
  for (const segment of within.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
      return false;
    }
  }
  return lstatSync(file).isFile();
}

function runCommand(command: string, args: readonly string[], cwd: string): void {
  const resolvedCommand = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command;
  const result = spawnSync(resolvedCommand, [...args], {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    timeout: 600_000,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed. The shell files remain for a safe retry.`,
    );
  }
}

function assertCompatibleExistingPackage(
  source: string,
  shellDependencies: Readonly<Record<string, string>>,
  capacitorVersion: string,
  typescriptVersion: string,
): void {
  const value = parseJsonObject(source, 'existing shell package');
  if (value.private !== true) {
    throw new Error('Existing Capacitor shell package must stay private.');
  }
  const dependencies = requireObject(value.dependencies, 'existing shell dependencies');
  const providerPackages = new Set([
    ...capacitorShellProviderPlugins.map((plugin) => plugin.packageName),
    ...notificationsShellPlugins,
  ]);
  for (const [name, version] of Object.entries(shellDependencies)) {
    // A store plugin the shell does not list yet is added by the plan. One it
    // lists at another version would compile native code that does not match
    // the game's JavaScript, so it is refused like any other pinned package.
    if (providerPackages.has(name) && dependencies[name] === undefined) {
      continue;
    }
    if (providerPackages.has(name) && dependencies[name] !== version) {
      throw new Error(
        `Existing shell ${name} is ${String(dependencies[name])} but the game uses ${version}; `
          + 'align the shell package with the game before rerunning.',
      );
    }
    if (dependencies[name] !== version) {
      throw new Error(`Existing shell ${name} differs; refusing to rewrite dependencies.`);
    }
  }
  const scripts = requireObject(value.scripts, 'existing shell scripts');
  if (scripts.cap !== 'cap') {
    throw new Error('Existing shell must expose the standard cap script.');
  }
  const devDependencies = requireObject(value.devDependencies, 'existing shell dev dependencies');
  if (devDependencies['@capacitor/cli'] !== capacitorVersion
    || devDependencies.typescript !== typescriptVersion) {
    throw new Error('Existing shell must include the pinned Capacitor CLI and TypeScript.');
  }
}

function normalizeBackendUrl(value: string): string {
  if (value.includes('$')) {
    throw new Error('Backend URL cannot contain dotenv expansion syntax.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Backend URL must be an absolute HTTPS URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.hash !== '' || parsed.search !== '') {
    throw new Error('Backend URL must be HTTPS without credentials, search, or fragment.');
  }
  if (isNonPublicServiceHostname(parsed.hostname)) {
    throw new Error('Backend URL must use a public HTTPS hostname for production.');
  }
  return parsed.href.replace(/\/$/u, '');
}

function readDotenvValue(source: string): string {
  const value = source.trim();
  if (!value.startsWith('"') && !value.startsWith("'")) {
    return value.split('#', 1)[0]?.trim() ?? '';
  }
  const quote = value[0];
  let closing = -1;
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== '\\') {
      closing = index;
      break;
    }
  }
  if (closing < 0 || (value.slice(closing + 1).trim() !== ''
    && !value.slice(closing + 1).trim().startsWith('#'))) {
    throw new Error('Production Game Services URL has malformed dotenv syntax.');
  }
  return value.slice(1, closing);
}

function readCapacitorConfigLiteral(source: string, key: 'appId' | 'appName' | 'webDir'):
  string | undefined {
  const expression = new RegExp(
    `^[ \\t]*${key}:[ \\t]*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')[ \\t]*,?[ \\t]*\\r?$`,
    'gmu',
  );
  const matches = [...source.matchAll(expression)];
  const literal = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (literal === undefined) {
    return undefined;
  }
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return undefined;
    }
  }
  const body = literal.slice(1, -1);
  let value = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      value += character;
      continue;
    }
    const escaped = body[++index];
    const replacements: Record<string, string> = {
      "'": "'",
      '"': '"',
      '\\': '\\',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escaped === undefined || !(escaped in replacements)) {
      return undefined;
    }
    value += replacements[escaped];
  }
  return value;
}

/** Refuse dynamic identity overrides; preserve the authored file without evaluating it. */
function requireStaticCapacitorConfig(source: string): string {
  let withoutComments = '';
  let codeOnly = '';
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '`') {
      throw new Error('Existing Capacitor config has ambiguous dynamic syntax.');
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      let closed = false;
      while (index < source.length) {
        const current = source[index] ?? '';
        withoutComments += current;
        codeOnly += current === '\n' ? '\n' : ' ';
        index += 1;
        if (current === '\\' && index < source.length) {
          withoutComments += source[index];
          codeOnly += ' ';
          index += 1;
        } else if (current === quote && index - 1 !== start) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new Error('Existing Capacitor config has an unterminated string.');
      }
      continue;
    }
    if (character === '/' && (next === '/' || next === '*')) {
      const block = next === '*';
      withoutComments += '  ';
      codeOnly += '  ';
      index += 2;
      while (index < source.length) {
        if (block && source[index] === '*' && source[index + 1] === '/') {
          withoutComments += '  ';
          codeOnly += '  ';
          index += 2;
          break;
        }
        if (!block && source[index] === '\n') {
          break;
        }
        const current = source[index] ?? '';
        const masked = current === '\n' ? '\n' : ' ';
        withoutComments += masked;
        codeOnly += masked;
        index += 1;
      }
      continue;
    }
    withoutComments += character;
    codeOnly += character;
    index += 1;
  }
  const configUses = [...codeOnly.matchAll(/\bconfig\b(?!\s*:)/gu)].length;
  const declaration = /\bconst\s+config\s*:\s*CapacitorConfig\s*=\s*\{/u.exec(codeOnly);
  if (declaration?.index === undefined) {
    throw new Error('Existing Capacitor config has ambiguous dynamic syntax.');
  }
  const opening = declaration.index + declaration[0].length - 1;
  const topLevelSource = maskNestedConfig(withoutComments, codeOnly, opening);
  const topLevelCode = maskNestedConfig(codeOnly, codeOnly, opening);
  const identityKeysAreUnique = (['appId', 'appName', 'webDir'] as const).every((key) =>
    [...topLevelCode.matchAll(new RegExp(`\\b${key}\\b`, 'gu'))].length === 1,
  );
  const computedProperty = /(?:\{|,)[ \t\n]*(?:(?:get|set)[ \t\n]+)?\[[^\]]*\][ \t\n]*(?::|\()/u;
  const hasComputedKey = computedProperty.test(topLevelCode);
  if (configUses !== 1 || topLevelCode.includes('...') || hasComputedKey
    || /\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/u.test(topLevelCode)
    || !identityKeysAreUnique
    || /^[ \t]*["'](?:appId|appName|webDir)["'][ \t]*:/mu.test(topLevelSource)
    || !/\bexport\s+default\s+config\s*;/u.test(codeOnly)) {
    throw new Error('Existing Capacitor config has ambiguous dynamic syntax.');
  }
  assertNoCapacitorServerUrl(withoutComments, codeOnly, topLevelCode);
  return topLevelSource;
}

function assertNoCapacitorServerUrl(source: string, code: string, topLevel: string): void {
  if (/^[ \t]*["']server["']\s*:/mu.test(source)) {
    throw new Error('Existing Capacitor config server field is ambiguous.');
  }
  const quotedKeys = [...source.matchAll(/(?:\{|,)\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*:/gu)];
  if (quotedKeys.some((match) => (match[2] ?? '').includes('\\'))) {
    throw new Error('Existing Capacitor config quoted property key is ambiguous.');
  }
  if (/\b(?:get|set)\s+server\s*\(/u.test(topLevel)
    || /(?:^|[,\s{])server\s*(?:,|\})/u.test(topLevel)) {
    throw new Error('Existing Capacitor config server field is dynamic.');
  }
  const server = /\bserver\s*:/u.exec(topLevel);
  if (server?.index === undefined) {
    return;
  }
  const afterColon = server.index + server[0].length;
  const opening = code.indexOf('{', afterColon);
  if (opening < 0 || code.slice(afterColon, opening).trim() !== '') {
    throw new Error('Existing Capacitor config server field is not a static object.');
  }
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(opening, index + 1);
        if (body.includes('...')
          || /\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/u.test(body)
          || /(?:^|[,\s{])(?:get|set)\s+\w+\s*\(/u.test(body)
          || /(?:^|[,\s{])(?:(?:get|set)\s+)?\[[^\]]+\]\s*(?::|\()/u.test(body)) {
          throw new Error('Existing Capacitor config server field has dynamic properties.');
        }
        const bodyCode = code.slice(opening, index + 1);
        if (/(?:^|[,\s{])["']?url["']?\s*:/u.test(body)
          || /(?:^|[,\s{])url\s*(?:,|\})/u.test(bodyCode)) {
          throw new Error('Existing Capacitor config server.url is unsupported.');
        }
        return;
      }
    }
  }
  throw new Error('Existing Capacitor config server field is incomplete.');
}

function maskNestedConfig(source: string, code: string, opening: number): string {
  const output: string[] = source.split('').map((character) => character === '\n' ? '\n' : ' ');
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    const character = code[index];
    if (character === '{') {
      depth += 1;
      if (depth === 1) {
        output[index] = source[index] ?? ' ';
      }
    } else if (character === '}') {
      if (depth === 1) {
        output[index] = source[index] ?? ' ';
      }
      depth -= 1;
      if (depth === 0) {
        return output.join('');
      }
    } else if (depth === 1) {
      output[index] = source[index] ?? ' ';
    }
  }
  throw new Error('Existing Capacitor config object is incomplete.');
}

function appendEnvLine(current: string, line: string): string {
  const separator = current !== '' && !current.endsWith('\n') ? '\n' : '';
  return `${current}${separator}${line}\n`;
}

function relativeGameFile(gameRoot: string, file: string): string {
  const canonical = realpathSync(path.resolve(gameRoot, file));
  const relative = path.relative(gameRoot, canonical);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Icon source must be a game-owned file.');
  }
  if (!lstatSync(canonical).isFile()) {
    throw new Error('Icon source must be a file.');
  }
  return relative.split(path.sep).join('/');
}

function readExisting(file: string): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  assertNotSymlink(file);
  return readFileSync(file, 'utf8');
}

function assertNotSymlink(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`Refusing to write through a symbolic link: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Adds the requested store plugins to an existing shell package, keeping every
 * other field as the game wrote it. The content is unchanged when nothing is
 * missing, so an untouched shell stays out of the change list.
 */
function withPackageDependencies(
  source: string,
  plugins: readonly { readonly packageName: string; readonly version: string }[],
): string {
  const value = parseJsonObject(source, 'existing shell package');
  const dependencies = requireObject(value.dependencies, 'existing shell dependencies');
  const missing = plugins.filter((plugin) => dependencies[plugin.packageName] === undefined);
  if (missing.length === 0) {
    return source;
  }
  return json({
    ...value,
    dependencies: {
      ...dependencies,
      ...Object.fromEntries(missing.map((plugin) => [plugin.packageName, plugin.version])),
    },
  });
}

/**
 * Resolves one requested store plugin to the exact version the shell and the
 * game pin: the game's installed copy, or, when the game does not declare the
 * plugin yet, the version this CLI release ships with (its published dev
 * dependency, or the plugin package of the kit checkout it runs from). A
 * declared but uninstalled plugin, or one whose peers the game's installed
 * kit packages do not satisfy, is refused before anything is written.
 */
function resolveProviderPlugin(
  gameRoot: string,
  gameDependencies: Readonly<Record<string, unknown>>,
  cliDevelopmentDependencies: Readonly<Record<string, unknown>>,
  plugin: CapacitorShellProviderPlugin,
): CapacitorShellPlannedProviderPlugin {
  const installedFile = path.join(gameRoot, 'node_modules', plugin.packageName, 'package.json');
  let version: string;
  let versionSource: CapacitorShellPlannedProviderPlugin['versionSource'];
  let peerDependencies: unknown;
  if (existsSync(installedFile)) {
    const installed = readJsonObject(installedFile);
    version = requireString(installed.version, `installed ${plugin.packageName} version`);
    versionSource = 'installed';
    peerDependencies = installed.peerDependencies;
  } else if (gameDependencies[plugin.packageName] !== undefined) {
    throw new Error(
      `The game declares ${plugin.packageName} but it is not installed; install game `
        + 'dependencies before initializing the shell.',
    );
  } else {
    const kitPackageFile = fileURLToPath(
      new URL(`../../../${plugin.packageDir}/package.json`, import.meta.url),
    );
    const kitPackage = existsSync(kitPackageFile) ? readJsonObject(kitPackageFile) : undefined;
    const published = cliDevelopmentDependencies[plugin.packageName];
    const known = typeof published === 'string' && valid(published) !== null
      ? published
      : kitPackage?.name === plugin.packageName
        ? kitPackage.version
        : undefined;
    if (typeof known !== 'string') {
      throw new Error(
        `Provider ${plugin.id} needs ${plugin.packageName}, and this CLI does not know which `
          + `version to install; add it to the game (pnpm add ${plugin.packageName}) and rerun.`,
      );
    }
    version = known;
    versionSource = 'kit';
    peerDependencies = kitPackage?.peerDependencies;
  }
  if (valid(version) === null || version.includes('+')) {
    throw new Error(`${plugin.packageName} must resolve to a concrete version, not ${version}.`);
  }
  if (typeof peerDependencies === 'object' && peerDependencies !== null) {
    // Every declared peer the game has installed must satisfy the plugin's
    // range (Capacitor core, the bridge, the adapter, and the platform alike),
    // so an incompatible host is refused before the shell or gateway is written.
    for (const [peer, range] of Object.entries(
      peerDependencies as Readonly<Record<string, unknown>>,
    )) {
      const peerFile = path.join(gameRoot, 'node_modules', peer, 'package.json');
      if (typeof range !== 'string' || !existsSync(peerFile)) {
        continue;
      }
      const peerVersion = readJsonObject(peerFile).version;
      if (typeof peerVersion === 'string' && valid(peerVersion) !== null
        && !satisfies(peerVersion, range, { includePrerelease: true })) {
        throw new Error(
          `Provider ${plugin.id} (${plugin.packageName}@${version}) needs ${peer} ${range}, but `
            + `the game has ${peerVersion}; upgrade the game's kit packages (mpgd kit upgrade) first.`,
        );
      }
    }
  }
  return { ...plugin, version, versionSource };
}

/**
 * Plans the gateway wiring for the requested store plugins. A gateway that
 * already imports the plugin is left alone; a gateway that is still the
 * unwired template gateway is replaced by the template's wired gateway, with
 * the support modules it imports written when the game has none; every other
 * gateway is game-owned, so the plan only warns. Nothing here can enable a
 * purchase: the wired gateway registers the store provider, and grants still
 * come from the backend ledger through the reconciler.
 */
function planProviderGatewayWiring(
  gameRoot: string,
  templateRoot: string | undefined,
  plugins: readonly CapacitorShellPlannedProviderPlugin[],
  warnings: string[],
): PlannedFile[] {
  const planned = new Map<string, string>();
  for (const plugin of plugins) {
    const current = readExisting(safeDestination(gameRoot, plugin.gatewayFile));
    // Wired means the gateway calls the plugin's service-provider factory; a
    // type-only or unused import of the package does not register anything.
    if (current !== undefined && new RegExp(`\\b${plugin.gatewayFactory}\\s*\\(`, 'u').test(current)) {
      continue;
    }
    const register = `register ${plugin.gatewayFactory} from ${plugin.packageName} there so the `
      + 'shell plugin is used';
    if (current === undefined) {
      warnings.push(`${plugin.gatewayFile} is missing; ${register}.`);
      continue;
    }
    const legacy = plugin.legacyGatewaySources.includes(current.replace(/\r\n/gu, '\n'));
    if (!legacy || templateRoot === undefined) {
      warnings.push(`${plugin.gatewayFile} does not call ${plugin.gatewayFactory}; ${register}.`);
      continue;
    }
    const support = new Map<string, string>();
    let kept: string | undefined;
    for (const file of capacitorShellProviderSupportFiles) {
      const existing = readExisting(safeDestination(gameRoot, file));
      const template = readTemplateFile(templateRoot, file);
      if (existing === undefined) {
        support.set(file, template);
      } else if (existing !== template) {
        kept = file;
        break;
      }
    }
    if (kept !== undefined) {
      warnings.push(
        `${plugin.gatewayFile} was not rewritten because the game-owned ${kept} differs from `
          + `the template; ${register}.`,
      );
      continue;
    }
    planned.set(plugin.gatewayFile, readTemplateFile(templateRoot, plugin.gatewayFile));
    for (const [file, content] of support) {
      planned.set(file, content);
    }
  }
  return [...planned].map(([file, content]) => ({ path: file, content }));
}

interface PlannedNotificationsProvider {
  readonly shellPlugins: readonly { readonly packageName: string; readonly version: string }[];
  /** The packages the game declares for notifications, at the versions to add when missing. */
  readonly gameDependencies: Readonly<Record<string, string>>;
  readonly files: readonly PlannedFile[];
}

/** The permission line that drops `SCHEDULE_EXACT_ALARM` from the merged Android manifest. */
export const androidInexactAlarmPermission =
  '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" tools:node="remove" />';

/** Whether an Android manifest already drops `SCHEDULE_EXACT_ALARM` from the merge. */
export function androidManifestRemovesExactAlarm(manifest: string): boolean {
  const code = withoutXmlComments(manifest);
  return /<uses-permission\b[^>]*android:name\s*=\s*"android\.permission\.SCHEDULE_EXACT_ALARM"[^>]*tools:node\s*=\s*"remove"/u
    .test(code)
    || /<uses-permission\b[^>]*tools:node\s*=\s*"remove"[^>]*android:name\s*=\s*"android\.permission\.SCHEDULE_EXACT_ALARM"/u
      .test(code);
}

/** The manifest with each XML comment blanked to spaces, so offsets stay the same. */
function withoutXmlComments(manifest: string): string {
  return manifest.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ' '));
}

/**
 * Drops `SCHEDULE_EXACT_ALARM`, which `@capacitor/local-notifications` adds
 * to the merged manifest: reminders are inexact (notifications RFC
 * "Reminders"), Android 14 denies the permission to new installs, and Play
 * restricts it to alarm and calendar apps. The tools namespace is bound on
 * the manifest root when missing. A manifest that already drops it is
 * returned unchanged.
 */
export function applyAndroidManifestInexactAlarms(manifest: string): string {
  if (androidManifestRemovesExactAlarm(manifest)) {
    return manifest;
  }
  const code = withoutXmlComments(manifest);
  const root = /<manifest\b[^>]*?>/u.exec(code);
  const close = code.lastIndexOf('</manifest>');
  if (root === null || close === -1 || root[0].endsWith('/>') || close < root.index) {
    return manifest;
  }
  const newline = manifest.includes('\r\n') ? '\r\n' : '\n';
  let rootTag = manifest.slice(root.index, root.index + root[0].length);
  if (!/\sxmlns:tools\s*=/u.test(rootTag)) {
    rootTag = rootTag.replace(/^<manifest\b/u, `<manifest xmlns:tools="${androidToolsNamespace}"`);
  }
  const head = `${manifest.slice(0, root.index)}${rootTag}${manifest.slice(root.index + root[0].length, close)}`;
  return `${head.trimEnd()}${newline}    ${androidInexactAlarmPermission}${newline}${manifest.slice(close)}`;
}

function materializeAndroidInexactAlarms(gameRoot: string): void {
  const manifestFile = safeDestination(
    gameRoot,
    `${shellPath}/android/app/src/main/AndroidManifest.xml`,
  );
  if (!existsSync(manifestFile) || !lstatSync(manifestFile).isFile()) {
    return;
  }
  const source = readFileSync(manifestFile, 'utf8');
  const next = applyAndroidManifestInexactAlarms(source);
  if (next !== source) {
    writeFileSync(manifestFile, next);
  }
}

/**
 * Plans `--providers notifications` for the shell and the game: the two
 * Capacitor plugins at the game's installed versions (or the starter's), the
 * game's notifications packages, and, when a Capacitor gateway is still the
 * template's, its notifications wiring with the starter modules it imports.
 * A game-owned gateway is only checked. Native setup the initializer never
 * writes (Firebase files, the iOS capability, an existing Android manifest)
 * is reported as warnings.
 */
function planNotificationsProvider(input: {
  readonly gameRoot: string;
  readonly templateRoot: string | undefined;
  readonly displayName: string;
  readonly gameDependencies: Readonly<Record<string, unknown>>;
  readonly existingShellPackage: string | undefined;
  readonly plannedGateways: readonly PlannedFile[];
  readonly warnings: string[];
}): PlannedNotificationsProvider {
  const { gameRoot, gameDependencies, warnings } = input;
  const shellDependencies = input.existingShellPackage === undefined
    ? {}
    : requireObject(
        parseJsonObject(input.existingShellPackage, 'existing shell package').dependencies,
        'existing shell dependencies',
      );
  if (gameDependencies[conflictingPushPlugin] !== undefined
    || shellDependencies[conflictingPushPlugin] !== undefined) {
    throw new Error(
      `--providers notifications installs @capacitor-firebase/messaging, which cannot run next to `
        + `${conflictingPushPlugin}: on iOS both claim Capacitor's one push handler. Remove `
        + `${conflictingPushPlugin} from the game and the shell first.`,
    );
  }
  const versionOf = (name: string): { readonly version: string; readonly installed: boolean } => {
    const installedFile = path.join(gameRoot, 'node_modules', name, 'package.json');
    if (existsSync(installedFile)) {
      const installed = readJsonObject(installedFile);
      const version = requireString(installed.version, `installed ${name} version`);
      if (valid(version) === null) {
        throw new Error(`${name} must resolve to a concrete version, not ${version}.`);
      }
      // The plugin's own peers (Capacitor core) must accept the game's
      // installed copies, as a store plugin's must.
      assertInstalledPeers(gameRoot, `${name}@${version}`, installed.peerDependencies);
      return { version, installed: true };
    }
    if (gameDependencies[name] !== undefined) {
      throw new Error(
        `The game declares ${name} but it is not installed; install game dependencies before `
          + 'initializing the shell.',
      );
    }
    const version = notificationsGameDependencies[name];
    if (version === undefined) {
      throw new Error(`No starter version is known for ${name}.`);
    }
    return { version, installed: false };
  };
  const shellPlugins = notificationsShellPlugins.map((name) => ({
    packageName: name,
    ...versionOf(name),
  }));
  // The wiring imports @mpgd/adapter-capacitor/notifications: the game's
  // installed adapter must have it, and the plugins must satisfy its peers.
  const adapter = readJsonObject(
    path.join(gameRoot, 'node_modules/@mpgd/adapter-capacitor/package.json'),
  );
  const adapterExports = adapter.exports;
  if (typeof adapterExports !== 'object' || adapterExports === null
    || (adapterExports as Readonly<Record<string, unknown>>)['./notifications'] === undefined) {
    throw new Error(
      `--providers notifications needs @mpgd/adapter-capacitor/notifications, which the game's `
        + `@mpgd/adapter-capacitor ${String(adapter.version)} does not export; upgrade the game's kit `
        + 'packages (mpgd kit upgrade) first.',
    );
  }
  // The starter's provider module also imports the settings opener, which
  // an adapter older than this CLI's notifications starter does not have.
  // The subpath's declared types file (dist/notifications.d.ts today), and
  // the module it re-exports the opener from.
  const adapterRoot = path.join(gameRoot, 'node_modules/@mpgd/adapter-capacitor');
  const declaredTypes = (adapterExports as Readonly<Record<string, unknown>>)['./notifications'];
  const typesPath = typeof declaredTypes === 'object' && declaredTypes !== null
    && typeof (declaredTypes as { readonly types?: unknown }).types === 'string'
    ? (declaredTypes as { readonly types: string }).types
    : './dist/notifications.d.ts';
  const adapterTypes = readExisting(path.join(adapterRoot, typesPath));
  const openerTypes = readExisting(
    path.join(adapterRoot, path.dirname(typesPath), 'notifications-settings.d.ts'),
  );
  // Refused only when the declarations show the opener is absent: an
  // `export *` the check cannot follow passes, and the build then decides.
  if (adapterTypes !== undefined && !/\bexport\s*\*/u.test(adapterTypes)
    && !`${adapterTypes}\n${openerTypes ?? ''}`.includes('openCapacitorNotificationSettings')) {
    throw new Error(
      `The game's @mpgd/adapter-capacitor ${String(adapter.version)} has no `
        + 'openCapacitorNotificationSettings, which the notifications starter uses; upgrade the '
        + "game's kit packages (mpgd kit upgrade) first.",
    );
  }
  // The adapter's other peers (Capacitor core) must accept the game's
  // installed copies too; the plugins get their own message below.
  assertInstalledPeers(
    gameRoot,
    `@mpgd/adapter-capacitor@${String(adapter.version)}`,
    typeof adapter.peerDependencies === 'object' && adapter.peerDependencies !== null
      ? Object.fromEntries(Object.entries(adapter.peerDependencies as Record<string, unknown>)
        .filter(([name]) => !notificationsShellPlugins.includes(name)))
      : undefined,
  );
  const adapterPeers = typeof adapter.peerDependencies === 'object' && adapter.peerDependencies !== null
    ? adapter.peerDependencies as Readonly<Record<string, unknown>>
    : {};
  for (const plugin of shellPlugins) {
    const range = adapterPeers[plugin.packageName];
    // A range semver cannot read (`workspace:*`, a tag) is not checked.
    if (typeof range === 'string' && validRange(range) !== null
      && !satisfies(plugin.version, range, { includePrerelease: true })) {
      throw new Error(
        plugin.installed
          ? `@mpgd/adapter-capacitor ${String(adapter.version)} needs ${plugin.packageName} ${range}, `
            + `but the game has ${plugin.version}; align the game's version before rerunning.`
          : `@mpgd/adapter-capacitor ${String(adapter.version)} needs ${plugin.packageName} ${range}, `
            + `but this CLI would add ${plugin.version}; add a version in that range to the game `
            + `(pnpm add ${plugin.packageName}) or upgrade the CLI, then rerun.`,
      );
    }
  }
  // The messaging plugin's web fallback imports `firebase`: the game's own
  // copy must be in the plugin's peer range. For the plugin the starter
  // adds, the kit pins the range. An installed plugin names its own, which
  // `versionOf` already checked against an installed firebase; this covers
  // the firebase the CLI would add.
  const messaging = shellPlugins.find(
    (plugin) => plugin.packageName === notificationsMessagingPlugin,
  );
  const firebase = versionOf('firebase');
  if (messaging !== undefined) {
    const installedPeers = messaging.installed
      ? readJsonObject(
        path.join(gameRoot, 'node_modules', notificationsMessagingPlugin, 'package.json'),
      ).peerDependencies
      : undefined;
    const declared = typeof installedPeers === 'object' && installedPeers !== null
      ? (installedPeers as Readonly<Record<string, unknown>>)['firebase']
      : undefined;
    const firebaseRange = messaging.installed ? declared : notificationsMessagingFirebaseRange;
    if (typeof firebaseRange === 'string' && validRange(firebaseRange) !== null
      && !satisfies(firebase.version, firebaseRange, { includePrerelease: true })) {
      throw new Error(
        firebase.installed
          ? `@capacitor-firebase/messaging ${messaging.version} needs firebase ${firebaseRange}, but the game `
            + `has ${firebase.version}; align the game's firebase (pnpm add firebase@"${firebaseRange}") `
            + 'before rerunning.'
          : `@capacitor-firebase/messaging ${messaging.version} needs firebase ${firebaseRange}, but this `
            + `CLI would add ${firebase.version}; add a version in that range to the game `
            + `(pnpm add firebase@"${firebaseRange}") or upgrade the CLI, then rerun.`,
      );
    }
  }
  const gamePackages = Object.fromEntries(
    Object.keys(notificationsGameDependencies).map((name) => [name, versionOf(name).version]),
  );

  const register = 'register createStarterCapacitorNotifications (src/platform/capacitorNotifications.ts) '
    + 'or createCapacitorNotificationServiceProvider from @mpgd/adapter-capacitor/notifications in its '
    + 'providers';
  const files: PlannedFile[] = [];
  const overlayRoot = input.templateRoot === undefined
    ? undefined
    : path.join(path.dirname(input.templateRoot), 'notifications-overlay', 'common');
  const jsonTitle = JSON.stringify(input.displayName).slice(1, -1);
  const starterFile = (root: string, file: string): string => {
    // A function replacer: `$&` or `$$` in a display name stays literal.
    const title = file.endsWith('.json') ? jsonTitle : input.displayName;
    return readTemplateFile(root, file).replaceAll('__GAME_TITLE__', () => title);
  };
  // The wired gateway imports these starter modules; a game-owned copy that
  // differs keeps the gateway as it is, as a differing store module does.
  const keptModule = overlayRoot === undefined
    ? undefined
    : notificationsCapacitorGatewayModules.find((file) => {
        const existing = readExisting(safeDestination(gameRoot, file));
        return existing !== undefined
          && existing.replace(/\r\n/gu, '\n') !== starterFile(overlayRoot, file);
      });
  for (const gatewayFile of Object.values(notificationsCapacitorGateways)) {
    const current = input.plannedGateways.find((file) => file.path === gatewayFile)?.content
      ?? readExisting(safeDestination(gameRoot, gatewayFile));
    if (current !== undefined && capacitorGatewayRegistersNotifications(current)) {
      continue;
    }
    if (current === undefined) {
      warnings.push(`${gatewayFile} is missing; ${register}.`);
      continue;
    }
    const template = input.templateRoot === undefined
      ? undefined
      : readTemplateFile(input.templateRoot, gatewayFile);
    if (template === undefined || current.replace(/\r\n/gu, '\n') !== template) {
      warnings.push(
        `${gatewayFile} does not register notifications and is game-owned; ${register}.`,
      );
      continue;
    }
    if (keptModule !== undefined) {
      warnings.push(
        `${gatewayFile} was not rewritten because the game-owned ${keptModule} differs from the `
          + `notifications starter; ${register}.`,
      );
      continue;
    }
    files.push({
      path: gatewayFile,
      content: wireCapacitorGatewayNotifications(gatewayFile, template),
    });
  }
  if (files.length > 0 && overlayRoot !== undefined) {
    // The starter modules and catalog the wired gateways read; the game keeps any it has.
    for (const file of notificationsCapacitorSupportFiles) {
      if (readExisting(safeDestination(gameRoot, file)) === undefined) {
        files.push({ path: file, content: starterFile(overlayRoot, file) });
      }
    }
    // Base-template modules they import, missing from a game an earlier release created.
    if (input.templateRoot !== undefined) {
      for (const file of notificationsCapacitorTemplateSupportFiles) {
        if (readExisting(safeDestination(gameRoot, file)) !== undefined) {
          continue;
        }
        const imported = notificationsCapacitorTemplateSupportImporters[file];
        const importerSource = imported === undefined
          ? undefined
          : readExisting(safeDestination(gameRoot, imported.importer));
        // A game whose own importer does not import the module would never use it.
        if (imported !== undefined && importerSource !== undefined
          && !sourceReferencesRelativeModule(importerSource, path.posix.basename(file, '.ts'))) {
          warnings.push(imported.warning);
          continue;
        }
        // The file imports a kit export an older installed package lacks.
        const required = imported?.requires;
        if (required !== undefined
          && installedPackageLacksExport(gameRoot, required.packageName, required.exportName)) {
          const version = installedPackageVersion(gameRoot, required.packageName);
          throw new Error(
            `--providers notifications writes ${file}, which imports ${required.exportName} from `
              + `${required.packageName}; the game's ${required.packageName} ${version} does not export it. `
              + "Upgrade the game's kit packages (mpgd kit upgrade) first.",
          );
        }
        files.push({ path: file, content: starterFile(input.templateRoot, file) });
      }
    }
    warnings.push(
      'The notification settings screen is not added to an existing game; render one from '
        + 'src/platform/notificationSettings.ts (see docs/NOTIFICATIONS.md) so players can turn '
        + 'reminders and advertising consent on and off.',
    );
  }

  const androidManifest = readExisting(
    safeDestination(gameRoot, `${shellPath}/android/app/src/main/AndroidManifest.xml`),
  );
  if (androidManifest !== undefined && !androidManifestRemovesExactAlarm(androidManifest)) {
    warnings.push(
      `${shellPath}/android/app/src/main/AndroidManifest.xml keeps SCHEDULE_EXACT_ALARM, which `
        + '@capacitor/local-notifications adds; reminders are inexact, so add '
        + `${androidInexactAlarmPermission} to the manifest.`,
    );
  }
  if (readExisting(safeDestination(gameRoot, `${shellPath}/android/app/google-services.json`)) === undefined) {
    warnings.push(
      `Android push needs ${shellPath}/android/app/google-services.json from the Firebase console `
        + '(see the mpgd-kit Firebase guide); without it the push half fails closed.',
    );
  }
  if (readExisting(safeDestination(gameRoot, `${shellPath}/ios/App/App/GoogleService-Info.plist`))
    === undefined) {
    warnings.push(
      `iOS push needs ${shellPath}/ios/App/App/GoogleService-Info.plist, the Push Notifications `
        + 'capability, an APNs key uploaded to Firebase, and the AppDelegate forwarding the '
        + 'messaging plugin documents (see the mpgd-kit Firebase guide).',
    );
  }
  return {
    shellPlugins: shellPlugins.map(({ packageName, version }) => ({ packageName, version })),
    gameDependencies: gamePackages,
    files,
  };
}

/**
 * Refuses a package whose declared peers the game's installed copies do not
 * satisfy (Capacitor core, the kit packages), before anything is written.
 */
function assertInstalledPeers(gameRoot: string, label: string, peerDependencies: unknown): void {
  if (typeof peerDependencies !== 'object' || peerDependencies === null) {
    return;
  }
  for (const [peer, range] of Object.entries(
    peerDependencies as Readonly<Record<string, unknown>>,
  )) {
    const peerFile = path.join(gameRoot, 'node_modules', peer, 'package.json');
    // A range semver cannot read (`workspace:*`, a tag) is not checked.
    if (typeof range !== 'string' || validRange(range) === null || !existsSync(peerFile)) {
      continue;
    }
    const peerVersion = readJsonObject(peerFile).version;
    if (typeof peerVersion === 'string' && valid(peerVersion) !== null
      && !satisfies(peerVersion, range, { includePrerelease: true })) {
      throw new Error(
        `${label} needs ${peer} ${range}, but the game has ${peerVersion}; align the game's `
          + 'versions before rerunning.',
      );
    }
  }
}

/** A regular file of the CLI's game template, read without leaving the template root. */
function readTemplateFile(templateRoot: string, relative: string): string {
  const root = realpathSync(templateRoot);
  const file = path.resolve(root, relative);
  const within = path.relative(root, file);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error(`Game template path escapes the template root: ${relative}`);
  }
  if (!existsSync(file) || !lstatSync(file).isFile()
    || path.relative(root, realpathSync(file)).startsWith('..')) {
    throw new Error(`Game template file is missing: ${relative}`);
  }
  return readFileSync(file, 'utf8');
}

function resolveInstalledPluginVersion(gameRoot: string, requirement: string): string {
  const adapterRoot = path.dirname(
    realpathSync(path.join(gameRoot, 'node_modules/@mpgd/adapter-capacitor/package.json')),
  );
  const installedPackage = path.join(
    adapterRoot,
    'node_modules/@mpgd/capacitor-game-services/package.json',
  );
  const fallbackPackage = path.join(
    gameRoot,
    'node_modules/@mpgd/capacitor-game-services/package.json',
  );
  const installedFile = existsSync(installedPackage) ? installedPackage : fallbackPackage;
  const installed = existsSync(installedFile)
    ? requireString(readJsonObject(installedFile).version, 'installed game-services plugin version')
    : undefined;
  const version = installed ?? requirement;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(
      'Install a concrete Capacitor game-services plugin before initializing the shell.',
    );
  }
  return version;
}

function readJsonObject(file: string): Record<string, unknown> {
  return parseJsonObject(readFileSync(file, 'utf8'), file);
}

function parseJsonObject(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  return requireObject(parsed, label);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Declaration files the export check reads at most: a guard against a pathological graph. */
const maxDeclarationFilesChecked = 500;

/** The declaration file names TypeScript pairs with a module specifier. */
function declarationCandidates(base: string): readonly string[] {
  // A specifier that already names a declaration file is that file.
  if (/\.d\.[cm]?ts$/u.test(base)) {
    return [base];
  }
  const extension = path.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  switch (extension) {
    case '.js':
    case '.ts':
      return [`${stem}.d.ts`];
    case '.mjs':
    case '.mts':
      return [`${stem}.d.mts`];
    case '.cjs':
    case '.cts':
      return [`${stem}.d.cts`];
    default:
      return [`${base}.d.ts`, path.join(base, 'index.d.ts')];
  }
}

/**
 * Whether the game's installed `packageName` provably lacks `exportName`:
 * its root type declarations, and every declaration file they re-export
 * from through relative specifiers, at any depth, never name it. Anything
 * the check cannot follow passes, and the game's build then decides, as for
 * the adapter's settings opener: an uninstalled or unreadable package, a
 * module it cannot read, or an `export *` from another package.
 */
function installedPackageLacksExport(gameRoot: string, packageName: string, exportName: string): boolean {
  // Only a plain identifier is searched for; anything else is not proof of absence.
  if (!/^[A-Za-z_$][\w$]*$/u.test(exportName)) {
    return false;
  }
  const packageRoot = path.join(gameRoot, 'node_modules', packageName);
  const manifest = readInstalledManifest(gameRoot, packageName);
  if (manifest === undefined) {
    return false;
  }
  const rootExport = typeof manifest.exports === 'object' && manifest.exports !== null
    ? (manifest.exports as Readonly<Record<string, unknown>>)['.']
    : undefined;
  const rootTypes = typeof rootExport === 'object' && rootExport !== null
    ? (rootExport as { readonly types?: unknown }).types
    : undefined;
  const typesPath = typeof rootTypes === 'string' ? rootTypes : manifest.types;
  if (typeof typesPath !== 'string') {
    return false;
  }
  // Every declaration file the root re-exports from, followed through relative
  // `export … from` specifiers at any depth; the name is searched as text, so a
  // named re-export of it counts as well.
  const relativeFrom = /\bexport\b[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/gu;
  const packageStar = /\bexport\s*(?:type\s*)?\*\s*(?:as\s+[\w$]+\s*)?from\s*['"](?!\.{1,2}\/)[^'"]+['"]/u;
  const nameUsed = new RegExp(`(?<![\\w$])${exportName.replace(/\$/gu, '\\$')}(?![\\w$])`, 'u');
  const pending = [path.join(packageRoot, typesPath)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop() ?? '';
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    if (visited.size > maxDeclarationFilesChecked) {
      return false;
    }
    let source: string | undefined;
    try {
      source = readExisting(file);
    } catch {
      source = undefined;
    }
    if (source === undefined || packageStar.test(source)) {
      // A module the check cannot read, or names from another package: do not refuse on a guess.
      return false;
    }
    if (nameUsed.test(source)) {
      return false;
    }
    for (const match of source.matchAll(relativeFrom)) {
      const candidates = declarationCandidates(path.join(path.dirname(file), match[1] ?? ''));
      pending.push(candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? file);
    }
  }
  return true;
}

/** The game's installed `packageName` manifest, or `undefined` when it is missing or unreadable. */
function readInstalledManifest(gameRoot: string, packageName: string): Record<string, unknown> | undefined {
  try {
    const source = readExisting(path.join(gameRoot, 'node_modules', packageName, 'package.json'));
    return source === undefined
      ? undefined
      : parseJsonObject(source, `${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

/** The installed package's version, for a message. */
function installedPackageVersion(gameRoot: string, packageName: string): string {
  const version = readInstalledManifest(gameRoot, packageName)?.version;
  return typeof version === 'string' ? version : 'unknown';
}
