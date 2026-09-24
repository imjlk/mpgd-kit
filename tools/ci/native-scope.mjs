import { fileURLToPath } from 'node:url';

const nativeRoots = [
  'adapters/capacitor/',
  'native-plugins/capacitor-game-services/',
  'apps/mobile-capacitor/',
];

export function isNativeOnlyChange(files) {
  let hasNativeChange = false;
  for (const file of files) {
    if (nativeRoots.some((root) => file.startsWith(root))) {
      hasNativeChange = true;
      continue;
    }
    if (/^\.sampo\/changesets\/[^/]+\.md$/.test(file)) continue;
    return false;
  }
  return hasNativeChange;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(isNativeOnlyChange(process.argv.slice(2)) ? 'true\n' : 'false\n');
}
