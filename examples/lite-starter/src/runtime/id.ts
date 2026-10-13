export function createClientId(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const id = randomUuid?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}-${id}`;
}
