/**
 * Strict base64 decoders shared inside the package (not exported). Both
 * answer undefined instead of throwing for anything that is not canonical
 * input: no whitespace, no characters outside the alphabet, no impossible
 * length, and at most two trailing `=` (standard alphabet only).
 */

/** Standard base64 (`+`, `/`), padding optional. Undefined when empty or invalid. */
export function decodeBase64(input: string): Uint8Array<ArrayBuffer> | undefined {
  const unpadded = /^([A-Za-z0-9+/]+)={0,2}$/u.exec(input)?.[1];
  if (unpadded === undefined || unpadded.length % 4 === 1) {
    return undefined;
  }
  return decodeUnpadded(unpadded);
}

/** Unpadded base64url (`-`, `_`), as JWS segments use it. Undefined when empty or invalid. */
export function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(input) || input.length % 4 === 1) {
    return undefined;
  }
  return decodeUnpadded(input.replaceAll('-', '+').replaceAll('_', '/'));
}

function decodeUnpadded(base64: string): Uint8Array<ArrayBuffer> | undefined {
  let binary: string;
  try {
    binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
