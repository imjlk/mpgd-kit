export type AitGameUserKeyProvider = () => Promise<unknown>;

const AIT_SDK_INVALID_CATEGORY = 'INVALID_CATEGORY' as const;
const AIT_SDK_ERROR = 'ERROR' as const;

export type AitGameIdentityResolution =
  | {
      readonly ok: true;
      readonly player: {
        readonly playerId: string;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export async function resolveAitGameIdentity(
  getUserKeyForGame: AitGameUserKeyProvider,
): Promise<AitGameIdentityResolution> {
  let result: unknown;

  try {
    result = await getUserKeyForGame();
  } catch (error) {
    return failure(
      'AIT_GAME_IDENTITY_REQUEST_FAILED',
      `Apps in Toss game identity request failed: ${errorMessage(error)}`,
      true,
    );
  }

  if (result === undefined) {
    return failure(
      'AIT_GAME_IDENTITY_UNSUPPORTED',
      'Apps in Toss game identity requires Toss app 5.232.0 or newer.',
      false,
    );
  }

  if (result === AIT_SDK_INVALID_CATEGORY) {
    return failure(
      'AIT_GAME_IDENTITY_INVALID_CATEGORY',
      'Apps in Toss game identity is only available to game mini-apps.',
      false,
    );
  }

  if (result === AIT_SDK_ERROR) {
    return failure(
      'AIT_GAME_IDENTITY_FAILED',
      'Apps in Toss could not resolve the game user identity.',
      true,
    );
  }

  if (!isGameUserHash(result)) {
    return failure(
      'AIT_GAME_IDENTITY_INVALID_RESPONSE',
      'Apps in Toss returned an invalid game user identity.',
      false,
    );
  }

  return {
    ok: true,
    player: {
      playerId: result.hash.trim(),
    },
  };
}

function isGameUserHash(input: unknown): input is { readonly type: 'HASH'; readonly hash: string } {
  if (typeof input !== 'object' || input === null) {
    return false;
  }

  const value = input as { readonly type?: unknown; readonly hash?: unknown };
  return value.type === 'HASH' && typeof value.hash === 'string' && value.hash.trim().length > 0;
}

function failure(
  code: string,
  message: string,
  retryable: boolean,
): AitGameIdentityResolution {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
