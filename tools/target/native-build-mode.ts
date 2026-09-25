export type NativePlatform = 'android' | 'ios';

export type NativeBuildMode =
  | 'sync'
  | 'debug'
  | 'simulator'
  | 'unsigned-archive'
  | 'signed-archive'
  | 'store-export';

export interface NativeBuildPlan {
  readonly platform: NativePlatform;
  readonly mode: NativeBuildMode;
  /** A signed archive still needs a store export on iOS. */
  readonly submissionCandidate: boolean;
}

const androidModes = new Set<NativeBuildMode>(['debug', 'unsigned-archive', 'signed-archive']);
const iosModes = new Set<NativeBuildMode>([
  'sync',
  'simulator',
  'unsigned-archive',
  'signed-archive',
  'store-export',
]);

export function resolveNativeBuildPlan(input: {
  readonly platform: NativePlatform;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
}): NativeBuildPlan {
  const { environment, platform, profile } = input;
  const explicit = environment.MPGD_NATIVE_BUILD_MODE?.trim();
  const legacyArchive = environment.MPGD_RUN_IOS_ARCHIVE === '1';
  const legacySimulator = environment.MPGD_RUN_IOS_SIMULATOR_BUILD === '1';

  if (legacyArchive && legacySimulator) {
    throw new Error('Select only one legacy iOS archive or simulator mode.');
  }
  if (explicit !== undefined && explicit !== '' && (legacyArchive || legacySimulator)) {
    throw new Error('MPGD_NATIVE_BUILD_MODE cannot be combined with legacy iOS build flags.');
  }
  if (platform !== 'ios' && (legacyArchive || legacySimulator)) {
    throw new Error('Legacy iOS build flags cannot select an Android mode.');
  }

  const selected = explicit && explicit !== ''
    ? explicit
    : legacyArchive
      ? 'unsigned-archive'
      : legacySimulator
        ? 'simulator'
        : profile === 'production'
          ? undefined
          : platform === 'android'
            ? 'unsigned-archive'
            : 'sync';
  if (selected === undefined) {
    throw new Error('Production native builds require an explicit MPGD_NATIVE_BUILD_MODE.');
  }
  const allowed = platform === 'android' ? androidModes : iosModes;
  if (!allowed.has(selected as NativeBuildMode)) {
    if (platform === 'android' && selected === 'sync') {
      throw new Error('Android sync artifacts are not portable; use debug or an archive mode.');
    }
    throw new Error(`Unsupported ${platform} native build mode: ${selected}.`);
  }
  const mode = selected as NativeBuildMode;
  if (profile === 'production'
    && mode !== 'signed-archive' && mode !== 'store-export') {
    throw new Error('Production native builds require a signed archive or store export.');
  }

  return {
    platform,
    mode,
    submissionCandidate: profile === 'production' && (platform === 'android'
      ? mode === 'signed-archive'
      : mode === 'store-export'),
  };
}
