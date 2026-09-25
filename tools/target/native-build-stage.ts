import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface NativeShellStage {
  readonly shellApp: string;
  readonly webDir: string;
  dispose(): void;
}

/**
 * Copies the native project to a same-depth sibling. pnpm's relative
 * node_modules links still resolve, while cap sync and native build output
 * cannot mutate the game-owned source shell or another target's stage.
 */
export function createNativeShellStage(input: {
  readonly shellApp: string;
  readonly webDir: string;
}): NativeShellStage {
  const sourceShell = realpathSync(input.shellApp);
  const declaredShell = path.resolve(input.shellApp);
  const declaredWeb = path.resolve(input.webDir);
  if (!lstatSync(sourceShell).isDirectory()) {
    throw new Error('Native shell must be a directory.');
  }
  const webRelative = path.relative(declaredShell, declaredWeb);
  if (webRelative === '' || webRelative.startsWith('..')
    || path.isAbsolute(webRelative)) {
    throw new Error('Native web directory must be inside its game-owned shell.');
  }
  const sourceWeb = path.join(sourceShell, webRelative);
  let checkedPath = sourceShell;
  for (const segment of webRelative.split(path.sep)) {
    checkedPath = path.join(checkedPath, segment);
    try {
      if (lstatSync(checkedPath).isSymbolicLink()) {
        throw new Error('Native web directory must not traverse a symbolic link.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  if (existsSync(sourceWeb) && !lstatSync(sourceWeb).isDirectory()) {
    throw new Error('Native web directory must be a directory when it exists.');
  }
  const stage = path.join(path.dirname(sourceShell), `.mpgd-native-stage-${randomUUID()}`);
  if (existsSync(stage)) {
    throw new Error('Native staging path already exists.');
  }
  try {
    cpSync(sourceShell, stage, {
      recursive: true,
      dereference: false,
      filter(source) {
        const relative = path.relative(sourceShell, source);
        const segments = relative.split(path.sep);
        if (segments.some((segment) =>
          ['.gradle', 'DerivedData', 'Pods', 'build'].includes(segment))) {
          return false;
        }
        if (relative !== '' && lstatSync(source).isSymbolicLink()
          && segments[0] !== 'node_modules') {
          throw new Error(`Native shell symlink is unsupported in mutable project inputs: ${relative}.`);
        }
        return true;
      },
    });
    return {
      shellApp: stage,
      webDir: path.join(stage, webRelative),
      dispose() {
        rmSync(stage, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
