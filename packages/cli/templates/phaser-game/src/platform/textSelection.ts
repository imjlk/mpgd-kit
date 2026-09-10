/**
 * Game-wide text selection policy.
 *
 * Games render tap targets, not documents, so text selection is disabled
 * globally by default and re-enabled only for input fields and elements that
 * explicitly opt in through {@link markSelectable}.
 *
 * Under the disabled policy the stylesheet layers, in ascending precedence:
 * default suppression, editable contenteditable hosts (any value except
 * explicit `false`, descendants included), explicit non-editable islands, and
 * finally form fields plus the {@link selectableElementClassName} opt-in.
 * All selectors are :where() normalized, so game CSS can still override the
 * policy for bespoke elements.
 */

export type TextSelectionMode = 'disabled' | 'enabled';

/** Class that re-enables text selection on an element and its descendants. */
export const selectableElementClassName = 'mpgd-selectable';

const textSelectionStylesheetId = 'mpgd-text-selection-policy';

export interface SelectableElement {
  readonly classList: {
    add(...tokens: string[]): void;
    remove(...tokens: string[]): void;
    contains(token: string): boolean;
  };
}

/** Parse the `ui.textSelection` game setting, defaulting to disabled. */
export function resolveTextSelectionMode(uiConfig: unknown): TextSelectionMode {
  if (uiConfig === undefined) {
    return 'disabled';
  }

  if (typeof uiConfig !== 'object' || uiConfig === null || Array.isArray(uiConfig)) {
    throw new Error('mpgd.game.json ui must be an object when present.');
  }

  for (const key of Object.keys(uiConfig)) {
    if (key !== 'textSelection') {
      throw new Error(`mpgd.game.json ui.${key} is not supported.`);
    }
  }

  const textSelection = (uiConfig as Record<string, unknown>).textSelection;

  if (textSelection === undefined) {
    return 'disabled';
  }

  if (textSelection !== 'disabled' && textSelection !== 'enabled') {
    throw new Error("mpgd.game.json ui.textSelection must be 'disabled' or 'enabled'.");
  }

  return textSelection;
}

/** Build the stylesheet that enforces the selection policy. */
export function buildTextSelectionStylesheet(mode: TextSelectionMode): string {
  if (mode === 'enabled') {
    return '/* mpgd: text selection enabled; browser default applies. */\n';
  }

  // Every selector is wrapped in :where() so all rules share zero specificity
  // and source order defines the precedence:
  // default suppression < editable hosts < explicit non-editable islands
  // < form fields and the selectable opt-in utility.
  return [
    '*, *::before, *::after {',
    '  -webkit-user-select: none;',
    '  user-select: none;',
    '  -webkit-touch-callout: none;',
    '}',
    ":where([contenteditable]:not([contenteditable='false'])),",
    ":where([contenteditable]:not([contenteditable='false'])) * {",
    '  -webkit-user-select: text;',
    '  user-select: text;',
    '  -webkit-touch-callout: default;',
    '}',
    ":where([contenteditable='false']), :where([contenteditable='false']) * {",
    '  -webkit-user-select: none;',
    '  user-select: none;',
    '  -webkit-touch-callout: none;',
    '}',
    `:where(input, textarea, .${selectableElementClassName}),`,
    `:where(input, textarea, .${selectableElementClassName}) * {`,
    '  -webkit-user-select: text;',
    '  user-select: text;',
    '  -webkit-touch-callout: default;',
    '}',
  ].join('\n');
}

/** Install (or refresh) the global selection policy stylesheet. */
export function installTextSelectionPolicy(mode: TextSelectionMode): void {
  if (typeof document === 'undefined') {
    return;
  }

  let stylesheet = document.getElementById(textSelectionStylesheetId);

  if (stylesheet === null) {
    stylesheet = document.createElement('style');
    stylesheet.id = textSelectionStylesheetId;
    document.head.append(stylesheet);
  }

  stylesheet.textContent = buildTextSelectionStylesheet(mode);
}

/** Re-enable text selection for a specific UI element and its descendants. */
export function markSelectable(element: SelectableElement): void {
  element.classList.add(selectableElementClassName);
}

/** Withdraw a previous {@link markSelectable} opt-in. */
export function unmarkSelectable(element: SelectableElement): void {
  element.classList.remove(selectableElementClassName);
}
