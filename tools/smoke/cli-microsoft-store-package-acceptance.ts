import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  parseMicrosoftStorePackageIdentity,
  parseWindowsAppCertificationResult,
  runMicrosoftStorePackageAcceptance,
  type MicrosoftStorePackageAcceptanceRuntime,
} from '../../packages/cli/src/index';

const fixtureRoot = resolve('node_modules/.cache/mpgd-cli-microsoft-store-package-acceptance');
const gameRoot = join(fixtureRoot, 'game');
const outputDir = join(gameRoot, 'release-output', 'microsoft-store');
const packagesDir = join(gameRoot, 'packages');
const packageFile = join(packagesDir, 'fixture.msixbundle');
const submissionEvidenceFile = join(outputDir, 'submission-preflight.json');
const appCertExecutable = join(fixtureRoot, 'appcert.exe');
const makeAppxExecutable = join(fixtureRoot, 'makeappx.exe');
const packageId = '12345Acme.FixtureGame';
const publisherId = 'CN=01234567-89ab-cdef-0123-456789abcdef';
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

  assert.deepEqual(parseMicrosoftStorePackageIdentity(identityXml(packageId, publisherId)), {
    name: packageId,
    publisher: publisherId,
    version: '1.2.3.4',
  });
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

  const outsidePackage = join(fixtureRoot, 'outside.msix');
  const escapedPackage = join(packagesDir, 'escaped.msix');
  writeFileSync(outsidePackage, 'outside');
  symlinkSync(outsidePackage, escapedPackage);
  assert.throws(
    () => runMicrosoftStorePackageAcceptance(
      { gameRoot, submissionEvidenceFile, packageFiles: [escapedPackage], outputDir },
      runtime,
    ),
    /must stay inside the game root/u,
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
      mkdirSync(join(outputDirArg, 'AppxMetadata'), { recursive: true });
      writeFileSync(
        join(outputDirArg, 'AppxMetadata', 'AppxBundleManifest.xml'),
        identityXml(packageId, emittedPublisherId),
      );
      writeFileSync(join(outputDirArg, 'neutral.appx'), 'fixture payload');

      if (emitSymlinkPayload) {
        symlinkSync(packageFile, join(outputDirArg, 'linked.appx'));
      }

      return;
    }

    if (action === 'unpack') {
      mkdirSync(outputDirArg, { recursive: true });
      writeFileSync(
        join(outputDirArg, 'AppxManifest.xml'),
        identityXml(packageId, emittedPublisherId),
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
  return `<Package><Identity Name="${name}" Publisher="${publisher}" Version="1.2.3.4"/></Package>`;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
