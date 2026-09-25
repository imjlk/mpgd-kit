export interface NativeCommandLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell?: boolean;
}

/** Resolve pnpm's JavaScript entrypoint because Node cannot spawn .cmd without a shell. */
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
  const pnpmScript = input.environment.npm_execpath;
  if (pnpmScript === undefined || !/\.[cm]?js$/iu.test(pnpmScript)) {
    throw new Error(
      'Windows native builds require pnpm exec mpgd so npm_execpath resolves the pnpm JavaScript entrypoint.',
    );
  }
  return {
    command: input.nodeExecutable ?? process.execPath,
    args: [pnpmScript, ...input.args],
  };
}
