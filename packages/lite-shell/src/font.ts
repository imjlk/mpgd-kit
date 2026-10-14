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
export interface LoadFontSubsetOptions {
  /** Give up waiting after this many ms (default 1500). */
  readonly timeoutMs?: number;
  /** FontFace `display` descriptor (default `'block'`). */
  readonly display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional';
  /**
   * The font finished loading after the timeout. It has already been added to
   * `document.fonts`; use this to re-measure text and redraw.
   */
  readonly onLateLoad?: (face: FontFace) => void;
}

export async function loadFontSubset(
  source: FontSubsetSource,
  options: LoadFontSubsetOptions = {},
): Promise<boolean> {
  if (typeof FontFace !== 'function' || typeof document === 'undefined') {
    return false;
  }
  const face = new FontFace(source.family, `url(${JSON.stringify(source.url)})`, {
    weight: source.weight ?? '400',
    style: source.style ?? 'normal',
    display: options.display ?? 'block',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), options.timeoutMs ?? 1500);
  });
  const loading = face.load();
  try {
    const loaded = await Promise.race([loading, timeout]);
    if (loaded === false) {
      // Keep the late font instead of discarding it.
      loading.then(
        (late) => {
          document.fonts.add(late);
          options.onLateLoad?.(late);
        },
        () => undefined,
      );
      return false;
    }
    document.fonts.add(loaded);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Unique code points of a text, sorted; feed this to a subsetter (e.g. pyftsubset --text). */
export function collectGlyphs(...texts: readonly string[]): string {
  return [...new Set([...texts.join('')])].sort().join('');
}
