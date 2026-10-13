import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Locate the PowerShell 5.1 MSIX acceptance module shipped with this CLI. */
export function getMicrosoftStoreNativeAcceptanceModulePath(): string {
  const modulePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../native-tools/windows-msix/WindowsMsixAcceptance.psm1',
  );
  if (!statSync(modulePath).isFile()) {
    throw new Error('The installed CLI is missing its Windows MSIX acceptance module.');
  }
  return modulePath;
}
