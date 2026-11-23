export type IconRunAction = 'generate' | 'verify' | 'inspect';

export interface IconRunRequest {
  readonly action: IconRunAction;
  /** Requested target names; undefined selects every configured target. */
  readonly targets: readonly string[] | undefined;
  readonly profile: string;
}

/**
 * Reads `tools/icons/run.ts <action> [targets] [profile]`, the arguments the
 * root `game:icons:<action>` scripts receive.
 *
 * `targets` is a comma-separated list, and an empty one selects every
 * configured target; a list that names no target, such as `,`, is refused. An
 * empty or missing `profile` is production for verify and development
 * otherwise.
 *
 * Earlier `mpgd game icons` releases ran `pnpm game:icons:<action> --
 * <targets> <profile>`, and pnpm 11 and 12 hand that `--` to the script. One
 * separator directly after the action is skipped so those CLIs keep working.
 */
export function parseIconRunArguments(argv: readonly string[]): IconRunRequest {
  const [action = 'generate', ...rest] = argv;

  if (action !== 'generate' && action !== 'verify' && action !== 'inspect') {
    throw new Error(`Unknown icon action: ${action}`);
  }

  const operands = rest[0] === '--' ? rest.slice(1) : rest;
  const [targetList = '', requestedProfile = '', ...unexpected] = operands;

  if (unexpected.length > 0) {
    throw new Error(`Unexpected icon arguments: ${unexpected.join(' ')}`);
  }

  const targets = targetList.length === 0
    ? undefined
    : targetList
      .split(',')
      .map((target) => target.trim())
      .filter((target) => target.length > 0);

  if (targets?.length === 0) {
    throw new Error(`The icon target list names no target: "${targetList}"`);
  }

  return {
    action,
    targets,
    profile: requestedProfile.length > 0
      ? requestedProfile
      : action === 'verify'
        ? 'production'
        : 'development',
  };
}
