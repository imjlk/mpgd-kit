/** Preserve prototype methods and their receivers, including optional port methods. */
export function forward<T extends object>(source: T, overrides: Partial<T> | object): T {
  const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>();
  return new Proxy({} as T, {
    get(_target, key) {
      if (Object.hasOwn(overrides, key)) {
        return Reflect.get(overrides, key);
      }
      const value: unknown = Reflect.get(source, key, source);
      if (typeof value !== 'function') {
        return value;
      }
      const prior = methods.get(key);
      if (prior?.original === value) {
        return prior.bound;
      }
      const bound: unknown = value.bind(source);
      methods.set(key, { original: value, bound });
      return bound;
    },
    has: (_target, key) => Object.hasOwn(overrides, key) || key in source,
    ownKeys: () => [...new Set([...Reflect.ownKeys(source), ...Reflect.ownKeys(overrides)])],
    getOwnPropertyDescriptor: (_target, key) =>
      key in source || Object.hasOwn(overrides, key)
        ? { configurable: true, enumerable: true, writable: false, value: undefined }
        : undefined,
    getPrototypeOf: () => Reflect.getPrototypeOf(source),
  });
}
