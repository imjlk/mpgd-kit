/**
 * Request headers for game-services calls: static headers, then a resolver
 * for rotating credentials, then per-request headers. Shared by the commerce
 * client and the notifications client so a game gives both one resolver.
 */

export type GameServicesHeaderResolver =
  () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

/** A runtime refused an operation because it was disposed (see `GameServicesRuntime.dispose`). */
export const gameServicesRuntimeDisposedCode = 'GAME_SERVICES_RUNTIME_DISPOSED';
/**
 * A runtime refused an operation because `sessionPlayerId` names another
 * player: it closed itself, as `dispose()` does, and the host creates a
 * runtime for the signed-in player (retryable there).
 */
export const gameServicesPlayerChangedCode = 'GAME_SERVICES_PLAYER_CHANGED';
/** A runtime refused an operation because `sessionPlayerId` names no player (signed out); it stays open. */
export const gameServicesSessionRequiredCode = 'GAME_SERVICES_SESSION_REQUIRED';

export type GameServicesRuntimeClosedCode =
  | typeof gameServicesRuntimeDisposedCode
  | typeof gameServicesPlayerChangedCode
  | typeof gameServicesSessionRequiredCode;

/**
 * An operation the runtime refused before it reached the backend or the
 * store: it was disposed, its player is no longer the session's, or the
 * session is signed out. Always retryable (with a runtime for the signed-in
 * player); nothing was sent and no record was ended.
 */
export class GameServicesRuntimeClosedError extends Error {
  readonly code: GameServicesRuntimeClosedCode;
  readonly retryable = true;

  constructor(code: GameServicesRuntimeClosedCode) {
    super(
      code === gameServicesPlayerChangedCode
        ? 'The session now names another player; this game services runtime is closed.'
        : code === gameServicesSessionRequiredCode
          ? 'The session names no player; sign in before using game services.'
          : 'This game services runtime was disposed.',
    );
    this.name = 'GameServicesRuntimeClosedError';
    this.code = code;
  }
}

/** Credentials could not be resolved; no backend request was dispatched. */
export class GameServicesHeaderResolutionError extends Error {
  constructor() {
    super('Game Services request headers could not be resolved before dispatch.');
    this.name = 'GameServicesHeaderResolutionError';
  }
}

/** Resolve rotating credentials once and preserve static → dynamic → request precedence. */
export async function resolveGameServicesRequestHeaders(input: {
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly getHeaders?: GameServicesHeaderResolver | undefined;
  readonly requestHeaders?: Readonly<Record<string, string>> | undefined;
}): Promise<Readonly<Record<string, string>>> {
  let dynamicHeaders: Readonly<Record<string, string>> | undefined;
  try {
    dynamicHeaders = await input.getHeaders?.();
  } catch (error) {
    if (error instanceof GameServicesRuntimeClosedError) {
      // The runtime's own refusal carries no credentials; its code says why.
      throw error;
    }
    // Resolver exceptions can contain credentials; expose a stable outcome.
    throw new GameServicesHeaderResolutionError();
  }
  const merged = new Map<string, string>();
  for (const layer of [input.headers, dynamicHeaders, input.requestHeaders]) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      merged.set(name.toLowerCase(), value);
    }
  }
  return Object.fromEntries(merged);
}
