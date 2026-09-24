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
  const sourceWeb = realpathSync(input.webDir);
  if (!lstatSync(sourceShell).isDirectory() || !lstatSync(sourceWeb).isDirectory()) {
    throw new Error('Native shell and web directory must be directories.');
  }
  const webRelative = path.relative(sourceShell, sourceWeb);
  if (webRelative === '' || webRelative.startsWith('..')
    || path.isAbsolute(webRelative)) {
    throw new Error('Native web directory must be inside its game-owned shell.');
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
        return !segments.includes('.gradle')
          && !segments.includes('DerivedData')
          && !segments.includes('Pods')
          && !segments.includes('build');
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
