/** The Capacitor shell's application target, the one `-target App` builds. */
export const iosSimulatorAppTarget = 'App';

/** The variable that carries a smoke value for one target only. */
function perTarget(setting: string): string {
  return `MPGD_SMOKE_${setting}_$(TARGET_NAME)`;
}

/**
 * Command-line build settings for an unsigned simulator build of the shell's
 * App target with the smoke Info.plist and without its storyboards and asset
 * catalog.
 *
 * xcodebuild applies a `SETTING=value` argument to every target in the build,
 * including the Swift package targets a shell's plugins pull in (Firebase,
 * Google utilities), so `INFOPLIST_FILE=App/Info-Smoke.plist` sent Xcode
 * looking for `firebase-ios-sdk/App/Info-Smoke.plist` in
 * `Firebase_FirebaseCore`. Each setting is therefore routed through a
 * variable named after `$(TARGET_NAME)` that only the App target defines:
 * every other target resolves it empty and keeps its own value through
 * `$(inherited)` (or `:default=$(inherited)` for a single path).
 *
 * `ASSETCATALOG_COMPILER_APPICON_NAME` stays a plain override: only an
 * application target names an app icon set, so clearing it changes the App
 * target alone, and an asset catalog a game adds would otherwise fail the
 * build looking for the excluded `AppIcon`.
 */
export function iosSimulatorSmokeBuildSettings(
  swiftConditions: readonly string[] = [],
): string[] {
  const app = iosSimulatorAppTarget;
  return [
    `INFOPLIST_FILE=$(${perTarget('INFOPLIST_FILE')}:default=$(inherited))`,
    `MPGD_SMOKE_INFOPLIST_FILE_${app}=App/Info-Smoke.plist`,
    `EXCLUDED_SOURCE_FILE_NAMES=$(inherited) $(${perTarget('EXCLUDED_SOURCE_FILE_NAMES')})`,
    `MPGD_SMOKE_EXCLUDED_SOURCE_FILE_NAMES_${app}=Main.storyboard LaunchScreen.storyboard Assets.xcassets`,
    'ASSETCATALOG_COMPILER_APPICON_NAME=',
    ...(swiftConditions.length === 0
      ? []
      : [
          `SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) $(${perTarget('SWIFT_ACTIVE_COMPILATION_CONDITIONS')})`,
          `MPGD_SMOKE_SWIFT_ACTIVE_COMPILATION_CONDITIONS_${app}=${swiftConditions.join(' ')}`,
        ]),
  ];
}
