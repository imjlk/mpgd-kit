import { isDeepStrictEqual } from 'node:util';

/**
 * pnpm `packageExtensions` for the Devvit release the kit pins.
 *
 * Some Devvit packages import modules at runtime that their manifests do not
 * declare. A hoisted `node_modules` happens to resolve them; pnpm's global
 * virtual store and other isolated layouts do not, and the Devvit build,
 * playtest or upload stops on an unresolved import. The kit root and the game
 * template's `pnpm-workspace.yaml` declare these extensions, and
 * `pnpm validate:starter-workflow` checks both files against the pinned Devvit
 * version, so a Devvit bump moves the keys together with the pins.
 *
 * The entries come from an audit of every `devvit` and `@devvit/*` 0.15.4
 * package: each bare `import`, `export … from`, `import()` and `require()` in
 * its published JavaScript, compared with its dependencies, peerDependencies
 * and optionalDependencies. Left out because no build, playtest or upload
 * loads them: the `*.test.js` files `@devvit/cli` ships (vitest),
 * `@devvit/linkers`' `test/test-builder.js` (`@devvit/internal-examples`), and
 * declaration files that name packages only for types.
 */

/**
 * The `long` release that protobufjs, which `@devvit/protos` declares, resolves
 * in the kit lockfile. Extending protos with the same release keeps one copy.
 */
export const devvitProtosLongVersion = '5.3.2';

export interface DevvitPackageExtension {
  readonly dependencies: Readonly<Record<string, string>>;
}

/** The extensions a workspace that pins Devvit `version` declares, keyed by pnpm selector. */
export function devvitPackageExtensions(
  version: string,
): Readonly<Record<string, DevvitPackageExtension>> {
  return {
    // `devvit upload` and `devvit playtest` bundle build-pack's devvit.json
    // entry template, which imports these from build-pack's own directory.
    [`@devvit/build-pack@${version}`]: {
      dependencies: { '@devvit/public-api': version, '@devvit/scheduler': version },
    },
    // MediaClient imports @devvit/shared-types, a devDependency of media.
    [`@devvit/media@${version}`]: { dependencies: { '@devvit/shared-types': version } },
    // Generated protobuf modules (the Redis client among them) import long directly.
    [`@devvit/protos@${version}`]: { dependencies: { long: devvitProtosLongVersion } },
  };
}

/** The package a pnpm selector names: `name`, `name@range` or `@scope/name@range`. */
export function selectorPackageName(selector: string): string {
  const versionAt = selector.indexOf('@', selector.startsWith('@') ? 1 : 0);
  return versionAt === -1 ? selector : selector.slice(0, versionAt);
}

function isDevvitPackage(name: string): boolean {
  return name === 'devvit' || name.startsWith('@devvit/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface DevvitPackageExtensionsInput {
  /** The workspace file, named in messages. */
  readonly path: string;
  /** The parsed `pnpm-workspace.yaml`. */
  readonly workspace: unknown;
  /** The exact Devvit version the workspace's Devvit apps pin. */
  readonly devvitVersion: string;
}

/**
 * Failures when a workspace's Devvit `packageExtensions` differ from
 * `devvitPackageExtensions(devvitVersion)`: an entry is missing or declares
 * other dependencies, or an entry names another Devvit package or version,
 * such as the keys a Devvit bump left behind. Extensions of other packages
 * are not checked.
 */
export function checkDevvitPackageExtensions(input: DevvitPackageExtensionsInput): string[] {
  const { path, devvitVersion } = input;
  const declared = isRecord(input.workspace) ? input.workspace.packageExtensions : undefined;
  if (declared !== undefined && !isRecord(declared)) {
    return [`${path}: packageExtensions must be a mapping.`];
  }
  const actual = declared ?? {};
  const expected = devvitPackageExtensions(devvitVersion);
  const failures: string[] = [];
  for (const [selector, extension] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, selector)) {
      failures.push(
        `${path}: packageExtensions must declare '${selector}': ${JSON.stringify(extension)}.`,
      );
    } else if (!isDeepStrictEqual(actual[selector], extension)) {
      failures.push(
        `${path}: packageExtensions '${selector}' must be ${JSON.stringify(extension)}, `
          + `not ${JSON.stringify(actual[selector])}.`,
      );
    }
  }
  for (const selector of Object.keys(actual)) {
    if (isDevvitPackage(selectorPackageName(selector)) && !Object.hasOwn(expected, selector)) {
      failures.push(
        `${path}: packageExtensions '${selector}' is not an extension Devvit `
          + `${devvitVersion} needs; move it to the pinned version or remove it.`,
      );
    }
  }
  return failures;
}
