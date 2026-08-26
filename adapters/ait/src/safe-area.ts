import { SafeArea } from '@apps-in-toss/web-framework';

/** Raw Apps in Toss safe-area values expressed in CSS pixels. */
export interface AitSafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Minimal SDK surface kept injectable for deterministic wrapper tests. */
export interface AitSafeAreaSource {
  get(): unknown;
  subscribe(input: { readonly onEvent: (insets: unknown) => void }): () => void;
}

/** Minimal CSS declaration surface required by the bridge. */
export interface AitSafeAreaCssStyle {
  getPropertyValue(property: string): string;
  getPropertyPriority?(property: string): string;
  setProperty(property: string, value: string, priority?: string): void;
  removeProperty(property: string): string;
}

export interface InstallAitSafeAreaCssVariablesOptions {
  readonly source?: AitSafeAreaSource;
  readonly style?: AitSafeAreaCssStyle;
}

/**
 * Apps in Toss positions the game navigation controls immediately below the
 * native top safe area. Keep full-width app chrome below this additional band.
 */
export const aitNavigationControlBandHeightPx = 52;

/** Apps in Toss navigation controls retain this edge gap from the safe right inset. */
export const aitNavigationControlEdgeGapPx = 10;

/** CSS contract shared by generated AIT wrappers and full-bleed games. */
export const aitSafeAreaCssVariables = Object.freeze({
  top: '--mpgd-safe-area-top',
  right: '--mpgd-safe-area-right',
  bottom: '--mpgd-safe-area-bottom',
  left: '--mpgd-safe-area-left',
  navigationControlTop: '--mpgd-ait-navigation-control-top',
  navigationControlRight: '--mpgd-ait-navigation-control-right',
  navigationContentTop: '--mpgd-ait-navigation-content-top',
} as const);

const maximumSafeAreaInsetPx = 4_096;

/**
 * Mirror the official AIT `SafeArea` snapshot into CSS custom properties and
 * keep them current when the WebView changes presentation or orientation.
 *
 * CSS `env(safe-area-inset-*)` remains the wrapper's pre-SDK fallback. Invalid
 * or unavailable native values never overwrite that fallback.
 */
export function installAitSafeAreaCssVariables(
  options: InstallAitSafeAreaCssVariablesOptions = {},
): () => void {
  const style = options.style ?? resolveDocumentRootStyle();
  if (style === undefined) {
    return () => {};
  }

  const source = options.source ?? SafeArea;
  const previous = rememberCssVariables(style);
  let active = true;
  let unsubscribe = () => {};
  const apply = (input: unknown): void => {
    if (!active) {
      return;
    }

    const insets = normalizeAitSafeAreaInsets(input);
    if (insets === null) {
      return;
    }

    style.setProperty(aitSafeAreaCssVariables.top, formatCssPixels(insets.top));
    style.setProperty(aitSafeAreaCssVariables.right, formatCssPixels(insets.right));
    style.setProperty(aitSafeAreaCssVariables.bottom, formatCssPixels(insets.bottom));
    style.setProperty(aitSafeAreaCssVariables.left, formatCssPixels(insets.left));
    style.setProperty(aitSafeAreaCssVariables.navigationControlTop, formatCssPixels(insets.top));
    style.setProperty(
      aitSafeAreaCssVariables.navigationControlRight,
      formatCssPixels(insets.right + aitNavigationControlEdgeGapPx),
    );
    style.setProperty(
      aitSafeAreaCssVariables.navigationContentTop,
      formatCssPixels(insets.top + aitNavigationControlBandHeightPx),
    );
  };

  try {
    apply(source.get());
  } catch {
    // Local browsers and older Toss hosts keep the CSS env() fallback.
  }

  try {
    const subscribed = source.subscribe({ onEvent: apply });
    unsubscribe = typeof subscribed === 'function' ? subscribed : () => {};
  } catch {
    // A missing native event bridge must not prevent the game from booting.
  }

  return () => {
    if (!active) {
      return;
    }
    active = false;
    try {
      unsubscribe();
    } finally {
      restoreCssVariables(style, previous);
    }
  };
}

function normalizeAitSafeAreaInsets(input: unknown): AitSafeAreaInsets | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const top = normalizeInset(record.top);
  const right = normalizeInset(record.right);
  const bottom = normalizeInset(record.bottom);
  const left = normalizeInset(record.left);
  if (top === null || right === null || bottom === null || left === null) {
    return null;
  }

  return { top, right, bottom, left };
}

function normalizeInset(input: unknown): number | null {
  return typeof input === 'number'
    && Number.isFinite(input)
    && input >= 0
    && input <= maximumSafeAreaInsetPx
    ? input
    : null;
}

function formatCssPixels(value: number): string {
  return `${Object.is(value, -0) ? 0 : value}px`;
}

function resolveDocumentRootStyle(): CSSStyleDeclaration | undefined {
  return typeof document === 'undefined' ? undefined : document.documentElement.style;
}

interface RememberedCssVariable {
  readonly property: string;
  readonly value: string;
  readonly priority: string;
}

function rememberCssVariables(style: AitSafeAreaCssStyle): readonly RememberedCssVariable[] {
  return Object.values(aitSafeAreaCssVariables).map((property) => ({
    property,
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority?.(property) ?? '',
  }));
}

function restoreCssVariables(
  style: AitSafeAreaCssStyle,
  previous: readonly RememberedCssVariable[],
): void {
  for (const entry of previous) {
    if (entry.value.length === 0) {
      style.removeProperty(entry.property);
    } else {
      style.setProperty(entry.property, entry.value, entry.priority);
    }
  }
}
