import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { escapeMarkdownInline, escapeMarkdownTable, relativeOrAbsolute } from './evidence-io.js';

export const microsoftStorePackageAcceptanceSchemaVersion = 1 as const;

const supportedPackageExtensions = ['.appx', '.appxbundle', '.msix', '.msixbundle'] as const;
const maximumWindowsPackageCommandDurationMs = 60 * 60 * 1_000;
const maximumWindowsPackageCommandOutputBytes = 16 * 1024 * 1024;

export interface MicrosoftStorePackageIdentity {
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
}

export interface MicrosoftStorePackageAcceptanceEvidence {
  readonly schemaVersion: 1;
  readonly target: 'microsoft-store';
  readonly submissionEvidenceFile: string;
  readonly submissionEvidenceSha256: string;
  readonly productIdentity: {
    readonly packageId: string;
    readonly publisherId: string;
    readonly publisherDisplayName: string;
    readonly reservedName: string;
  };
  readonly packages: readonly {
    readonly file: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly identity: MicrosoftStorePackageIdentity;
    readonly payloadIdentities: readonly MicrosoftStorePackageIdentity[];
    readonly certification: {
      readonly result: 'PASS';
      readonly reportFile: string;
      readonly reportSha256: string;
    };
  }[];
}

export interface RunMicrosoftStorePackageAcceptanceInput {
  readonly gameRoot: string;
  readonly submissionEvidenceFile: string;
  readonly packageFiles: readonly string[];
  readonly outputDir: string;
}

export interface MicrosoftStorePackageAcceptanceRuntime {
  readonly platform: NodeJS.Platform;
  readonly appCertExecutable: string;
  readonly makeAppxExecutable: string;
  readonly runCommand: (command: string, args: readonly string[]) => void;
}

export interface CreateMicrosoftStorePackageAcceptanceRuntimeInput {
  readonly appCertExecutable?: string;
  readonly makeAppxExecutable?: string;
}

export function createMicrosoftStorePackageAcceptanceRuntime(
  input: CreateMicrosoftStorePackageAcceptanceRuntimeInput = {},
): MicrosoftStorePackageAcceptanceRuntime {
  if (process.platform !== 'win32') {
    throw new Error(
      'Microsoft Store package acceptance must run on Windows with the Windows SDK and an active user session.',
    );
  }

  const windowsKitsDir = path.join(
    requireEnvironmentPath(process.env['ProgramFiles(x86)'], 'ProgramFiles(x86)'),
    'Windows Kits',
    '10',
  );
  const certificationKitDir = path.join(windowsKitsDir, 'App Certification Kit');
  const appCertExecutable = readCanonicalTool(
    input.appCertExecutable ?? path.join(certificationKitDir, 'appcert.exe'),
    'Windows App Certification Kit executable',
  );
  const makeAppxExecutable = input.makeAppxExecutable === undefined
    ? findMicrosoftStoreMakeAppxExecutable(windowsKitsDir, process.arch)
    : readCanonicalTool(input.makeAppxExecutable, 'MakeAppx executable');

  return {
    platform: process.platform,
    appCertExecutable,
    makeAppxExecutable,
    runCommand: runWindowsCommand,
  };
}

export function findMicrosoftStoreMakeAppxExecutable(
  windowsKitsDir: string,
  architecture: NodeJS.Architecture,
): string {
  const architectures = windowsSdkArchitectures(architecture);
  const binDir = path.join(windowsKitsDir, 'bin');
  const versionDirectories = readDirectoryNames(binDir)
    .filter((name) => /^\d+(?:\.\d+)+$/u.test(name))
    .sort(compareWindowsSdkVersionsDescending);
  const candidates = versionDirectories.flatMap((version) =>
    architectures.map((candidateArchitecture) =>
      path.join(binDir, version, candidateArchitecture, 'makeappx.exe'),
    ),
  );

  candidates.push(path.join(windowsKitsDir, 'App Certification Kit', 'makeappx.exe'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readCanonicalTool(candidate, 'MakeAppx executable');
    }
  }

  throw new Error(
    'MakeAppx executable must exist in a Windows SDK bin directory or the App Certification Kit; pass --makeappx to select it explicitly.',
  );
}

export function runMicrosoftStorePackageAcceptance(
  input: RunMicrosoftStorePackageAcceptanceInput,
  runtime = createMicrosoftStorePackageAcceptanceRuntime(),
): MicrosoftStorePackageAcceptanceEvidence {
  if (runtime.platform !== 'win32') {
    throw new Error('Microsoft Store package acceptance runtime must use Windows.');
  }

  if (input.packageFiles.length === 0) {
    throw new Error('Microsoft Store package acceptance requires at least one package.');
  }

  const gameRoot = readCanonicalDirectory(input.gameRoot, 'game root');
  const outputDir = readCanonicalDirectoryInside(
    gameRoot,
    input.outputDir,
    'Microsoft Store package acceptance output directory',
  );
  const submissionEvidenceFile = readCanonicalFileInside(
    gameRoot,
    input.submissionEvidenceFile,
    'Microsoft Store submission evidence',
  );
  const submissionEvidenceContents = readFileSync(submissionEvidenceFile);
  const submissionEvidence = parseSubmissionEvidence(
    parseJson(
      submissionEvidenceContents.toString('utf8'),
      submissionEvidenceFile,
      'Microsoft Store submission evidence',
    ),
  );
  const packageFiles = input.packageFiles.map((file) => readCanonicalPackage(gameRoot, file));

  if (new Set(packageFiles).size !== packageFiles.length) {
    throw new Error('Microsoft Store package acceptance package paths must be unique.');
  }

  const jsonFile = resolveOutputFileInside(
    gameRoot,
    path.join(outputDir, 'package-acceptance.json'),
    'package acceptance JSON',
  );
  const markdownFile = resolveOutputFileInside(
    gameRoot,
    path.join(outputDir, 'package-acceptance.md'),
    'package acceptance Markdown',
  );

  assertDistinctEvidenceFiles(
    [
      { file: jsonFile, label: 'package acceptance JSON' },
      { file: markdownFile, label: 'package acceptance Markdown' },
    ],
    [
      { file: submissionEvidenceFile, label: 'submission evidence' },
      ...packageFiles.map((file) => ({ file, label: 'Microsoft Store package' })),
    ],
  );

  const tempRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-microsoft-store-package-'));

  try {
    const packages = packageFiles.map((packageFile, index) => {
      const packageSnapshot = hashFileSnapshot(packageFile);
      const inspected = inspectPackage({
        packageFile,
        tempRoot: path.join(tempRoot, String(index + 1).padStart(2, '0')),
        runtime,
      });

      for (const identity of [inspected.identity, ...inspected.payloadIdentities]) {
        assertExpectedIdentity(identity, submissionEvidence.productIdentity);
      }

      const reportFile = path.join(
        outputDir,
        `${String(index + 1).padStart(2, '0')}-${safeFileNameSegment(path.basename(packageFile))}.wack.xml`,
      );

      rmSync(reportFile, { force: true });
      runtime.runCommand(runtime.appCertExecutable, ['reset']);
      runtime.runCommand(runtime.appCertExecutable, [
        'test',
        '-appxpackagepath',
        packageFile,
        '-reportoutputpath',
        reportFile,
      ]);

      const canonicalReportFile = readCanonicalFileInside(
        outputDir,
        reportFile,
        'Windows App Certification Kit report',
      );
      const reportContents = readFileSync(canonicalReportFile);
      const result = parseWindowsAppCertificationResult(
        reportContents.toString('utf8'),
      );

      if (result !== 'PASS') {
        throw new Error(`Windows App Certification Kit failed for ${packageFile}.`);
      }

      const acceptedPackageSnapshot = hashFileSnapshot(packageFile);

      if (
        acceptedPackageSnapshot.sizeBytes !== packageSnapshot.sizeBytes
        || acceptedPackageSnapshot.sha256 !== packageSnapshot.sha256
      ) {
        throw new Error(
          `Microsoft Store package changed during acceptance: ${packageFile}`,
        );
      }

      return {
        file: relativeOrAbsolute(gameRoot, packageFile),
        sizeBytes: packageSnapshot.sizeBytes,
        sha256: packageSnapshot.sha256,
        identity: inspected.identity,
        payloadIdentities: inspected.payloadIdentities,
        certification: {
          result,
          reportFile: relativeOrAbsolute(gameRoot, canonicalReportFile),
          reportSha256: hashBuffer(reportContents),
        },
      };
    });
    const evidence: MicrosoftStorePackageAcceptanceEvidence = {
      schemaVersion: microsoftStorePackageAcceptanceSchemaVersion,
      target: 'microsoft-store',
      submissionEvidenceFile: relativeOrAbsolute(gameRoot, submissionEvidenceFile),
      submissionEvidenceSha256: hashBuffer(submissionEvidenceContents),
      productIdentity: submissionEvidence.productIdentity,
      packages,
    };

    writeFileSync(jsonFile, `${JSON.stringify(evidence, null, 2)}\n`);
    writeFileSync(markdownFile, renderMicrosoftStorePackageAcceptanceMarkdown(evidence));

    return evidence;
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

export function parseMicrosoftStorePackageIdentity(xml: string): MicrosoftStorePackageIdentity {
  const identityAttributes = findPackageIdentityAttributes(xml);

  if (identityAttributes === undefined) {
    throw new Error('Microsoft Store package manifest is missing Identity.');
  }

  const attributes = parseXmlAttributes(identityAttributes);

  return {
    name: requireXmlAttribute(attributes, 'Name'),
    publisher: requireXmlAttribute(attributes, 'Publisher'),
    version: requireXmlAttribute(attributes, 'Version'),
  };
}

export function parseWindowsAppCertificationResult(xml: string): 'PASS' | 'FAIL' {
  const reportTag = xml.match(/<REPORT\b([^>]*)>/iu);

  if (reportTag === null) {
    throw new Error('Windows App Certification Kit report is missing REPORT.');
  }

  const result = requireXmlAttribute(
    parseXmlAttributes(reportTag[1] ?? ''),
    'OVERALL_RESULT',
  ).toUpperCase();

  if (result !== 'PASS' && result !== 'FAIL') {
    throw new Error(`Unsupported Windows App Certification Kit result: ${result}`);
  }

  return result;
}

export function renderMicrosoftStorePackageAcceptanceMarkdown(
  evidence: MicrosoftStorePackageAcceptanceEvidence,
): string {
  const lines = [
    '# Microsoft Store Package Acceptance',
    '',
    `- Package ID: ${escapeMarkdownInline(evidence.productIdentity.packageId)}`,
    `- Publisher ID: ${escapeMarkdownInline(evidence.productIdentity.publisherId)}`,
    `- Submission evidence SHA-256: ${evidence.submissionEvidenceSha256}`,
    '',
    '| Package | Version | Bytes | SHA-256 | WACK |',
    '| --- | --- | ---: | --- | --- |',
  ];

  for (const acceptedPackage of evidence.packages) {
    lines.push(
      `| ${escapeMarkdownTable(acceptedPackage.file)} | ${escapeMarkdownTable(acceptedPackage.identity.version)} | ${acceptedPackage.sizeBytes} | ${acceptedPackage.sha256} | ${acceptedPackage.certification.result} |`,
    );
  }

  return `${lines.join('\n')}\n`;
}

interface InspectedPackage {
  readonly identity: MicrosoftStorePackageIdentity;
  readonly payloadIdentities: readonly MicrosoftStorePackageIdentity[];
}

function inspectPackage(input: {
  readonly packageFile: string;
  readonly tempRoot: string;
  readonly runtime: MicrosoftStorePackageAcceptanceRuntime;
}): InspectedPackage {
  const extension = path.extname(input.packageFile).toLowerCase();
  mkdirSync(input.tempRoot, { recursive: true });

  if (extension === '.appxbundle' || extension === '.msixbundle') {
    const bundleDir = path.join(input.tempRoot, 'bundle');
    const canonicalTempRoot = readCanonicalDirectory(
      input.tempRoot,
      'Microsoft Store package inspection directory',
    );
    input.runtime.runCommand(input.runtime.makeAppxExecutable, [
      'unbundle',
      '/p',
      input.packageFile,
      '/d',
      bundleDir,
      '/o',
      '/l',
    ]);
    const canonicalBundleDir = readCanonicalDirectory(
      bundleDir,
      'Microsoft Store unpacked bundle directory',
    );
    assertInside(
      canonicalTempRoot,
      canonicalBundleDir,
      'Microsoft Store unpacked bundle directory',
    );

    const identity = parseMicrosoftStorePackageIdentity(
      readFileSync(
        readCanonicalFileInside(
          canonicalBundleDir,
          path.join(canonicalBundleDir, 'AppxMetadata', 'AppxBundleManifest.xml'),
          'Microsoft Store bundle manifest',
        ),
        'utf8',
      ),
    );
    const payloads = listFiles(canonicalBundleDir).filter((file) => {
      const payloadExtension = path.extname(file).toLowerCase();
      return payloadExtension === '.appx' || payloadExtension === '.msix';
    });

    if (payloads.length === 0) {
      throw new Error(
        `Microsoft Store bundle contains no app package payloads: ${input.packageFile}`,
      );
    }

    return {
      identity,
      payloadIdentities: payloads.map((payload, index) => inspectSinglePackage(
        payload,
        path.join(input.tempRoot, `payload-${index + 1}`),
        input.runtime,
      )),
    };
  }

  return {
    identity: inspectSinglePackage(
      input.packageFile,
      path.join(input.tempRoot, 'package'),
      input.runtime,
    ),
    payloadIdentities: [],
  };
}

function inspectSinglePackage(
  packageFile: string,
  outputDir: string,
  runtime: MicrosoftStorePackageAcceptanceRuntime,
): MicrosoftStorePackageIdentity {
  const canonicalParent = readCanonicalDirectory(
    path.dirname(outputDir),
    'Microsoft Store package inspection directory',
  );
  runtime.runCommand(runtime.makeAppxExecutable, [
    'unpack',
    '/p',
    packageFile,
    '/d',
    outputDir,
    '/o',
    '/l',
  ]);
  const canonicalOutputDir = readCanonicalDirectory(
    outputDir,
    'Microsoft Store unpacked package directory',
  );
  assertInside(canonicalParent, canonicalOutputDir, 'Microsoft Store unpacked package directory');

  return parseMicrosoftStorePackageIdentity(
    readFileSync(
      readCanonicalFileInside(
        canonicalOutputDir,
        path.join(canonicalOutputDir, 'AppxManifest.xml'),
        'Microsoft Store app package manifest',
      ),
      'utf8',
    ),
  );
}

function assertExpectedIdentity(
  identity: MicrosoftStorePackageIdentity,
  expected: MicrosoftStorePackageAcceptanceEvidence['productIdentity'],
): void {
  if (!equalsAsciiCaseInsensitive(identity.name, expected.packageId)) {
    throw new Error(
      `Microsoft Store package identity Name must be ${expected.packageId}; received ${identity.name}.`,
    );
  }

  if (identity.publisher !== expected.publisherId) {
    throw new Error(
      `Microsoft Store package identity Publisher must be ${expected.publisherId}; received ${identity.publisher}.`,
    );
  }
}

function findPackageIdentityAttributes(xml: string): string | undefined {
  const stack: string[] = [];
  let offset = 0;

  while (offset < xml.length) {
    const start = xml.indexOf('<', offset);

    if (start < 0) {
      break;
    }

    if (xml.startsWith('<!--', start)) {
      offset = requireXmlTerminator(xml, start + 4, '-->', 'comment');
      continue;
    }

    if (xml.startsWith('<![CDATA[', start)) {
      offset = requireXmlTerminator(xml, start + 9, ']]>', 'CDATA section');
      continue;
    }

    if (xml.startsWith('<?', start)) {
      offset = requireXmlTerminator(xml, start + 2, '?>', 'processing instruction');
      continue;
    }

    if (/^<!DOCTYPE\b/iu.test(xml.slice(start))) {
      throw new Error('Microsoft Store package manifest must not contain a DOCTYPE declaration.');
    }

    if (xml.startsWith('<!', start)) {
      throw new Error('Microsoft Store package manifest contains unsupported XML markup.');
    }

    const end = findXmlTagEnd(xml, start + 1);
    const source = xml.slice(start + 1, end);
    const closing = /^\s*\//u.test(source);
    const tagNamePattern = closing ? /^\s*\/\s*([A-Za-z_][\w:.-]*)/u : /^\s*([A-Za-z_][\w:.-]*)/u;
    const tagName = source.match(tagNamePattern)?.[1];

    if (tagName === undefined) {
      throw new Error('Microsoft Store package manifest contains malformed XML markup.');
    }

    if (closing) {
      const opened = stack.pop();

      if (opened !== tagName) {
        throw new Error('Microsoft Store package manifest contains mismatched XML elements.');
      }

      offset = end + 1;
      continue;
    }

    const parent = stack.at(-1);
    const selfClosing = /\/\s*$/u.test(source);

    if (
      tagName === 'Identity'
      && stack.length === 1
      && (parent === 'Package' || parent === 'Bundle')
    ) {
      const nameEnd = source.indexOf(tagName) + tagName.length;
      return source.slice(nameEnd, selfClosing ? source.lastIndexOf('/') : undefined);
    }

    if (!selfClosing) {
      stack.push(tagName);
    }

    offset = end + 1;
  }

  return undefined;
}

function findXmlTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | undefined;

  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];

    if (quote === undefined && (character === '"' || character === "'")) {
      quote = character;
    } else if (character === quote) {
      quote = undefined;
    } else if (quote === undefined && character === '>') {
      return index;
    }
  }

  throw new Error('Microsoft Store package manifest contains an unterminated XML element.');
}

function requireXmlTerminator(
  xml: string,
  start: number,
  terminator: string,
  label: string,
): number {
  const end = xml.indexOf(terminator, start);

  if (end < 0) {
    throw new Error(`Microsoft Store package manifest contains an unterminated XML ${label}.`);
  }

  return end + terminator.length;
}

function equalsAsciiCaseInsensitive(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    const normalizedLeft = leftCode >= 0x41 && leftCode <= 0x5a ? leftCode + 0x20 : leftCode;
    const normalizedRight = rightCode >= 0x41 && rightCode <= 0x5a ? rightCode + 0x20 : rightCode;

    if (normalizedLeft !== normalizedRight) {
      return false;
    }
  }

  return true;
}

function windowsSdkArchitectures(architecture: NodeJS.Architecture): readonly string[] {
  if (architecture === 'arm64') {
    return ['arm64', 'x64', 'x86'];
  }

  if (architecture === 'x64') {
    return ['x64', 'x86'];
  }

  if (architecture === 'ia32') {
    return ['x86'];
  }

  if (architecture === 'arm') {
    return ['arm'];
  }

  return ['x64', 'x86', 'arm64', 'arm'];
}

function readDirectoryNames(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compareWindowsSdkVersionsDescending(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function parseSubmissionEvidence(input: unknown): {
  readonly productIdentity: MicrosoftStorePackageAcceptanceEvidence['productIdentity'];
} {
  const root = requireRecord(input, 'Microsoft Store submission evidence');

  if (root.schemaVersion !== 1 || root.target !== 'microsoft-store') {
    throw new Error(
      'Microsoft Store submission evidence must use schemaVersion 1 and target microsoft-store.',
    );
  }

  const identity = requireRecord(root.productIdentity, 'submission evidence productIdentity');

  return {
    productIdentity: {
      packageId: requireNonEmptyString(identity.packageId, 'submission evidence packageId'),
      publisherId: requireNonEmptyString(identity.publisherId, 'submission evidence publisherId'),
      publisherDisplayName: requireNonEmptyString(
        identity.publisherDisplayName,
        'submission evidence publisherDisplayName',
      ),
      reservedName: requireNonEmptyString(
        identity.reservedName,
        'submission evidence reservedName',
      ),
    },
  };
}

function parseXmlAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/gu;

  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const value = match[3];

    if (name !== undefined && value !== undefined) {
      attributes.set(name.toUpperCase(), decodeXmlAttribute(value));
    }
  }

  return attributes;
}

function requireXmlAttribute(attributes: ReadonlyMap<string, string>, name: string): string {
  const value = attributes.get(name.toUpperCase());

  if (value === undefined || value.length === 0) {
    throw new Error(`Microsoft Store XML is missing ${name}.`);
  }

  return value;
}

function decodeXmlAttribute(value: string): string {
  const numericDecoded = value.replace(
    /&#(?:x([0-9A-Fa-f]+)|([0-9]+));/gu,
    (_reference, hexadecimal: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hexadecimal ?? decimal ?? '', hexadecimal === undefined ? 10 : 16);

      if (
        !Number.isInteger(codePoint)
        || codePoint === 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw new Error(`Microsoft Store XML contains an invalid character reference: ${value}`);
      }

      return String.fromCodePoint(codePoint);
    },
  );

  if (/&(?!(?:quot|apos|lt|gt|amp);)/u.test(numericDecoded)) {
    throw new Error(`Microsoft Store XML contains an unsupported entity reference: ${value}`);
  }

  return numericDecoded
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function readCanonicalPackage(gameRoot: string, file: string): string {
  const packageFile = readCanonicalFileInside(gameRoot, file, 'Microsoft Store package');
  const extension = path.extname(packageFile).toLowerCase();

  if (!supportedPackageExtensions.includes(
    extension as (typeof supportedPackageExtensions)[number],
  )) {
    throw new Error(
      `Unsupported Microsoft Store package extension ${extension || '(none)'}; expected ${supportedPackageExtensions.join(', ')}.`,
    );
  }

  return packageFile;
}

function readCanonicalTool(file: string, label: string): string {
  let canonical: string;

  try {
    canonical = realpathSync(file);
  } catch (error) {
    throw new Error(`${label} must exist: ${file} (${formatError(error)})`);
  }

  if (!lstatSync(canonical).isFile()) {
    throw new Error(`${label} must be a regular file: ${canonical}`);
  }

  return canonical;
}

function runWindowsCommand(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    killSignal: 'SIGTERM',
    maxBuffer: maximumWindowsPackageCommandOutputBytes,
    timeout: maximumWindowsPackageCommandDurationMs,
    windowsHide: true,
  });
  const output = [result.stdout, result.stderr]
    .filter((value) => value.length > 0)
    .join('\n')
    .trim();

  if (result.error !== undefined) {
    if (isTimeoutError(result.error)) {
      throw new Error(
        `Windows package command timed out after ${maximumWindowsPackageCommandDurationMs}ms: ${command} ${args.join(' ')}${formatCommandOutput(output)}`,
      );
    }

    throw new Error(
      `Windows package command could not complete: ${command} ${args.join(' ')} (${formatError(result.error)})${formatCommandOutput(output)}`,
    );
  }

  if (result.signal !== null) {
    throw new Error(
      `Windows package command was killed by signal ${result.signal}: ${command} ${args.join(' ')}${formatCommandOutput(output)}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `Windows package command failed with exit code ${String(result.status)}: ${command} ${args.join(' ')}${formatCommandOutput(output)}`,
    );
  }

  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
}

function listFiles(dir: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`Unpacked package symlink is not allowed: ${file}`);
    } else if (entry.isDirectory()) {
      files.push(...listFiles(file));
    } else if (entry.isFile()) {
      files.push(file);
    }
  }

  return files.sort(compareCodeUnits);
}

function parseJson(source: string, file: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Failed to read ${label} ${file}: ${formatError(error)}`);
  }
}

function hashFileSnapshot(file: string): { readonly sizeBytes: number; readonly sha256: string } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(file, 'r');
  const before = fstatSync(descriptor);

  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        break;
      }

      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }

  const after = statSync(file);

  if (
    after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error(`File changed while it was being hashed: ${file}`);
  }

  return { sizeBytes: before.size, sha256: hash.digest('hex') };
}

function hashBuffer(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function readCanonicalDirectory(input: string, label: string): string {
  let canonical: string;

  try {
    canonical = realpathSync(input);
  } catch (error) {
    throw new Error(`${label} must exist: ${input} (${formatError(error)})`);
  }

  if (!lstatSync(canonical).isDirectory()) {
    throw new Error(`${label} must be a directory: ${canonical}`);
  }

  return canonical;
}

function readCanonicalDirectoryInside(root: string, input: string, label: string): string {
  const canonical = readCanonicalDirectory(input, label);
  assertInside(root, canonical, label);
  return canonical;
}

function readCanonicalFileInside(root: string, input: string, label: string): string {
  let canonical: string;

  try {
    canonical = realpathSync(input);
  } catch (error) {
    throw new Error(`${label} must exist: ${input} (${formatError(error)})`);
  }

  assertInside(root, canonical, label);

  if (!lstatSync(canonical).isFile()) {
    throw new Error(`${label} must be a regular file: ${canonical}`);
  }

  return canonical;
}

function resolveOutputFileInside(root: string, file: string, label: string): string {
  const parent = readCanonicalDirectory(path.dirname(file), `${label} directory`);
  assertInside(root, parent, label);
  let metadata: ReturnType<typeof lstatSync> | undefined;

  try {
    metadata = lstatSync(file);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  if (metadata !== undefined) {
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${file}`);
    }

    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file when it already exists: ${file}`);
    }
  }

  let resolved = path.join(parent, path.basename(file));

  if (metadata !== undefined) {
    try {
      resolved = realpathSync(file);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  assertInside(root, resolved, label);
  return resolved;
}

function assertDistinctEvidenceFiles(
  outputs: readonly { readonly file: string; readonly label: string }[],
  protectedFiles: readonly { readonly file: string; readonly label: string }[],
): void {
  for (const [index, output] of outputs.entries()) {
    for (const candidate of [...outputs.slice(index + 1), ...protectedFiles]) {
      if (sameFile(output.file, candidate.file)) {
        throw new Error(`${output.label} must not alias ${candidate.label}: ${output.file}`);
      }
    }
  }
}

function sameFile(left: string, right: string): boolean {
  if (path.relative(left, right).length === 0) {
    return true;
  }

  if (!existsSync(left) || !existsSync(right)) {
    return false;
  }

  const leftMetadata = statSync(left);
  const rightMetadata = statSync(right);
  return leftMetadata.dev === rightMetadata.dev && leftMetadata.ino === rightMetadata.ino;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside its allowed root: ${root}`);
  }
}

function requireEnvironmentPath(input: string | undefined, label: string): string {
  if (input === undefined || input.length === 0) {
    throw new Error(`Missing Windows environment path: ${label}`);
  }

  return input;
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }

  return input as Record<string, unknown>;
}

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }

  return input;
}

function safeFileNameSegment(value: string): string {
  const stem = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return stem.length === 0 ? 'package' : stem;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ETIMEDOUT';
}

function formatCommandOutput(output: string): string {
  return output.length === 0 ? '' : `\n${output}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
