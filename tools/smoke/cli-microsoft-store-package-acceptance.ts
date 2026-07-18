import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  parseMicrosoftStorePackageIdentity,
  parseWindowsAppCertificationResult,
  runMicrosoftStorePackageAcceptance,
  type MicrosoftStorePackageAcceptanceRuntime,
} from '../../packages/cli/src/index';
import { findMicrosoftStoreMakeAppxExecutable } from '../../packages/cli/src/microsoft-store-package-acceptance';

const fixtureRoot = resolve('node_modules/.cache/mpgd-cli-microsoft-store-package-acceptance');
const gameRoot = join(fixtureRoot, 'game');
const outputDir = join(gameRoot, 'release-output', 'microsoft-store');
const packagesDir = join(gameRoot, 'packages');
const packageFile = join(packagesDir, 'fixture.msixbundle');
const submissionEvidenceFile = join(outputDir, 'submission-preflight.json');
const appCertExecutable = join(fixtureRoot, 'appcert.exe');
const makeAppxExecutable = join(fixtureRoot, 'makeappx.exe');
const windowsKitsDir = join(fixtureRoot, 'Windows Kits', '10');
const packageId = '12345Acme.FixtureGame';
const publisherId = 'CN=01234567-89ab-cdef-0123-456789abcdef';
let emittedPackageId = packageId;
let emittedPublisherId = publisherId;
let certificationResult: 'PASS' | 'FAIL' = 'PASS';
let emitSymlinkPayload = false;
let mutatePackageDuringCertification = false;

try {
  rmSync(fixtureRoot, { force: true, recursive: true });
  mkdirSync(packagesDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(packageFile, 'fixture bundle');
  writeFileSync(appCertExecutable, 'fixture appcert');
  writeFileSync(makeAppxExecutable, 'fixture makeappx');
  const olderSdkMakeAppx = join(windowsKitsDir, 'bin', '10.0.22621.0', 'x64', 'makeappx.exe');
  const currentSdkMakeAppx = join(windowsKitsDir, 'bin', '10.0.26100.0', 'x64', 'makeappx.exe');
  const malformedSdkMakeAppx = join(windowsKitsDir, 'bin', '99.0.preview', 'x64', 'makeappx.exe');
  mkdirSync(join(olderSdkMakeAppx, '..'), { recursive: true });
  mkdirSync(join(currentSdkMakeAppx, '..'), { recursive: true });
  mkdirSync(join(malformedSdkMakeAppx, '..'), { recursive: true });
  writeFileSync(olderSdkMakeAppx, 'older fixture makeappx');
  writeFileSync(currentSdkMakeAppx, 'current fixture makeappx');
  writeFileSync(malformedSdkMakeAppx, 'invalid fixture makeappx');
  assert.equal(findMicrosoftStoreMakeAppxExecutable(windowsKitsDir, 'x64'), currentSdkMakeAppx);
  assert.equal(findMicrosoftStoreMakeAppxExecutable(windowsKitsDir, 'arm64'), currentSdkMakeAppx);

  const x86FallbackKitsDir = join(fixtureRoot, 'x86 fallback Windows Kits', '10');
  const x86FallbackMakeAppx = join(
    x86FallbackKitsDir,
    'bin',
    '10.0.26100.0',
    'x86',
    'makeappx.exe',
  );
  mkdirSync(join(x86FallbackMakeAppx, '..'), { recursive: true });
  writeFileSync(x86FallbackMakeAppx, 'x86 fallback fixture makeappx');
  assert.equal(
    findMicrosoftStoreMakeAppxExecutable(x86FallbackKitsDir, 'arm64'),
    x86FallbackMakeAppx,
  );

  const certificationFallbackKitsDir = join(
    fixtureRoot,
    'certification fallback Windows Kits',
    '10',
  );
  const certificationFallbackMakeAppx = join(
    certificationFallbackKitsDir,
    'App Certification Kit',
    'makeappx.exe',
  );
  mkdirSync(join(certificationFallbackMakeAppx, '..'), { recursive: true });
  writeFileSync(certificationFallbackMakeAppx, 'certification fallback fixture makeappx');
  assert.equal(
    findMicrosoftStoreMakeAppxExecutable(certificationFallbackKitsDir, 'x64'),
    certificationFallbackMakeAppx,
  );
  assert.throws(
    () => findMicrosoftStoreMakeAppxExecutable(join(fixtureRoot, 'missing Windows Kits'), 'x64'),
    /pass --makeappx to select it explicitly/u,
  );
  const invalidBinKitsDir = join(fixtureRoot, 'invalid bin Windows Kits');
  mkdirSync(invalidBinKitsDir, { recursive: true });
  writeFileSync(join(invalidBinKitsDir, 'bin'), 'not a directory');
  assert.throws(
    () => findMicrosoftStoreMakeAppxExecutable(invalidBinKitsDir, 'x64'),
    /Failed to read Windows SDK bin directory/u,
  );
  assert.throws(
    () => findMicrosoftStoreMakeAppxExecutable(windowsKitsDir, 'riscv64'),
    /Unsupported Windows SDK host architecture riscv64/u,
  );
  writeJson(submissionEvidenceFile, {
    schemaVersion: 1,
    target: 'microsoft-store',
    productIdentity: {
      packageId,
      publisherId,
      publisherDisplayName: 'Acme Games',
      reservedName: 'Fixture Game',
    },
  });

  const runtime: MicrosoftStorePackageAcceptanceRuntime = {
    platform: 'win32',
    appCertExecutable,
    makeAppxExecutable,
    runCommand,
  };
  const evidence = runMicrosoftStorePackageAcceptance(
    {
      gameRoot,
      submissionEvidenceFile,
      packageFiles: [packageFile],
      outputDir,
    },
    runtime,
  );

  assert.equal(evidence.target, 'microsoft-store');
  assert.equal(evidence.packages.length, 1);
  assert.equal(evidence.packages[0]?.identity.name, packageId);
  assert.equal(evidence.packages[0]?.payloadIdentities.length, 1);
  assert.equal(evidence.packages[0]?.certification.result, 'PASS');
  assert.match(
    readFileSync(join(outputDir, 'package-acceptance.md'), 'utf8'),
    /# Microsoft Store Package Acceptance/u,
  );
  assert.equal(
    JSON.parse(readFileSync(join(outputDir, 'package-acceptance.json'), 'utf8')).packages.length,
    1,
  );

  const evidenceWithoutWack = runMicrosoftStorePackageAcceptance(
    { gameRoot, submissionEvidenceFile, packageFiles: [packageFile], outputDir },
    {
      platform: 'win32',
      makeAppxExecutable,
      runCommand,
    },
  );
  assert.equal(evidenceWithoutWack.packages[0]?.certification.result, 'NOT_RUN');

  emittedPackageId = packageId.toLowerCase();
  assert.equal(
    runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [packageFile], outputDir },
      runtime,
    ).packages[0]?.identity.name,
    emittedPackageId,
  );
  emittedPackageId = packageId;

  assert.deepEqual(parseMicrosoftStorePackageIdentity(identityXml(packageId, publisherId)), {
    name: packageId,
    publisher: publisherId,
    version: '1.2.3.4',
  });
  assert.deepEqual(
    parseMicrosoftStorePackageIdentity(
      `<Package><!-- <Identity Name="Wrong" Publisher="CN=Wrong" Version="0.0.0.0"/> -->${identityTag(packageId, publisherId)}</Package>`,
    ),
    {
      name: packageId,
      publisher: publisherId,
      version: '1.2.3.4',
    },
  );
  assert.deepEqual(
    parseMicrosoftStorePackageIdentity(identityXml(packageId, 'CN=Acme&#x2c; Inc')),
    {
      name: packageId,
      publisher: 'CN=Acme, Inc',
      version: '1.2.3.4',
    },
  );
  assert.deepEqual(
    parseMicrosoftStorePackageIdentity(identityXml(packageId, 'CN=Acme&#38;amp; Labs')),
    {
      name: packageId,
      publisher: 'CN=Acme&amp; Labs',
      version: '1.2.3.4',
    },
  );
  assert.equal(parseWindowsAppCertificationResult('<REPORT OVERALL_RESULT="Pass"/>'), 'PASS');
  assert.throws(
    () => parseWindowsAppCertificationResult('<REPORT OVERALL_RESULT="UNKNOWN"/>'),
    /Unsupported Windows App Certification Kit result/u,
  );

  certificationResult = 'FAIL';
  assert.throws(
    () => runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [packageFile], outputDir },
      runtime,
    ),
    /Windows App Certification Kit failed/u,
  );
  certificationResult = 'PASS';

  emittedPublisherId = 'CN=wrong-publisher';
  assert.throws(
    () => runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [packageFile], outputDir },
      runtime,
    ),
    /identity Publisher must be/u,
  );
  emittedPublisherId = publisherId;

  emitSymlinkPayload = true;
  assert.throws(
    () => runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [packageFile], outputDir },
      runtime,
    ),
    /package symlink is not allowed/u,
  );
  emitSymlinkPayload = false;

  mutatePackageDuringCertification = true;
  assert.throws(
    () => runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [packageFile], outputDir },
      runtime,
    ),
    /package changed during acceptance/u,
  );
  mutatePackageDuringCertification = false;
  writeFileSync(packageFile, 'fixture bundle');

  writeFileSync(submissionEvidenceFile, '{');
  assert.throws(
    () => runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [packageFile], outputDir },
      runtime,
    ),
    /Failed to parse Microsoft Store submission evidence/u,
  );
  writeJson(submissionEvidenceFile, {
    schemaVersion: 1,
    target: 'microsoft-store',
    productIdentity: {
      packageId,
      publisherId,
      publisherDisplayName: 'Acme Games',
      reservedName: 'Fixture Game',
    },
  });

  const outsidePackage = join(fixtureRoot, 'outside.msix');
  const escapedPackage = join(packagesDir, 'escaped.msix');
  writeFileSync(outsidePackage, 'outside');
  symlinkSync(outsidePackage, escapedPackage);
  assert.throws(
    () => runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [escapedPackage], outputDir },
      runtime,
    ),
    /Microsoft Store package must stay inside its allowed root/u,
  );

  const outsideEvidence = join(fixtureRoot, 'outside-evidence.json');
  const acceptanceJson = join(outputDir, 'package-acceptance.json');
  writeFileSync(outsideEvidence, 'must remain unchanged');
  rmSync(acceptanceJson);
  symlinkSync(outsideEvidence, acceptanceJson);
  assert.throws(
    () => runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [packageFile], outputDir },
      runtime,
    ),
    /package acceptance JSON must not be a symbolic link/u,
  );
  assert.equal(readFileSync(outsideEvidence, 'utf8'), 'must remain unchanged');
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('CLI Microsoft Store package acceptance smoke passed.');

function runCommand(command: string, args: readonly string[]): void {
  if (command === makeAppxExecutable) {
    const outputDirArg = requiredArgumentAfter(args, '/d');
    const action = args[0];

    if (action === 'unbundle') {
      assert.ok(args.includes('/l'));
      mkdirSync(join(outputDirArg, 'AppxMetadata'), { recursive: true });
      writeFileSync(
        join(outputDirArg, 'AppxMetadata', 'AppxBundleManifest.xml'),
        identityXml(emittedPackageId, emittedPublisherId),
      );
      writeFileSync(join(outputDirArg, 'neutral.appx'), 'fixture payload');

      if (emitSymlinkPayload) {
        symlinkSync(packageFile, join(outputDirArg, 'linked.appx'));
      }

      return;
    }

    if (action === 'unpack') {
      assert.ok(args.includes('/l'));
      mkdirSync(outputDirArg, { recursive: true });
      writeFileSync(
        join(outputDirArg, 'AppxManifest.xml'),
        identityXml(emittedPackageId, emittedPublisherId),
      );
      return;
    }
  }

  if (command === appCertExecutable) {
    if (args[0] === 'reset') {
      return;
    }

    if (args[0] === 'test') {
      if (mutatePackageDuringCertification) {
        writeFileSync(packageFile, 'mutated package');
      }

      writeFileSync(
        requiredArgumentAfter(args, '-reportoutputpath'),
        `<REPORT OVERALL_RESULT="${certificationResult}"/>`,
      );
      return;
    }
  }

  throw new Error(`Unexpected fixture command: ${command} ${args.join(' ')}`);
}

function requiredArgumentAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];

  if (value === undefined) {
    throw new Error(`Missing fixture argument after ${flag}.`);
  }

  return value;
}

function identityXml(name: string, publisher: string): string {
  return `<Package>${identityTag(name, publisher)}</Package>`;
}

function identityTag(name: string, publisher: string): string {
  return `<Identity Name="${name}" Publisher="${publisher}" Version="1.2.3.4"/>`;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
