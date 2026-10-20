/**
 * Request headers for game-services calls: static headers, then a resolver
 * for rotating credentials, then per-request headers. Shared by the commerce
 * client and the notifications client so a game gives both one resolver.
 */

export type GameServicesHeaderResolver =
  () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

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
  } catch {
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
