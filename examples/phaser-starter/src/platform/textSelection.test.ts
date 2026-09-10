import assert from 'node:assert/strict';

import {
  buildTextSelectionStylesheet,
  markSelectable,
  resolveTextSelectionMode,
  selectableElementClassName,
  unmarkSelectable,
} from './textSelection';

interface RecordingClassList {
  readonly classes: Set<string>;
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  contains(token: string): boolean;
}

function createElement(): { classList: RecordingClassList } {
  const classes = new Set<string>();
  const classList: RecordingClassList = {
    classes,
    add: (...tokens: string[]) => {
      for (const token of tokens) {
        classes.add(token);
      }
    },
    remove: (...tokens: string[]) => {
      for (const token of tokens) {
        classes.delete(token);
      }
    },
    contains: (token: string) => classes.has(token),
  };

  return { classList };
}

assert.equal(resolveTextSelectionMode(undefined), 'disabled');
assert.equal(resolveTextSelectionMode({}), 'disabled');
assert.equal(resolveTextSelectionMode({ textSelection: undefined }), 'disabled');
assert.equal(resolveTextSelectionMode({ textSelection: 'disabled' }), 'disabled');
assert.equal(resolveTextSelectionMode({ textSelection: 'enabled' }), 'enabled');
assert.throws(
  () => resolveTextSelectionMode({ textSelection: 'sometimes' }),
  /must be 'disabled' or 'enabled'/u,
);
assert.throws(
  () => resolveTextSelectionMode({ textSeletion: 'enabled' }),
  /ui\.textSeletion is not supported/u,
);
assert.throws(
  () => resolveTextSelectionMode('disabled'),
  /ui must be an object/u,
);
assert.throws(
  () => resolveTextSelectionMode(null),
  /ui must be an object/u,
);

const disabledStylesheet = buildTextSelectionStylesheet('disabled');

assert.match(disabledStylesheet, /-webkit-user-select: none;/u);
assert.match(disabledStylesheet, /user-select: none;/u);
assert.match(disabledStylesheet, /-webkit-touch-callout: none;/u);
assert.match(disabledStylesheet, /input, textarea/u);
assert.match(
  disabledStylesheet,
  /:where\(\[contenteditable\]:not\(\[contenteditable='false'\]\)\)/u,
);
assert.match(
  disabledStylesheet,
  /:where\(\[contenteditable\]:not\(\[contenteditable='false'\]\)\) \*/u,
);
assert.match(
  disabledStylesheet,
  /:where\(\[contenteditable='false'\]\), :where\(\[contenteditable='false'\]\) \*/u,
);
assert.match(
  disabledStylesheet,
  new RegExp(`:where\\(input, textarea, \\.${selectableElementClassName}\\)`, 'u'),
);
assert.match(
  disabledStylesheet,
  new RegExp(`:where\\(input, textarea, \\.${selectableElementClassName}\\) \\*`, 'u'),
);
assert.match(disabledStylesheet, /-webkit-user-select: text;/u);
assert.match(disabledStylesheet, /-webkit-touch-callout: default;/u);

// Layer precedence is source order after :where() specificity normalization:
// editable hosts < explicit non-editable islands < the selectable opt-in.
const editableLayer = disabledStylesheet.indexOf(
  ":where([contenteditable]:not([contenteditable='false']))",
);
const nonEditableIslandLayer = disabledStylesheet.indexOf(
  ":where([contenteditable='false']),",
);
const selectableLayer = disabledStylesheet.indexOf(
  `:where(input, textarea, .${selectableElementClassName}),`,
);

assert.ok(editableLayer >= 0, 'editable layer present');
assert.ok(nonEditableIslandLayer > editableLayer, 'false islands override editable hosts');
assert.ok(selectableLayer > nonEditableIslandLayer, 'opt-in overrides false islands');

const enabledStylesheet = buildTextSelectionStylesheet('enabled');

assert.equal(enabledStylesheet.includes('-webkit-user-select: none;'), false);
assert.equal(enabledStylesheet.includes('user-select: none;'), false);
assert.match(enabledStylesheet, /browser default applies/u);

const element = createElement();

markSelectable(element);
assert.equal(element.classList.contains(selectableElementClassName), true);
unmarkSelectable(element);
assert.equal(element.classList.contains(selectableElementClassName), false);
unmarkSelectable(element);
assert.equal(element.classList.contains(selectableElementClassName), false);

console.log('Text selection policy tests passed.');
