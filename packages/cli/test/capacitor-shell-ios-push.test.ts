import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { iosPushWiringWarnings, materializeIosPushWiring } from '../src/capacitor-shell-starter.js';
import {
  applyIosAppDelegatePushForwarding,
  applyIosProjectPushEntitlements,
  applyIosSceneDelegateColdStartForwarding,
  inspectIosFirebaseConfig,
  inspectIosPushWiring,
  iosAppBundlesResource,
  iosAppDelegatePushForwardingSwift,
  iosPushEntitlementsFile,
  iosPushEntitlementsSetting,
  iosPushEntitlementsXml,
  readIosAppReleaseEntitlements,
  readPlistTopLevelValue,
  resolveIosEntitlementsSetting,
  shellUsesFirebaseMessaging,
  stripSwiftCommentsAndStrings,
  swiftForwardsColdStartNotification,
  swiftForwardsPushToken,
} from '../src/native-shell-store-policy.js';
import { notificationsMessagingPlugin } from '../src/notifications-starter.js';
import {
  inspectNativeStorePolicy,
  reportNativeStorePolicy,
} from '../../../tools/target/native-store-policy.js';

// iOS push wiring for generated Capacitor shells (`--providers notifications`,
// mobile launch L5b): the aps-environment entitlement, the AppDelegate's APNs
// token forwarding, and the reference shell's cold-start tap forwarding (#407).

/** The reference shell lives in the checkout, not next to the compiled test (prepared CI lane). */
function resolveKitRoot(): string {
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    fileURLToPath(new URL('../../..', import.meta.url)),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0
      && existsSync(path.join(root, 'apps/mobile-capacitor/ios/App/App/SceneDelegate.swift'))) {
      return root;
    }
  }
  throw new Error(`Cannot locate the kit checkout from ${candidates.join(', ')}.`);
}

const kitRoot = resolveKitRoot();
const referenceShell = path.join(kitRoot, 'apps/mobile-capacitor');
const referenceSceneDelegate = readFileSync(
  path.join(referenceShell, 'ios/App/App/SceneDelegate.swift'),
  'utf8',
);
const referenceProject = readFileSync(
  path.join(referenceShell, 'ios/App/App.xcodeproj/project.pbxproj'),
  'utf8',
);

// The AppDelegate and SceneDelegate `cap add ios` copies from Capacitor 8.5.2's
// ios-spm-template (@capacitor/cli assets/ios-spm-template.tar.gz).
const capacitorAppDelegate = [
  'import UIKit',
  'import Capacitor',
  '',
  '@UIApplicationMain',
  'class AppDelegate: UIResponder, UIApplicationDelegate {',
  '',
  '    var window: UIWindow?',
  '',
  '    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {',
  '        // Override point for customization after application launch.',
  '        return true',
  '    }',
  '',
  '    func applicationWillResignActive(_ application: UIApplication) {',
  '        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.',
  '        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.',
  '    }',
  '',
  '    func applicationDidEnterBackground(_ application: UIApplication) {',
  '        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.',
  '        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.',
  '    }',
  '',
  '    func applicationWillEnterForeground(_ application: UIApplication) {',
  '        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.',
  '    }',
  '',
  '    func applicationDidBecomeActive(_ application: UIApplication) {',
  '        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.',
  '    }',
  '',
  '    func applicationWillTerminate(_ application: UIApplication) {',
  '        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.',
  '    }',
  '',
  '    func application(_ application: UIApplication,',
  '                     configurationForConnecting connectingSceneSession: UISceneSession,',
  '                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {',
  '        let config = UISceneConfiguration(name: "Default Configuration",',
  '                                          sessionRole: connectingSceneSession.role)',
  '        config.delegateClass = SceneDelegate.self',
  '        return config',
  '    }',
  '}',
  '',
].join('\n');
const capacitorSceneDelegate = [
  'import UIKit',
  'import Capacitor',
  '',
  'class SceneDelegate: UIResponder, UIWindowSceneDelegate {',
  '    var window: UIWindow?',
  '',
  '    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {',
  '        guard let windowScene = scene as? UIWindowScene else { return }',
  '',
  '        window = UIWindow(windowScene: windowScene)',
  '        window?.rootViewController = CAPBridgeViewController()',
  '        window?.makeKeyAndVisible()',
  '',
  '        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)',
  '    }',
  '',
  '    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {',
  '        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)',
  '    }',
  '',
  '    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {',
  '        SceneDelegateProxy.shared.scene(scene, continue: userActivity)',
  '    }',
  '}',
  '',
].join('\n');

const roots: string[] = [];
const temporaryRoot = (prefix: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
const crlf = (source: string): string => source.replace(/\n/gu, '\r\n');

try {
  // When the kit's Capacitor CLI is installed, its template must still be the
  // one the patches above are written against: a Capacitor upgrade that
  // changes it fails here instead of shipping shells without the wiring.
  const templateArchive = path.join(
    referenceShell,
    'node_modules/@capacitor/cli/assets/ios-spm-template.tar.gz',
  );
  if (existsSync(templateArchive)) {
    const extracted = temporaryRoot('mpgd-ios-template-');
    const tar = spawnSync('tar', ['-xzf', templateArchive, '-C', extracted], { encoding: 'utf8' });
    if (tar.status === 0) {
      assert.equal(
        readFileSync(path.join(extracted, 'App/App/AppDelegate.swift'), 'utf8'),
        capacitorAppDelegate,
      );
      assert.equal(
        readFileSync(path.join(extracted, 'App/App/SceneDelegate.swift'), 'utf8'),
        capacitorSceneDelegate,
      );
      const templateProject = readFileSync(
        path.join(extracted, 'App/App.xcodeproj/project.pbxproj'),
        'utf8',
      );
      const patched = applyIosProjectPushEntitlements(templateProject);
      assert.ok(patched !== undefined, "Capacitor's template project takes the entitlements");
      assert.equal(readIosAppReleaseEntitlements(patched), iosPushEntitlementsSetting);
    } else {
      console.info(`Skipped the Capacitor template check: tar failed (${tar.stderr.trim()}).`);
    }
  }

  // The cold-start forwarding turns Capacitor's scene delegate into the reference shell's.
  assert.equal(
    applyIosSceneDelegateColdStartForwarding(capacitorSceneDelegate),
    referenceSceneDelegate,
  );
  assert.equal(
    applyIosSceneDelegateColdStartForwarding(referenceSceneDelegate),
    referenceSceneDelegate,
    'a scene delegate that forwards the response is kept',
  );
  assert.equal(
    applyIosSceneDelegateColdStartForwarding(crlf(capacitorSceneDelegate)),
    crlf(referenceSceneDelegate),
    'CRLF sources keep their line endings',
  );
  assert.equal(
    applyIosSceneDelegateColdStartForwarding(
      capacitorSceneDelegate.replace(
        'import Capacitor',
        'import Capacitor\nimport UserNotifications',
      ),
    ),
    referenceSceneDelegate,
    'an existing UserNotifications import is not repeated',
  );
  assert.equal(
    applyIosSceneDelegateColdStartForwarding(
      capacitorSceneDelegate.replace(
        /\n {8}SceneDelegateProxy\.shared\.scene\(scene, willConnectTo[^\n]*/u,
        '',
      ),
    ),
    undefined,
    'a scene delegate without the Capacitor proxy call is left to the game',
  );
  assert.equal(
    applyIosSceneDelegateColdStartForwarding(
      capacitorSceneDelegate.replace('class SceneDelegate', 'final class GameSceneDelegate'),
    ),
    undefined,
  );
  assert.equal(
    applyIosSceneDelegateColdStartForwarding(
      capacitorSceneDelegate.replace('    var window', '    // connectionOptions.notificationResponse\n    var window'),
    )?.includes('forwardColdStartNotification(connectionOptions.notificationResponse)'),
    true,
    'a comment that names the response is not the forwarding',
  );
  assert.equal(swiftForwardsColdStartNotification(capacitorSceneDelegate), false);
  assert.equal(swiftForwardsColdStartNotification(referenceSceneDelegate), true);

  // The APNs token forwarding the messaging plugin documents.
  const appDelegate = applyIosAppDelegatePushForwarding(capacitorAppDelegate);
  assert.ok(appDelegate !== undefined);
  assert.ok(
    appDelegate.endsWith(
      `        return config\n    }\n\n${iosAppDelegatePushForwardingSwift.join('\n')}\n}\n`,
    ),
    'the forwarding closes the AppDelegate class',
  );
  assert.equal(swiftForwardsPushToken(appDelegate), true);
  assert.equal(swiftForwardsPushToken(capacitorAppDelegate), false);
  assert.equal(applyIosAppDelegatePushForwarding(appDelegate), appDelegate, 'idempotent');
  assert.equal(applyIosAppDelegatePushForwarding(crlf(capacitorAppDelegate)), crlf(appDelegate));
  assert.equal(
    applyIosAppDelegatePushForwarding(capacitorAppDelegate.replace(
      '    func applicationWillTerminate',
      '    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {}\n\n    func applicationWillTerminate',
    )),
    undefined,
    "a game's own registration callback is not doubled",
  );
  assert.equal(
    applyIosAppDelegatePushForwarding(
      capacitorAppDelegate.replace('UIApplicationDelegate', 'NSObject'),
    ),
    undefined,
  );
  assert.equal(
    swiftForwardsPushToken(
      `${capacitorAppDelegate}// didRegisterForRemoteNotificationsWithDeviceToken: .capacitorDidRegisterForRemoteNotifications\n`,
    ),
    false,
    'a comment is not the forwarding',
  );
  assert.equal(
    swiftForwardsPushToken(
      '/* outer /* nested */ didRegisterForRemoteNotificationsWithDeviceToken */ let x = "capacitorDidRegisterForRemoteNotifications"',
    ),
    false,
    'nested comments and strings are not code',
  );
  const swift = 'let a = """\n"quoted" { \n""" // }\nlet b = "\\"}" /* { */ + 1';
  assert.equal(stripSwiftCommentsAndStrings(swift).length, swift.length, 'offsets are kept');
  const forward = (body: string): string =>
    `func application(_ a: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken t: Data) {${body}}`;
  const post = ' NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: t) ';
  assert.equal(
    swiftForwardsPushToken(`let s = #"5" screen"#\n${forward(post)}`),
    true,
    'raw strings',
  );
  assert.equal(swiftForwardsPushToken(`let s = ##"a "# b"##\n${forward(post)}`), true);
  assert.equal(
    swiftForwardsPushToken(`let s = "unterminated\n${forward(post)}`),
    true,
    'resyncs at a newline',
  );
  assert.equal(
    swiftForwardsPushToken(
      `${forward(' ')}\nlet o = NotificationCenter.default.addObserver(forName: .capacitorDidRegisterForRemoteNotifications, object: nil, queue: nil) { _ in }`,
    ),
    false,
    'the post must be inside the registration callback',
  );
  assert.equal(swiftForwardsPushToken(forward(' Messaging.messaging().apnsToken = t ')), true);
  assert.doesNotMatch(stripSwiftCommentsAndStrings(swift), /[{}"]/u);

  // The entitlement on every App target configuration, outside the build phases.
  const project = applyIosProjectPushEntitlements(referenceProject);
  assert.ok(project !== undefined);
  assert.equal(readIosAppReleaseEntitlements(referenceProject), undefined);
  assert.equal(readIosAppReleaseEntitlements(project), iosPushEntitlementsSetting);
  assert.equal(
    project.match(/\bCODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/gu)?.length,
    2,
    'Debug and Release of the App target, not the project-level configurations',
  );
  assert.equal(
    project.match(/\/\* App\.entitlements \*\/ = \{isa = PBXFileReference;/gu)?.length,
    1,
  );
  assert.doesNotMatch(project, /App\.entitlements in /u, 'the entitlements file is not bundled');
  assert.equal(applyIosProjectPushEntitlements(project), project, 'idempotent');
  assert.equal(
    applyIosProjectPushEntitlements(
      applyIosProjectPushEntitlements(referenceProject)?.replaceAll(
        'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;',
        'CODE_SIGN_ENTITLEMENTS = App/Game.entitlements;',
      ) ?? '',
    ),
    undefined,
    'another entitlements file is left to the game',
  );
  const sourceRootSetting = project.replaceAll(
    'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;',
    'CODE_SIGN_ENTITLEMENTS = "$(SRCROOT)/App/App.entitlements";',
  );
  assert.equal(applyIosProjectPushEntitlements(sourceRootSetting), sourceRootSetting);
  assert.equal(
    resolveIosEntitlementsSetting('$(SRCROOT)/App/App.entitlements'),
    'App/App.entitlements',
  );
  assert.equal(
    resolveIosEntitlementsSetting('${PROJECT_DIR}/App/App.entitlements'),
    'App/App.entitlements',
  );
  assert.equal(resolveIosEntitlementsSetting('$(TARGET_NAME)/App.entitlements'), undefined);
  assert.equal(applyIosProjectPushEntitlements('// not a project'), undefined);
  assert.equal(
    readPlistTopLevelValue(iosPushEntitlementsXml, 'aps-environment')?.xml,
    '<string>development</string>',
  );

  // Inspection: what the production preflight and the initializer report.
  const wired = {
    project,
    readProjectFile: (relative: string) =>
      relative === iosPushEntitlementsSetting ? iosPushEntitlementsXml : undefined,
    swiftSources: [appDelegate, referenceSceneDelegate],
  };
  assert.deepEqual(inspectIosPushWiring(wired), []);
  const stock = inspectIosPushWiring({
    project: referenceProject,
    readProjectFile: () => undefined,
    swiftSources: [capacitorAppDelegate, capacitorSceneDelegate],
  });
  assert.deepEqual(
    stock.map((issue) => issue.level),
    ['error', 'error', 'error'],
  );
  assert.match(
    stock[0]?.message ?? '',
    /aps-environment entitlement.*CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements/u,
  );
  assert.match(
    stock[1]?.message ?? '',
    /capacitorDidRegisterForRemoteNotifications, object: deviceToken/u,
  );
  assert.match(
    stock[2]?.message ?? '',
    /forwardColdStartNotification\(connectionOptions\.notificationResponse\)/u,
  );
  assert.deepEqual(
    inspectIosPushWiring({ ...wired, readProjectFile: () => undefined }).map((issue) => issue.level),
    ['error'],
    'a setting whose file is missing',
  );
  assert.equal(
    inspectIosPushWiring({
      ...wired,
      readProjectFile: () => iosPushEntitlementsXml.replace('development', 'staging'),
    })[0]?.level,
    'error',
  );
  assert.equal(
    inspectIosPushWiring({ ...wired, readProjectFile: () => '<plist><dict><key>aps-environment' })[0]?.level,
    'error',
    'an unreadable entitlements file',
  );
  assert.deepEqual(
    inspectIosPushWiring({
      ...wired,
      project: project.replaceAll(
        'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;',
        'CODE_SIGN_ENTITLEMENTS = "$(TARGET_NAME)/App.entitlements";',
      ),
    }).map((issue) => issue.level),
    ['warning'],
    'a setting the kit cannot resolve is only reported',
  );
  const levels = (changed: Partial<typeof wired>): readonly string[] =>
    inspectIosPushWiring({ ...wired, ...changed }).map((issue) => issue.level);
  assert.deepEqual(
    levels({
      project: project.replace(
        /(\/\* Release \*\/ = \{\s*isa = XCBuildConfiguration;\s*buildSettings = \{[^}]*?)CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/u,
        '$1"CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]" = App/App.entitlements;',
      ),
    }),
    ['warning'],
    'a per-SDK setting is only reported',
  );
  const perSdk = referenceProject.replace(
    'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;',
    'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n\t\t\t\t"CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]" = App/Game.entitlements;',
  );
  assert.notEqual(perSdk, referenceProject);
  assert.equal(
    applyIosProjectPushEntitlements(perSdk),
    undefined,
    'a per-SDK setting is left to the game',
  );
  const releaseId = /([0-9A-F]{24}) \/\* Release \*\/ = \{\s*isa = XCBuildConfiguration;\s*buildSettings = \{\s*ASSETCATALOG/u
    .exec(referenceProject)?.[1];
  assert.ok(releaseId !== undefined);
  assert.deepEqual(
    levels({
      project: referenceProject.replace(
        new RegExp(`(${releaseId} /\\* Release \\*/ = \\{\\s*isa = XCBuildConfiguration;)`, 'u'),
        '$1\n\t\t\tbaseConfigurationReference = 958DCC722DB07C7200EA8C5F /* release.xcconfig */;',
      ),
    }),
    ['warning'],
    'an xcconfig may set the entitlements',
  );
  assert.deepEqual(levels({ project: referenceProject }), ['error'], 'no setting and no xcconfig');
  // The App target inherits the project-level Release settings.
  const projectRelease = /([0-9A-F]{24}) \/\* Release \*\/ = \{\s*isa = XCBuildConfiguration;\s*buildSettings = \{\s*ALWAYS_SEARCH/u
    .exec(referenceProject)?.[1];
  assert.ok(projectRelease !== undefined);
  const inherited = referenceProject.replace(
    new RegExp(
      `(${projectRelease} /\\* Release \\*/ = \\{\\s*isa = XCBuildConfiguration;\\s*buildSettings = \\{)`,
      'u',
    ),
    '$1\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;',
  );
  assert.notEqual(inherited, referenceProject);
  assert.deepEqual(levels({ project: inherited }), [], 'an inherited project-level setting counts');
  assert.deepEqual(
    levels({
      project: referenceProject.replace(
        new RegExp(
          `(${projectRelease} /\\* Release \\*/ = \\{\\s*isa = XCBuildConfiguration;)`,
          'u',
        ),
        '$1\n\t\t\tbaseConfigurationReference = 958DCC722DB07C7200EA8C5F /* release.xcconfig */;',
      ),
    }),
    ['warning'],
    'a project-level xcconfig may set it too',
  );
  assert.deepEqual(
    levels({
      project: inherited.replace(
        new RegExp(`(${releaseId} /\\* Release \\*/ = \\{\\s*isa = XCBuildConfiguration;)`, 'u'),
        '$1\n\t\t\tbaseConfigurationReference = 958DCC722DB07C7200EA8C5F /* release.xcconfig */;',
      ),
    }),
    ['warning'],
    'a target xcconfig may override the inherited setting',
  );
  assert.deepEqual(
    levels({
      readProjectFile: () => iosPushEntitlementsXml.replace('development', '$(APS_ENVIRONMENT)'),
    }),
    ['warning'],
    'a build-setting value is only reported',
  );
  assert.deepEqual(levels({ project: '// not a project' }), ['warning']);
  // A shell without scenes gets the cold-start tap through the notification center.
  assert.deepEqual(levels({ swiftSources: [appDelegate] }), []);
  assert.deepEqual(levels({ swiftSources: [appDelegate, capacitorSceneDelegate] }), ['error']);
  assert.equal(
    shellUsesFirebaseMessaging({ dependencies: { [notificationsMessagingPlugin]: '8.5.2' } }),
    true,
  );
  assert.equal(shellUsesFirebaseMessaging({ dependencies: {} }), false);
  assert.equal(shellUsesFirebaseMessaging(undefined), false);

  // A freshly generated project gets all three; a second run changes nothing.
  const game = temporaryRoot('mpgd-ios-push-');
  const ios = path.join(game, 'apps/mobile-capacitor/ios/App');
  const write = (relative: string, content: string): void => {
    const file = path.join(ios, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const read = (relative: string): string => readFileSync(path.join(ios, relative), 'utf8');
  write('App.xcodeproj/project.pbxproj', referenceProject);
  write('App/AppDelegate.swift', capacitorAppDelegate);
  write('App/SceneDelegate.swift', capacitorSceneDelegate);
  write('App/public/index.html', '<!doctype html>');
  assert.equal(iosPushWiringWarnings(game).length, 3, 'an existing project only gets the steps');
  assert.match(
    iosPushWiringWarnings(game)[0] ?? '',
    /^apps\/mobile-capacitor\/ios is game-owned and not rewritten: /u,
  );
  materializeIosPushWiring(game);
  assert.equal(read(`App/${iosPushEntitlementsFile}`), iosPushEntitlementsXml);
  assert.equal(read('App.xcodeproj/project.pbxproj'), project);
  assert.equal(read('App/AppDelegate.swift'), appDelegate);
  assert.equal(read('App/SceneDelegate.swift'), referenceSceneDelegate);
  assert.deepEqual(iosPushWiringWarnings(game), []);
  materializeIosPushWiring(game);
  assert.equal(read('App.xcodeproj/project.pbxproj'), project);
  assert.equal(read('App/AppDelegate.swift'), appDelegate);
  assert.equal(iosPushWiringWarnings(temporaryRoot('mpgd-ios-push-empty-')).length, 0);

  // A layout the patches do not know is reported, never guessed at.
  const unexpected = temporaryRoot('mpgd-ios-push-unexpected-');
  const unexpectedIos = path.join(unexpected, 'apps/mobile-capacitor/ios/App');
  mkdirSync(path.join(unexpectedIos, 'App.xcodeproj'), { recursive: true });
  mkdirSync(path.join(unexpectedIos, 'App'), { recursive: true });
  writeFileSync(path.join(unexpectedIos, 'App.xcodeproj/project.pbxproj'), referenceProject);
  writeFileSync(
    path.join(unexpectedIos, 'App/AppDelegate.swift'),
    'final class GameDelegate {}\n',
    {
      flag: 'w',
    },
  );
  const gameScene = 'final class GameScene: UIResponder, UIWindowSceneDelegate {}\n';
  writeFileSync(path.join(unexpectedIos, 'App/SceneDelegate.swift'), gameScene);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => {
    warned.push(message);
  };
  try {
    materializeIosPushWiring(unexpected);
  } finally {
    console.warn = warn;
  }
  assert.equal(
    readFileSync(path.join(unexpectedIos, 'App/AppDelegate.swift'), 'utf8'),
    'final class GameDelegate {}\n',
  );
  assert.equal(warned.length, 2, 'the token and cold-start steps are printed');
  assert.equal(
    readFileSync(path.join(unexpectedIos, 'App/SceneDelegate.swift'), 'utf8'),
    gameScene,
    'a scene delegate without the Capacitor layout is not rewritten',
  );
  assert.ok(
    warned.every((message) =>
      message.startsWith('[mpgd] The generated iOS project has an unexpected layout: '),
    ),
  );

  // The production preflight fails a shell with the messaging plugin that lacks the wiring.
  const shell = temporaryRoot('mpgd-ios-push-shell-');
  const shellIos = path.join(shell, 'ios/App');
  mkdirSync(path.join(shellIos, 'App.xcodeproj'), { recursive: true });
  mkdirSync(path.join(shellIos, 'App'), { recursive: true });
  writeFileSync(path.join(shellIos, 'App.xcodeproj/project.pbxproj'), referenceProject);
  writeFileSync(
    path.join(shellIos, 'App/Info.plist'),
    readFileSync(path.join(referenceShell, 'ios/App/App/Info.plist')),
  );
  writeFileSync(path.join(shellIos, 'App/AppDelegate.swift'), capacitorAppDelegate);
  writeFileSync(path.join(shellIos, 'App/SceneDelegate.swift'), capacitorSceneDelegate);
  writeFileSync(path.join(shell, 'package.json'), JSON.stringify({ dependencies: {} }));
  const pushMessages = (issues: readonly { readonly message: string }[]): readonly string[] =>
    issues.map((issue) => issue.message).filter((message) =>
      message.includes('@capacitor-firebase/messaging'),
    );
  assert.deepEqual(
    pushMessages(inspectNativeStorePolicy({ platform: 'ios', shellApp: shell })),
    [],
    'a shell without the messaging plugin is not checked',
  );
  writeFileSync(
    path.join(shell, 'package.json'),
    JSON.stringify({ dependencies: { [notificationsMessagingPlugin]: '8.5.2' } }),
  );
  const unwired = inspectNativeStorePolicy({ platform: 'ios', shellApp: shell });
  assert.equal(pushMessages(unwired).length, 4);
  assert.equal(unwired.filter((issue) => issue.level === 'error').length, 3);
  const logged: string[] = [];
  assert.throws(
    () => reportNativeStorePolicy(unwired, true, (message) => logged.push(message)),
    /aps-environment entitlement[\s\S]*forwards the APNs device token[\s\S]*connectionOptions\.notificationResponse/u,
  );
  assert.doesNotThrow(
    () => reportNativeStorePolicy(unwired, false, () => undefined),
    'staging only warns',
  );
  writeFileSync(path.join(shellIos, 'App.xcodeproj/project.pbxproj'), project);
  writeFileSync(path.join(shellIos, `App/${iosPushEntitlementsFile}`), iosPushEntitlementsXml);
  writeFileSync(path.join(shellIos, 'App/AppDelegate.swift'), appDelegate);
  writeFileSync(path.join(shellIos, 'App/SceneDelegate.swift'), referenceSceneDelegate);
  const wiredIssues = inspectNativeStorePolicy({ platform: 'ios', shellApp: shell });
  assert.equal(pushMessages(wiredIssues).length, 1);
  assert.match(
    pushMessages(wiredIssues)[0] ?? '',
    /does not bundle GoogleService-Info\.plist/u,
    'only the Firebase config file is left, as a warning',
  );
  assert.equal(
    wiredIssues.some((issue) => issue.level === 'error'),
    false,
  );
  assert.deepEqual(
    inspectIosFirebaseConfig(project).map((issue) => issue.level),
    ['warning'],
  );
  assert.equal(iosAppBundlesResource(project, 'GoogleService-Info.plist'), false);

  console.info('iOS push wiring for generated Capacitor shells passed.');
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}
