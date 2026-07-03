export interface ReplayEvent {
  readonly frame: number;
  readonly action: string;
  readonly value: string;
}

export function createReplayHash(seed: number, events: readonly ReplayEvent[]): string {
  let hash = 2166136261 ^ seed;

  for (const event of events) {
    hash = fnv1a(hash, `${event.frame}:${event.action}:${event.value};`);
  }

  return hash.toString(16).padStart(8, '0');
}

function fnv1a(initialHash: number, input: string): number {
  let hash = initialHash >>> 0;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash >>> 0;
}
