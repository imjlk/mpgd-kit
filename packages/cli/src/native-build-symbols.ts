import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

// Crash symbols a native release build leaves next to its store artifact, so
// `mpgd deploy run` can record them in the immutable build record:
//
// - Android: the R8 `mapping.txt` of a minified release build. Google Play
//   gets it as the bundle's deobfuscation file (`deploy submit` uses the
//   recorded one); the Crashlytics Gradle plugin uploads it to Crashlytics
//   during the build itself.
// - iOS, when the shell installs Firebase Crashlytics: the archive's dSYMs
//   (zipped, with their UUIDs), the shell's `upload-symbols` tool from its
//   Swift Package Manager (or CocoaPods) checkout, and the
//   `GoogleService-Info.plist` the archived app bundles. `mpgd deploy run`
//   uploads them with `upload-symbols -gsp <plist> -p ios <zip>`.

/** Game-relative paths, under the build's `release-output/native/<target>/` root. */
export interface NativeBuildSymbols {
  /** Android: R8 `mapping.txt` of this exact bundle. */
  readonly r8Mapping?: string;
  /** iOS with Firebase Crashlytics. */
  readonly crashlytics?: NativeBuildCrashlyticsSymbols;
}

export interface NativeBuildCrashlyticsSymbols {
  /** Zip of the archive's `dSYMs` folder. */
  readonly dsymArchive: string;
  /** Each dSYM bundle in the archive and the Mach-O UUIDs of its DWARF files. */
  readonly dsyms: readonly NativeDsymIdentity[];
  /** Firebase's `upload-symbols` from the shell's package checkout. */
  readonly uploadTool: string;
  /** The `GoogleService-Info.plist` the archived app bundles. */
  readonly googleServiceInfo: string;
}

export interface NativeDsymIdentity {
  readonly bundle: string;
  readonly uuids: readonly string[];
}

/**
 * Validate a symbols record read from a build status file. `isPath` checks
 * each recorded path (game-relative, inside the build's output root).
 */
export function assertNativeBuildSymbols(
  value: unknown,
  isPath: (file: string) => boolean,
): asserts value is NativeBuildSymbols {
  const isRecord = (entry: unknown): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry);
  const pathField = (entry: unknown): boolean => typeof entry === 'string' && isPath(entry);
  if (!isRecord(value)
    || Object.keys(value).some((key) => key !== 'r8Mapping' && key !== 'crashlytics')
    || (value.r8Mapping === undefined) === (value.crashlytics === undefined)
    || (value.r8Mapping !== undefined && !pathField(value.r8Mapping))) {
    throw new Error('Native build symbols are malformed.');
  }
  const crashlytics = value.crashlytics;
  if (crashlytics === undefined) {
    return;
  }
  if (!isRecord(crashlytics)
    || Object.keys(crashlytics).some((key) =>
      !['dsymArchive', 'dsyms', 'uploadTool', 'googleServiceInfo'].includes(key))
    || !pathField(crashlytics.dsymArchive) || !pathField(crashlytics.uploadTool)
    || !pathField(crashlytics.googleServiceInfo)
    || !isDsymIdentityList(crashlytics.dsyms)) {
    throw new Error('Native build symbols are malformed.');
  }
}

/** A non-empty, sorted list of dSYM bundles with their UUIDs. */
export function isDsymIdentityList(value: unknown): value is readonly NativeDsymIdentity[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 256
    && value.every((entry: unknown) => typeof entry === 'object' && entry !== null
      && !Array.isArray(entry)
      && Object.keys(entry).every((key) => key === 'bundle' || key === 'uuids')
      && typeof (entry as NativeDsymIdentity).bundle === 'string'
      && isDsymBundleName((entry as NativeDsymIdentity).bundle)
      && Array.isArray((entry as NativeDsymIdentity).uuids)
      && (entry as NativeDsymIdentity).uuids.length > 0
      && (entry as NativeDsymIdentity).uuids.length <= 32
      && (entry as NativeDsymIdentity).uuids.every(isDsymUuid));
}

/** A dSYM bundle file name: no path separator or control character, not hidden. */
export function isDsymBundleName(name: string): boolean {
  return name.length <= 255 && /^[^./\\\u0000-\u001f\u007f][^/\\\u0000-\u001f\u007f]*\.dSYM$/u.test(name);
}

/**
 * A game-relative path under the target's native build output root
 * (`release-output/native/<target>/`), without empty or `..` segments.
 */
export function isNativeOutputPath(file: string, target: string): boolean {
  return file.startsWith(`release-output/native/${target}/`) && !path.isAbsolute(file)
    && !file.split(/[\\/]/u).some((segment) => segment === '' || segment === '..');
}

/** Where AGP writes the release variant's R8 mapping file. */
export const androidReleaseMappingPath = 'app/build/outputs/mapping/release/mapping.txt';

/** File names inside the build's `symbols/` directory. */
export const nativeSymbolFileNames = Object.freeze({
  r8Mapping: 'mapping.txt',
  dsymArchive: 'dSYMs.zip',
  uploadTool: 'upload-symbols',
  googleServiceInfo: 'GoogleService-Info.plist',
});

/**
 * Where a Crashlytics-enabled iOS archive puts its Swift Package checkouts
 * (`xcodebuild -clonedSourcePackagesDirPath`), so `upload-symbols` is found
 * without searching DerivedData.
 */
export const iosCrashlyticsSourcePackagesDirectory = '.mpgd-source-packages';

/**
 * `upload-symbols` ships next to the Crashlytics `run` script: in the Swift
 * Package checkout (`SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/`,
 * the path Firebase's run script uses) or in CocoaPods
 * (`Pods/FirebaseCrashlytics/`, the path Firebase's manual-upload command uses).
 */
export function crashlyticsUploadToolCandidates(input: {
  readonly sourcePackages: string;
  readonly iosProject: string;
}): readonly string[] {
  return [
    path.join(input.sourcePackages, 'checkouts/firebase-ios-sdk/Crashlytics/upload-symbols'),
    path.join(input.iosProject, 'App/Pods/FirebaseCrashlytics/upload-symbols'),
  ];
}

export interface CollectIosCrashlyticsSymbolsInput {
  /** Absolute path of the `.xcarchive` this build produced. */
  readonly archive: string;
  /** Absolute path of the staged shell's `ios` directory. */
  readonly iosProject: string;
  /** Absolute `-clonedSourcePackagesDirPath` of the archive build. */
  readonly sourcePackages: string;
  /** Absolute output directory (`<artifact root>/symbols`). */
  readonly outputDirectory: string;
  readonly copyFile: (source: string, destination: string) => void;
  /** Zips `source` (a directory) into `destination` keeping the folder name. */
  readonly zipDirectory: (source: string, destination: string) => void;
}

export interface CollectedIosCrashlyticsSymbols {
  readonly dsymArchive: string;
  readonly dsyms: readonly NativeDsymIdentity[];
  readonly uploadTool: string;
  readonly googleServiceInfo: string;
}

/**
 * Copy what Crashlytics needs out of a staged archive build before the stage
 * is removed. Refused when the archive has no dSYM (Firebase: "Set Debug
 * Information Format to DWARF with dSYM File"), when the checkout has no
 * `upload-symbols`, or when the app does not bundle `GoogleService-Info.plist`.
 */
export function collectIosCrashlyticsSymbols(
  input: CollectIosCrashlyticsSymbolsInput,
): CollectedIosCrashlyticsSymbols {
  const dsymFolder = path.join(input.archive, 'dSYMs');
  const dsyms = readArchiveDsyms(dsymFolder);
  if (dsyms.length === 0) {
    throw new Error(
      'Crash reporting is on, but the iOS archive has no dSYM; set Debug Information Format to '
        + '"DWARF with dSYM File" for the Release configuration.',
    );
  }
  const tool = crashlyticsUploadToolCandidates(input)
    .find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
  if (tool === undefined) {
    throw new Error(
      'Crash reporting is on, but the iOS build has no Firebase Crashlytics upload-symbols in its '
        + 'Swift Package (firebase-ios-sdk/Crashlytics) or CocoaPods (FirebaseCrashlytics) checkout.',
    );
  }
  const plist = path.join(archivedApp(input.archive), 'GoogleService-Info.plist');
  if (!existsSync(plist) || !lstatSync(plist).isFile()) {
    throw new Error(
      'Crash reporting is on, but the archived iOS app does not bundle GoogleService-Info.plist.',
    );
  }
  const output = {
    dsymArchive: path.join(input.outputDirectory, nativeSymbolFileNames.dsymArchive),
    uploadTool: path.join(input.outputDirectory, nativeSymbolFileNames.uploadTool),
    googleServiceInfo: path.join(input.outputDirectory, nativeSymbolFileNames.googleServiceInfo),
  };
  input.zipDirectory(dsymFolder, output.dsymArchive);
  if (!existsSync(output.dsymArchive) || !statSync(output.dsymArchive).isFile()
    || statSync(output.dsymArchive).size === 0) {
    throw new Error('The iOS dSYM archive was not written.');
  }
  input.copyFile(tool, output.uploadTool);
  input.copyFile(plist, output.googleServiceInfo);
  return { ...output, dsyms };
}

/** The single `.app` bundle under `Products/Applications` of an archive. */
function archivedApp(archive: string): string {
  const applications = path.join(archive, 'Products/Applications');
  const apps = existsSync(applications)
    ? readdirSync(applications).filter((name) => name.endsWith('.app'))
    : [];
  if (apps.length !== 1) {
    throw new Error('The iOS archive must contain exactly one application bundle.');
  }
  return path.join(applications, apps[0] ?? '');
}

/** Every `*.dSYM` bundle of an archive's `dSYMs` folder, sorted, with its UUIDs. */
export function readArchiveDsyms(dsymFolder: string): NativeDsymIdentity[] {
  if (!existsSync(dsymFolder)) {
    return [];
  }
  const bundles = readdirSync(dsymFolder)
    .filter((name) => name.endsWith('.dSYM') && !name.startsWith('.'))
    .sort();
  return bundles.map((bundle) => {
    if (!isDsymBundleName(bundle)) {
      throw new Error(`dSYM bundle name is not supported: ${JSON.stringify(bundle)}.`);
    }
    const dwarf = path.join(dsymFolder, bundle, 'Contents/Resources/DWARF');
    const files = existsSync(dwarf)
      ? readdirSync(dwarf).filter((name) => lstatSync(path.join(dwarf, name)).isFile()).sort()
      : [];
    // Only Mach-O files carry UUIDs; Finder litter such as .DS_Store is skipped.
    const uuids = [...new Set(files.flatMap((file) => {
      const candidate = path.join(dwarf, file);
      return isMachOFile(candidate) ? readMachOUuids(candidate) : [];
    }))].sort();
    if (uuids.length === 0) {
      throw new Error(`dSYM ${bundle} has no Mach-O UUID.`);
    }
    return { bundle, uuids };
  });
}

function isMachOFile(file: string): boolean {
  const descriptor = openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    if (readSync(descriptor, magic, 0, 4, 0) !== 4) {
      return false;
    }
    return [0xfeedfacf, 0xfeedface, 0xcffaedfe, 0xcefaedfe, 0xcafebabe, 0xcafebabf]
      .includes(magic.readUInt32BE(0));
  } finally {
    closeSync(descriptor);
  }
}

const lcUuid = 0x1b;
const uuidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u;

/** dSYM UUIDs as `dwarfdump --uuid` prints them. */
export function isDsymUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

/**
 * The `LC_UUID` of each architecture in a thin or universal Mach-O file,
 * read from its headers only (DWARF files can be hundreds of megabytes).
 */
export function readMachOUuids(file: string): string[] {
  const descriptor = openSync(file, 'r');
  try {
    const read = (offset: number, length: number): Buffer => {
      const buffer = Buffer.alloc(length);
      const bytes = readSync(descriptor, buffer, 0, length, offset);
      if (bytes !== length) {
        throw new Error(`${path.basename(file)} is not a complete Mach-O file.`);
      }
      return buffer;
    };
    const magic = read(0, 4).readUInt32BE(0);
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const wide = magic === 0xcafebabf;
      const count = read(4, 4).readUInt32BE(0);
      if (count === 0 || count > 32) {
        throw new Error(`${path.basename(file)} has an invalid universal header.`);
      }
      const entrySize = wide ? 32 : 20;
      const uuids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const entry = read(8 + index * entrySize, entrySize);
        const offset = wide ? Number(entry.readBigUInt64BE(8)) : entry.readUInt32BE(8);
        uuids.push(...readThinMachOUuid(read, offset, file));
      }
      return uuids;
    }
    return readThinMachOUuid(read, 0, file);
  } finally {
    closeSync(descriptor);
  }
}

function readThinMachOUuid(
  read: (offset: number, length: number) => Buffer,
  base: number,
  file: string,
): string[] {
  const magicBytes = read(base, 4);
  const magic = magicBytes.readUInt32LE(0);
  let headerSize: number;
  let littleEndian = true;
  if (magic === 0xfeedfacf) {
    headerSize = 32;
  } else if (magic === 0xfeedface) {
    headerSize = 28;
  } else if (magicBytes.readUInt32BE(0) === 0xfeedfacf) {
    headerSize = 32;
    littleEndian = false;
  } else if (magicBytes.readUInt32BE(0) === 0xfeedface) {
    headerSize = 28;
    littleEndian = false;
  } else {
    throw new Error(`${path.basename(file)} is not a Mach-O file.`);
  }
  const u32 = (buffer: Buffer, offset: number): number => littleEndian
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset);
  const header = read(base, headerSize);
  const commandCount = u32(header, 16);
  const commandBytes = u32(header, 20);
  if (commandCount > 4096 || commandBytes > 16 * 1024 * 1024) {
    throw new Error(`${path.basename(file)} has an invalid Mach-O header.`);
  }
  const commands = read(base + headerSize, commandBytes);
  let offset = 0;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commands.length) {
      break;
    }
    const command = u32(commands, offset);
    const size = u32(commands, offset + 4);
    if (size < 8 || offset + size > commands.length) {
      break;
    }
    if (command === lcUuid && size >= 24) {
      const hex = commands.subarray(offset + 8, offset + 24).toString('hex').toUpperCase();
      return [`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
        hex.slice(20)}`];
    }
    offset += size;
  }
  return [];
}
