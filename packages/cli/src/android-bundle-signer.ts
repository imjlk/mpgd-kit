import path from 'node:path';

import { runReleaseProcess } from './deploy-process.js';

const signerPattern = /\bSHA256:\s*((?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2})/u;
const timeoutMs = 60_000;
const maxOutputBytes = 1024 * 1024;

/** Recheck the signer of these AAB bytes before persisting or submitting them. */
export async function inspectAndroidBundleSigner(aabFile: string): Promise<string> {
  const bundle = path.resolve(aabFile);
  const options = {
    cwd: path.dirname(bundle),
    timeoutMs,
    maxOutputBytes,
  };
  const verified = await runReleaseProcess({
    ...options,
    command: 'jarsigner',
    args: ['-verify', '-verbose', bundle],
  });
  if (verified.truncated || !/\bjar verified\./u.test(verified.output)
    || /jar is unsigned|contains unsigned entries|has expired/iu.test(verified.output)) {
    throw new Error('Android App Bundle JAR signature verification failed.');
  }
  const certificate = await runReleaseProcess({
    ...options,
    command: 'keytool',
    args: ['-J-Duser.language=en', '-printcert', '-jarfile', bundle],
  });
  const signer = /\bSigner #1:/u.test(certificate.output)
    ? signerPattern.exec(certificate.output)?.[1]
    : undefined;
  if (certificate.truncated || /\bSigner #2:/u.test(certificate.output)
    || signer === undefined) {
    throw new Error('Android App Bundle must have exactly one inspectable signer.');
  }
  return signer.replaceAll(':', '').toLowerCase();
}
