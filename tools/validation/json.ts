export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function object(value: unknown, label: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}
export function parseObject(text: string, label: string): JsonObject {
  const value: unknown = JSON.parse(text);
  return object(value, label);
}
export function optionalObject(parent: JsonObject, key: string): JsonObject {
  return parent[key] === undefined ? {} : object(parent[key], key);
}
export function stringMap(parent: JsonObject, key: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(optionalObject(parent, key))) {
    if (typeof value !== 'string') {
      throw new Error(`${key}.${name} must be a string.`);
    }
    result[name] = value;
  }
  return result;
}
export function manifest(text: string, label: string) {
  const value = parseObject(text, label);
  return {
    dependencies: stringMap(value, 'dependencies'),
    devDependencies: stringMap(value, 'devDependencies'),
    peerDependencies: stringMap(value, 'peerDependencies'),
    capacitor: optionalObject(value, 'capacitor'),
  };
}
