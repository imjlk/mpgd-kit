export interface FontSubsetSource {
  readonly family: string;
  /** URL of a subset font (woff2), typically emitted by the bundler. */
  readonly url: string;
  readonly weight?: string;
  readonly style?: string;
}

/**
 * Load a bundled font subset before first paint so text measurement (for
 * example Pretext) matches rendering. Resolves false instead of throwing when
 * the FontFace API is unavailable or the font times out, so the game still
 * starts with a fallback font.
 */
export async function loadFontSubset(
  source: FontSubsetSource,
  options: { readonly timeoutMs?: number } = {},
): Promise<boolean> {
  if (typeof FontFace !== 'function' || typeof document === 'undefined') {
    return false;
  }
  const face = new FontFace(source.family, `url(${JSON.stringify(source.url)})`, {
    weight: source.weight ?? '400',
    style: source.style ?? 'normal',
    display: 'block',
  });
  const timeout = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), options.timeoutMs ?? 1500);
  });
  try {
    const loaded = await Promise.race([face.load(), timeout]);
    if (loaded === false) {
      return false;
    }
    document.fonts.add(loaded);
    return true;
  } catch {
    return false;
  }
}

/** Unique code points of a text, sorted; feed this to a subsetter (e.g. pyftsubset --text). */
export function collectGlyphs(...texts: readonly string[]): string {
  return [...new Set([...texts.join('')])].sort().join('');
}
