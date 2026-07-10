export function assertOwnEnumerablePropertyLimit(
  input: Record<string, unknown>,
  maximum: number,
  label: string,
): void {
  let propertyCount = 0;

  for (const key in input) {
    if (Object.hasOwn(input, key)) {
      propertyCount += 1;

      if (propertyCount > maximum) {
        throw new Error(`${label} must not contain more than ${String(maximum)} entries.`);
      }
    }
  }
}
