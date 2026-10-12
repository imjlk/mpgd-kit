export interface NativeCommandLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell?: boolean;
}

/** Launch pnpm directly; Windows .cmd shims require a shell and lose argument boundaries. */
export function resolveNativeCommandLaunch(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly nodeExecutable?: string;
}): NativeCommandLaunch {
  if ((input.platform ?? process.platform) !== 'win32') {
    return { command: input.command, args: input.args };
  }
  if (input.command === './gradlew') {
    return { command: 'gradlew.bat', args: input.args, shell: true };
  }
  if (input.command !== 'pnpm') {
    return { command: input.command, args: input.args };
  }
  const pnpmEntry = input.environment.npm_execpath;
  if (pnpmEntry === undefined || !/\.(?:exe|[cm]?js)$/iu.test(pnpmEntry)) {
    throw new Error(
      'Windows builds require pnpm exec mpgd so npm_execpath resolves the pnpm executable or JavaScript entrypoint.',
    );
  }
  if (/\.exe$/iu.test(pnpmEntry)) {
    return { command: pnpmEntry, args: input.args };
  }
  return {
    command: input.nodeExecutable ?? process.execPath,
    args: [pnpmEntry, ...input.args],
  };
}
