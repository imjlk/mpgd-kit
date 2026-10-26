import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { IosPushWiringInput } from './native-shell-store-policy.js';

/** Swift files read at most from the App group: a guard against a pathological tree. */
const maxSwiftSources = 2_000;

/**
 * The iOS project files `inspectIosPushWiring` reads, from a shell's
 * `ios/App` directory (the Xcode project directory): the project, a reader
 * for files inside that directory, and the Swift sources of the App group.
 * Symbolic links and paths that leave the directory are never followed.
 * Undefined when the shell has no readable Xcode project.
 */
export function readIosPushWiringInput(iosProjectDirectory: string): IosPushWiringInput | undefined {
  const project = readContainedFile(iosProjectDirectory, 'App.xcodeproj/project.pbxproj');
  if (project === undefined) {
    return undefined;
  }
  return {
    project,
    readProjectFile: (relative) => readContainedFile(iosProjectDirectory, relative),
    swiftSources: listContainedSwiftFiles(iosProjectDirectory, 'App')
      .map((relative) => readContainedFile(iosProjectDirectory, relative) ?? ''),
  };
}

/** A regular file inside `root` by its relative path, or undefined when missing or unsafe. */
function readContainedFile(root: string, relative: string): string | undefined {
  const file = path.resolve(root, relative);
  const within = path.relative(root, file);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    return undefined;
  }
  let current = root;
  for (const segment of within.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
      return undefined;
    }
  }
  return lstatSync(file).isFile() ? readFileSync(file, 'utf8') : undefined;
}

function listContainedSwiftFiles(root: string, relativeRoot: string): string[] {
  const pending = [relativeRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const relative = pending.pop() ?? '';
    const full = path.join(root, relative);
    if (!existsSync(full) || lstatSync(full).isSymbolicLink() || !lstatSync(full).isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      // The web bundle Capacitor copies into the App group holds no Swift.
      if (entry.isDirectory() && child !== path.join(relativeRoot, 'public')) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith('.swift')) {
        files.push(child);
        if (files.length > maxSwiftSources) {
          throw new Error('The iOS App group has too many Swift sources to inspect.');
        }
      }
    }
  }
  return files.sort();
}
